/*
 * Money formatting and the vocabulary that keeps estimate kinds distinct: recorded attributed
 * costs, allocated query estimates, prospective hourly rates, priced subtotals, imported data
 * and synthetic demo figures. Missing values are never rendered as zero.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;

  const DISCLAIMER = 'Estimated costs. Billing can be delayed; final invoices may differ.';

  const BASIS = Object.freeze({
    list: {
      short: 'List price',
      note: 'Uses system.billing.list_prices (effective list). Private discounts are excluded. Cloud-provider charges are excluded.',
    },
    account: {
      short: 'Account price',
      note: 'Uses system.billing.account_prices. Invoice adjustments not in that table are not modeled. Cloud-provider charges are excluded.',
    },
    import: {
      short: 'Imported',
      note: 'From a local costs.json import. Contains only the summaries that were imported — no query history or run detail.',
    },
    demo: {
      short: 'DEMO',
      note: 'Synthetic demo figures. Not connected to Databricks.',
    },
  });

  /** Estimate kinds and their suffix labels. */
  const KIND = Object.freeze({
    recorded: 'est.',
    allocated: 'approx.',
    rate: 'DBU only',
    subtotal: 'priced subtotal',
  });

  function isMissing(v) {
    return v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v));
  }

  /**
   * Format an amount. Small nonzero amounts keep up to six decimals so a $0.000412 query is not
   * shown as $0.00. Negative values (corrections) keep their sign.
   */
  function formatAmount(value, currency = 'USD', opts = {}) {
    if (isMissing(value)) return null;
    const abs = Math.abs(value);
    let digits = 2;
    if (abs !== 0 && abs < 0.01) digits = 6;
    else if (abs !== 0 && abs < 1 && opts.precise) digits = 4;
    if (opts.compact && abs >= 10000) {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(value);
    }
    let text = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits === 6 ? 2 : digits,
      maximumFractionDigits: digits,
    }).format(value);
    if (abs !== 0 && Number(value.toFixed(digits)) === 0) text = (value < 0 ? '−' : '') + '<' + formatAmount(Math.pow(10, -digits), currency);
    return text;
  }

  function formatChange(current, previous) {
    if (isMissing(current) || isMissing(previous)) return { text: 'No comparison', pct: null };
    if (previous === 0) return { text: current === 0 ? 'No change' : 'New spend', pct: null };
    const pct = ((current - previous) / Math.abs(previous)) * 100;
    const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
    return { text: sign + Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0) + '% vs prior', pct };
  }

  function formatQuantity(q, unit) {
    if (isMissing(q)) return null;
    const n = new Intl.NumberFormat('en-US', { maximumFractionDigits: Math.abs(q) < 1 ? 4 : 2 }).format(q);
    return unit ? n + ' ' + unit : n;
  }

  function formatDuration(ms) {
    if (isMissing(ms) || ms < 0) return null;
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  const api = Object.freeze({ DISCLAIMER, BASIS, KIND, isMissing, formatAmount, formatChange, formatQuantity, formatDuration });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).labels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
