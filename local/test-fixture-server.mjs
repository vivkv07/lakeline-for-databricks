// SIMULATED: the fixture executes the extension's SQL on DuckDB through local/support/sqlengine.mjs.
// This checks query logic and API shapes; it is not proof of Databricks compatibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, FIXTURE_TOKEN, FIXTURE_ORIGIN, mapEngineError } from './fixture-server.mjs';
import { buildDataset, monitorSnapshot, LIST_PRICES, JOBS_PRICE_AFTER_CHANGE, PRICE_CHANGE_DAYS_AGO, UNPRICED_SKU, SENTINEL_SQL_TEXT as DATA_SENTINEL, WAREHOUSES, PIPELINES } from './fixture-data.mjs';
import { SENTINEL_SQL_TEXT } from './support/sqlengine.mjs';
import { fixtureTemplateValues, renderFixtureTemplate, legacyFragment, escapeHtml, LEGACY_TEMPLATE_VALUES, TEMPLATE_PLACEHOLDER, NON_WAREHOUSE_STATEMENT_INDEX, queryHistoryDaysAgo } from './fixture-data.mjs';
import { startHelper, readExtensionId, FIXTURE_TOKEN as HELPER_FIXTURE_TOKEN } from './server.mjs';
import { rawRequest, rewriteFetch } from './test-helper-fakes.mjs';
import { load } from './support/load.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const http = load('databricks/http.js');
const result = load('databricks/result.js');
const summary = load('databricks/queries/summary.js');
const warehouses = load('databricks/warehouses.js');
const periods = load('core/periods.js');
const errors = load('errors.js');
const nativeCost = load('content/native-cost-data.js');

const NOW = Date.parse('2026-10-15T17:30:00Z');
const W1 = WAREHOUSES[0].id;
const W2 = WAREHOUSES[1].id;

let fx;
let client;
const fast = { sleep: async () => {} };

function conn(priceTable = 'system.billing.list_prices') {
  return { origin: FIXTURE_ORIGIN, workspaceId: '1234567890', priceTable, usageSource: 'system.billing.usage', historySource: 'system.query.history', currency: 'USD', cloud: 'fixture' };
}

async function runSummary(c, periodDays, warehouseId = W1) {
  const q = summary.build(c, { periodDays }, NOW);
  const res = await http.executeStatement(client, { warehouseId, statement: q.statement, parameters: q.parameters, rowLimit: q.rowLimit }, fast);
  return summary.parse(result.parseResult(res, { maxRows: q.maxRows }).rows, q);
}

test.before(async () => {
  fx = await startFixtureServer({ port: 0, nowMs: NOW, log: () => {} });
  client = http.create({ origin: FIXTURE_ORIGIN, token: FIXTURE_TOKEN, fetch: rewriteFetch(FIXTURE_ORIGIN, fx.origin) });
});

test.after(async () => {
  await fx.close();
});

test('binds 127.0.0.1, checks Host, serves app routes and only allowlisted static files', async () => {
  assert.equal(fx.server.address().address, '127.0.0.1');
  const get = (p, headers = { Host: '127.0.0.1:' + fx.port }) => rawRequest({ port: fx.port, path: p, headers });
  assert.equal((await get('/jobs/101', { Host: 'localhost:' + fx.port })).status, 403);
  assert.equal((await get('/jobs/101', { Host: 'evil.example' })).status, 403);
  for (const route of ['/', '/jobs/101', '/jobs/101/runs/101020376', '/sql/warehouses/' + W1, '/editor/notebooks/3001?o=1234567890', '/pipelines/' + PIPELINES[0].pipeline_id, '/sql/history', '/server.mjs', '/support/sqlengine.mjs']) {
    const r = await get(route);
    assert.equal(r.status, 200, route);
    assert.match(r.headers['content-type'], /text\/html/, route);
    assert.ok(!/startFixtureServer|createEngine|DuckDBInstance/.test(r.text), 'no source served for ' + route);
  }
  for (const bad of ['/fixture/../server.mjs', '/fixture/%2e%2e/server.mjs', '/fixture/..%2fserver.mjs', '/workspace%2ejs/../x']) {
    const r = await get(bad);
    assert.ok(r.status === 400 || r.status === 404, bad + ' → ' + r.status);
    assert.ok(!/startFixtureServer/.test(r.text));
  }
  assert.equal((await get('/fixture/x.mjs')).status, 404);
  assert.equal((await get('/fixture/does-not-exist.html')).status, 404);
  const js = await get('/workspace.js');
  if (fs.existsSync(path.join(HERE, 'workspace.js'))) {
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
  } else assert.equal(js.status, 404);
  const fixtureFiles = fs.existsSync(path.join(HERE, 'fixture')) ? fs.readdirSync(path.join(HERE, 'fixture')).filter((f) => /\.html$/.test(f)) : [];
  if (fixtureFiles.length) assert.equal((await get('/fixture/' + fixtureFiles[0])).status, 200);
  assert.equal((await rawRequest({ port: fx.port, method: 'POST', path: '/jobs/101', headers: { Host: '127.0.0.1:' + fx.port } })).status, 405);
});

test('mock API accepts only the documented fake fixture token', async () => {
  const call = (auth) => rawRequest({ port: fx.port, path: '/api/2.0/sql/warehouses', headers: Object.assign({ Host: '127.0.0.1:' + fx.port }, auth ? { Authorization: auth } : {}) });
  assert.equal((await call(null)).status, 401);
  assert.equal((await call('Bearer dapi-fixture-0000000000000000000000000001')).status, 401);
  assert.equal((await call('Basic ' + FIXTURE_TOKEN)).status, 401);
  assert.equal((await call('Bearer ' + FIXTURE_TOKEN)).status, 200);
  assert.equal(HELPER_FIXTURE_TOKEN, FIXTURE_TOKEN);
  const unknown = await rawRequest({ port: fx.port, path: '/api/2.0/clusters/delete', headers: { Host: '127.0.0.1:' + fx.port, Authorization: 'Bearer ' + FIXTURE_TOKEN } });
  assert.equal(unknown.status, 404);
});

test('warehouses: three synthetic warehouses over two pages, exactly one RUNNING', async () => {
  const list = await warehouses.list(client);
  assert.equal(list.length, 3);
  assert.deepEqual(list.filter((w) => w.state === 'RUNNING').map((w) => w.id), [W1]);
  assert.equal(warehouses.autoSelect(list).id, W1);
  assert.equal(list.find((w) => w.id === W1).serverless, true);
  const page1 = await client.get('/api/2.0/sql/warehouses');
  assert.equal(page1.warehouses.length, 2);
  assert.ok(page1.next_page_token);
});

test('synthetic dataset: deterministic, sentinel-only query text, consistent job/pipeline identities', () => {
  const a = buildDataset({ nowMs: NOW });
  const b = buildDataset({ nowMs: NOW });
  assert.deepEqual(a, b);
  assert.equal(DATA_SENTINEL, SENTINEL_SQL_TEXT);
  const t = a.tables;
  assert.ok(t['query.history'].length > 50);
  assert.ok(t['query.history'].every((h) => h.statement_text === SENTINEL_SQL_TEXT));
  const dates = new Set(t['billing.usage'].map((u) => u.usage_date));
  assert.equal(dates.size, 200);
  assert.ok(t['billing.usage'].every((u) => Date.parse(u.usage_end_time + 'Z') <= NOW), 'no future usage');
  assert.ok(t['billing.usage'].every((u) => u.workspace_id === '1234567890'));
  for (const rt of ['ORIGINAL', 'RETRACTION', 'RESTATEMENT']) assert.ok(t['billing.usage'].some((u) => u.record_type === rt), rt);
  assert.ok(t['billing.usage'].some((u) => u.sku_name === 'GENIE_FREE_USAGE'));
  assert.equal(t['billing.usage'].filter((u) => u.sku_name === UNPRICED_SKU).length, 3);
  assert.ok(!t['billing.list_prices'].some((p) => p.sku_name === UNPRICED_SKU || p.sku_name === 'GENIE_FREE_USAGE'));
  // Every JOB_TASK-triggered update points at a refresh_pipeline task run of job 102 whose parent run is billed to job 102.
  const tasks = new Map(t['lakeflow.job_task_run_timeline'].map((x) => [x.run_id, x]));
  const job102Runs = new Set(t['billing.usage'].filter((u) => u.usage_metadata.job_id === '102').map((u) => u.usage_metadata.job_run_id));
  const triggered = t['lakeflow.pipeline_update_timeline'].filter((x) => x.trigger_type === 'JOB_TASK');
  assert.ok(triggered.length > 100);
  for (const upd of triggered) {
    const task = tasks.get(upd.trigger_details.job_task.job_task_run_id);
    assert.ok(task && task.job_id === '102' && task.task_key === 'refresh_pipeline');
    assert.ok(job102Runs.has(task.job_run_id));
    assert.ok(t['billing.usage'].some((u) => u.usage_metadata.dlt_update_id === upd.update_id));
  }
  const yesterday = periods.addDays(periods.utcDate(NOW), -1);
  const failed = t['lakeflow.job_run_timeline'].filter((r) => r.result_state === 'FAILED');
  assert.deepEqual(failed.map((r) => [r.job_id, r.period_start_time.slice(0, 10)]), [['102', yesterday]]);
});

/** Independent expected cost for a period: Σ signed qty × the valid list price; GENIE is free. */
function expectedListCost(start, endExclusive) {
  const { tables } = buildDataset({ nowMs: NOW });
  const change = Date.parse(periods.addDays(periods.utcDate(NOW), -PRICE_CHANGE_DAYS_AGO) + 'T00:00:00Z');
  let total = 0;
  let unpriced = 0;
  for (const u of tables['billing.usage']) {
    if (u.usage_date < start || u.usage_date >= endExclusive) continue;
    if (u.sku_name === 'GENIE_FREE_USAGE') continue;
    let price = LIST_PRICES[u.sku_name];
    if (u.sku_name === 'PREMIUM_JOBS_COMPUTE' && Date.parse(u.usage_end_time + 'Z') >= change) price = JOBS_PRICE_AFTER_CHANGE;
    if (price === undefined) {
      unpriced += 1;
      continue;
    }
    total += u.usage_quantity * price;
  }
  return { total, unpriced };
}

test('summary end to end through the extension http client + summary.build/parse (list prices)', async () => {
  const s7 = await runSummary(conn(), 7);
  const p7 = periods.completePeriod(7, NOW);
  assert.equal(s7.pricingBasis, 'list');
  assert.equal(s7.priceTable, 'system.billing.list_prices');
  assert.equal(s7.current.coverage, 'complete');
  const exp = expectedListCost(p7.start, p7.endExclusive);
  assert.equal(exp.unpriced, 0);
  assert.ok(Math.abs(s7.currentAmount - exp.total) < 1e-6, s7.currentAmount + ' vs ' + exp.total);
  assert.ok(s7.freeQuantity.GENIE_FREE_USAGE > 0);
  // Previous 7 days include the unpriced day 12 days ago → priced subtotal only.
  assert.equal(s7.previous.coverage, 'partial');
  assert.deepEqual(s7.previous.unpricedSkus, [UNPRICED_SKU]);

  const s30 = await runSummary(conn(), 30);
  const p30 = periods.completePeriod(30, NOW);
  assert.equal(s30.current.coverage, 'partial');
  assert.equal(s30.current.total, null);
  assert.equal(s30.current.unpricedRecords, 3);
  assert.deepEqual(s30.current.unpricedSkus, [UNPRICED_SKU]);
  const exp30 = expectedListCost(p30.start, p30.endExclusive);
  assert.ok(Math.abs(s30.current.pricedSubtotal - exp30.total) < 1e-6);
  // 90 days spans the list-price change (validity windows).
  const s90 = await runSummary(conn(), 90);
  const p90 = periods.completePeriod(90, NOW);
  const exp90 = expectedListCost(p90.prevStart, p90.start);
  assert.equal(s90.current.coverage, 'partial');
  assert.equal(s90.previous.coverage, 'complete');
  assert.ok(Math.abs(s90.previousAmount - exp90.total) < 1e-6, s90.previousAmount + ' vs ' + exp90.total);
  // The same window priced only at the old rate would differ: the validity window matters.
  const { tables } = buildDataset({ nowMs: NOW });
  const oldRateOnly = tables['billing.usage'].filter((u) => u.usage_date >= p90.prevStart && u.usage_date < p90.start && u.sku_name === 'PREMIUM_JOBS_COMPUTE').reduce((s, u) => s + u.usage_quantity * (JOBS_PRICE_AFTER_CHANGE - LIST_PRICES.PREMIUM_JOBS_COMPUTE), 0);
  assert.ok(Math.abs(oldRateOnly) > 0.01);
  assert.equal(fx.state.sentinelReads, 0);
});

test('summary with account prices is priced separately (85 % of list), never mixed', async () => {
  const list = await runSummary(conn(), 7);
  const acct = await runSummary(conn('system.billing.account_prices'), 7);
  assert.equal(acct.pricingBasis, 'account');
  assert.equal(acct.priceTable, 'system.billing.account_prices');
  assert.ok(Math.abs(acct.currentAmount - list.currentAmount * 0.85) < 1e-4);
});

test('statement API: pending → poll path, cancel, read-only guard, sentinel guard, error mapping', async () => {
  // Pending then RUNNING on the first poll, SUCCEEDED on the next.
  const slow = await startFixtureServer({ port: 0, nowMs: NOW, pendingPolls: 1, log: () => {} });
  try {
    const c2 = http.create({ origin: FIXTURE_ORIGIN, token: FIXTURE_TOKEN, fetch: rewriteFetch(FIXTURE_ORIGIN, slow.origin) });
    let sleeps = 0;
    const q = summary.build(conn(), { periodDays: 7 }, NOW);
    const res = await http.executeStatement(c2, { warehouseId: W1, statement: q.statement, parameters: q.parameters, rowLimit: q.rowLimit }, { sleep: async () => { sleeps += 1; } });
    assert.equal(res.status.state, 'SUCCEEDED');
    assert.equal(sleeps, 2);
  } finally {
    await slow.close();
  }
  // wait_timeout 0s → PENDING; cancel → CANCELED.
  const pending = await client.post('/api/2.0/sql/statements', { warehouse_id: W1, statement: 'SELECT 1 AS x', wait_timeout: '0s', disposition: 'INLINE', format: 'JSON_ARRAY' });
  assert.equal(pending.status.state, 'PENDING');
  await client.post('/api/2.0/sql/statements/' + pending.statement_id + '/cancel');
  assert.equal((await client.get('/api/2.0/sql/statements/' + pending.statement_id)).status.state, 'CANCELED');

  const exec = (statement) => http.executeStatement(client, { warehouseId: W1, statement, parameters: [] }, fast);
  await assert.rejects(exec('DELETE FROM billing.usage'), (e) => e.dcc.details.errorCode === 'INVALID_PARAMETER_VALUE');
  await assert.rejects(exec('SELECT 1; DROP TABLE billing.usage'), (e) => e.dcc.details.errorCode === 'INVALID_PARAMETER_VALUE');
  await assert.rejects(exec('SELECT statement_text FROM system.query.history'), (e) => e.dcc.details.errorCode === 'FIXTURE_SENTINEL_READ');
  assert.equal(fx.state.sentinelReads, 1);
  // Reading the list-price field from account_prices fails like Databricks (FIELD_NOT_FOUND).
  await assert.rejects(exec('SELECT p.pricing.effective_list.default FROM system.billing.account_prices p'), (e) => e.dcc.code === 'PRICE_FIELD_MISMATCH');
  await assert.rejects(exec('SELECT * FROM system.billing.nope'), (e) => e.dcc.code === 'TABLE_NOT_FOUND');
  assert.equal(errors.classify(mapEngineError('Binder Error: Referenced column "zzz" not found')).code, 'SCHEMA_MISMATCH');
  await assert.rejects(http.executeStatement(client, { warehouseId: 'ffffffffffffffff', statement: 'SELECT 1', parameters: [] }, fast), (e) => e.dcc.code === 'WAREHOUSE_UNAVAILABLE');
});

test('a statement on a stopped warehouse starts it (simulated billing side effect is observable)', async () => {
  const before = fx.state.warehouseStarts;
  await http.executeStatement(client, { warehouseId: W2, statement: 'SELECT 1 AS x', parameters: [] }, fast);
  assert.equal(fx.state.warehouseStarts, before + 1);
  const list = await warehouses.list(client);
  assert.equal(list.find((w) => w.id === W2).state, 'RUNNING');
});

test('monitor REST data: runs (limit ≤ 25, active/failed), pipelines, clusters', async () => {
  await assert.rejects(client.get('/api/2.2/jobs/runs/list', { limit: 26 }), (e) => e.dcc.details.httpStatus === 400);
  const all = await client.get('/api/2.2/jobs/runs/list', { limit: 25 });
  assert.ok(all.runs.some((r) => r.status.state === 'RUNNING'));
  assert.ok(all.runs.some((r) => r.status.state === 'TERMINATED' && r.status.termination_details.code === 'RUN_EXECUTION_ERROR'));
  assert.ok(all.runs.every((r) => typeof r.job_id === 'number' && typeof r.run_id === 'number'));
  const active = await client.get('/api/2.2/jobs/runs/list', { limit: 25, active_only: true });
  assert.ok(active.runs.length >= 1 && active.runs.every((r) => r.status.state !== 'TERMINATED'));
  const paged = await client.get('/api/2.2/jobs/runs/list', { limit: 2 });
  assert.equal(paged.runs.length, 2);
  assert.equal(paged.has_more, true);
  const next = await client.get('/api/2.2/jobs/runs/list', { limit: 2, page_token: paged.next_page_token });
  assert.notDeepEqual(next.runs.map((r) => r.run_id), paged.runs.map((r) => r.run_id));
  const pipes = await client.get('/api/2.0/pipelines');
  assert.deepEqual(pipes.statuses.map((p) => p.state).sort(), ['FAILED', 'IDLE', 'RUNNING']);
  const clusters = await client.get('/api/2.1/clusters/list');
  assert.ok(clusters.clusters.some((c) => c.state === 'RUNNING'));
  assert.ok(clusters.clusters.some((c) => c.termination_reason && c.termination_reason.type === 'CLOUD_FAILURE'));
  // The failed REST run is the same run the lakeflow table marks FAILED.
  const snap = monitorSnapshot(NOW);
  const failedRest = snap.runs.find((r) => r.state.result_state === 'FAILED');
  const failedLake = buildDataset({ nowMs: NOW }).tables['lakeflow.job_run_timeline'].find((r) => r.result_state === 'FAILED');
  assert.equal(String(failedRest.run_id), failedLake.run_id);
});

test('helper started with --fixture semantics runs summary against the DuckDB fixture with the fake token', async () => {
  const id = readExtensionId();
  const h = await startHelper({ port: 0, extensionId: id, devFixture: true, fetch: rewriteFetch(FIXTURE_ORIGIN, fx.origin), log: () => {}, opener: async () => ({ ok: true }), oauth: { cliInfo: async () => ({ found: false }), getToken: async () => { throw new Error('CLI must not be used for the fixture'); }, login: async () => { throw new Error('no'); }, forget() {} } });
  try {
    const call = (p, body) => rawRequest({ port: h.port, method: 'POST', path: p, headers: { Host: '127.0.0.1:' + h.port, Origin: 'chrome-extension://' + id, 'X-DCC-Key': h.key, 'X-DCC-Protocol': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const wh = await call('/bridge/warehouses', { origin: FIXTURE_ORIGIN });
    assert.equal(wh.json.warehouses.length, 3);
    const q = await call('/bridge/query', { origin: FIXTURE_ORIGIN, workspaceId: '1234567890', kind: 'summary', args: { periodDays: 30 }, conn: { priceTable: 'system.billing.list_prices', currency: 'USD', warehouseId: W1 } });
    assert.equal(q.status, 200, q.text);
    assert.equal(q.json.result.current.coverage, 'partial');
    const login = await call('/bridge/login', { origin: FIXTURE_ORIGIN, purpose: 'cost' });
    assert.equal(login.status, 400, 'login never accepts the fixture origin');
    const runs = await call('/bridge/api', { origin: FIXTURE_ORIGIN, path: '/api/2.2/jobs/runs/list', query: { limit: 5 } });
    assert.equal(runs.json.data.runs.length, 5);
  } finally {
    await h.close();
  }
});

test('`node local/server.mjs --fixture-only` starts the fixture on 8765 (skipped if the port is busy)', async (t) => {
  const busy = await new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.listen(8765, '127.0.0.1', () => s.close(() => resolve(false)));
  });
  if (busy) return t.skip('port 8765 in use');
  const child = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--fixture-only'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    const t0 = Date.now();
    while (!/127\.0\.0\.1:8765/.test(out)) {
      if (Date.now() - t0 > 15000) throw new Error('fixture did not start: ' + out);
      await new Promise((r) => setTimeout(r, 50));
    }
    const r = await rawRequest({ port: 8765, path: '/api/2.0/sql/warehouses', headers: { Host: '127.0.0.1:8765', Authorization: 'Bearer ' + FIXTURE_TOKEN } });
    assert.equal(r.status, 200);
    assert.equal(r.json.warehouses.length, 2);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  }
});

/* ------------------------------------------------------------------ fixture page templating */

const FIXTURE_DIR = path.join(HERE, 'fixture');
const fragmentFiles = () => (fs.existsSync(FIXTURE_DIR) ? fs.readdirSync(FIXTURE_DIR).filter((f) => /^[a-z0-9][a-z0-9_.-]*\.html$/.test(f)).sort() : []);
const placeholdersIn = (text) => [...new Set([...text.matchAll(TEMPLATE_PLACEHOLDER)].map((m) => m[1]))].sort();
const getFixture = (p) => rawRequest({ port: fx.port, path: p, headers: { Host: '127.0.0.1:' + fx.port } });

test('templating: values are HTML-escaped, unknown names are reported and left in place', () => {
  const out = renderFixtureTemplate('<a title="{{A}}" href="/x/{{B}}">{{A}}</a>{{NOPE}}{{lower}}{{ B }}', { A: `<b>"Tom's" & co</b>`, B: '101' });
  assert.equal(out.html, '<a title="&lt;b&gt;&quot;Tom&#39;s&quot; &amp; co&lt;/b&gt;" href="/x/101">&lt;b&gt;&quot;Tom&#39;s&quot; &amp; co&lt;/b&gt;</a>{{NOPE}}{{lower}}{{ B }}');
  assert.deepEqual(out.used, ['A', 'B']);
  assert.deepEqual(out.unknown, ['NOPE']);
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  // Only own string values count (no prototype lookups, no non-strings).
  assert.deepEqual(renderFixtureTemplate('{{CONSTRUCTOR}}{{N}}', Object.assign(Object.create({ CONSTRUCTOR: 'x' }), { N: 5 })).unknown, ['CONSTRUCTOR', 'N']);
  assert.throws(() => legacyFragment('{{NOT_A_FIXTURE_VALUE}}'), /NOT_A_FIXTURE_VALUE/);
});

test('templating: every fragment placeholder has a live and a legacy value; served pages have none left', async () => {
  const live = fixtureTemplateValues(buildDataset({ nowMs: NOW }));
  assert.deepEqual(fx.templateValues, live, 'server renders with the values of its own dataset');
  assert.deepEqual(Object.keys(live).sort(), Object.keys(LEGACY_TEMPLATE_VALUES).sort());
  for (const v of Object.values(live)) assert.equal(typeof v, 'string');
  const files = fragmentFiles();
  assert.ok(files.length >= 10, 'fixture fragments present: ' + files.join(', '));
  const used = new Set();
  for (const f of files) {
    const raw = fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8');
    for (const name of placeholdersIn(raw)) {
      used.add(name);
      assert.ok(Object.prototype.hasOwnProperty.call(live, name), f + ': {{' + name + '}} has no live value');
    }
    assert.doesNotThrow(() => legacyFragment(raw), f);
    const r = await getFixture('/fixture/' + f + '?JOB_101=evil&x={{JOB_101}}');
    assert.equal(r.status, 200, f);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.ok(!/\{\{[^}]*\}\}/.test(r.text), f + ': placeholder left in the served page');
    assert.ok(!/evil/.test(r.text), f + ': request input never reaches the page');
    assert.equal(r.text, renderFixtureTemplate(raw, live).html, f);
    if (/SENTINEL_SQL_TEXT/.test(raw)) assert.equal((r.text.match(/SENTINEL_SQL_TEXT_MUST_NEVER_BE_READ/g) || []).length, (raw.match(/SENTINEL_SQL_TEXT_MUST_NEVER_BE_READ/g) || []).length, f + ': sentinel cells kept');
  }
  // Every value is used somewhere (no dead names), and HEAD works on templated files too.
  assert.deepEqual([...used].sort(), Object.keys(live).sort());
  const head = await rawRequest({ port: fx.port, method: 'HEAD', path: '/fixture/' + files[0], headers: { Host: '127.0.0.1:' + fx.port } });
  assert.equal(head.status, 200);
});

test('templating: linked IDs exist in the billing data; the Launched workflow and the query-history rows match as documented', async () => {
  const { tables } = buildDataset({ nowMs: NOW });
  const v = fx.templateValues;
  const billedRuns = new Set(tables['billing.usage'].map((u) => u.usage_metadata.job_run_id).filter(Boolean));
  const billedUpdates = new Set(tables['billing.usage'].map((u) => u.usage_metadata.dlt_update_id).filter(Boolean));

  const runs = (await getFixture('/fixture/job-runs.html')).text;
  const links = [...runs.matchAll(/href="\/jobs\/(\d+)\/runs\/(\d+)\?o=1234567890"/g)].map((m) => [m[1], m[2]]);
  const own = links.filter(([j]) => j === '101');
  assert.deepEqual([...new Set(own.map(([, r]) => r))], [1, 2, 3, 4].map((k) => v['JOB_101_RUN_D' + k]));
  for (const [, r] of own) assert.ok(billedRuns.has(r), 'run ' + r + ' is billed');
  // Non-matching "Launched" workflow links are kept and have no billing.
  const launched = links.filter(([j]) => j !== '101');
  assert.deepEqual(launched.map(([j]) => j), ['777', '777']);
  assert.ok(/href="\/jobs\/777\?o=1234567890"/.test(runs));
  assert.ok(!tables['billing.usage'].some((u) => u.usage_metadata.job_id === '777'));
  assert.ok(new RegExp('<td role="gridcell">' + v.JOB_101_RUN_D5 + '</td>').test(runs), 'launcher-only row shows the run ID as text');
  assert.ok(billedRuns.has(v.JOB_102_RUN_D1));

  const pipe = (await getFixture('/fixture/pipeline-updates.html')).text;
  for (const k of [1, 2, 3]) {
    assert.ok(pipe.includes('/pipelines/' + v.PIPELINE_P1 + '/updates/' + v['PIPELINE_P1_UPDATE_D' + k]));
    assert.ok(billedUpdates.has(v['PIPELINE_P1_UPDATE_D' + k]));
  }
  // The "Triggered by" link is the job 102 run whose refresh_pipeline task triggered the D1 update.
  assert.ok(pipe.includes('/jobs/102/runs/' + v.JOB_102_RUN_D1 + '?o=1234567890'));
  const upd = tables['lakeflow.pipeline_update_timeline'].find((u) => u.update_id === v.PIPELINE_P1_UPDATE_D1);
  const task = tables['lakeflow.job_task_run_timeline'].find((t) => t.run_id === upd.trigger_details.job_task.job_task_run_id);
  assert.equal(task.job_run_id, v.JOB_102_RUN_D1);

  const wh = (await getFixture('/fixture/warehouses-list.html')).text;
  assert.deepEqual([...wh.matchAll(/data-fx-warehouse="([0-9a-f]{16})"/g)].map((m) => m[1]), WAREHOUSES.map((w) => w.id));
  const apps = (await getFixture('/fixture/apps.html')).text;
  assert.ok(tables['billing.usage'].some((u) => u.usage_metadata.app_name === v.APP_NAME) && apps.includes('/apps/' + v.APP_NAME + '?o='));
  const nb = (await getFixture('/fixture/notebooks.html')).text;
  for (const id of [v.NOTEBOOK_N1, v.NOTEBOOK_N2]) assert.ok(nb.includes('notebooks/' + id) || nb.includes('#notebook/' + id));

  // Query history: statement links exist (FINISHED on W1; one on non-warehouse compute), the
  // running row's statement is not in history yet, and the metadata-only row parses (with the
  // extension's own parsers) to exactly one record, in any time zone thanks to the +00:00 offset.
  const qh = (await getFixture('/fixture/query-history.html')).text;
  const hist = new Map(tables['query.history'].map((h) => [h.statement_id, h]));
  const ids = [...qh.matchAll(/queryId=([0-9a-f-]{36})/g)].map((m) => m[1]);
  assert.deepEqual(ids, [v.STMT_FINISHED, v.STMT_RUNNING, v.STMT_CACHED, v.STMT_NON_WAREHOUSE]);
  assert.equal(hist.get(v.STMT_FINISHED).compute.warehouse_id, WAREHOUSES[0].id);
  assert.equal(hist.get(v.STMT_FINISHED).execution_status, 'FINISHED');
  assert.ok(!hist.has(v.STMT_RUNNING));
  assert.equal(hist.get(v.STMT_NON_WAREHOUSE).compute.type, 'SERVERLESS_COMPUTE');
  assert.equal(v.STMT_NON_WAREHOUSE.slice(-2), String(NON_WAREHOUSE_STATEMENT_INDEX));
  const qhDay = periods.addDays(periods.utcDate(NOW), -queryHistoryDaysAgo(NOW));
  assert.equal(hist.get(v.STMT_FINISHED).start_time.slice(0, 10), qhDay);
  const startMs = nativeCost.parseDisplayedTime(v.QH_META_START, { nowMs: NOW });
  const dur = nativeCost.parseDuration(v.QH_META_DURATION);
  assert.ok(startMs && dur && dur.toleranceMs === 50, v.QH_META_START + ' / ' + v.QH_META_DURATION);
  assert.ok(qh.includes('<td>' + v.QH_META_START + '</td>') && qh.includes('<td>' + v.QH_META_DURATION + '</td>'));
  const lo = Math.ceil(dur.ms - dur.toleranceMs);
  const hi = Math.floor(dur.ms + dur.toleranceMs);
  const matches = tables['query.history'].filter((h) => h.compute.warehouse_id === WAREHOUSES[0].id && Date.parse(h.start_time + 'Z') >= startMs && Date.parse(h.start_time + 'Z') < startMs + 1000 && h.total_duration_ms >= lo && h.total_duration_ms <= hi);
  assert.equal(matches.length, 1, 'metadata row matches exactly one history record');
  for (const k of ['STMT_FINISHED', 'STMT_NON_WAREHOUSE']) {
    const h = hist.get(v[k]);
    assert.equal(nativeCost.parseDisplayedTime(v[k + '_START'], { nowMs: NOW }), Date.parse(h.start_time + 'Z'), k);
    const d = nativeCost.parseDuration(v[k + '_DURATION']);
    assert.ok(Math.abs(d.ms - h.total_duration_ms) <= d.toleranceMs, k);
  }
  // Statement text never appears in the dataset other than the sentinel.
  assert.ok(tables['query.history'].every((h) => h.statement_text === SENTINEL_SQL_TEXT));
});
