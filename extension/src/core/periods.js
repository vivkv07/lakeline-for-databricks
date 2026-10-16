/*
 * UTC period math. Reporting periods are complete UTC dates that exclude today; the comparison
 * period is the immediately preceding window of equal length. Lookback windows for run/query
 * search may include today and are reported separately.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const V = NODE ? require('./validate.js') : root.DCC.validate;
  const DAY_MS = 86400000;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function utcDate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  function dateToMs(date) {
    if (!DATE_RE.test(date)) throw new Error('Invalid UTC date');
    return Date.parse(date + 'T00:00:00.000Z');
  }

  function addDays(date, n) {
    return utcDate(dateToMs(date) + n * DAY_MS);
  }

  function daysBetween(start, endExclusive) {
    return Math.round((dateToMs(endExclusive) - dateToMs(start)) / DAY_MS);
  }

  /** Dates from start (inclusive) to endExclusive. */
  function enumerateDates(start, endExclusive) {
    const out = [];
    for (let d = start; d < endExclusive; d = addDays(d, 1)) out.push(d);
    return out;
  }

  /**
   * @param {number} days 7 | 30 | 90
   * @param {number} nowMs
   * @returns {{days, start, endExclusive, prevStart, prevEndExclusive, today}}
   */
  function completePeriod(days, nowMs = Date.now()) {
    if (!V.isPeriodDays(days)) throw new Error('Unsupported period');
    const today = utcDate(nowMs);
    const endExclusive = today;
    const start = addDays(endExclusive, -days);
    return { days, start, endExclusive, prevStart: addDays(start, -days), prevEndExclusive: start, today };
  }

  /** Lookback window of N UTC dates ending today (inclusive), e.g. 365 for run search, 90 for query history. */
  function lookback(days, nowMs = Date.now(), includeToday = true) {
    const today = utcDate(nowMs);
    const endExclusive = includeToday ? addDays(today, 1) : today;
    return { days, start: addDays(endExclusive, -days), endExclusive };
  }

  /** Map a current-period date to its aligned prior-period date (same offset). */
  function alignedPriorDate(date, period) {
    return addDays(date, -period.days);
  }

  /** Human label: "Sep 15 – Oct 14, 2026 (UTC)" (end shown inclusive). */
  function periodLabel(start, endExclusive) {
    const fmt = (d, withYear) => {
      const dt = new Date(dateToMs(d));
      const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
      if (withYear) opts.year = 'numeric';
      return dt.toLocaleDateString('en-US', opts);
    };
    const lastDay = addDays(endExclusive, -1);
    return fmt(start, false) + ' – ' + fmt(lastDay, true) + ' (UTC)';
  }

  /** Freshness age label for the latest observed usage timestamp. */
  function ageLabel(latestMs, nowMs = Date.now()) {
    if (!Number.isFinite(latestMs)) return 'No usage observed';
    const mins = Math.max(0, Math.round((nowMs - latestMs) / 60000));
    if (mins < 90) return 'Latest usage ' + mins + ' min ago';
    const hours = Math.round(mins / 60);
    if (hours < 48) return 'Latest usage ' + hours + ' h ago';
    return 'Latest usage ' + Math.round(hours / 24) + ' d ago';
  }

  /** ISO weekday with Monday = 0 … Sunday = 6 for a UTC date. */
  function mondayIndex(date) {
    return (new Date(dateToMs(date)).getUTCDay() + 6) % 7;
  }

  const api = Object.freeze({
    DAY_MS,
    utcDate,
    dateToMs,
    addDays,
    daysBetween,
    enumerateDates,
    completePeriod,
    lookback,
    alignedPriorDate,
    periodLabel,
    ageLabel,
    mondayIndex,
  });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).periods = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
