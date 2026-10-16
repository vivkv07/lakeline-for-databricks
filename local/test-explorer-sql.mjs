// Explorer query kinds executed on the SIMULATED DuckDB engine (support/sqlengine.mjs). This checks
// query logic (exclusive ownership, limits, run durations, both price tables); it is not proof of
// Databricks compatibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './support/load.mjs';
import { createEngine, usageRow, listPrice, accountPrice, WS } from './support/sqlengine.mjs';

const result = load('databricks/result.js');
const registry = load('databricks/queries/index.js');
const explore = load('databricks/queries/explore.js');
const errors = load('errors.js');

const NOW = Date.parse('2026-10-15T12:00:00Z'); // 7d period: 2026-10-08..14, prior 2026-10-01..07
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} expected ${b}, got ${a}`);
const conn = (priceTable = 'system.billing.list_prices') => ({
  origin: 'https://dbc-1.cloud.databricks.com', workspaceId: WS, authMode: 'pat', priceTable,
  usageSource: 'system.billing.usage', historySource: 'system.query.history', currency: 'USD',
});

/** Executor that mirrors the PAT path: Statement API response → result.parseResult (row caps). */
function executor(db, opts = {}) {
  const seen = [];
  const exec = async (q) => {
    seen.push(q);
    if (opts.failTimeline && /job_run_timeline/.test(q.statement)) {
      throw new errors.DccError({ errorCode: 'PERMISSION_DENIED', message: 'User does not have SELECT on system.lakeflow.job_run_timeline' });
    }
    const res = await db.execute({ statement: q.statement, parameters: q.parameters, row_limit: q.rowLimit });
    return result.parseResult(res, { maxRows: q.maxRows }).rows;
  };
  return { exec, seen };
}

async function priced(db, table = 'system.billing.list_prices', price = 0.5) {
  await db.insert(table.replace('system.', ''), [(table.endsWith('list_prices') ? listPrice : accountPrice)({ price })]);
}

test('registry resolves the three explore kinds from one module', () => {
  for (const k of ['exploreSummary', 'exploreEntities', 'exploreRuns']) assert.equal(registry.get(k), explore.kinds[k]);
  assert.equal(typeof explore.kinds.exploreRuns.run, 'function');
  assert.equal(typeof explore.kinds.exploreSummary.build, 'function');
});

test('exploreSummary: exclusive ownership per record in priority job > pipeline > warehouse > notebook > app > cluster > unattributed', async () => {
  const db = await createEngine();
  await priced(db);
  const d = '2026-10-10';
  await db.insert('billing.usage', [
    usageRow({ date: d, qty: 2, job_id: '1', job_run_id: '11', pipeline_id: 'p', warehouse_id: 'w', notebook_id: '5', app_id: 'a', cluster_id: 'c' }),
    usageRow({ date: d, qty: 4, pipeline_id: 'p', warehouse_id: 'w', notebook_id: '5', cluster_id: 'c' }),
    usageRow({ date: d, qty: 6, warehouse_id: 'w', notebook_id: '5', cluster_id: 'c' }),
    usageRow({ date: d, qty: 8, notebook_id: '5', app_id: 'a', cluster_id: 'c' }),
    usageRow({ date: d, qty: 10, app_name: 'my-app', cluster_id: 'c' }),
    usageRow({ date: d, qty: 12, cluster_id: 'c' }),
    usageRow({ date: d, qty: 14 }),
    usageRow({ date: '2026-10-03', qty: 20, job_id: '1' }),
  ]);
  const { exec } = executor(db);
  const s = await registry.run('exploreSummary', { conn: conn(), args: { periodDays: 7 }, nowMs: NOW, exec });
  const cur = Object.fromEntries(s.daily.filter((r) => r.period === 'cur').map((r) => [r.owner, r.cost]));
  assert.deepEqual(cur, { job: 1, pipeline: 2, warehouse: 3, notebook: 4, app: 5, cluster: 6, unattributed: 7 });
  const total = s.daily.filter((r) => r.period === 'cur').reduce((a, r) => a + r.cost, 0);
  close(total, 0.5 * (2 + 4 + 6 + 8 + 10 + 12 + 14), 'each record counted exactly once');
  assert.equal(s.daily.find((r) => r.period === 'prev').owner, 'job');
  assert.equal(s.pricingBasis, 'list');
  assert.equal(s.priceTable, 'system.billing.list_prices');
  assert.equal(s.currency, 'USD');
  assert.deepEqual([s.period.start, s.period.endExclusive], ['2026-10-08', '2026-10-15']);
  assert.ok(Number.isFinite(s.freshness.latestUsageMs));
  assert.equal(s.coverage.current, 'complete');
});

test('exploreSummary: ≤ 20,000 rows; an oversized result is rejected, never shown truncated', async () => {
  const db = await createEngine();
  await priced(db);
  // 14 dates × 1,500 SKUs = 21,000 grouped rows.
  await db.exec(`INSERT INTO billing.usage
    SELECT 'r' || i, 'acct-1', '${WS}', 'SKU_' || (i % 1500), 'AWS', 'DBU',
           TIMESTAMP '2026-10-01 01:00:00' + INTERVAL (i // 1500) DAY, TIMESTAMP '2026-10-01 02:00:00' + INTERVAL (i // 1500) DAY,
           DATE '2026-10-01' + INTERVAL (i // 1500) DAY, 1, 'ORIGINAL', 'JOBS',
           {'job_id': NULL, 'job_run_id': NULL, 'dlt_pipeline_id': NULL, 'dlt_update_id': NULL, 'warehouse_id': NULL, 'cluster_id': NULL, 'notebook_id': NULL, 'notebook_path': NULL, 'app_id': NULL, 'app_name': NULL, 'job_name': NULL, 'endpoint_name': NULL},
           {'is_photon': false, 'is_serverless': false, 'sql_tier': NULL}
    FROM range(21000) t(i)`);
  const q = explore.kinds.exploreSummary.build(conn(), { periodDays: 7 }, NOW);
  assert.equal(q.maxRows, 20000);
  assert.equal(q.rowLimit, 20001);
  const { exec } = executor(db);
  await assert.rejects(registry.run('exploreSummary', { conn: conn(), args: { periodDays: 7 }, nowMs: NOW, exec }), (e) => e.dcc && e.dcc.code === 'RESULT_TOO_LARGE');
});

test('exploreEntities: LIMIT 200 with the full candidate count, metadata names, prior amounts, partial status', async () => {
  const db = await createEngine();
  await priced(db);
  const rows = [];
  for (let i = 0; i < 205; i++) rows.push(usageRow({ date: '2026-10-09', qty: 1000 - i, job_id: String(5000 + i), job_name: 'job ' + i }));
  rows.push(usageRow({ date: '2026-10-02', qty: 100, job_id: '5000', job_name: 'old name' })); // prior period
  rows.push(usageRow({ date: '2026-10-09', qty: 3000, notebook_id: '77', notebook_path: '/Users/x/nb' }));
  rows.push(usageRow({ date: '2026-10-09', qty: 2900, app_id: 'app-uuid-1', app_name: 'sales-app' }));
  rows.push(usageRow({ date: '2026-10-09', qty: 2800, warehouse_id: '0123456789abcdef' }));
  rows.push(usageRow({ date: '2026-10-09', qty: 2700, cluster_id: '0101-123456-abcdefgh', sku: 'UNPRICED_SKU' }));
  rows.push(usageRow({ date: '2026-10-09', qty: 2700, cluster_id: '0101-123456-abcdefgh' }));
  rows.push(usageRow({ date: '2026-10-02', qty: 50, job_id: '99999' })); // prior-only: not a candidate
  await db.insert('billing.usage', rows);
  const { exec, seen } = executor(db);
  const out = await registry.run('exploreEntities', { conn: conn(), args: { periodDays: 7 }, nowMs: NOW, exec });
  assert.equal(out.items.length, 200);
  assert.equal(out.limit, 200);
  assert.equal(out.candidateCount, 209); // 205 jobs + notebook + app + warehouse + cluster
  assert.equal(out.limited, true);
  assert.match(seen[0].statement, /LIMIT 200/);
  const [nb, app, wh, cl] = out.items;
  assert.deepEqual([nb.ownerType, nb.name, nb.nameSource, nb.amount], ['notebook', '/Users/x/nb', 'notebook_path', 1500]);
  assert.deepEqual([app.ownerType, app.id, app.name, app.nameSource], ['app', 'app-uuid-1', 'sales-app', 'app_name']);
  assert.deepEqual([wh.ownerType, wh.id, wh.name], ['warehouse', '0123456789abcdef', null], 'no name in billing → ID only');
  assert.equal(cl.ownerType, 'cluster');
  assert.equal(cl.status, 'partial');
  assert.equal(cl.amount, 1350);
  assert.equal(cl.unpricedRecords, 1);
  assert.ok(cl.warnings.some((w) => w.code === 'UNPRICED'));
  const top = out.items.find((i) => i.key === 'job:5000');
  assert.equal(top.amount, 500);
  assert.equal(top.prevAmount, 50);
  assert.equal(top.prevStatus, 'ok');
  assert.equal(top.name, 'job 0', 'latest recorded name wins');
  const fresh = out.items.find((i) => i.key === 'job:5001');
  assert.equal(fresh.prevAmount, null);
  assert.equal(fresh.prevStatus, 'no-usage');
  assert.ok(!out.items.some((i) => i.key === 'job:99999'));
  for (let i = 1; i < out.items.length; i++) assert.ok((out.items[i - 1].amount ?? -Infinity) >= (out.items[i].amount ?? -Infinity));
  assert.equal(out.totals.coverage, 'partial', 'workspace total has an unpriced record → shares not valid');
  assert.equal(out.pricingBasis, 'list');
  assert.ok(out.period && out.freshness);
});

async function runsFixture(db) {
  await priced(db);
  await runsUsage(db);
}

async function runsUsage(db) {
  await db.insert('billing.usage', [
    usageRow({ date: '2026-10-09', qty: 10, job_id: '7', job_run_id: '701', job_name: 'nightly', start: '2026-10-09T01:00:00', end: '2026-10-09T02:00:00' }),
    usageRow({ date: '2026-10-09', qty: 6, job_id: '7', job_run_id: '701', start: '2026-10-09T02:00:00', end: '2026-10-09T03:00:00' }),
    // Same run billed in the prior period: excluded from the selected-period run cost.
    usageRow({ date: '2026-10-07', qty: 100, job_id: '7', job_run_id: '701', start: '2026-10-07T23:00:00', end: '2026-10-07T23:59:00' }),
    usageRow({ date: '2026-10-10', qty: 4, job_id: '7', job_run_id: '702' }),
    usageRow({ date: '2026-10-11', qty: 2, job_id: '8', job_run_id: '801' }),
    usageRow({ date: '2026-10-11', qty: 9, job_id: '8' }), // job usage without a run ID
    usageRow({ date: '2026-10-11', qty: 9, notebook_id: '5' }), // not a job
  ]);
  const ts = (v) => ({ $raw: `TIMESTAMP '${v}'` });
  await db.insert('lakeflow.job_run_timeline', [
    // Two hourly slices for run 701: duration = earliest start → latest end.
    { workspace_id: WS, job_id: '7', run_id: '701', period_start_time: ts('2026-10-07 23:00:00'), period_end_time: ts('2026-10-08 00:00:00'), result_state: null, run_type: 'JOB_RUN' },
    { workspace_id: WS, job_id: '7', run_id: '701', period_start_time: ts('2026-10-08 00:00:00'), period_end_time: ts('2026-10-09 03:00:00'), result_state: 'SUCCEEDED', run_type: 'JOB_RUN' },
    // Run 702 still running (no final state).
    { workspace_id: WS, job_id: '7', run_id: '702', period_start_time: ts('2026-10-10 01:00:00'), period_end_time: ts('2026-10-10 02:00:00'), result_state: null, run_type: 'JOB_RUN' },
    // Another workspace's row with the same run ID is ignored.
    { workspace_id: '999', job_id: '8', run_id: '801', period_start_time: ts('2026-10-11 01:00:00'), period_end_time: ts('2026-10-11 09:00:00'), result_state: 'SUCCEEDED', run_type: 'JOB_RUN' },
  ]);
}

test('exploreRuns: selected-period run cost plus optional durations from job_run_timeline', async () => {
  const db = await createEngine();
  await runsFixture(db);
  const { exec, seen } = executor(db);
  const out = await registry.run('exploreRuns', { conn: conn(), args: { periodDays: 7 }, nowMs: NOW, exec });
  assert.equal(seen.length, 2);
  const by = Object.fromEntries(out.items.map((r) => [r.runId, r]));
  assert.deepEqual(Object.keys(by).sort(), ['701', '702', '801']);
  assert.equal(by['701'].amount, 8, 'only billing inside the selected period');
  assert.equal(by['701'].jobName, 'nightly');
  assert.equal(by['701'].durationStatus, 'ok');
  assert.equal(by['701'].durationMs, Date.parse('2026-10-09T03:00:00Z') - Date.parse('2026-10-07T23:00:00Z'));
  assert.equal(by['701'].resultState, 'SUCCEEDED');
  assert.equal(by['702'].durationStatus, 'running');
  assert.equal(by['702'].durationMs, null);
  assert.equal(by['801'].durationStatus, 'missing', 'other workspace timeline rows are ignored');
  assert.equal(by['801'].durationMs, null, 'missing duration is never 0');
  assert.equal(out.durationStatus, 'ok');
  assert.equal(out.candidateCount, 3);
  assert.equal(out.limited, false);
  assert.ok(out.warnings.some((w) => w.code === 'PERIOD_SCOPED' && /lifetime/.test(w.text)));
  assert.ok(by['701'].cohortComplete);
  assert.equal(by['701'].cohortRuns, 2);
  // Run IDs are bound as parameters, never interpolated.
  assert.doesNotMatch(seen[1].statement, /701|801/);
  assert.ok(seen[1].parameters.some((p) => p.value === '701'));
  assert.equal(out.pricingBasis, 'list');
});

test('exploreRuns: a failed duration read keeps costs, warns, and leaves durations null', async () => {
  const db = await createEngine();
  await runsFixture(db);
  const { exec } = executor(db, { failTimeline: true });
  const out = await registry.run('exploreRuns', { conn: conn(), args: { periodDays: 7 }, nowMs: NOW, exec });
  assert.equal(out.durationStatus, 'unavailable');
  assert.equal(out.durationError, 'LAKEFLOW_ACCESS_DENIED');
  assert.ok(out.warnings.some((w) => w.code === 'DURATION_UNAVAILABLE'));
  assert.equal(out.items.length, 3);
  for (const r of out.items) {
    assert.equal(r.durationMs, null);
    assert.equal(r.durationStatus, 'unavailable');
    assert.ok(r.warnings.some((w) => w.code === 'DURATION_UNAVAILABLE'));
  }
  assert.equal(out.items.find((r) => r.runId === '701').amount, 8);
  // Missing table behaves the same (schema/table unavailable).
  await db.exec('DROP TABLE lakeflow.job_run_timeline');
  const again = await registry.run('exploreRuns', { conn: conn(), args: { periodDays: 7 }, nowMs: NOW, exec: executor(db).exec });
  assert.equal(again.durationStatus, 'unavailable');
  assert.equal(again.items.find((r) => r.runId === '701').amount, 8);
});

test('exploreRuns: job filter is a bound parameter and invalid IDs are rejected', async () => {
  const db = await createEngine();
  await runsFixture(db);
  const { exec, seen } = executor(db);
  const out = await registry.run('exploreRuns', { conn: conn(), args: { periodDays: 7, jobId: '8' }, nowMs: NOW, exec });
  assert.deepEqual(out.items.map((r) => r.runId), ['801']);
  assert.equal(out.jobId, '8');
  assert.ok(seen[0].parameters.some((p) => p.name === 'job_id' && p.value === '8'));
  assert.doesNotMatch(seen[0].statement, /= '8'/);
  await assert.rejects(registry.run('exploreRuns', { conn: conn(), args: { periodDays: 7, jobId: "8' OR 1=1" }, nowMs: NOW, exec }));
  await assert.rejects(registry.run('exploreRuns', { conn: conn(), args: { periodDays: 14 }, nowMs: NOW, exec }));
  assert.throws(() => explore.kinds.exploreEntities.build(conn(), { periodDays: 5 }, NOW));
  assert.throws(() => explore.kinds.exploreSummary.build({ ...conn(), priceTable: 'main.x.prices' }, { periodDays: 7 }, NOW));
});

test('exploreRuns: no runs → no duration statement; limit is disclosed', async () => {
  const db = await createEngine();
  await priced(db);
  const { exec, seen } = executor(db);
  const out = await registry.run('exploreRuns', { conn: conn(), args: { periodDays: 7 }, nowMs: NOW, exec });
  assert.equal(seen.length, 1);
  assert.equal(out.items.length, 0);
  assert.equal(out.durationStatus, 'not-needed');
  assert.equal(out.limit, explore.RUN_LIMIT);
  assert.match(seen[0].statement, new RegExp('LIMIT ' + explore.RUN_LIMIT));
});

test('all three kinds run on both price tables with the same amounts and the right struct path', async () => {
  const amounts = {};
  for (const table of ['system.billing.list_prices', 'system.billing.account_prices']) {
    const db = await createEngine();
    await priced(db, table, 0.25);
    await runsUsage(db);
    const { exec, seen } = executor(db);
    const c = conn(table);
    const s = await registry.run('exploreSummary', { conn: c, args: { periodDays: 7 }, nowMs: NOW, exec });
    const e = await registry.run('exploreEntities', { conn: c, args: { periodDays: 7 }, nowMs: NOW, exec });
    const r = await registry.run('exploreRuns', { conn: c, args: { periodDays: 7 }, nowMs: NOW, exec });
    for (const out of [s, e, r]) {
      assert.equal(out.priceTable, table);
      assert.equal(out.pricingBasis, table.endsWith('list_prices') ? 'list' : 'account');
      assert.equal(out.currency, 'USD');
    }
    for (const q of seen) {
      if (/job_run_timeline/.test(q.statement)) continue;
      if (table.endsWith('list_prices')) {
        assert.match(q.statement, /p\.pricing\.effective_list\.default/);
        assert.doesNotMatch(q.statement, /p\.pricing\.default/);
      } else {
        assert.match(q.statement, /p\.pricing\.default/);
        assert.doesNotMatch(q.statement, /effective_list/);
      }
      assert.doesNotMatch(q.statement, /COALESCE\s*\([^)]*pricing/i);
    }
    amounts[table] = { summary: s.daily.filter((x) => x.period === 'cur').reduce((a, x) => a + (x.cost || 0), 0), top: e.items[0].amount, run: r.items.find((x) => x.runId === '701').amount };
  }
  assert.deepEqual(amounts['system.billing.list_prices'], amounts['system.billing.account_prices']);
  assert.ok(amounts['system.billing.list_prices'].summary > 0);
});

test('generated SQL stays inside the portable dialect and never interpolates values', () => {
  const c = conn();
  const statements = [
    explore.kinds.exploreSummary.build(c, { periodDays: 30 }, NOW),
    explore.kinds.exploreEntities.build(c, { periodDays: 30 }, NOW),
    explore.kinds.exploreRuns.buildCosts(c, { periodDays: 30, jobId: '123456' }, NOW),
    explore.kinds.exploreRuns.buildDurations(c, explore.kinds.exploreSummary.build(c, { periodDays: 30 }, NOW).period, ['111', '222']),
  ];
  for (const q of statements) {
    assert.doesNotMatch(q.statement, /from_json|explode|named_struct|timestampadd|date_add|MAX_BY|ANY_VALUE/i);
    assert.ok(!q.statement.includes(WS), 'workspace ID is a parameter');
    assert.doesNotMatch(q.statement, /2026-/, 'dates are parameters');
    assert.doesNotMatch(q.statement, /123456|'111'|'222'/);
    for (const p of q.parameters) assert.ok(['STRING', 'DATE', 'TIMESTAMP', 'BIGINT'].includes(p.type));
    assert.doesNotMatch(q.statement, /statement_text/);
  }
});
