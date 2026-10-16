/*
 * SYNTHETIC Explorer data for Demo mode. Deterministic per workspace and period, makes no
 * network requests, and every result carries synthetic:true and pricingBasis 'demo' so the UI
 * labels it DEMO. Shapes match the exploreSummary / exploreEntities / exploreRuns results.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const periods = dep('periods', '../core/periods.js');

  const ENTITY_LIMIT = 200;
  const RUN_LIMIT = 500;

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
  const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
  const hex = (r, n) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');

  function base(period, nowMs) {
    return {
      synthetic: true,
      pricingBasis: 'demo',
      priceTable: null,
      priceField: null,
      currency: 'USD',
      period,
      latestUsageMs: nowMs - 3 * 3600 * 1000,
      freshness: { latestUsageMs: nowMs - 3 * 3600 * 1000, observedAtMs: nowMs },
    };
  }

  const DEMO_JOB_BASE = 900001;
  const TYPE_PLAN = [
    ['job', 92],
    ['notebook', 58],
    ['cluster', 44],
    ['pipeline', 20],
    ['warehouse', 8],
    ['app', 7],
    ['unattributed', 1],
  ];

  function demoId(type, i, r) {
    switch (type) {
      case 'job': return String(DEMO_JOB_BASE + i);
      case 'notebook': return String(4400000000 + i * 37);
      case 'cluster': return '0918-' + String(100000 + i * 7).slice(0, 6) + '-demo' + hex(r, 4);
      case 'pipeline': return hex(r, 8) + '-' + hex(r, 4) + '-4' + hex(r, 3) + '-8' + hex(r, 3) + '-' + hex(r, 12);
      case 'warehouse': return hex(r, 16);
      case 'app': return 'demo-app-' + (i + 1);
      default: return null;
    }
  }

  function demoName(type, i) {
    switch (type) {
      case 'job': return 'demo_job_' + String(i + 1).padStart(3, '0');
      case 'notebook': return '/Users/demo.user@example.com/demo-notebook-' + (i + 1);
      case 'app': return 'demo-app-' + (i + 1);
      default: return null;
    }
  }

  /** Ranked synthetic owners (230 candidates → top 200 returned, to show the limit disclosure). */
  function entities(origin, workspaceId, periodDays, nowMs = Date.now()) {
    const period = periods.completePeriod(periodDays, nowMs);
    const r = rng(seedOf('entities|' + origin + '|' + workspaceId + '|' + periodDays));
    const scale = periodDays / 30;
    const all = [];
    for (const [type, count] of TYPE_PLAN) {
      for (let i = 0; i < count; i++) {
        const weight = type === 'unattributed' ? 0.6 : 1 / Math.pow(i + 1.5, 0.85);
        const typeBase = { job: 260, notebook: 120, cluster: 140, pipeline: 150, warehouse: 300, app: 40, unattributed: 30 }[type];
        const amount = round(typeBase * weight * scale * (0.6 + r() * 0.8));
        const isNew = r() < 0.08;
        const prev = isNew ? null : round(amount * (0.6 + r() * 0.8));
        const id = demoId(type, i, r);
        all.push({
          key: type + ':' + (id === null ? '-' : id),
          ownerType: type,
          id,
          name: demoName(type, i),
          nameSource: { job: 'job_name', notebook: 'notebook_path', app: 'app_name' }[type] || null,
          amount,
          status: 'ok',
          pricedRecords: 1,
          unpricedRecords: 0,
          prevAmount: prev,
          prevStatus: isNew ? 'no-usage' : 'ok',
          activeDays: Math.max(1, Math.round(periodDays * (0.3 + r() * 0.7))),
          latestUsageMs: nowMs - Math.round(r() * 48) * 3600 * 1000,
          scope: 'period',
          attribution: 'demo',
          warnings: [],
        });
      }
    }
    all.sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key));
    const total = all.reduce((s, e) => s + e.amount, 0);
    return Object.assign(base(period, nowMs), {
      kind: 'exploreEntities',
      limit: ENTITY_LIMIT,
      candidateCount: all.length,
      limited: all.length > ENTITY_LIMIT,
      totals: { coverage: 'complete', amount: round(total), pricedRecords: all.length, unpricedRecords: 0 },
      items: all.slice(0, ENTITY_LIMIT),
    });
  }

  function runsForJob(jobId, jobName, period, nowMs, r) {
    const startMs = periods.dateToMs(period.start);
    const spanMs = periods.dateToMs(period.endExclusive) - startMs;
    const n = 9 + Math.floor(r() * 26);
    const rate = 0.6 + r() * 2.5; // $ per hour
    const typical = (8 + r() * 50) * 60000;
    const out = [];
    for (let i = 0; i < n; i++) {
      let duration = Math.round(typical * (0.7 + r() * 0.6));
      if (r() < 0.07) duration = Math.round(duration * (2.5 + r() * 2));
      // A few runs share an identical duration and cost to demonstrate overlap selection.
      if (i > 0 && i % 11 === 0) duration = out[i - 1].durationMs || duration;
      const amount = round((duration / 3600000) * rate * (0.95 + r() * 0.1));
      const start = startMs + Math.floor(r() * (spanMs - duration));
      const roll = r();
      const status = roll < 0.05 ? 'missing' : roll < 0.08 ? 'running' : 'ok';
      const run = {
        key: 'job_run:' + jobId + ':' + String(Number(jobId) * 1000 + i),
        jobId,
        runId: String(Number(jobId) * 1000 + i),
        jobName,
        amount: i > 0 && i % 11 === 0 ? out[i - 1].amount : amount,
        status: 'ok',
        pricedRecords: 1,
        unpricedRecords: 0,
        firstUsageMs: start,
        lastUsageMs: start + duration,
        cohortRuns: n,
        cohortComplete: true,
        startMs: status === 'missing' ? null : start,
        endMs: status === 'missing' ? null : start + duration,
        durationMs: status === 'ok' ? duration : null,
        resultState: status === 'ok' ? (r() < 0.9 ? 'SUCCEEDED' : 'FAILED') : null,
        durationStatus: status,
        scope: 'period',
        attribution: 'demo',
        warnings: status === 'missing' ? [{ code: 'DURATION_MISSING', text: 'No run timeline found for this run; duration unavailable.' }] : status === 'running' ? [{ code: 'RUN_NOT_FINISHED', text: 'Run has no final state in the timeline yet; duration not final.' }] : [],
      };
      out.push(run);
    }
    return out;
  }

  /** Synthetic per-run costs; jobId narrows to one job (any numeric ID gets runs). */
  function runs(origin, workspaceId, periodDays, nowMs = Date.now(), jobId = null) {
    const period = periods.completePeriod(periodDays, nowMs);
    const jobs = jobId ? [jobId] : Array.from({ length: 7 }, (_, i) => String(DEMO_JOB_BASE + i));
    let items = [];
    for (const id of jobs) {
      const idx = Number(id) - DEMO_JOB_BASE;
      const name = idx >= 0 && idx < 92 ? demoName('job', idx) : null;
      items = items.concat(runsForJob(id, name, period, nowMs, rng(seedOf('runs|' + origin + '|' + workspaceId + '|' + periodDays + '|' + id))));
    }
    items.sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key));
    const candidateCount = items.length;
    return Object.assign(base(period, nowMs), {
      kind: 'exploreRuns',
      jobId: jobId || null,
      limit: RUN_LIMIT,
      candidateCount,
      limited: candidateCount > RUN_LIMIT,
      durationStatus: 'ok',
      durationError: null,
      durationLookbackDays: 30,
      warnings: [
        { code: 'PERIOD_SCOPED', text: 'Run amounts include only billing recorded in the selected period (' + periods.periodLabel(period.start, period.endExclusive) + '). A run that started earlier or continued later has a different lifetime cost.' },
      ],
      items: items.slice(0, RUN_LIMIT),
    });
  }

  const OWNER_SPLIT = Object.freeze({
    JOBS: [['job', 1]],
    SQL: [['warehouse', 1]],
    ALL_PURPOSE: [['notebook', 0.55], ['cluster', 0.45]],
    DLT: [['pipeline', 1]],
    APPS: [['app', 1]],
  });

  /** Ownership breakdown derived from the synthetic banner summary rows. */
  function ownerSummary(summary) {
    if (!summary || !summary.period) return null;
    const daily = [];
    for (const row of (summary && summary.daily) || []) {
      const split = OWNER_SPLIT[row.product] || [['unattributed', 1]];
      for (const [owner, f] of split) {
        daily.push(Object.assign({}, row, { owner, cost: row.cost === null ? null : round(row.cost * f, 6), quantity: row.quantity === null || row.quantity === undefined ? null : round(row.quantity * f, 6) }));
      }
    }
    return Object.assign({}, base(summary.period, (summary.latestUsageMs || Date.now()) + 3 * 3600 * 1000), {
      kind: 'exploreSummary',
      coverage: { current: 'complete', previous: 'complete' },
      daily,
      latestUsageMs: summary.latestUsageMs,
      rowCount: daily.length,
    });
  }

  const api = Object.freeze({ entities, runs, ownerSummary, seedOf, rng });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).exploreDemo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
