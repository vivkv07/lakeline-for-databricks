/*
 * The single pricing adapter used by every cost query.
 *
 * Exactly two price tables are allowed, and the struct field is derived from the table BEFORE
 * SQL is generated. Never COALESCE across the two struct paths: if a field is absent, Databricks
 * fails at compile time (FIELD_NOT_FOUND) before COALESCE could run.
 *
 * Price matching (applied identically everywhere):
 *   p.account_id = u.account_id AND p.sku_name = u.sku_name AND p.cloud = u.cloud
 *   AND p.usage_unit = u.usage_unit AND p.currency_code = :currency
 *   AND u.usage_end_time >= p.price_start_time
 *   AND (p.price_end_time IS NULL OR u.usage_end_time < p.price_end_time)
 * A record is priced only when exactly one price row matches and its price is a number.
 * GENIE_FREE_USAGE (documented free SKU) is the only SKU assigned zero; its quantity is reported
 * separately. Signed quantities (ORIGINAL, RETRACTION, RESTATEMENT) are all kept.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const V = NODE ? require('../core/validate.js') : root.DCC.validate;

  const PRICE_TABLES = Object.freeze({
    'system.billing.list_prices': Object.freeze({ field: 'pricing.effective_list.default', basis: 'list' }),
    'system.billing.account_prices': Object.freeze({ field: 'pricing.default', basis: 'account' }),
  });
  const DEFAULT_PRICE_TABLE = 'system.billing.list_prices';
  const FREE_SKUS = Object.freeze(['GENIE_FREE_USAGE']);
  const ADAPTER_VERSION = 2;

  /** @returns {{table, quoted, field, basis}} — throws for any table outside the allowlist. */
  function adapterFor(priceTable) {
    const entry = Object.prototype.hasOwnProperty.call(PRICE_TABLES, priceTable) ? PRICE_TABLES[priceTable] : null;
    if (!entry) throw new Error('Unsupported price table');
    return { table: priceTable, quoted: V.quoteThreePartName(priceTable), field: 'p.' + entry.field, basis: entry.basis };
  }

  function param(name, value, type = 'STRING') {
    return { name, value: String(value), type };
  }

  /**
   * Build the shared priced-usage CTE chain.
   * @param {object} o
   * @param {string} o.priceTable    one of PRICE_TABLES
   * @param {string} o.usageSource   validated three-part name (system.billing.usage or approved view)
   * @param {string} o.currency      ISO code; prices are never converted
   * @param {string} o.startDate     inclusive UTC date
   * @param {string} o.endDate       exclusive UTC date
   * @param {string} [o.extraWhere]  internal predicate over alias `u` (never user text)
   * @returns {{cte:string, params:object[], adapter:object}}
   *   CTEs: usage_scoped, record_prices, priced_usage (columns of usage + is_priced, cost,
   *   free_quantity, price_matches)
   */
  function pricedUsageCte(o) {
    const adapter = adapterFor(o.priceTable);
    const usage = V.quoteThreePartName(o.usageSource);
    if (!V.isCurrency(o.currency)) throw new Error('Invalid currency');
    if (!V.isWorkspaceId(o.workspaceId)) throw new Error('Invalid workspace ID');
    const freeList = FREE_SKUS.map((s) => "'" + s + "'").join(', ');
    const cte = `usage_scoped AS (
  SELECT u.record_id, u.account_id, u.workspace_id, u.sku_name, u.cloud, u.usage_unit,
         u.usage_start_time, u.usage_end_time, u.usage_date, u.usage_quantity, u.record_type,
         u.billing_origin_product, u.usage_metadata, u.product_features
  FROM ${usage} u
  WHERE u.workspace_id = :workspace_id
    AND u.usage_date >= :start_date AND u.usage_date < :end_date${o.extraWhere ? '\n    AND (' + o.extraWhere + ')' : ''}
),
record_prices AS (
  SELECT us.record_id,
         COUNT(p.sku_name) AS price_matches,
         MAX(TRY_CAST(${adapter.field} AS DOUBLE)) AS unit_price
  FROM usage_scoped us
  LEFT JOIN ${adapter.quoted} p
    ON p.account_id = us.account_id
   AND p.sku_name = us.sku_name
   AND p.cloud = us.cloud
   AND p.usage_unit = us.usage_unit
   AND p.currency_code = :currency
   AND us.usage_end_time >= p.price_start_time
   AND (p.price_end_time IS NULL OR us.usage_end_time < p.price_end_time)
  GROUP BY us.record_id
),
priced_usage AS (
  SELECT us.*,
         rp.price_matches,
         (us.sku_name IN (${freeList}) OR (rp.price_matches = 1 AND rp.unit_price IS NOT NULL)) AS is_priced,
         CASE WHEN us.sku_name IN (${freeList}) THEN CAST(0 AS DOUBLE)
              WHEN rp.price_matches = 1 AND rp.unit_price IS NOT NULL
              THEN CAST(us.usage_quantity AS DOUBLE) * rp.unit_price END AS cost,
         CASE WHEN us.sku_name IN (${freeList}) THEN CAST(us.usage_quantity AS DOUBLE) ELSE CAST(0 AS DOUBLE) END AS free_quantity
  FROM usage_scoped us
  JOIN record_prices rp ON rp.record_id = us.record_id
)`;
    const params = [
      param('workspace_id', o.workspaceId),
      param('start_date', o.startDate, 'DATE'),
      param('end_date', o.endDate, 'DATE'),
      param('currency', o.currency),
    ];
    return { cte, params, adapter };
  }

  /** Provenance carried through parsers, caches, responses, labels, tooltips and CSV. */
  function provenance(priceTable, currency) {
    const a = adapterFor(priceTable);
    return { pricingBasis: a.basis, priceTable: a.table, priceField: a.field.replace(/^p\./, ''), currency };
  }

  const api = Object.freeze({
    PRICE_TABLES,
    DEFAULT_PRICE_TABLE,
    FREE_SKUS,
    ADAPTER_VERSION,
    adapterFor,
    pricedUsageCte,
    provenance,
    param,
  });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).pricing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
