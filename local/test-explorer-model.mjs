// Explorer model, heuristics, links, data client and demo data. Pure Node unit tests (no DOM,
// no SQL); the data-client tests use a stubbed workspace-data `query` (SIMULATED messaging).
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './support/load.mjs';

const M = load('explorer/explore-model.js');
const D = load('explorer/explore-data.js');
const demo = load('explorer/explore-demo.js');
const periods = load('core/periods.js');

const NOW = Date.parse('2026-10-15T12:00:00Z'); // 7d: 2026-10-08..14, prior 2026-10-01..07
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} expected ${b}, got ${a}`);

function summaryOf(daily, extra = {}) {
  const days = extra.days || 7;
  return Object.assign({ kind: 'summary', pricingBasis: 'list', priceTable: 'system.billing.list_prices', currency: 'USD', period: periods.completePeriod(days, NOW), latestUsageMs: NOW - 3600e3, daily }, extra);
}
const row = (period, date, product, sku, cost, unpriced = 0) => ({ period, date, product, sku, unit: 'DBU', cost, complete: unpriced === 0, unpricedRecords: unpriced, quantity: 1 });

test('aggregation keeps missing dates unavailable, flags partial and unpriced days, aligns prior days', () => {
  const s = summaryOf([
    row('cur', '2026-10-08', 'JOBS', 'A', 10),
    row('cur', '2026-10-08', 'SQL', 'B', 5),
    row('cur', '2026-10-09', 'JOBS', 'A', 4, 2), // partial
    row('cur', '2026-10-10', 'JOBS', 'A', null, 3), // unpriced only
    row('prev', '2026-10-01', 'JOBS', 'A', 8),
    row('prev', '2026-10-01', 'SQL', 'B', 2),
    row('prev', '2026-09-01', 'JOBS', 'A', 999), // outside both windows: dropped
  ]);
  const m = M.normalize(s, { nowMs: NOW });
  assert.equal(m.rows.length, 6);
  const series = M.dailySeries(m, {});
  assert.equal(series.length, 7);
  const byDate = Object.fromEntries(series.map((d) => [d.date, d]));
  assert.equal(byDate['2026-10-08'].cost, 15);
  assert.equal(byDate['2026-10-08'].status, 'complete');
  assert.equal(byDate['2026-10-08'].priorDate, '2026-10-01');
  assert.equal(byDate['2026-10-08'].priorDate, periods.alignedPriorDate('2026-10-08', m.period));
  assert.equal(byDate['2026-10-08'].prior.cost, 10);
  close(byDate['2026-10-08'].change.pct, 50);
  assert.equal(byDate['2026-10-09'].status, 'partial');
  assert.equal(byDate['2026-10-09'].cost, 4);
  assert.equal(byDate['2026-10-10'].status, 'unpriced');
  assert.equal(byDate['2026-10-10'].cost, null);
  for (const d of ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']) {
    assert.equal(byDate[d].status, 'unavailable', d);
    assert.equal(byDate[d].cost, null, d + ' must not be zero');
    assert.equal(byDate[d].prior.status, 'unavailable');
  }
  const totals = M.periodTotals(m, {});
  assert.equal(totals.current.status, 'partial');
  assert.equal(totals.missingDates, 4);
  assert.equal(totals.share.valid, false);
  assert.match(totals.share.reason, /priced subtotal/);
});

test('filters, group totals (prior-only keys kept as no-usage) and day detail', () => {
  const s = summaryOf([
    row('cur', '2026-10-08', 'JOBS', 'A', 6),
    row('cur', '2026-10-08', 'JOBS', 'A2', 2),
    row('cur', '2026-10-09', 'SQL', 'B', 2),
    row('prev', '2026-10-01', 'JOBS', 'A', 4),
    row('prev', '2026-10-02', 'DLT', 'C', 3),
  ]);
  const m = M.normalize(s, { nowMs: NOW });
  const g = M.groupTotals(m, 'product', {});
  const jobs = g.items.find((i) => i.key === 'JOBS');
  assert.equal(jobs.cost, 8);
  assert.equal(jobs.prevCost, 4);
  close(jobs.share, 0.8);
  const dlt = g.items.find((i) => i.key === 'DLT');
  assert.equal(dlt.status, 'no-usage');
  assert.equal(dlt.cost, null);
  assert.equal(dlt.share, null);
  const skus = M.groupTotals(m, 'sku', { product: 'JOBS' });
  assert.deepEqual(skus.items.map((i) => i.key).sort(), ['A', 'A2']);
  close(skus.items.find((i) => i.key === 'A').share, 0.75);
  const series = M.dailySeries(m, { sku: 'A' });
  assert.equal(series.find((d) => d.date === '2026-10-08').cost, 6);
  assert.equal(series.find((d) => d.date === '2026-10-09').status, 'unavailable');
  const dd = M.dayDetail(m, '2026-10-08', {}, 'product');
  assert.equal(dd.priorDate, '2026-10-01');
  assert.equal(dd.current.cost, 8);
  assert.equal(dd.prior.cost, 4);
  assert.equal(dd.items.find((i) => i.key === 'JOBS').prevCost, 4);
});

test('sort by cost/change/name asc/desc keeps missing values last', () => {
  const items = [
    { name: 'b', cost: 5, change: { abs: -2 } },
    { name: 'a', cost: null, change: null },
    { name: 'c', cost: 9, change: { abs: 4 } },
    { name: 'd', cost: -1, change: { abs: 0 } },
  ];
  const names = (sort) => M.sortItems(items, sort).map((i) => i.name).join('');
  assert.equal(names({ key: 'cost', dir: 'desc' }), 'cbda');
  assert.equal(names({ key: 'cost', dir: 'asc' }), 'dbca');
  assert.equal(names({ key: 'change', dir: 'desc' }), 'cdba');
  assert.equal(names({ key: 'change', dir: 'asc' }), 'bdca');
  assert.equal(names({ key: 'name', dir: 'asc' }), 'abcd');
  assert.equal(names({ key: 'name', dir: 'desc' }), 'dcba');
  assert.deepEqual(M.search(items, 'B', ['name']).map((i) => i.name), ['b']);
});

test('share of total only for complete, positive totals', () => {
  assert.equal(M.shareValidity({ cost: 10, status: 'complete' }).valid, true);
  assert.equal(M.shareValidity({ cost: 10, status: 'partial' }).valid, false);
  assert.equal(M.shareValidity({ cost: -3, status: 'complete' }).valid, false);
  assert.equal(M.shareValidity({ cost: null, status: 'unavailable' }).valid, false);
  assert.equal(M.shareOf(5, { valid: true, total: 20 }), 0.25);
  assert.equal(M.shareOf(5, { valid: false }), null);
});

test('calendar is Monday-first UTC with unavailable (not zero) missing dates', () => {
  const s = summaryOf([row('cur', '2026-10-08', 'JOBS', 'A', 3), row('cur', '2026-10-12', 'JOBS', 'A', 7)]);
  const m = M.normalize(s, { nowMs: NOW });
  const cal = M.calendar(m, M.dailySeries(m, {}));
  assert.deepEqual(cal.weekdayLabels, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  // 2026-10-08 is a Thursday, so the first grid row starts on Monday 2026-10-05.
  assert.equal(cal.weeks[0][0].date, '2026-10-05');
  assert.equal(periods.mondayIndex(cal.weeks[0][0].date), 0);
  assert.equal(cal.weeks[0][0].inPeriod, false);
  assert.equal(cal.weeks[0][3].date, '2026-10-08');
  assert.equal(cal.weeks[0][3].cost, 3);
  const flat = cal.weeks.flat();
  assert.ok(cal.weeks.every((w) => w.length === 7));
  assert.equal(flat.filter((c) => c.inPeriod).length, 7);
  const oct9 = flat.find((c) => c.date === '2026-10-09');
  assert.equal(oct9.status, 'unavailable');
  assert.equal(oct9.cost, null);
  assert.equal(cal.max, 7);
  assert.equal(M.intensity(7, 7), 5);
  assert.equal(M.intensity(null, 7), 0);
  assert.equal(M.intensity(-2, 7), 0);
});

test('statistics: median, MAD and type-7 quantiles', () => {
  assert.equal(M.median([3, 1, 2]), 2);
  assert.equal(M.median([4, 1, 2, 3]), 2.5);
  assert.equal(M.mad([1, 2, 3, 4, 100]), 1);
  assert.equal(M.quantile([1, 2, 3, 4], 0.25), 1.75);
  assert.equal(M.quantile([1, 2, 3, 4], 0.75), 3.25);
  assert.equal(M.median([]), null);
});

function spikeFixture({ prevDays = 30, base = 10, weekdayBoost = {}, cur = {} } = {}) {
  const p = periods.completePeriod(30, NOW);
  const daily = [];
  periods.enumerateDates(p.prevStart, p.prevEndExclusive).slice(0, prevDays).forEach((d, i) => {
    const wd = periods.mondayIndex(d);
    daily.push(row('prev', d, 'JOBS', 'A', base + (weekdayBoost[wd] || 0) + (i % 3) * 0.5));
  });
  for (const d of periods.enumerateDates(p.start, p.endExclusive)) daily.push(row('cur', d, 'JOBS', 'A', cur[d] !== undefined ? cur[d] : base));
  return M.normalize(summaryOf(daily, { days: 30, period: p }), { nowMs: NOW });
}

test('spike heuristic: same-weekday baseline, MAX(median×1.5, median+3×MAD), partial days not flagged', () => {
  // Mondays cost ~40 in the prior period; a Monday at 45 is normal for Mondays, a Tuesday at 45 is a spike.
  const m = spikeFixture({ weekdayBoost: { 0: 30 }, cur: { '2026-10-05': 45, '2026-10-06': 45, '2026-10-07': 15 } });
  const res = M.spikeFlags(M.dailySeries(m, {}), M.priorDailySeries(m, {}), { latestUsageMs: m.latestUsageMs, nowMs: NOW });
  assert.equal(res.status, 'ok');
  assert.equal(periods.mondayIndex('2026-10-05'), 0);
  assert.ok(!res.flags.has('2026-10-05'), 'Monday compared with Mondays');
  const tue = res.flags.get('2026-10-06');
  assert.ok(tue, 'Tuesday spike flagged');
  assert.equal(tue.sampleKind, 'same-weekday');
  assert.ok(tue.samples >= 3);
  close(tue.threshold, Math.max(tue.median * 1.5, tue.median + 3 * tue.mad));
  assert.ok(!res.flags.has('2026-10-07'), '15 is below 1.5 × median ~10.5');
  // Exact threshold check against independently computed statistics.
  const prev = M.priorDailySeries(m, {}).filter((d) => d.weekday === 1).map((d) => d.cost);
  const med = M.median(prev);
  close(tue.threshold, Math.max(med * 1.5, med + 3 * M.mad(prev)));
});

test('spike heuristic falls back to all prior days when fewer than 3 same-weekday samples', () => {
  const p = periods.completePeriod(30, NOW);
  // 14 prior days only, all on Saturdays/Sundays is impossible in 14 consecutive days, so use a
  // sparse prior period: 14 priced days on Mon–Fri plus nothing on weekends.
  const daily = [];
  for (const d of periods.enumerateDates(p.prevStart, p.prevEndExclusive)) if (periods.mondayIndex(d) < 5) daily.push(row('prev', d, 'JOBS', 'A', 10));
  const sat = periods.enumerateDates(p.start, p.endExclusive).find((d) => periods.mondayIndex(d) === 5);
  daily.push(row('cur', sat, 'JOBS', 'A', 40));
  const m = M.normalize(summaryOf(daily, { days: 30, period: p }), { nowMs: NOW });
  const res = M.spikeFlags(M.dailySeries(m, {}), M.priorDailySeries(m, {}), { latestUsageMs: m.latestUsageMs, nowMs: NOW });
  assert.equal(res.flags.get(sat).sampleKind, 'all-prior');
});

test('spike heuristic is suppressed with <14 priced prior days, stale freshness, or a 7-day period', () => {
  const few = spikeFixture({ prevDays: 13, cur: { '2026-10-06': 99 } });
  const r1 = M.spikeFlags(M.dailySeries(few, {}), M.priorDailySeries(few, {}), { latestUsageMs: few.latestUsageMs, nowMs: NOW });
  assert.equal(r1.status, 'suppressed');
  assert.equal(r1.reason, 'history');
  assert.equal(r1.flags.size, 0);
  const ok = spikeFixture({ cur: { '2026-10-06': 99 } });
  const stale = M.spikeFlags(M.dailySeries(ok, {}), M.priorDailySeries(ok, {}), { latestUsageMs: NOW - 72 * 3600e3, nowMs: NOW });
  assert.equal(stale.status, 'suppressed');
  assert.equal(stale.reason, 'freshness');
  const none = M.spikeFlags(M.dailySeries(ok, {}), M.priorDailySeries(ok, {}), { latestUsageMs: null, nowMs: NOW });
  assert.equal(none.reason, 'freshness');
  const week = M.normalize(summaryOf([row('cur', '2026-10-08', 'JOBS', 'A', 100)]), { nowMs: NOW });
  assert.equal(M.spikeFlags(M.dailySeries(week, {}), M.priorDailySeries(week, {}), { latestUsageMs: NOW, nowMs: NOW }).status, 'suppressed');
  // Partial prior days do not count as priced history.
  const p = periods.completePeriod(30, NOW);
  const daily = periods.enumerateDates(p.prevStart, p.prevEndExclusive).map((d) => row('prev', d, 'JOBS', 'A', 10, 1));
  const partial = M.normalize(summaryOf(daily, { days: 30, period: p }), { nowMs: NOW });
  assert.equal(M.spikeFlags(M.dailySeries(partial, {}), M.priorDailySeries(partial, {}), { latestUsageMs: NOW, nowMs: NOW }).reason, 'history');
});

function run(jobId, i, amount, durationMs, extra = {}) {
  return Object.assign({ key: 'job_run:' + jobId + ':' + i, jobId, runId: String(i), amount, status: 'ok', durationMs, durationStatus: durationMs ? 'ok' : 'missing', resultState: durationMs ? 'SUCCEEDED' : null, cohortComplete: true }, extra);
}

test('high-cost run heuristic: Q3 + 1.5×IQR per job cohort with ≥8 eligible runs', () => {
  const costs = [1, 1.1, 0.9, 1.05, 1.2, 0.95, 1, 1.15, 5];
  const runs = costs.map((c, i) => run('7', i, c, 600000));
  const res = M.highCostRuns(runs);
  const q1 = M.quantile(costs, 0.25);
  const q3 = M.quantile(costs, 0.75);
  const cohort = res.cohorts.get('7');
  assert.equal(cohort.status, 'ok');
  close(cohort.fence, q3 + 1.5 * (q3 - q1));
  assert.deepEqual([...res.flags.keys()], ['job_run:7:8']);
});

test('high-cost run heuristic is suppressed for small or incomplete cohorts; unusable runs are excluded', () => {
  // 7 eligible + runs with missing duration, running, unpriced: not enough comparable runs.
  const runs = [1, 1, 1, 1, 1, 1, 9].map((c, i) => run('8', i, c, 60000));
  runs.push(run('8', 20, 50, null), run('8', 21, 60, 60000, { durationStatus: 'running', resultState: null }), run('8', 22, null, 60000, { status: 'unpriced' }), run('8', 23, 70, 60000, { status: 'partial' }));
  const res = M.highCostRuns(runs);
  assert.equal(res.cohorts.get('8').status, 'suppressed');
  assert.equal(res.cohorts.get('8').eligible, 7);
  assert.equal(res.flags.size, 0);
  const limited = [1, 1, 1, 1, 1, 1, 1, 1, 9].map((c, i) => run('9', i, c, 60000, { cohortComplete: false }));
  const r2 = M.highCostRuns(limited);
  assert.equal(r2.cohorts.get('9').status, 'suppressed');
  assert.match(r2.cohorts.get('9').reason, /incomplete/);
});

test('native links are built only from validated routes for this origin and workspace', () => {
  const O = 'https://dbc-1.cloud.databricks.com';
  assert.equal(M.nativeHref({ type: 'job_run', jobId: '12', runId: '34' }, O, '42'), O + '/jobs/12/runs/34?o=42');
  assert.equal(M.nativeHref({ type: 'job', jobId: '12' }, O, '42'), O + '/jobs/12?o=42');
  assert.equal(M.nativeHref({ type: 'pipeline', pipelineId: '0123abcd-0123-4567-89ab-0123456789ab' }, O, '42'), O + '/pipelines/0123abcd-0123-4567-89ab-0123456789ab?o=42');
  assert.equal(M.nativeHref({ type: 'warehouse', warehouseId: '0123456789abcdef' }, O, '42'), O + '/sql/warehouses/0123456789abcdef?o=42');
  assert.equal(M.nativeHref({ type: 'notebook', notebookId: '987' }, O, '42'), O + '/editor/notebooks/987?o=42');
  assert.equal(M.nativeHref({ type: 'app', appName: 'my-app' }, O, '42'), O + '/apps/my-app?o=42');
  for (const bad of [
    [{ type: 'job_run', jobId: '12', runId: '../x' }, O, '42'],
    [{ type: 'job', jobId: '12' }, 'https://evil.example', '42'],
    [{ type: 'job', jobId: '12' }, 'https://accounts.cloud.databricks.com', '42'],
    [{ type: 'job', jobId: '12' }, O, 'abc'],
    [{ type: 'app', appName: 'create' }, O, '42'],
    [{ type: 'cluster', clusterId: '0101-123456-abcdefgh' }, O, '42'],
    [null, O, '42'],
  ]) assert.equal(M.nativeHref(...bad), null, JSON.stringify(bad));
  assert.equal(M.entityRef({ ownerType: 'cluster', id: '0101-123456-abcdefgh' }), null);
  assert.equal(M.entityRef({ ownerType: 'app', id: 'a1b2', name: 'Not A Valid Name' }), null);
  assert.deepEqual(M.entityRef({ ownerType: 'app', id: 'a1b2', name: 'good-app' }), { type: 'app', appName: 'good-app' });
  assert.equal(M.entityRef({ ownerType: 'unattributed', id: null }), null);
});

test('colors follow the entity: stable slots by name, extras fold into Other', () => {
  const a = M.colorMap(['SQL', 'JOBS', 'DLT']);
  const b = M.colorMap(['DLT', 'SQL', 'JOBS']);
  assert.equal(a.colorOf('JOBS'), b.colorOf('JOBS'));
  const many = M.colorMap(Array.from({ length: 10 }, (_, i) => 'P' + i), new Map(Array.from({ length: 10 }, (_, i) => ['P' + i, i])));
  assert.equal(many.folded.length, 3);
  assert.ok(many.folded.includes('P0'));
  assert.equal(many.colorOf('P0'), M.OTHER_COLOR);
});

test('import summaries: rows re-dated into the period, coverageEnd respected, no prior daily', () => {
  const p = periods.completePeriod(7, NOW);
  const s = { kind: 'summary', imported: true, pricingBasis: 'import', currency: 'EUR', coverageEnd: '2026-10-12', daily: [{ period: 'cur', date: '2026-10-09', product: 'IMPORTED', sku: 'IMPORTED', cost: 3, complete: true }, { period: 'cur', date: '2026-10-10', product: 'IMPORTED', sku: 'IMPORTED', cost: null, complete: false }, { period: 'cur', date: '2026-10-13', product: 'IMPORTED', sku: 'IMPORTED', cost: 4, complete: true }] };
  const m = M.normalize(s, { periodDays: 7, nowMs: NOW });
  assert.equal(m.mode, 'import');
  assert.deepEqual(m.period, p);
  assert.equal(m.currency, 'EUR');
  assert.equal(m.hasPrior, false);
  const series = M.dailySeries(m, {});
  assert.equal(series.find((d) => d.date === '2026-10-09').cost, 3);
  assert.equal(series.find((d) => d.date === '2026-10-10').status, 'unavailable');
  assert.equal(series.find((d) => d.date === '2026-10-13').status, 'unavailable', 'after coverageEnd');
  assert.equal(series[0].prior.status, 'unavailable');
});

/* ------------------------------------------------------------------ data client (SIMULATED messaging) */

function fakeCtx(mode, respond) {
  const calls = [];
  return {
    calls,
    ctx: {
      origin: 'https://dbc-1.cloud.databricks.com',
      workspaceId: '42',
      settings: { mode, periodDays: 30 },
      connection: { priceTable: 'system.billing.list_prices', currency: 'USD' },
      data: {
        query: async (channel, kind, args, scope) => {
          calls.push({ channel, kind, args, scope });
          return respond(kind, args, scope);
        },
      },
    },
  };
}

test('data client: 5-minute cache, in-flight dedupe, force reload', async () => {
  let t = 1000;
  const client = D.create({ now: () => t });
  let release;
  const gate = new Promise((r) => (release = r));
  const { ctx, calls } = fakeCtx('connected', async () => {
    await gate;
    return { ok: true, data: { kind: 'exploreEntities', items: [], candidateCount: 0 } };
  });
  const args = { periodDays: 30 };
  const p1 = client.load(ctx, 'exploreEntities', args, 'entities');
  const p2 = client.load(ctx, 'exploreEntities', args, 'entities');
  assert.equal(p1, p2, 'deduped');
  release();
  const r1 = await p1;
  assert.equal(r1.status, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'exploreEntities');
  assert.equal(calls[0].args.periodDays, 30);
  t += 4 * 60 * 1000;
  const r2 = await client.load(ctx, 'exploreEntities', args, 'entities');
  assert.equal(r2.cached, true);
  assert.equal(calls.length, 1);
  assert.ok(client.peek(ctx, 'exploreEntities', args, 'entities'));
  t += 2 * 60 * 1000; // > 5 minutes
  assert.equal(client.peek(ctx, 'exploreEntities', args, 'entities'), null);
  await client.load(ctx, 'exploreEntities', args, 'entities');
  assert.equal(calls.length, 2);
  await client.load(ctx, 'exploreEntities', args, 'entities', { force: true });
  assert.equal(calls.length, 3);
  // Different scope/period is a different key.
  await client.load(ctx, 'exploreRuns', { periodDays: 30, jobId: '5' }, 'runs:job:5');
  assert.equal(calls.length, 4);
  assert.throws(() => client.load(ctx, 'exploreRuns', { periodDays: 30, jobId: '5; DROP' }, 'x'));
  assert.throws(() => client.load(ctx, 'summary', { periodDays: 30 }, 'x'));
});

test('data client: demo → synthetic without a request; import → unavailable; errors, paused and stale pass through', async () => {
  const client = D.create();
  const d = fakeCtx('demo', () => assert.fail('no request in demo mode'));
  const r = await client.load(d.ctx, 'exploreEntities', { periodDays: 30 }, 'entities', { summary: { synthetic: true, pricingBasis: 'demo', latestUsageMs: NOW } });
  assert.equal(r.status, 'ok');
  assert.equal(r.value.synthetic, true);
  assert.equal(r.value.pricingBasis, 'demo');
  assert.equal(d.calls.length, 0);
  const i = fakeCtx('import', () => assert.fail('no request in import mode'));
  assert.deepEqual(await client.load(i.ctx, 'exploreRuns', { periodDays: 30 }, 'runs', { summary: { imported: true, pricingBasis: 'import' } }), { status: 'unavailable', mode: 'import' });
  // Settings say connected but the router answers for another mode.
  const routed = fakeCtx('connected', () => ({ ok: true, data: { unavailableInMode: 'demo' } }));
  const rd = await client.load(routed.ctx, 'exploreRuns', { periodDays: 7 }, 'runs');
  assert.equal(rd.status, 'ok');
  assert.equal(rd.value.synthetic, true);
  const routedImport = fakeCtx('connected', () => ({ ok: true, data: { unavailableInMode: 'import' } }));
  assert.equal((await client.load(routedImport.ctx, 'exploreRuns', { periodDays: 7 }, 'runs2')).status, 'unavailable');
  const err = fakeCtx('connected', () => ({ ok: false, error: { code: 'BILLING_ACCESS_DENIED', title: 't', steps: [] } }));
  const re = await client.load(err.ctx, 'exploreEntities', { periodDays: 7 }, 'e');
  assert.equal(re.status, 'error');
  assert.equal(re.error.code, 'BILLING_ACCESS_DENIED');
  const again = await client.load(err.ctx, 'exploreEntities', { periodDays: 7 }, 'e');
  assert.equal(err.calls.length, 2, 'errors are not cached');
  assert.equal(again.status, 'error');
  assert.equal((await client.load(fakeCtx('connected', () => ({ ok: true, data: { paused: true } })).ctx, 'exploreEntities', { periodDays: 7 }, 'p')).status, 'paused');
  assert.equal((await client.load(fakeCtx('connected', () => ({ stale: true })).ctx, 'exploreEntities', { periodDays: 7 }, 's')).status, 'stale');
});

test('demo Explorer data is synthetic, deterministic and discloses the 200 limit', () => {
  const a = demo.entities('https://dbc-1.cloud.databricks.com', '42', 30, NOW);
  const b = demo.entities('https://dbc-1.cloud.databricks.com', '42', 30, NOW);
  assert.deepEqual(a, b);
  assert.equal(a.synthetic, true);
  assert.equal(a.pricingBasis, 'demo');
  assert.equal(a.items.length, 200);
  assert.equal(a.limited, true);
  assert.ok(a.candidateCount > 200);
  for (let i = 1; i < a.items.length; i++) assert.ok(a.items[i - 1].amount >= a.items[i].amount);
  const runs = demo.runs('https://dbc-1.cloud.databricks.com', '42', 30, NOW, '900001');
  assert.equal(runs.synthetic, true);
  assert.ok(runs.items.every((r) => r.jobId === '900001'));
  assert.ok(runs.items.some((r) => r.durationStatus !== 'ok' && r.durationMs === null), 'some durations missing, never zero');
  assert.ok(runs.items.every((r) => r.durationMs === null || r.durationMs > 0));
});
