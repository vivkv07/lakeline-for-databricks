/*
 * Deterministic SYNTHETIC demo data. Every object carries pricingBasis 'demo' and synthetic:true
 * so the UI labels it DEMO. Makes no network requests.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const periods = NODE ? require('./periods.js') : root.DCC.periods;

  // Small deterministic PRNG (mulberry32) seeded from strings.
  function seedOf(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

  const PRODUCTS = [
    { product: 'JOBS', sku: 'PREMIUM_JOBS_SERVERLESS_COMPUTE_US_EAST', base: 42 },
    { product: 'SQL', sku: 'PREMIUM_SERVERLESS_SQL_COMPUTE_US_EAST', base: 31 },
    { product: 'ALL_PURPOSE', sku: 'PREMIUM_ALL_PURPOSE_COMPUTE', base: 18 },
    { product: 'DLT', sku: 'PREMIUM_DLT_ADVANCED_COMPUTE', base: 12 },
    { product: 'MODEL_SERVING', sku: 'PREMIUM_SERVERLESS_REAL_TIME_INFERENCE', base: 6 },
    { product: 'APPS', sku: 'PREMIUM_APPS_US_EAST', base: 2.5 },
  ];

  function summary(origin, workspaceId, periodDays, nowMs = Date.now()) {
    const period = periods.completePeriod(periodDays, nowMs);
    const r = rng(seedOf(origin + '|' + workspaceId));
    const daily = [];
    let cur = 0;
    let prev = 0;
    for (const date of periods.enumerateDates(period.prevStart, period.endExclusive)) {
      const isCur = date >= period.start;
      const weekday = periods.mondayIndex(date);
      const weekendFactor = weekday >= 5 ? 0.45 : 1;
      for (const p of PRODUCTS) {
        const cost = round(p.base * weekendFactor * (0.7 + r() * 0.6) * (isCur ? 1.06 : 1), 4);
        if (isCur) cur += cost;
        else prev += cost;
        daily.push({ period: isCur ? 'cur' : 'prev', date, product: p.product, sku: p.sku, unit: 'DBU', cost, complete: true, unpricedRecords: 0, quantity: round(cost / 0.55, 3) });
      }
    }
    const totals = (v) => ({ coverage: 'complete', total: round(v, 4), pricedSubtotal: null, pricedRecords: 1, unpricedRecords: 0, ambiguousRecords: 0, unpricedSkus: [], firstUnpricedDate: null, lastUnpricedDate: null });
    return {
      kind: 'summary',
      synthetic: true,
      pricingBasis: 'demo',
      priceTable: null,
      priceField: null,
      currency: 'USD',
      period,
      current: totals(cur),
      previous: totals(prev),
      currentAmount: round(cur, 4),
      previousAmount: round(prev, 4),
      daily,
      freeQuantity: {},
      latestUsageMs: nowMs - 3 * 3600 * 1000,
      rowCount: daily.length,
    };
  }

  /** Synthetic per-resource / per-run amounts keyed by refKey. */
  function rowAmounts(refs, periodDays) {
    const items = {};
    for (const ref of refs) {
      const key = ref.key;
      const r = rng(seedOf(key + '|' + periodDays));
      const scale = /run|update|statement/.test(ref.type) ? 3 : 40 * (periodDays / 30);
      items[key] = {
        key,
        status: 'ok',
        amount: round(scale * (0.05 + r()), 4),
        scope: /run|update/.test(ref.type) ? 'execution' : 'period',
        attribution: 'demo',
        warnings: [],
      };
    }
    return { synthetic: true, pricingBasis: 'demo', currency: 'USD', items };
  }

  const api = Object.freeze({ summary, rowAmounts, rng, seedOf });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).demo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
