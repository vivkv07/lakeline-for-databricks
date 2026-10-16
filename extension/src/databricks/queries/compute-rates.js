/*
 * computeRates: current DBU unit prices for prospective compute-size previews (spec §9).
 *
 *   target 'warehouse'  — the latest billed DBU SKU of that SQL warehouse in the last 90 UTC dates
 *                         (usage_metadata.warehouse_id). On a create page (no warehouse ID yet) only
 *                         a serverless selection is priced, and only when the workspace billed exactly
 *                         one serverless SQL SKU in that window.
 *   target 'allPurpose' — current all-purpose (classic interactive) DBU prices for SKUs observed in
 *                         the workspace, or on the existing cluster when it has billing, filtered by
 *                         Photon when known. Exactly one unambiguous numeric rate is required.
 *
 * "Current" price: price_start_time ≤ now AND (price_end_time IS NULL OR price_end_time > now), in
 * the selected price table only. The struct field comes from pricing.adapterFor(priceTable); the two
 * price fields are never combined. SQL warehouse rates are never used for interactive compute.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const V = dep('validate', '../../core/validate.js');
  const periods = dep('periods', '../../core/periods.js');
  const pricing = dep('pricing', '../pricing.js');
  const errors = dep('errors', '../../errors.js');

  const LOOKBACK_DAYS = 90;
  const MAX_ROWS = 500;
  const RATE_EPSILON = 1e-12;

  function checkConn(conn) {
    if (!conn || !V.isWorkspaceId(conn.workspaceId)) throw new Error('Invalid workspace ID');
    if (!V.isCurrency(conn.currency)) throw new Error('Invalid currency');
    return {
      workspaceId: conn.workspaceId,
      priceTable: conn.priceTable,
      currency: conn.currency,
      usage: V.quoteThreePartName(conn.usageSource || 'system.billing.usage'),
      adapter: pricing.adapterFor(conn.priceTable),
    };
  }

  /** Observed SKUs → their current price in the selected table (one row per observed SKU key). */
  function priceLookupCte(adapter) {
    return `current_prices AS (
  SELECT o.sku_name, o.account_id, o.cloud, o.usage_unit,
         COUNT(p.sku_name) AS price_matches,
         MIN(TRY_CAST(${adapter.field} AS DOUBLE)) AS min_price,
         MAX(TRY_CAST(${adapter.field} AS DOUBLE)) AS unit_price
  FROM observed o
  LEFT JOIN ${adapter.quoted} p
    ON p.account_id = o.account_id
   AND p.sku_name = o.sku_name
   AND p.cloud = o.cloud
   AND p.usage_unit = o.usage_unit
   AND p.currency_code = :currency
   AND unix_millis(p.price_start_time) <= :now_ms
   AND (p.price_end_time IS NULL OR unix_millis(p.price_end_time) > :now_ms)
  GROUP BY o.sku_name, o.account_id, o.cloud, o.usage_unit
)`;
  }

  const SELECT_OBSERVED_PRICES = `SELECT o.sku_name, o.last_end_ms, o.records, o.any_serverless, o.scoped_records,
       cp.price_matches, cp.unit_price
FROM observed o
LEFT JOIN current_prices cp
  ON cp.sku_name = o.sku_name AND cp.account_id = o.account_id AND cp.cloud = o.cloud AND cp.usage_unit = o.usage_unit
ORDER BY o.last_end_ms DESC, o.sku_name`;

  function baseParams(c, nowMs) {
    const lb = periods.lookback(LOOKBACK_DAYS, nowMs, true);
    const P = pricing.param;
    return {
      lb,
      params: [
        P('workspace_id', c.workspaceId),
        P('start_date', lb.start, 'DATE'),
        P('end_date', lb.endExclusive, 'DATE'),
        P('currency', c.currency),
        P('now_ms', Math.floor(nowMs), 'BIGINT'),
      ],
    };
  }

  function buildWarehouse(c, a, nowMs) {
    const { params, lb } = baseParams(c, nowMs);
    let scope;
    if (a.warehouseId) {
      params.push(pricing.param('warehouse_id', a.warehouseId));
      scope = 'u.usage_metadata.warehouse_id = :warehouse_id';
    } else {
      // Create page: serverless SQL only (see header).
      scope = "u.billing_origin_product = 'SQL' AND u.usage_metadata.warehouse_id IS NOT NULL AND u.product_features.is_serverless = TRUE";
    }
    const statement = `WITH observed AS (
  SELECT u.sku_name, u.account_id, u.cloud, u.usage_unit,
         MAX(unix_millis(u.usage_end_time)) AS last_end_ms,
         COUNT(*) AS records,
         MAX(CASE WHEN u.product_features.is_serverless = TRUE THEN 1 ELSE 0 END) AS any_serverless,
         COUNT(*) AS scoped_records
  FROM ${c.usage} u
  WHERE u.workspace_id = :workspace_id
    AND u.usage_date >= :start_date AND u.usage_date < :end_date
    AND u.usage_unit = 'DBU'
    AND ${scope}
  GROUP BY u.sku_name, u.account_id, u.cloud, u.usage_unit
),
${priceLookupCte(c.adapter)}
${SELECT_OBSERVED_PRICES}`;
    return { kind: 'computeRates:warehouse', statement, parameters: params, rowLimit: MAX_ROWS + 1, maxRows: MAX_ROWS, lookback: lb };
  }

  function buildAllPurpose(c, a, nowMs) {
    const { params, lb } = baseParams(c, nowMs);
    let photon = '';
    if (a.photon === true) photon = '\n    AND u.product_features.is_photon = TRUE';
    else if (a.photon === false) photon = '\n    AND COALESCE(u.product_features.is_photon, FALSE) = FALSE';
    let scoped = 'CAST(0 AS BIGINT)';
    if (a.clusterId) {
      params.push(pricing.param('cluster_id', a.clusterId));
      scoped = 'SUM(CASE WHEN u.usage_metadata.cluster_id = :cluster_id THEN 1 ELSE 0 END)';
    }
    const statement = `WITH observed AS (
  SELECT u.sku_name, u.account_id, u.cloud, u.usage_unit,
         MAX(unix_millis(u.usage_end_time)) AS last_end_ms,
         COUNT(*) AS records,
         CAST(0 AS BIGINT) AS any_serverless,
         ${scoped} AS scoped_records
  FROM ${c.usage} u
  WHERE u.workspace_id = :workspace_id
    AND u.usage_date >= :start_date AND u.usage_date < :end_date
    AND u.usage_unit = 'DBU'
    AND u.billing_origin_product = 'ALL_PURPOSE'
    AND COALESCE(u.product_features.is_serverless, FALSE) = FALSE${photon}
  GROUP BY u.sku_name, u.account_id, u.cloud, u.usage_unit
),
${priceLookupCte(c.adapter)}
${SELECT_OBSERVED_PRICES}`;
    return { kind: 'computeRates:allPurpose', statement, parameters: params, rowLimit: MAX_ROWS + 1, maxRows: MAX_ROWS, lookback: lb };
  }

  const safeSku = (s) => (typeof s === 'string' ? V.safeText(s, 120) : null);

  /** One row → {sku, rate|null, state:'priced'|'missing'|'ambiguous'} */
  function priceState(r) {
    if (r.price_matches > 1) return { sku: safeSku(r.sku_name), rate: null, state: 'ambiguous' };
    if (r.price_matches === 1 && Number.isFinite(r.unit_price)) return { sku: safeSku(r.sku_name), rate: r.unit_price, state: 'priced' };
    return { sku: safeSku(r.sku_name), rate: null, state: 'missing' };
  }

  function parseWarehouse(rows, a, c) {
    if (!rows.length) {
      return { status: 'unavailable', reason: a.warehouseId ? 'No DBU billing for this warehouse in the last ' + LOOKBACK_DAYS + ' UTC days.' : 'No serverless SQL warehouse billing in this workspace in the last ' + LOOKBACK_DAYS + ' UTC days.' };
    }
    if (!a.warehouseId && rows.length > 1) {
      return { status: 'ambiguous', reason: 'Several serverless SQL SKUs were billed recently; the SKU for a new warehouse is not certain.', skus: rows.map((r) => safeSku(r.sku_name)) };
    }
    const latestEnd = rows[0].last_end_ms;
    const latest = rows.filter((r) => r.last_end_ms === latestEnd);
    const skus = [...new Set(latest.map((r) => safeSku(r.sku_name)))];
    if (skus.length > 1) return { status: 'ambiguous', reason: 'More than one SKU was billed at the latest time for this warehouse.', skus };
    const r = latest[0];
    const isServerless = r.any_serverless > 0 || /SERVERLESS/i.test(String(r.sku_name));
    if (typeof a.serverless === 'boolean' && a.serverless !== isServerless) {
      return { status: 'unavailable', reason: 'The selected warehouse type differs from the latest billed SKU (' + skus[0] + '), so its rate does not apply.', sku: skus[0] };
    }
    const p = priceState(r);
    if (p.state === 'priced') return { status: 'ok', ratePerDbu: p.rate, sku: p.sku, skus: [p.sku], lastBilledMs: latestEnd };
    if (p.state === 'ambiguous') return { status: 'ambiguous', reason: 'More than one current price row in ' + c.priceTable + ' matches ' + p.sku + '.', sku: p.sku };
    return { status: 'unavailable', reason: 'No current price in ' + c.priceTable + ' for ' + p.sku + '.', sku: p.sku };
  }

  function parseAllPurpose(rows, a, c) {
    let use = rows;
    let basis = 'workspace';
    if (a.clusterId && rows.some((r) => r.scoped_records > 0)) {
      use = rows.filter((r) => r.scoped_records > 0);
      basis = 'cluster';
    }
    if (!use.length) {
      return { status: 'unavailable', reason: 'No classic all-purpose compute billing' + (a.photon === true ? ' with Photon' : a.photon === false ? ' without Photon' : '') + ' in this workspace in the last ' + LOOKBACK_DAYS + ' UTC days.', basis };
    }
    const states = use.map(priceState);
    const skus = states.map((s) => s.sku);
    if (states.some((s) => s.state === 'ambiguous')) {
      return { status: 'ambiguous', reason: 'More than one current price row matches an observed all-purpose SKU.', skus, basis };
    }
    const missing = states.filter((s) => s.state === 'missing');
    if (missing.length) {
      return { status: 'unavailable', reason: 'No current price in ' + c.priceTable + ' for ' + missing.map((s) => s.sku).join(', ') + '.', skus, basis };
    }
    const rates = [];
    for (const s of states) if (!rates.some((r) => Math.abs(r - s.rate) <= RATE_EPSILON)) rates.push(s.rate);
    if (rates.length !== 1) {
      return {
        status: 'ambiguous',
        reason: 'Observed all-purpose SKUs have different DBU prices (' + states.map((s) => s.sku).join(', ') + ')' + (a.photon === null ? '; Photon could not be detected.' : '.'),
        skus,
        basis,
      };
    }
    return { status: 'ok', ratePerDbu: rates[0], sku: skus.length === 1 ? skus[0] : null, skus, basis };
  }

  function sanitizeArgs(args) {
    const a = args && typeof args === 'object' ? args : {};
    if (a.target === 'warehouse') {
      if (a.warehouseId !== undefined && a.warehouseId !== null && !V.isWarehouseId(a.warehouseId)) throw new errors.DccError({ code: 'UNKNOWN', message: 'Invalid warehouse ID' });
      const serverless = typeof a.serverless === 'boolean' ? a.serverless : null;
      return { target: 'warehouse', warehouseId: a.warehouseId || null, serverless };
    }
    if (a.target === 'allPurpose') {
      if (a.clusterId !== undefined && a.clusterId !== null && !V.isClusterId(a.clusterId)) throw new errors.DccError({ code: 'UNKNOWN', message: 'Invalid cluster ID' });
      return { target: 'allPurpose', photon: typeof a.photon === 'boolean' ? a.photon : null, clusterId: a.clusterId || null };
    }
    throw new errors.DccError({ code: 'UNKNOWN', message: 'Unsupported compute rate target' });
  }

  /**
   * @param {{conn, args, nowMs, exec}} ctx
   * @returns {{kind, target, status:'ok'|'ambiguous'|'unavailable', ratePerDbu:number|null, sku, skus,
   *   currency, pricingBasis, priceTable, priceField, reason, unit:'DBU'}}
   */
  async function run({ conn, args, nowMs = Date.now(), exec }) {
    const c = checkConn(conn);
    const a = sanitizeArgs(args);
    const prov = pricing.provenance(c.priceTable, c.currency);
    const envelope = (r) => Object.assign({}, prov, { kind: 'computeRates', target: a.target, unit: 'DBU', ratePerDbu: null, sku: null, skus: [], reason: null, scope: 'rate', label: 'DBU only' }, r, { lookbackDays: LOOKBACK_DAYS });
    if (a.target === 'warehouse' && !a.warehouseId && a.serverless !== true) {
      return envelope({ status: 'unavailable', reason: 'A new warehouse is priced only when Serverless is selected; its SKU is otherwise not known yet.' });
    }
    const q = a.target === 'warehouse' ? buildWarehouse(c, a, nowMs) : buildAllPurpose(c, a, nowMs);
    const rows = await exec(q);
    const parsed = a.target === 'warehouse' ? parseWarehouse(rows, a, c) : parseAllPurpose(rows, a, c);
    if (parsed.status !== 'ok') parsed.ratePerDbu = null;
    return envelope(parsed);
  }

  const api = Object.freeze({ LOOKBACK_DAYS, buildWarehouse, buildAllPurpose, sanitizeArgs, run });
  if (NODE) module.exports = api;
  else ((root.DCC || (root.DCC = {})).queries || (root.DCC.queries = {})).computeRates = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
