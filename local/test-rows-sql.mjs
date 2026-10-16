// Badge amounts ("rows" kind): direct attribution, job → pipeline attribution, windows, fallback.
// SQL runs on the SIMULATED DuckDB engine (support/sqlengine.mjs): this checks query logic, not
// Databricks compatibility. No macros beyond the engine's own were needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './support/load.mjs';
import { createEngine, usageRow, listPrice, accountPrice, WS } from './support/sqlengine.mjs';

const rowsKind = load('databricks/queries/row-data.js');
const registry = load('databricks/queries/index.js');
const result = load('databricks/result.js');
const errors = load('errors.js');

// 30d period: 2026-09-15 .. 2026-10-14 (today excluded). Execution window: 2025-10-16 .. 2026-10-15
// (365 UTC dates including today).
const NOW = Date.parse('2026-10-15T12:00:00Z');
const conn = (priceTable = 'system.billing.list_prices') => ({
  origin: 'https://dbc-1.cloud.databricks.com', workspaceId: WS, authMode: 'pat', priceTable,
  usageSource: 'system.billing.usage', historySource: 'system.query.history', currency: 'USD',
});

const J = '1001';
const K = '2002';
const R1 = '50101';
const R2 = '50102';
const T1 = '70001'; // task run of R1
const T2 = '70002'; // task run of R2
const P = '0a1b2c3d-1111-4a2b-8c3d-000000000001';
const U1 = '0a1b2c3d-2222-4a2b-8c3d-000000000011'; // triggered by J / T1 (R1)
const U2 = '0a1b2c3d-2222-4a2b-8c3d-000000000012'; // triggered by J / T2 (R2)
const U3 = '0a1b2c3d-2222-4a2b-8c3d-000000000013'; // manual
const WH = 'a1b2c3d4e5f60001';

const ts = (s) => ({ $raw: `TIMESTAMP '${s}'` });
function updateSlice({ pipeline = P, update, job = null, taskRun = null, start, end, trigger = 'JOB_TASK', ws = WS }) {
  return {
    workspace_id: ws, pipeline_id: pipeline, update_id: update, trigger_type: trigger,
    trigger_details: { job_task: { job_id: job, job_task_run_id: taskRun } },
    period_start_time: ts(start), period_end_time: ts(end), result_state: null,
  };
}
function taskSlice({ job = J, run, jobRun, start, end, ws = WS }) {
  return { workspace_id: ws, job_id: job, run_id: run, job_run_id: jobRun, task_key: 'refresh_pipeline', period_start_time: ts(start), period_end_time: ts(end), result_state: null };
}
/** Hourly slices from `date` hh:00 for n hours. */
function hours(date, fromHour, n, make) {
  return Array.from({ length: n }, (_, i) => {
    const h = String(fromHour + i).padStart(2, '0');
    const h2 = String(fromHour + i + 1).padStart(2, '0');
    return make(`${date} ${h}:00:00`, h2 === '24' ? `${date} 23:59:59` : `${date} ${h2}:00:00`);
  });
}

/** Executor: Statement API response → parsed rows; DuckDB catalog/binder errors → Databricks classes. */
function execFor(db, { deny } = {}) {
  const calls = [];
  const exec = async (q) => {
    calls.push(q);
    if (deny) deny(q);
    try {
      const res = await db.execute({ statement: q.statement, parameters: q.parameters, row_limit: q.rowLimit });
      return result.parseResult(res, { maxRows: q.maxRows }).rows;
    } catch (e) {
      if (e.dcc) throw e;
      const msg = String(e.message);
      const errorCode = /Catalog Error/.test(msg) && /does not exist/.test(msg) ? 'TABLE_OR_VIEW_NOT_FOUND' : /Binder Error/.test(msg) ? 'UNRESOLVED_COLUMN' : 'INTERNAL_ERROR';
      throw new errors.DccError({ message: msg, errorCode });
    }
  };
  exec.calls = calls;
  return exec;
}

const close = (a, b, msg) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${msg ?? ''} expected ${b}, got ${a}`);
const refs = {
  job: { type: 'job', jobId: J },
  r1: { type: 'job_run', jobId: J, runId: R1 },
  r2: { type: 'job_run', jobId: J, runId: R2 },
  pipeline: { type: 'pipeline', pipelineId: P },
  u1: { type: 'pipeline_update', pipelineId: P, updateId: U1 },
  wh: { type: 'warehouse', warehouseId: WH },
  nb: { type: 'notebook', notebookId: '3001' },
  app: { type: 'app', appName: 'sales-dashboard' },
};
const run = (db, refList, { periodDays = 30, c = conn(), exec = execFor(db) } = {}) =>
  rowsKind.run({ conn: c, args: { periodDays, refs: refList }, nowMs: NOW, exec });

/** Standard scenario: job J with runs R1/R2 each triggering one pipeline update. */
async function seedJobScenario(db, priceTable = 'billing.list_prices', priceRow = listPrice) {
  await db.insert('billing.usage', [
    usageRow({ date: '2026-10-10', qty: 10, job_id: J, job_run_id: R1 }),
    usageRow({ date: '2026-10-11', qty: 6, job_id: J, job_run_id: R2 }),
    usageRow({ date: '2026-10-10', qty: 4, pipeline_id: P, update_id: U1, product: 'DLT', sku: 'JOBS_SERVERLESS' }),
    usageRow({ date: '2026-10-11', qty: 3, pipeline_id: P, update_id: U2, product: 'DLT', sku: 'JOBS_SERVERLESS' }),
    usageRow({ date: '2026-10-12', qty: 100, pipeline_id: P, update_id: U3, product: 'DLT', sku: 'JOBS_SERVERLESS' }),
  ]);
  await db.insert(priceTable, [priceRow({ price: 1 }), priceRow({ sku: 'JOBS_SERVERLESS', price: 1 })]);
  await db.insert('lakeflow.pipeline_update_timeline', [
    ...hours('2026-10-10', 1, 3, (s, e) => updateSlice({ update: U1, job: J, taskRun: T1, start: s, end: e })),
    ...hours('2026-10-11', 1, 2, (s, e) => updateSlice({ update: U2, job: J, taskRun: T2, start: s, end: e })),
    ...hours('2026-10-12', 1, 4, (s, e) => updateSlice({ update: U3, trigger: 'MANUAL', start: s, end: e })),
  ]);
  await db.insert('lakeflow.job_task_run_timeline', [
    ...hours('2026-10-10', 0, 4, (s, e) => taskSlice({ run: T1, jobRun: R1, start: s, end: e })),
    ...hours('2026-10-11', 0, 3, (s, e) => taskSlice({ run: T2, jobRun: R2, start: s, end: e })),
  ]);
}

test('job period total includes pipeline updates triggered by the job', async () => {
  const db = await createEngine();
  await seedJobScenario(db);
  const out = await run(db, [refs.job, refs.pipeline, refs.u1]);
  const job = out.items['job:' + J];
  assert.equal(job.status, 'ok');
  assert.equal(job.attribution, 'direct+pipelines');
  assert.equal(job.label, 'Job total');
  assert.equal(job.scope, 'period');
  close(job.amount, 10 + 6 + 4 + 3, 'direct + U1 + U2, never the manual U3');
  close(job.linkedAmount, 4 + 3, 'triggered part');
  assert.deepEqual(job.warnings, []);
  close(out.items['pipeline:' + P].amount, 4 + 3 + 100, 'pipeline badge is its own direct total');
  assert.equal(out.items['pipeline:' + P].attribution, 'direct');
  close(out.items[`pipeline_update:${P}:${U1}`].amount, 4);
  assert.equal(out.items[`pipeline_update:${P}:${U1}`].scope, 'execution');
});

test('per-run cost includes only updates mapped to that exact parent run', async () => {
  const db = await createEngine();
  await seedJobScenario(db);
  // A slice claiming task run T1 under another job K must not link to R1 (constrained by job).
  await db.insert('lakeflow.pipeline_update_timeline', [updateSlice({ update: U3, job: K, taskRun: T1, start: '2026-10-12 01:00:00', end: '2026-10-12 02:00:00' })]);
  const out = await run(db, [refs.r1, refs.r2]);
  const r1 = out.items[`job_run:${J}:${R1}`];
  const r2 = out.items[`job_run:${J}:${R2}`];
  close(r1.amount, 10 + 4, 'R1 = direct + U1 only');
  close(r2.amount, 6 + 3, 'R2 = direct + U2 only');
  assert.equal(r1.attribution, 'direct+pipelines');
  assert.equal(r1.label, 'Run cost');
  assert.equal(r1.scope, 'execution');
  close(r1.linkedAmount, 4);
});

test('hourly timeline slices and repeated task rows are deduplicated (no multiplied charges)', async () => {
  const db = await createEngine();
  await seedJobScenario(db);
  // Exact duplicate slices and repeated task rows on top of the hourly slices.
  await db.insert('lakeflow.pipeline_update_timeline', hours('2026-10-10', 1, 3, (s, e) => updateSlice({ update: U1, job: J, taskRun: T1, start: s, end: e })));
  await db.insert('lakeflow.job_task_run_timeline', hours('2026-10-10', 0, 4, (s, e) => taskSlice({ run: T1, jobRun: R1, start: s, end: e })));
  const out = await run(db, [refs.job, refs.r1]);
  close(out.items['job:' + J].amount, 23, 'job counted once per record');
  close(out.items[`job_run:${J}:${R1}`].amount, 14, 'run counted once per record');
});

test('a record matching both direct and linked attribution is counted once per target', async () => {
  const db = await createEngine();
  await seedJobScenario(db);
  // Pipeline billing that also carries the job's tags (matches job_id AND U1 membership).
  await db.insert('billing.usage', [usageRow({ date: '2026-10-10', qty: 5, job_id: J, job_run_id: R1, pipeline_id: P, update_id: U1, sku: 'JOBS_SERVERLESS' })]);
  const out = await run(db, [refs.job, refs.r1, refs.u1]);
  close(out.items['job:' + J].amount, 23 + 5);
  close(out.items['job:' + J].linkedAmount, 7, 'directly tagged record is not reported as linked');
  close(out.items[`job_run:${J}:${R1}`].amount, 14 + 5);
  close(out.items[`pipeline_update:${P}:${U1}`].amount, 4 + 5);
});

test('workspace isolation: other workspaces never contribute billing or timeline links', async () => {
  const db = await createEngine();
  await seedJobScenario(db);
  const U9 = '0a1b2c3d-2222-4a2b-8c3d-000000000099';
  await db.insert('billing.usage', [
    usageRow({ date: '2026-10-10', qty: 50, job_id: J, job_run_id: R1, workspace_id: '999' }),
    usageRow({ date: '2026-10-10', qty: 9, pipeline_id: P, update_id: U9 }),
  ]);
  await db.insert('lakeflow.pipeline_update_timeline', [updateSlice({ update: U9, job: J, taskRun: T1, start: '2026-10-10 05:00:00', end: '2026-10-10 06:00:00', ws: '999' })]);
  const out = await run(db, [refs.job, refs.r1]);
  close(out.items['job:' + J].amount, 23);
  close(out.items[`job_run:${J}:${R1}`].amount, 14);
});

test('period vs execution windows: complete UTC period excludes today; runs search 365 dates incl. today', async () => {
  const db = await createEngine();
  await db.insert('billing.usage', [
    usageRow({ date: '2026-10-15', qty: 2, job_id: J, job_run_id: R1 }), // today
    usageRow({ date: '2026-09-15', qty: 1, job_id: J, job_run_id: R1 }), // first period date
    usageRow({ date: '2026-09-14', qty: 3, job_id: J, job_run_id: R1 }), // before the period
    usageRow({ date: '2025-10-16', qty: 7, job_id: J, job_run_id: R1 }), // first lookback date
    usageRow({ date: '2025-10-15', qty: 1000, job_id: J, job_run_id: R1 }), // outside 365 dates
  ]);
  await db.insert('billing.list_prices', [listPrice({ price: 1 })]);
  const out = await run(db, [refs.job, refs.r1]);
  const job = out.items['job:' + J];
  const r1 = out.items[`job_run:${J}:${R1}`];
  close(job.amount, 1, 'period');
  close(r1.amount, 2 + 1 + 3 + 7, 'execution');
  assert.deepEqual(job.window, { start: '2026-09-15', endExclusive: '2026-10-15' });
  assert.deepEqual(r1.window, { start: '2025-10-16', endExclusive: '2026-10-16' });
  assert.match(r1.note, /365 UTC dates up to and including today/);
  assert.match(r1.note, /Delayed billing or bounded history can make it incomplete/);
  assert.match(job.note, /Not lifetime spend/);
  assert.deepEqual(out.windows, { period: job.window, execution: r1.window });

  const seven = await run(db, [refs.job], { periodDays: 7 });
  assert.equal(seven.items['job:' + J].status, 'none');
  assert.equal(seven.items['job:' + J].amount, null);
});

test('timeline scans are bounded by the scope window (± 1 day) and never join billing directly', () => {
  const nr = rowsKind.normalizeRefs([refs.job, refs.pipeline]).refs;
  const q = rowsKind.buildScope(conn(), nr, { start: '2026-09-15', endExclusive: '2026-10-15' }, 'period', true);
  const p = Object.fromEntries(q.parameters.map((x) => [x.name, x]));
  assert.equal(p.tl_start.value, '2026-09-14 00:00:00');
  assert.equal(p.tl_start.type, 'TIMESTAMP');
  assert.equal(p.tl_end.value, '2026-10-16 00:00:00');
  assert.match(q.statement, /put\.period_end_time >= :tl_start AND put\.period_start_time < :tl_end/);
  const er = rowsKind.normalizeRefs([refs.r1]).refs;
  const qe = rowsKind.buildScope(conn(), er, { start: '2025-10-16', endExclusive: '2026-10-16' }, 'execution', true);
  assert.match(qe.statement, /jt\.period_end_time >= :tl_start AND jt\.period_start_time < :tl_end/);
  assert.match(qe.statement, /jt\.workspace_id = :workspace_id/);
  for (const sql of [q.statement, qe.statement]) {
    // Timelines appear only inside link_rows; billing joins the deduplicated membership array.
    const linkRows = sql.slice(sql.indexOf('link_rows AS ('), sql.indexOf('links AS ('));
    const rest = sql.replace(linkRows, '');
    assert.doesNotMatch(rest, /_timeline/);
    assert.match(sql, /collect_set\(concat_ws\('\|', pipeline_id, update_id\)\) AS members/);
    assert.match(sql, /array_contains\(tl\.members, concat_ws\('\|', pu\.usage_metadata\.dlt_pipeline_id, pu\.usage_metadata\.dlt_update_id\)\)/);
    assert.doesNotMatch(sql, /\bEXISTS\b/i);
  }
});

test('SQL portability and parameterization: ids only as params, no unsupported functions', async () => {
  const db = await createEngine();
  await seedJobScenario(db);
  const exec = execFor(db);
  await run(db, Object.values(refs), { exec });
  assert.equal(exec.calls.length, 2, 'one statement per scope');
  for (const q of exec.calls) {
    for (const bad of [/from_json/i, /explode/i, /named_struct/i, /timestampadd/i, /date_add/i, /COALESCE\s*\([^)]*pricing/i]) assert.doesNotMatch(q.statement, bad);
    for (const id of [J, R1, P, U1, WH, '3001', 'sales-dashboard', WS]) assert.ok(!q.statement.includes(id), 'value interpolated: ' + id);
    assert.match(q.statement, /usage_scoped AS \(/, 'shared pricing adapter CTE');
    assert.match(q.statement, /p\.pricing\.effective_list\.default/);
    for (const prm of q.parameters) assert.ok(['STRING', 'DATE', 'TIMESTAMP', 'BIGINT'].includes(prm.type));
  }
});

test('both price tables give the same amounts for the same prices on every badge type', async () => {
  const totals = {};
  for (const [table, row] of [['system.billing.list_prices', listPrice], ['system.billing.account_prices', accountPrice]]) {
    const db = await createEngine();
    await seedJobScenario(db, table.replace('system.', ''), row);
    await db.insert('billing.usage', [
      usageRow({ date: '2026-10-09', qty: 8, warehouse_id: WH }),
      usageRow({ date: '2026-10-09', qty: 2, notebook_id: '3001' }),
      usageRow({ date: '2026-10-09', qty: 3, app_name: 'sales-dashboard' }),
    ]);
    const exec = execFor(db);
    const out = await run(db, Object.values(refs), { c: conn(table), exec });
    assert.equal(out.priceTable, table);
    assert.equal(out.pricingBasis, table.endsWith('list_prices') ? 'list' : 'account');
    assert.equal(out.priceField, table.endsWith('list_prices') ? 'pricing.effective_list.default' : 'pricing.default');
    assert.equal(out.currency, 'USD');
    for (const q of exec.calls) {
      if (table.endsWith('account_prices')) assert.doesNotMatch(q.statement, /effective_list/);
      else assert.doesNotMatch(q.statement, /p\.pricing\.default/);
    }
    totals[table] = Object.fromEntries(Object.entries(out.items).map(([k, v]) => [k, v.amount]));
  }
  assert.deepEqual(totals['system.billing.list_prices'], totals['system.billing.account_prices']);
  const t = totals['system.billing.list_prices'];
  close(t['warehouse:' + WH], 8);
  close(t['notebook:3001'], 2);
  close(t['app:sales-dashboard'], 3);
  close(t['job:' + J], 23);
});

test('direct-only fallback when lakeflow tables are missing: per-item label and warning', async () => {
  const db = await createEngine();
  await seedJobScenario(db);
  await db.exec('DROP TABLE lakeflow.pipeline_update_timeline; DROP TABLE lakeflow.job_task_run_timeline');
  const exec = execFor(db);
  const out = await run(db, [refs.job, refs.r1, refs.pipeline, refs.wh], { exec });
  const job = out.items['job:' + J];
  const r1 = out.items[`job_run:${J}:${R1}`];
  assert.equal(job.attribution, 'direct-only');
  assert.equal(job.label, 'Direct job cost');
  close(job.amount, 16, 'direct only; never presented as the complete total');
  assert.equal(job.warnings.length, 1);
  assert.equal(job.warnings[0].code, 'PIPELINE_ATTRIBUTION_UNAVAILABLE');
  assert.match(job.warnings[0].text, /not a complete job total/);
  assert.equal(r1.attribution, 'direct-only');
  assert.match(r1.label, /^Direct job cost/);
  close(r1.amount, 10);
  assert.equal(r1.warnings[0].code, 'PIPELINE_ATTRIBUTION_UNAVAILABLE');
  assert.equal(out.items['pipeline:' + P].attribution, 'direct');
  assert.deepEqual(out.items['pipeline:' + P].warnings, []);
  assert.equal(out.items['warehouse:' + WH].status, 'none');
  // Two failed timeline attempts (one per scope) + two direct-only statements without lakeflow.
  assert.equal(exec.calls.length, 4);
  assert.equal(exec.calls.filter((q) => !q.linked).length, 2);
  for (const q of exec.calls.filter((x) => !x.linked)) assert.doesNotMatch(q.statement, /lakeflow/);
});

test('direct-only fallback also covers denied access and a changed timeline schema', async () => {
  for (const variant of ['denied', 'schema']) {
    const db = await createEngine();
    await seedJobScenario(db);
    let deny;
    if (variant === 'denied') {
      deny = (q) => {
        if (/lakeflow/.test(q.statement)) throw new errors.DccError({ errorCode: 'INSUFFICIENT_PERMISSIONS', message: 'User does not have SELECT on Table system.lakeflow.pipeline_update_timeline' });
      };
    } else {
      await db.exec('ALTER TABLE lakeflow.pipeline_update_timeline DROP COLUMN trigger_details');
    }
    const out = await run(db, [refs.job], { exec: execFor(db, { deny }) });
    const job = out.items['job:' + J];
    assert.equal(job.attribution, 'direct-only', variant);
    assert.equal(job.label, 'Direct job cost', variant);
    assert.equal(job.warnings[0].code, 'PIPELINE_ATTRIBUTION_UNAVAILABLE', variant);
    close(job.amount, 16, variant);
  }
});

test('if direct-only also fails, that error is thrown; other errors are never masked', async () => {
  const db = await createEngine();
  await seedJobScenario(db);
  await db.exec('DROP TABLE lakeflow.pipeline_update_timeline; DROP TABLE billing.usage');
  await assert.rejects(run(db, [refs.job]), (e) => e.dcc && e.dcc.code === 'TABLE_NOT_FOUND');

  const db2 = await createEngine();
  await seedJobScenario(db2);
  const exec = execFor(db2, { deny: () => { throw new errors.DccError({ errorCode: 'PERMISSION_DENIED', message: 'User does not have SELECT on system.billing.usage' }); } });
  await assert.rejects(run(db2, [refs.job], { exec }), (e) => e.dcc.code === 'BILLING_ACCESS_DENIED');
  assert.equal(exec.calls.length, 1, 'no direct-only retry for a billing error');
});

test('missing is null (never 0); zero is a real priced zero', async () => {
  const db = await createEngine();
  await db.insert('billing.usage', [
    usageRow({ date: '2026-10-10', qty: 5, warehouse_id: WH, sku: 'ZERO_SKU' }),
    usageRow({ date: '2026-10-10', qty: 4, notebook_id: '3001', sku: 'GENIE_FREE_USAGE' }),
  ]);
  await db.insert('billing.list_prices', [listPrice({ sku: 'ZERO_SKU', price: 0 })]);
  const out = await run(db, [refs.app, refs.wh, refs.nb, refs.r1]);
  const app = out.items['app:sales-dashboard'];
  assert.equal(app.status, 'none');
  assert.equal(app.coverage, 'empty');
  assert.equal(app.amount, null);
  assert.equal(out.items[`job_run:${J}:${R1}`].amount, null);
  assert.equal(out.items[`job_run:${J}:${R1}`].coverage, 'empty');
  assert.equal(out.items['warehouse:' + WH].status, 'ok');
  assert.equal(out.items['warehouse:' + WH].amount, 0);
  assert.equal(out.items['notebook:3001'].amount, 0, 'documented free SKU');
});

test('signed corrections are kept; negative amounts preserved', async () => {
  const db = await createEngine();
  await db.insert('billing.usage', [
    usageRow({ date: '2026-10-10', qty: 10, record_type: 'ORIGINAL', pipeline_id: P, update_id: U1 }),
    usageRow({ date: '2026-10-11', qty: -10, record_type: 'RETRACTION', pipeline_id: P, update_id: U1 }),
    usageRow({ date: '2026-10-11', qty: 8, record_type: 'RESTATEMENT', pipeline_id: P, update_id: U1 }),
    usageRow({ date: '2026-10-11', qty: -4, record_type: 'RETRACTION', warehouse_id: WH }),
    usageRow({ date: '2026-10-11', qty: 6, record_type: 'ORIGINAL', job_id: J, job_run_id: R1 }),
    usageRow({ date: '2026-10-12', qty: -6, record_type: 'RETRACTION', job_id: J, job_run_id: R1 }),
  ]);
  await db.insert('billing.list_prices', [listPrice({ price: 0.5 })]);
  const out = await run(db, [refs.u1, refs.pipeline, refs.wh, refs.job]);
  close(out.items[`pipeline_update:${P}:${U1}`].amount, 4);
  close(out.items['pipeline:' + P].amount, 4);
  close(out.items['warehouse:' + WH].amount, -2, 'negative kept');
  assert.equal(out.items['job:' + J].status, 'ok');
  assert.equal(out.items['job:' + J].amount, 0, 'net-zero corrections are a real zero, not missing');
});

test('partial pricing → priced subtotal with per-item warning; nothing priced → no amount', async () => {
  const db = await createEngine();
  await db.insert('billing.usage', [
    usageRow({ date: '2026-10-10', qty: 10, job_id: J, job_run_id: R1 }),
    usageRow({ date: '2026-10-11', qty: 3, job_id: J, job_run_id: R1, sku: 'NEW_SKU' }),
    usageRow({ date: '2026-10-12', qty: 3, warehouse_id: WH, sku: 'NEW_SKU' }),
  ]);
  await db.insert('billing.list_prices', [listPrice({ price: 2 })]);
  const out = await run(db, [refs.job, refs.wh]);
  const job = out.items['job:' + J];
  assert.equal(job.status, 'partial');
  assert.equal(job.coverage, 'partial');
  close(job.amount, 20, 'priced subtotal only');
  assert.equal(job.label, 'Job total (priced subtotal)');
  assert.equal(job.unpricedRecords, 1);
  assert.deepEqual(job.unpricedSkus, ['NEW_SKU']);
  assert.equal(job.firstUnpricedDate, '2026-10-11');
  assert.equal(job.warnings[0].code, 'UNPRICED_USAGE');
  assert.match(job.warnings[0].text, /NEW_SKU/);
  const wh = out.items['warehouse:' + WH];
  assert.equal(wh.status, 'unavailable');
  assert.equal(wh.reason, 'price-unavailable');
  assert.equal(wh.amount, null);
  assert.equal(wh.warnings[0].code, 'PRICE_UNAVAILABLE');
});

test('refs are re-validated inside run(): sanitized, deduplicated, ≤ 40, statements not handled here', async () => {
  const db = await createEngine();
  await seedJobScenario(db);
  const exec = execFor(db);
  const out = await registry.run('rows', {
    conn: conn(),
    nowMs: NOW,
    exec,
    args: {
      periodDays: 30,
      refs: [
        refs.job, { ...refs.job, extra: "'; DROP TABLE x" }, { type: 'job', jobId: '12ab' }, { type: 'warehouse', warehouseId: 'XYZ' },
        { type: 'app', appName: 'create' }, { type: 'statement', statementId: '01234567-89ab-4cde-8f01-23456789abcd' }, null, 'job:1',
      ],
    },
  });
  assert.deepEqual(Object.keys(out.items).sort(), ['job:1001', 'statement:01234567-89ab-4cde-8f01-23456789abcd']);
  assert.equal(out.items['statement:01234567-89ab-4cde-8f01-23456789abcd'].status, 'unavailable');
  assert.equal(exec.calls.length, 1);
  const many = Array.from({ length: 41 }, (_, i) => ({ type: 'job', jobId: String(5000 + i) }));
  await assert.rejects(run(db, many), /Too many resources|Something went wrong/);
  await assert.rejects(rowsKind.run({ conn: conn(), args: { periodDays: 14, refs: [refs.job] }, nowMs: NOW, exec }));
  const forty = Array.from({ length: 40 }, (_, i) => ({ type: 'job', jobId: String(5000 + i) }));
  const ok = await run(db, forty);
  assert.equal(Object.keys(ok.items).length, 40);
});
