/*
 * Workspace summary: daily product/SKU aggregates for the selected complete UTC period and the
 * immediately preceding equal period, plus unpriced coverage and freshness. ≤ 20,000 rows.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const pricing = NODE ? require('../pricing.js') : root.DCC.pricing;
  const periods = NODE ? require('../../core/periods.js') : root.DCC.periods;

  const MAX_ROWS = 20000;

  /**
   * @param {object} conn validated connection
   * @param {number} periodDays 7|30|90
   * @param {number} nowMs
   */
  function build(conn, periodDays, nowMs = Date.now()) {
    const period = periods.completePeriod(periodDays, nowMs);
    const { cte, params } = pricing.pricedUsageCte({
      priceTable: conn.priceTable,
      usageSource: conn.usageSource,
      currency: conn.currency,
      workspaceId: conn.workspaceId,
      startDate: period.prevStart,
      endDate: period.endExclusive,
    });
    const statement = `WITH ${cte}
SELECT CASE WHEN usage_date >= :cur_start THEN 'cur' ELSE 'prev' END AS period,
       CAST(usage_date AS STRING) AS usage_date,
       COALESCE(billing_origin_product, 'UNKNOWN') AS product,
       sku_name,
       usage_unit,
       SUM(CASE WHEN is_priced THEN cost END) AS priced_cost,
       SUM(CASE WHEN is_priced THEN 1 ELSE 0 END) AS priced_records,
       SUM(CASE WHEN is_priced THEN 0 ELSE 1 END) AS unpriced_records,
       SUM(CASE WHEN is_priced THEN 0 WHEN price_matches > 1 THEN 1 ELSE 0 END) AS ambiguous_records,
       SUM(CAST(usage_quantity AS DOUBLE)) AS quantity,
       SUM(free_quantity) AS free_quantity,
       unix_millis(MAX(usage_end_time)) AS latest_usage_ms
FROM priced_usage
GROUP BY 1, 2, 3, 4, 5
ORDER BY 2, 3, 4`;
    params.push(pricing.param('cur_start', period.start, 'DATE'));
    return {
      kind: 'summary',
      statement,
      parameters: params,
      rowLimit: MAX_ROWS + 1,
      maxRows: MAX_ROWS,
      period,
      provenance: pricing.provenance(conn.priceTable, conn.currency),
    };
  }

  function emptyTotals() {
    return { pricedCost: 0, pricedRecords: 0, unpricedRecords: 0, ambiguousRecords: 0, unpricedSkus: new Set(), firstUnpriced: null, lastUnpriced: null };
  }

  /**
   * Coverage state:
   *   empty    — no usage records at all (not zero spend; display "No usage recorded")
   *   complete — every record priced → full total
   *   partial  — some priced, some not → "Priced subtotal" only
   *   none     — nothing priced → no subtotal
   */
  function finalizeTotals(t) {
    let coverage;
    if (t.pricedRecords + t.unpricedRecords === 0) coverage = 'empty';
    else if (t.unpricedRecords === 0) coverage = 'complete';
    else if (t.pricedRecords === 0) coverage = 'none';
    else coverage = 'partial';
    return {
      coverage,
      total: coverage === 'complete' ? t.pricedCost : null,
      pricedSubtotal: coverage === 'partial' ? t.pricedCost : null,
      pricedRecords: t.pricedRecords,
      unpricedRecords: t.unpricedRecords,
      ambiguousRecords: t.ambiguousRecords,
      unpricedSkus: [...t.unpricedSkus].sort(),
      firstUnpricedDate: t.firstUnpriced,
      lastUnpricedDate: t.lastUnpriced,
    };
  }

  /** Comparable amount for a period: full total, or priced subtotal when partial; null otherwise. */
  function shownAmount(t) {
    if (t.coverage === 'complete') return t.total;
    if (t.coverage === 'partial') return t.pricedSubtotal;
    return null;
  }

  /**
   * @param {object[]} rows parsed rows
   * @param {object} query the object returned by build()
   */
  function parse(rows, query) {
    const totals = { cur: emptyTotals(), prev: emptyTotals() };
    const daily = [];
    const free = {};
    let latest = null;
    for (const r of rows) {
      const t = totals[r.period === 'cur' ? 'cur' : 'prev'];
      const pricedCost = r.priced_cost === null ? 0 : r.priced_cost;
      t.pricedCost += pricedCost;
      t.pricedRecords += r.priced_records || 0;
      t.unpricedRecords += r.unpriced_records || 0;
      t.ambiguousRecords += r.ambiguous_records || 0;
      if (r.unpriced_records > 0) {
        t.unpricedSkus.add(r.sku_name);
        if (!t.firstUnpriced || r.usage_date < t.firstUnpriced) t.firstUnpriced = r.usage_date;
        if (!t.lastUnpriced || r.usage_date > t.lastUnpriced) t.lastUnpriced = r.usage_date;
      }
      if (r.free_quantity) free[r.sku_name] = (free[r.sku_name] || 0) + r.free_quantity;
      if (Number.isFinite(r.latest_usage_ms) && (latest === null || r.latest_usage_ms > latest)) latest = r.latest_usage_ms;
      daily.push({
        period: r.period,
        date: r.usage_date,
        product: r.product,
        sku: r.sku_name,
        unit: r.usage_unit,
        cost: r.priced_records > 0 ? pricedCost : null,
        complete: r.unpriced_records === 0,
        unpricedRecords: r.unpriced_records,
        quantity: r.quantity,
      });
    }
    const current = finalizeTotals(totals.cur);
    const previous = finalizeTotals(totals.prev);
    return Object.assign({}, query.provenance, {
      kind: 'summary',
      period: query.period,
      current,
      previous,
      currentAmount: shownAmount(current),
      previousAmount: shownAmount(previous),
      daily,
      freeQuantity: free,
      latestUsageMs: latest,
      rowCount: rows.length,
    });
  }

  const api = Object.freeze({ MAX_ROWS, build, parse, shownAmount });
  if (NODE) module.exports = api;
  else ((root.DCC || (root.DCC = {})).queries || (root.DCC.queries = {})).summary = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
