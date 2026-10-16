/*
 * queryEstimates: allocated per-execution estimates for native SQL Query History rows (spec §8).
 *
 * Statements (all read-only, parameterized, metadata only):
 *   1. identity   — history rows for the requested statement IDs, or for warehouse + start-second +
 *                   total-duration windows. Only a UNIQUE metadata match is accepted.
 *   2. billing    — warehouse usage intervals overlapping the targets' active windows, priced through
 *                   the shared adapter (signed sum per interval), plus the latest billed end per
 *                   warehouse (to tell "Waiting for billing" from missing billing).
 *   3. executions — every execution visible to this identity on those warehouses that overlaps those
 *                   intervals (not only rows on screen), capped and withheld rather than undercounted.
 * The SQL text column is never selected, filtered, or otherwise referenced. Result rows of the
 * estimated queries are never read.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const V = dep('validate', '../../core/validate.js');
  const periods = dep('periods', '../../core/periods.js');
  const allocation = dep('allocation', '../../core/allocation.js');
  const pricing = dep('pricing', '../pricing.js');

  const MAX_TARGETS = 40;
  const LOOKBACK_DAYS = 90;
  const MAX_IDENTITY_ROWS = 2000;
  const MAX_INTERVAL_ROWS = 5000;
  const MAX_EXECUTION_ROWS = 10000;
  const MAX_TOLERANCE_MS = 60000;
  const MAX_DURATION_MS = 3 * 86400000;
  const DAY_MS = 86400000;
  // Statements can run for up to 48 h (max statement timeout); executions overlapping a billing
  // interval are searched from this far before it.
  const MAX_STATEMENT_SPAN_MS = 3 * DAY_MS;
  // Missing history newer than this is reported as "Waiting for history" (ingestion delay).
  const HISTORY_DELAY_MS = 2 * 3600000;
  // With no billing at all for a warehouse, executions newer than this are "Waiting for billing".
  const BILLING_DELAY_MS = 3 * DAY_MS;
  const KEY_RE = /^[A-Za-z0-9:_.|-]{1,160}$/;
  const PENDING_STATES = new Set(['RUNNING', 'QUEUED', 'PENDING', 'STARTED', 'SUBMITTED', 'FETCHING_RESULTS', 'WAITING']);
  const NATIVE_STATES = new Set(['running', 'queued', 'finished', 'failed', 'canceled']);
  const LABELS = allocation.LABELS;

  function isDccTooLarge(e) {
    return Boolean(e && e.dcc && e.dcc.code === 'RESULT_TOO_LARGE');
  }

  function item(key, status, extra) {
    return Object.assign(
      {
        key,
        status,
        label: status === 'ok' ? 'Allocated estimate' : LABELS[status],
        reason: null,
        amount: null,
        statementId: null,
        warehouseId: null,
        intervals: 0,
        concurrency: null,
        assumptions: [],
        scope: 'execution',
        attribution: 'allocated',
        warnings: [],
      },
      extra || {}
    );
  }

  function checkConn(conn) {
    if (!conn || !V.isWorkspaceId(conn.workspaceId)) throw new Error('Invalid workspace ID');
    if (!V.isCurrency(conn.currency)) throw new Error('Invalid currency');
    pricing.adapterFor(conn.priceTable); // throws for anything outside the allowlist
    return {
      workspaceId: conn.workspaceId,
      priceTable: conn.priceTable,
      currency: conn.currency,
      usageSource: conn.usageSource || 'system.billing.usage',
      history: V.quoteThreePartName(conn.historySource || 'system.query.history'),
      usage: V.quoteThreePartName(conn.usageSource || 'system.billing.usage'),
    };
  }

  const isInt = (v) => typeof v === 'number' && Number.isSafeInteger(v);

  /**
   * Re-validate targets from the content script. Returns accepted targets (≤ 40 unique keys) and
   * items for targets that could not be validated.
   */
  function sanitizeTargets(raw, nowMs) {
    const targets = [];
    const items = {};
    const seen = new Set();
    const minMs = Date.UTC(2015, 0, 1);
    const maxMs = nowMs + DAY_MS;
    for (const t of Array.isArray(raw) ? raw : []) {
      if (targets.length + Object.keys(items).length >= MAX_TARGETS) break;
      if (!t || typeof t !== 'object' || typeof t.key !== 'string' || !KEY_RE.test(t.key) || seen.has(t.key)) continue;
      seen.add(t.key);
      const native = {
        status: typeof t.status === 'string' && NATIVE_STATES.has(t.status) ? t.status : null,
        cached: t.cached === true,
      };
      const startOk = isInt(t.startMs) && t.startMs >= minMs && t.startMs <= maxMs;
      const durOk = isInt(t.durationMs) && t.durationMs >= 0 && t.durationMs <= MAX_DURATION_MS;
      const tolOk = typeof t.toleranceMs === 'number' && Number.isFinite(t.toleranceMs) && t.toleranceMs >= 0 && t.toleranceMs <= MAX_TOLERANCE_MS;
      const sid = typeof t.statementId === 'string' ? t.statementId.toLowerCase() : null;
      if (sid && V.isStatementId(sid)) {
        targets.push({
          key: t.key,
          kind: 'statement',
          statementId: sid,
          startMs: startOk ? Math.floor(t.startMs / 1000) * 1000 : null,
          durationMs: durOk ? t.durationMs : null,
          native,
        });
      } else if ((t.statementId === undefined || t.statementId === null) && V.isWarehouseId(t.warehouseId) && startOk && durOk && tolOk) {
        targets.push({
          key: t.key,
          kind: 'meta',
          warehouseId: t.warehouseId,
          startMs: Math.floor(t.startMs / 1000) * 1000,
          durationMs: t.durationMs,
          toleranceMs: t.toleranceMs,
          durLo: Math.max(0, Math.ceil(t.durationMs - t.toleranceMs)),
          durHi: Math.floor(t.durationMs + t.toleranceMs),
          native,
        });
      } else {
        items[t.key] = item(t.key, 'row_unavailable', { reason: 'The row did not expose a valid statement ID, or a warehouse ID with start time and duration.' });
      }
    }
    return { targets, items };
  }

  /* ------------------------------------------------------------------ statement 1: identity */

  const HISTORY_COLUMNS = `h.statement_id,
       h.compute.type AS compute_type,
       h.compute.warehouse_id AS warehouse_id,
       h.execution_status,
       unix_millis(h.start_time) AS start_ms,
       unix_millis(h.end_time) AS end_ms,
       h.total_duration_ms,
       h.execution_duration_ms,
       h.from_result_cache`;

  function buildIdentityQuery(c, targets, lb) {
    const P = pricing.param;
    const params = [
      P('workspace_id', c.workspaceId),
      // Coarse date bounds (one day wider each side, so a session time zone can't clip them);
      // the exact UTC window uses epoch milliseconds.
      P('lb_coarse_start', periods.addDays(lb.start, -1), 'DATE'),
      P('lb_coarse_end', periods.addDays(lb.endExclusive, 1), 'DATE'),
      P('lb_start_ms', periods.dateToMs(lb.start), 'BIGINT'),
      P('lb_end_ms', periods.dateToMs(lb.endExclusive), 'BIGINT'),
    ];
    const ors = [];
    const sids = [...new Set(targets.filter((t) => t.kind === 'statement').map((t) => t.statementId))];
    if (sids.length) {
      sids.forEach((s, i) => params.push(P('sid' + i, s)));
      ors.push('h.statement_id IN (' + sids.map((_, i) => ':sid' + i).join(', ') + ')');
    }
    targets
      .filter((t) => t.kind === 'meta')
      .forEach((t, i) => {
        params.push(P('mw' + i, t.warehouseId), P('ms' + i, t.startMs, 'BIGINT'), P('me' + i, t.startMs + 1000, 'BIGINT'), P('mlo' + i, t.durLo, 'BIGINT'), P('mhi' + i, t.durHi, 'BIGINT'));
        ors.push(`(h.compute.warehouse_id = :mw${i} AND unix_millis(h.start_time) >= :ms${i} AND unix_millis(h.start_time) < :me${i} AND h.total_duration_ms >= :mlo${i} AND h.total_duration_ms <= :mhi${i})`);
      });
    const statement = `SELECT ${HISTORY_COLUMNS}
FROM ${c.history} h
WHERE h.workspace_id = :workspace_id
  AND h.start_time >= :lb_coarse_start AND h.start_time < :lb_coarse_end
  AND unix_millis(h.start_time) >= :lb_start_ms AND unix_millis(h.start_time) < :lb_end_ms
  AND (${ors.join('\n    OR ')})`;
    return { kind: 'queryEstimates:identity', statement, parameters: params, rowLimit: MAX_IDENTITY_ROWS + 1, maxRows: MAX_IDENTITY_ROWS };
  }

  function metaFromRow(r) {
    return {
      statementId: typeof r.statement_id === 'string' ? r.statement_id.toLowerCase() : null,
      computeType: typeof r.compute_type === 'string' ? r.compute_type.toUpperCase() : null,
      warehouseId: typeof r.warehouse_id === 'string' ? r.warehouse_id : null,
      status: typeof r.execution_status === 'string' ? r.execution_status.toUpperCase() : null,
      startMs: Number.isFinite(r.start_ms) ? r.start_ms : null,
      endMs: Number.isFinite(r.end_ms) ? r.end_ms : null,
      totalMs: Number.isFinite(r.total_duration_ms) ? r.total_duration_ms : null,
      executionMs: Number.isFinite(r.execution_duration_ms) ? r.execution_duration_ms : null,
      fromCache: r.from_result_cache === true,
    };
  }

  function matchesMeta(m, t) {
    return m.warehouseId === t.warehouseId && m.startMs !== null && m.startMs >= t.startMs && m.startMs < t.startMs + 1000 && m.totalMs !== null && m.totalMs >= t.durLo && m.totalMs <= t.durHi;
  }

  const safeType = (v) => (typeof v === 'string' && /^[A-Z_]{1,40}$/.test(v) ? v : 'unknown');

  /** Classify a matched history record; returns an item or a numeric candidate. */
  function classify(t, m) {
    const base = { statementId: m.statementId, warehouseId: V.isWarehouseId(m.warehouseId) ? m.warehouseId : null };
    if (m.computeType !== 'WAREHOUSE') {
      return { item: item(t.key, 'compute_unsupported', Object.assign(base, { reason: 'Only SQL warehouse executions are estimated. This statement ran on ' + safeType(m.computeType) + ' compute.' })) };
    }
    if (m.endMs === null || PENDING_STATES.has(m.status)) {
      return { item: item(t.key, 'pending', Object.assign(base, { reason: 'The execution has not finished, so there is no completed execution time to allocate.' })) };
    }
    if (m.fromCache) {
      return { item: item(t.key, 'cached', Object.assign(base, { reason: 'Served from the result cache; no warehouse execution time is allocated to it.' })) };
    }
    if (m.status !== 'FINISHED') {
      return { item: item(t.key, 'unavailable', Object.assign(base, { reason: 'Only finished executions get an estimate (status: ' + safeType(m.status) + ').' })) };
    }
    if (!base.warehouseId) {
      return { item: item(t.key, 'unavailable', Object.assign(base, { reason: 'The history record has no valid warehouse ID.' })) };
    }
    const w = allocation.activeWindow(m);
    if (!w) {
      return { item: item(t.key, 'cached', Object.assign(base, { reason: 'No measurable execution time was recorded for this statement.' })) };
    }
    return { candidate: { target: t, meta: m, window: w, warehouseId: m.warehouseId } };
  }

  function missingItem(t, nowMs) {
    const refEnd = t.startMs !== null && t.startMs !== undefined ? t.startMs + (t.durationMs || 0) : null;
    if (refEnd !== null && refEnd > nowMs - HISTORY_DELAY_MS) {
      return item(t.key, 'waiting_history', {
        statementId: t.statementId || null,
        warehouseId: t.warehouseId || null,
        reason: 'No query history record yet. Records usually appear within minutes to a few hours after a statement ends.',
      });
    }
    return item(t.key, 'unavailable', {
      statementId: t.statementId || null,
      warehouseId: t.warehouseId || null,
      reason:
        'No matching query history record in the last ' + LOOKBACK_DAYS + ' UTC days. The record may be older than the lookback, not yet ingested, or not visible to your identity.',
    });
  }

  /* ------------------------------------------------------------------ statement 2: billing */

  function buildBillingQuery(c, candidates, lb) {
    const P = pricing.param;
    const warehouses = [...new Set(candidates.map((x) => x.warehouseId))];
    const params = [];
    warehouses.forEach((w, i) => params.push(P('bw' + i, w)));
    const ors = [];
    let n = 0;
    for (const [i, w] of warehouses.entries()) {
      for (const span of allocation.mergeSpans(candidates.filter((x) => x.warehouseId === w).map((x) => x.window))) {
        params.push(P('bs' + n, span.startMs, 'BIGINT'), P('be' + n, span.endMs, 'BIGINT'));
        ors.push(`(u.usage_metadata.warehouse_id = :bw${i} AND unix_millis(u.usage_end_time) > :bs${n} AND unix_millis(u.usage_start_time) < :be${n})`);
        n += 1;
      }
    }
    const minStart = Math.min(...candidates.map((x) => x.window.startMs));
    const maxEnd = Math.max(...candidates.map((x) => x.window.endMs));
    const startDate = periods.utcDate(minStart - DAY_MS);
    const endDate = periods.addDays(periods.utcDate(maxEnd), 2);
    const whList = warehouses.map((_, i) => ':bw' + i).join(', ');
    const { cte, params: cteParams } = pricing.pricedUsageCte({
      priceTable: c.priceTable,
      usageSource: c.usageSource,
      currency: c.currency,
      workspaceId: c.workspaceId,
      startDate,
      endDate,
      extraWhere: `u.usage_metadata.warehouse_id IN (${whList}) AND (${ors.join(' OR ')})`,
    });
    const latestEnd = periods.addDays(lb.endExclusive, 1);
    params.push(P('latest_start', startDate, 'DATE'), P('latest_end', latestEnd, 'DATE'));
    const statement = `WITH ${cte},
latest AS (
  SELECT u.usage_metadata.warehouse_id AS warehouse_id, MAX(unix_millis(u.usage_end_time)) AS latest_end_ms
  FROM ${c.usage} u
  WHERE u.workspace_id = :workspace_id
    AND u.usage_date >= :latest_start AND u.usage_date < :latest_end
    AND u.usage_metadata.warehouse_id IN (${whList})
  GROUP BY u.usage_metadata.warehouse_id
),
intervals AS (
  SELECT usage_metadata.warehouse_id AS warehouse_id,
         unix_millis(usage_start_time) AS start_ms,
         unix_millis(usage_end_time) AS end_ms,
         SUM(CASE WHEN is_priced THEN cost END) AS priced_cost,
         SUM(CASE WHEN is_priced THEN 0 ELSE 1 END) AS unpriced_records,
         COUNT(*) AS records,
         MIN(sku_name) AS sku_min,
         MAX(sku_name) AS sku_max
  FROM priced_usage
  GROUP BY usage_metadata.warehouse_id, unix_millis(usage_start_time), unix_millis(usage_end_time)
)
SELECT 'interval' AS row_kind, warehouse_id, start_ms, end_ms, priced_cost, unpriced_records, records, sku_min, sku_max,
       CAST(NULL AS BIGINT) AS latest_end_ms
FROM intervals
UNION ALL
SELECT 'latest' AS row_kind, warehouse_id, CAST(NULL AS BIGINT), CAST(NULL AS BIGINT), CAST(NULL AS DOUBLE), CAST(NULL AS BIGINT),
       CAST(NULL AS BIGINT), CAST(NULL AS STRING), CAST(NULL AS STRING), latest_end_ms
FROM latest`;
    return {
      kind: 'queryEstimates:billing',
      statement,
      parameters: cteParams.concat(params),
      rowLimit: MAX_INTERVAL_ROWS + 1,
      maxRows: MAX_INTERVAL_ROWS,
    };
  }

  function parseBilling(rows) {
    const intervals = [];
    const latest = new Map();
    for (const r of rows) {
      if (!V.isWarehouseId(r.warehouse_id)) continue;
      if (r.row_kind === 'latest') {
        if (Number.isFinite(r.latest_end_ms)) latest.set(r.warehouse_id, r.latest_end_ms);
        continue;
      }
      if (r.row_kind !== 'interval' || !Number.isFinite(r.start_ms) || !Number.isFinite(r.end_ms)) continue;
      const skus = [...new Set([r.sku_min, r.sku_max].filter((s) => typeof s === 'string'))].map((s) => V.safeText(s, 80));
      intervals.push({
        id: r.warehouse_id + '|' + r.start_ms + '|' + r.end_ms,
        warehouseId: r.warehouse_id,
        startMs: r.start_ms,
        endMs: r.end_ms,
        cost: r.unpriced_records > 0 || r.priced_cost === null ? null : r.priced_cost,
        unpricedRecords: r.unpriced_records || 0,
        records: r.records || 0,
        skus,
      });
    }
    return { intervals, latest };
  }

  /* ------------------------------------------------------------------ statement 3: executions */

  function buildExecutionsQuery(c, spansByWarehouse) {
    const P = pricing.param;
    const params = [P('workspace_id', c.workspaceId)];
    const ors = [];
    const whs = [...spansByWarehouse.keys()];
    let n = 0;
    let minStart = Infinity;
    let maxEnd = -Infinity;
    whs.forEach((w, i) => {
      params.push(P('xw' + i, w));
      for (const span of spansByWarehouse.get(w)) {
        params.push(P('xs' + n, span.startMs, 'BIGINT'), P('xe' + n, span.endMs, 'BIGINT'));
        ors.push(`(h.compute.warehouse_id = :xw${i} AND unix_millis(h.end_time) > :xs${n} AND unix_millis(h.start_time) < :xe${n})`);
        minStart = Math.min(minStart, span.startMs);
        maxEnd = Math.max(maxEnd, span.endMs);
        n += 1;
      }
    });
    params.push(P('x_coarse_start', periods.utcDate(minStart - MAX_STATEMENT_SPAN_MS), 'DATE'), P('x_coarse_end', periods.addDays(periods.utcDate(maxEnd), 2), 'DATE'));
    const statement = `SELECT h.statement_id,
       h.compute.type AS compute_type,
       h.compute.warehouse_id AS warehouse_id,
       h.execution_status,
       unix_millis(h.start_time) AS start_ms,
       unix_millis(h.end_time) AS end_ms,
       h.execution_duration_ms,
       h.from_result_cache
FROM ${c.history} h
WHERE h.workspace_id = :workspace_id
  AND h.start_time >= :x_coarse_start AND h.start_time < :x_coarse_end
  AND h.end_time IS NOT NULL
  AND h.compute.warehouse_id IN (${whs.map((_, i) => ':xw' + i).join(', ')})
  AND (${ors.join('\n    OR ')})`;
    return { kind: 'queryEstimates:executions', statement, parameters: params, rowLimit: MAX_EXECUTION_ROWS + 1, maxRows: MAX_EXECUTION_ROWS };
  }

  /* ------------------------------------------------------------------ run */

  /**
   * @param {{conn, args:{targets:object[]}, nowMs:number, exec:(query)=>Promise<object[]>}} ctx
   */
  async function run({ conn, args, nowMs = Date.now(), exec }) {
    const c = checkConn(conn);
    const prov = pricing.provenance(c.priceTable, c.currency);
    const lb = periods.lookback(LOOKBACK_DAYS, nowMs, true);
    const lbStartMs = periods.dateToMs(lb.start);
    const { targets, items } = sanitizeTargets(args && args.targets, nowMs);
    const totals = { cost: 0, allocated: 0, idle: 0, warehouses: [] };
    const statements = [];
    const done = () =>
      Object.assign({}, prov, {
        kind: 'queryEstimates',
        lookback: { days: LOOKBACK_DAYS, start: lb.start, endExclusive: lb.endExclusive },
        items,
        totals,
        statements,
        assumptions: allocation.ASSUMPTIONS.slice(),
      });
    const run1 = async (q) => {
      statements.push(q.kind);
      return exec(q);
    };

    // Native running/queued/cached states need no SQL.
    const open = [];
    for (const t of targets) {
      if (t.native.status === 'running' || t.native.status === 'queued') {
        items[t.key] = item(t.key, 'pending', { statementId: t.statementId || null, warehouseId: t.warehouseId || null, reason: 'Databricks shows this execution as ' + t.native.status + '.' });
      } else if (t.native.cached) {
        items[t.key] = item(t.key, 'cached', { statementId: t.statementId || null, warehouseId: t.warehouseId || null, reason: 'Databricks shows this result as served from cache; no warehouse execution time is allocated to it.' });
      } else if (t.kind === 'meta' && t.startMs < lbStartMs) {
        items[t.key] = item(t.key, 'unavailable', { warehouseId: t.warehouseId, reason: 'Started before the ' + LOOKBACK_DAYS + '-day query history lookback.' });
      } else open.push(t);
    }
    if (!open.length) return done();

    // 1. Identity.
    let idRows;
    try {
      idRows = await run1(buildIdentityQuery(c, open, lb));
    } catch (e) {
      if (!isDccTooLarge(e)) throw e;
      for (const t of open) items[t.key] = item(t.key, 'unavailable', { reason: 'Too many query history records matched these rows; estimates are withheld rather than guessed.' });
      return done();
    }
    const metas = idRows.map(metaFromRow).filter((m) => V.isStatementId(m.statementId));
    const byStatement = new Map(metas.map((m) => [m.statementId, m]));
    const candidates = [];
    for (const t of open) {
      let m = null;
      if (t.kind === 'statement') {
        m = byStatement.get(t.statementId) || null;
        if (!m) {
          items[t.key] = missingItem(t, nowMs);
          continue;
        }
      } else {
        const matches = [...new Map(metas.filter((x) => matchesMeta(x, t)).map((x) => [x.statementId, x])).values()];
        if (matches.length === 0) {
          items[t.key] = missingItem(t, nowMs);
          continue;
        }
        if (matches.length > 1) {
          items[t.key] = item(t.key, 'ambiguous', {
            warehouseId: t.warehouseId,
            reason: matches.length + ' executions on this warehouse match the displayed start second and duration. Open the query to get its statement ID.',
          });
          continue;
        }
        m = matches[0];
      }
      const cls = classify(t, m);
      if (cls.item) items[t.key] = cls.item;
      else candidates.push(cls.candidate);
    }
    if (!candidates.length) return done();

    // 2. Billing intervals overlapping the active windows.
    let billing;
    try {
      billing = parseBilling(await run1(buildBillingQuery(c, candidates, lb)));
    } catch (e) {
      if (!isDccTooLarge(e)) throw e;
      for (const x of candidates) items[x.target.key] = item(x.target.key, 'unavailable', { statementId: x.meta.statementId, warehouseId: x.warehouseId, reason: 'Too many billing intervals overlap these executions; estimates are withheld.' });
      return done();
    }
    const numeric = [];
    for (const x of candidates) {
      const base = { statementId: x.meta.statementId, warehouseId: x.warehouseId, activeStartMs: x.window.startMs, activeEndMs: x.window.endMs };
      const ivs = billing.intervals.filter((iv) => iv.warehouseId === x.warehouseId && iv.startMs < x.window.endMs && iv.endMs > x.window.startMs);
      const latestEnd = billing.latest.has(x.warehouseId) ? billing.latest.get(x.warehouseId) : null;
      const newerThanBilling = latestEnd === null ? x.window.endMs > nowMs - BILLING_DELAY_MS : x.window.endMs > latestEnd;
      const covered = allocation.coveredMs(ivs, x.window.startMs, x.window.endMs);
      const span = x.window.endMs - x.window.startMs;
      if (!ivs.length || covered < span) {
        if (newerThanBilling) {
          items[x.target.key] = item(x.target.key, 'waiting_billing', Object.assign(base, { reason: ivs.length ? 'Billing for part of this execution has not been recorded yet.' : 'Warehouse billing for this time has not been recorded yet. Billing is usually delayed by a few hours.' }));
          continue;
        }
        if (!ivs.length) {
          items[x.target.key] = item(x.target.key, 'unavailable', Object.assign(base, { reason: 'No warehouse billing interval overlaps this execution.' }));
          continue;
        }
      }
      const unpriced = ivs.filter((iv) => iv.cost === null);
      if (unpriced.length) {
        const skus = [...new Set(unpriced.flatMap((iv) => iv.skus))].sort();
        items[x.target.key] = item(x.target.key, 'price_unavailable', Object.assign(base, {
          reason: unpriced.reduce((a, iv) => a + iv.unpricedRecords, 0) + ' overlapping billing record(s) have no unique matching price in ' + c.priceTable + (skus.length ? ' (SKU: ' + skus.join(', ') + ')' : '') + '.',
        }));
        continue;
      }
      numeric.push(Object.assign(x, { intervals: ivs, coverage: span > 0 ? covered / span : 0, base }));
    }
    if (!numeric.length) return done();

    // 3. Every visible execution overlapping the relevant intervals (not just rows on screen).
    const relevant = new Map();
    for (const x of numeric) for (const iv of x.intervals) relevant.set(iv.id, iv);
    const spansByWarehouse = new Map();
    for (const iv of relevant.values()) {
      if (!spansByWarehouse.has(iv.warehouseId)) spansByWarehouse.set(iv.warehouseId, []);
      spansByWarehouse.get(iv.warehouseId).push(iv);
    }
    for (const [w, list] of spansByWarehouse) spansByWarehouse.set(w, allocation.mergeSpans(list));
    let execRows;
    try {
      execRows = await run1(buildExecutionsQuery(c, spansByWarehouse));
    } catch (e) {
      if (!isDccTooLarge(e)) throw e;
      for (const x of numeric) {
        items[x.target.key] = item(x.target.key, 'unavailable', Object.assign(x.base, {
          reason: 'More than ' + MAX_EXECUTION_ROWS.toLocaleString('en-US') + ' executions overlap the billing intervals; the estimate is withheld rather than undercounting concurrency.',
        }));
      }
      return done();
    }
    const executions = new Map();
    for (const r of execRows) {
      const m = metaFromRow(r);
      if (!V.isStatementId(m.statementId) || m.computeType !== 'WAREHOUSE' || !spansByWarehouse.has(m.warehouseId) || m.fromCache) continue;
      const w = allocation.activeWindow(m);
      if (w) executions.set(m.statementId, { id: m.statementId, warehouseId: m.warehouseId, startMs: w.startMs, endMs: w.endMs });
    }
    for (const x of numeric) executions.set(x.meta.statementId, { id: x.meta.statementId, warehouseId: x.warehouseId, startMs: x.window.startMs, endMs: x.window.endMs });

    // 4. Allocate.
    const result = allocation.allocateByWarehouse([...relevant.values()], [...executions.values()]);
    totals.cost = result.cost;
    totals.allocated = result.allocated;
    totals.idle = result.idle;
    totals.warehouses = result.warehouses;
    totals.executions = executions.size;
    for (const x of numeric) {
      const a = result.byExecution[x.meta.statementId];
      if (!a) {
        items[x.target.key] = item(x.target.key, 'unavailable', Object.assign(x.base, { reason: 'No priced billing interval overlaps the active execution window.' }));
        continue;
      }
      const assumptions = allocation.ASSUMPTIONS.slice();
      if (x.coverage < 1) assumptions.push('About ' + Math.round((1 - x.coverage) * 100) + '% of the active window has no recorded billing interval; that part is not estimated.');
      items[x.target.key] = item(x.target.key, 'ok', Object.assign(x.base, {
        amount: a.amount,
        intervals: a.intervals,
        concurrency: a.concurrency,
        reason:
          'Allocated from ' + a.intervals + ' billing interval' + (a.intervals === 1 ? '' : 's') +
          (a.concurrency > 1 ? ', shared with up to ' + (a.concurrency - 1) + ' other concurrent quer' + (a.concurrency === 2 ? 'y' : 'ies') : ', no concurrent queries observed') + '.',
        assumptions,
      }));
    }
    return done();
  }

  const api = Object.freeze({
    MAX_TARGETS,
    LOOKBACK_DAYS,
    MAX_EXECUTION_ROWS,
    LABELS,
    sanitizeTargets,
    buildIdentityQuery,
    buildBillingQuery,
    buildExecutionsQuery,
    run,
  });
  if (NODE) module.exports = api;
  else ((root.DCC || (root.DCC = {})).queries || (root.DCC.queries = {})).queryEstimates = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
