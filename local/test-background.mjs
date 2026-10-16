// Background module tests. Databricks HTTP is faked; SQL runs on the SIMULATED DuckDB engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, fakeArea } from './support/load.mjs';
import { createEngine, usageRow, listPrice, WS } from './support/sqlengine.mjs';

const http = load('databricks/http.js');
const warehouses = load('databricks/warehouses.js');
const cacheMod = load('background/cache.js');
const storeMod = load('background/store.js');
const secretsMod = load('background/secrets.js');
const dataService = load('background/data-service.js');
const routerMod = load('background/router.js');
const registration = load('background/registration.js');
const helperClient = load('background/helper-client.js');

const ORIGIN = 'https://dbc-1.cloud.databricks.com';
const WH = '0123456789abcdef';
const PAT = ('dapi' + '0123456789abcdef'.repeat(2));
const NOW = Date.parse('2026-10-15T12:00:00Z');

function jsonResponse(status, obj) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj), json: async () => obj };
}

/** Fake Databricks workspace: warehouses list + statement execution on DuckDB. */
function fakeDatabricks(engine, { warehouseList, onRequest } = {}) {
  const calls = [];
  async function fetchImpl(url, init) {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, init });
    if (onRequest) {
      const r = await onRequest(u, init);
      if (r) return r;
    }
    if (init.headers.Authorization !== 'Bearer ' + PAT) return jsonResponse(401, { error_code: 'UNAUTHENTICATED', message: 'Invalid access token' });
    if (u.pathname === '/api/2.0/sql/warehouses') return jsonResponse(200, { warehouses: warehouseList || [{ id: WH, name: 'Starter', state: 'RUNNING', cluster_size: 'Small' }] });
    if (u.pathname === '/api/2.0/sql/statements' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      try {
        return jsonResponse(200, await engine.execute(body));
      } catch (e) {
        return jsonResponse(200, { statement_id: '01ef0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b', status: { state: 'FAILED', error: { error_code: 'BAD_REQUEST', message: e.message } } });
      }
    }
    return jsonResponse(404, { error_code: 'NOT_FOUND', message: 'no route' });
  }
  return { fetchImpl, calls };
}

/* ------------------------------------------------------------------ http */

test('http client only calls allowlisted paths, refuses redirects, validates query params', async () => {
  const seen = [];
  const client = http.create({ origin: ORIGIN, token: PAT, fetch: async (url, init) => (seen.push({ url, init }), jsonResponse(200, {})) });
  await client.get('/api/2.0/sql/warehouses');
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.credentials, 'omit');
  const blocked = (e) => /Blocked/.test(e.dcc.details.message);
  await assert.rejects(client.post('/api/2.1/jobs/run-now', {}), blocked);
  await assert.rejects(client.get('/api/2.0/clusters/delete'), blocked);
  await assert.rejects(client.get('/api/2.0/sql/warehouses', { 'x&y': '1' }));
  await assert.rejects(client.get('/api/2.0/sql/warehouses', { page_token: 'a b"c' }));
  assert.throws(() => http.buildUrl('https://evil.example', '/api/2.0/sql/warehouses'));
  assert.throws(() => http.buildUrl(ORIGIN, '//evil.example/api/2.0/sql/warehouses'));
  assert.equal(seen.length, 1);
});

test('executeStatement polls, classifies failures with statement ID, and cancels on timeout', async () => {
  const id = '01ef0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
  let gets = 0;
  const ok = {
    post: async () => ({ statement_id: id, status: { state: 'PENDING' } }),
    get: async () => (++gets < 2 ? { statement_id: id, status: { state: 'RUNNING' } } : { statement_id: id, status: { state: 'SUCCEEDED' }, manifest: {}, result: {} }),
  };
  const res = await http.executeStatement(ok, { warehouseId: WH, statement: 'SELECT 1', parameters: [] }, { sleep: async () => {} });
  assert.equal(res.status.state, 'SUCCEEDED');

  const failing = { post: async () => ({ statement_id: id, status: { state: 'FAILED', error: { error_code: 'FIELD_NOT_FOUND', message: 'No such struct field `effective_list`' } } }) };
  await assert.rejects(http.executeStatement(failing, { warehouseId: WH, statement: 'x', parameters: [] }), (e) => e.dcc.code === 'PRICE_FIELD_MISMATCH' && e.dcc.details.statementId === id);

  let t = 0;
  const cancelled = [];
  const slow = {
    post: async (path) => (path.endsWith('/cancel') ? (cancelled.push(path), {}) : { statement_id: id, status: { state: 'RUNNING' } }),
    get: async () => ({ statement_id: id, status: { state: 'RUNNING' } }),
  };
  await assert.rejects(http.executeStatement(slow, { warehouseId: WH, statement: 'x', parameters: [] }, { now: () => (t += 60000), sleep: async () => {}, timeoutMs: 100000 }), (e) => e.dcc.code === 'SQL_TIMEOUT');
  assert.equal(cancelled.length, 1);
  await assert.rejects(http.executeStatement(ok, { warehouseId: 'nope', statement: 'x' }), (e) => e.dcc.code === 'WAREHOUSE_UNAVAILABLE');
});

/* ------------------------------------------------------------------ warehouses */

test('Automatic warehouse: running first, then smaller size, then name/id; unusable skipped', () => {
  const list = [
    { id: 'a000000000000001', name: 'Big', state: 'RUNNING', size: 'Large' },
    { id: 'a000000000000002', name: 'Tiny stopped', state: 'STOPPED', size: '2X-Small' },
    { id: 'a000000000000003', name: 'Small run', state: 'RUNNING', size: 'Small' },
    { id: 'a000000000000004', name: 'Alpha', state: 'RUNNING', size: 'Small' },
    { id: 'a000000000000005', name: 'Gone', state: 'DELETED', size: '2X-Small' },
  ];
  assert.equal(warehouses.autoSelect(list).name, 'Alpha');
  assert.equal(warehouses.autoSelect(list.filter((w) => w.state !== 'RUNNING')).name, 'Tiny stopped');
  assert.equal(warehouses.autoSelect([list[4]]), null);
  assert.equal(warehouses.describeSaved({ mode: 'manual', id: 'ffffffffffffffff', name: 'Old' }, list).status, 'unavailable');
  assert.equal(warehouses.describeSaved({ mode: 'auto', resolvedId: 'a000000000000005' }, list).status, 'unavailable');
  assert.equal(warehouses.describeSaved({ mode: 'auto', resolvedId: 'a000000000000003' }, list).status, 'ok');
  assert.equal(warehouses.normalize({ id: "x'; drop", name: 'bad' }), null);
});

test('warehouse listing paginates and drops invalid IDs', async () => {
  const pages = [{ warehouses: [{ id: WH, name: 'A', state: 'RUNNING', cluster_size: 'Small', enable_serverless_compute: true }], next_page_token: 'p2' }, { warehouses: [{ id: 'bad', name: 'B' }, { id: 'fedcba9876543210', name: 'C', state: 'STOPPED', cluster_size: 'Medium' }] }];
  let i = 0;
  const list = await warehouses.list({ get: async () => pages[i++] });
  assert.deepEqual(list.map((w) => w.id), [WH, 'fedcba9876543210']);
  assert.equal(list[0].serverless, true);
});

/* ------------------------------------------------------------------ cache */

test('cache dedupes in-flight work, expires after TTL, and honors force', async () => {
  let t = 0;
  const c = cacheMod.create({ now: () => t, ttlMs: 1000 });
  let runs = 0;
  const work = () => new Promise((r) => setTimeout(() => r(++runs), 5));
  const [a, b] = await Promise.all([c.dedupe('k', work), c.dedupe('k', work)]);
  assert.equal(runs, 1);
  assert.equal(a.value, 1);
  assert.equal(b.joined, true);
  assert.equal((await c.dedupe('k', work)).cached, true);
  t = 2000;
  assert.equal((await c.dedupe('k', work)).value, 2);
  assert.equal((await c.dedupe('k', work, { force: true })).value, 3);
  assert.notEqual(cacheMod.key({ origin: 'a', connRev: 1, kind: 'summary', periodDays: 7 }), cacheMod.key({ origin: 'a', connRev: 2, kind: 'summary', periodDays: 7 }));
  const zero = cacheMod.create();
  zero.set('z', 0);
  assert.equal(zero.get('z'), 0, 'meaningful zero is cached as a value');
  assert.equal(zero.get('missing'), undefined);
});

/* ------------------------------------------------------------------ store */

test('settings migrate from earlier shapes; connections keep their warehouse choice on edit', async () => {
  const area = fakeArea({ 'dcc.settings': { paused: true, period: 7, mode: 'bogus', junk: 1 }, 'dcc.appearance': { entries: { x: 1 } } });
  const store = storeMod.create(area);
  const { settings } = await store.migrate();
  assert.equal(settings.showCosts, false);
  assert.equal(settings.periodDays, 7);
  assert.equal(settings.mode, 'connected');
  assert.ok(!('junk' in settings));
  const base = { origin: ORIGIN, workspaceId: WS, authMode: 'pat', warehouse: { mode: 'manual', id: WH, name: 'Starter' } };
  assert.equal((await store.saveConnection(base)).ok, true);
  const edited = await store.saveConnection({ origin: ORIGIN, workspaceId: WS, authMode: 'pat', priceTable: 'system.billing.account_prices' });
  assert.equal(edited.value.warehouse.mode, 'manual');
  assert.equal(edited.value.warehouse.id, WH);
  assert.equal(edited.value.revision, 2);
  assert.equal((await store.saveConnection({ ...base, priceTable: 'main.x.prices' })).ok, false);
  await store.removeConnection(ORIGIN);
  assert.deepEqual(area.data['dcc.appearance'], { entries: { x: 1 } }, 'billing disconnect never touches appearance');
  const s2 = await store.updateSettings({ periodDays: 90 });
  assert.equal(s2.revision, settings.revision + 1);
});

/* ------------------------------------------------------------------ data service */

async function connectedEnv({ mode = 'connected', engine } = {}) {
  const local = fakeArea();
  const session = fakeArea();
  const store = storeMod.create(local);
  const secrets = secretsMod.create(session);
  await store.migrate();
  await store.updateSettings({ mode, periodDays: 7 });
  await store.saveConnection({ origin: ORIGIN, workspaceId: WS, authMode: 'pat', warehouse: { mode: 'manual', id: WH } });
  await secrets.setPat(ORIGIN, PAT);
  const db = engine || (await createEngine());
  const fake = fakeDatabricks(db);
  const helper = helperClient.create({ fetch: async () => { throw new Error('helper must not be called'); }, getBridge: async () => null });
  const data = dataService.create({ store, secrets, helper, fetch: fake.fetchImpl, now: () => NOW });
  return { store, secrets, data, fake, db, local };
}

test('demo mode returns labeled synthetic data and makes no network requests', async () => {
  const env = await connectedEnv({ mode: 'demo' });
  const s = await env.data.summary({ origin: ORIGIN, workspaceId: WS, periodDays: 7 });
  assert.equal(s.synthetic, true);
  assert.equal(s.pricingBasis, 'demo');
  const rows = await env.data.rows({ origin: ORIGIN, workspaceId: WS, periodDays: 7, refs: [{ type: 'job', jobId: '1', key: 'job:1' }] });
  assert.equal(rows.synthetic, true);
  assert.equal(env.fake.calls.length, 0);
});

test('connected PAT summary runs end-to-end, caches, and isolates by connection revision', async () => {
  const env = await connectedEnv();
  await env.db.insert('billing.usage', [usageRow({ date: '2026-10-10', qty: 4 })]);
  await env.db.insert('billing.list_prices', [listPrice({ price: 0.25 })]);
  const s = await env.data.summary({ origin: ORIGIN, workspaceId: WS, periodDays: 7 });
  assert.equal(s.currentAmount, 1);
  assert.equal(s.priceTable, 'system.billing.list_prices');
  const posts = () => env.fake.calls.filter((c) => c.path === '/api/2.0/sql/statements').length;
  assert.equal(posts(), 1);
  const again = await env.data.summary({ origin: ORIGIN, workspaceId: WS, periodDays: 7 });
  assert.equal(again.cached, true);
  assert.equal(posts(), 1);
  await env.store.saveConnection({ origin: ORIGIN, workspaceId: WS, authMode: 'pat', currency: 'USD' });
  await env.data.summary({ origin: ORIGIN, workspaceId: WS, periodDays: 7 });
  assert.equal(posts(), 2, 'new connection revision → new cache key');
  await assert.rejects(env.data.summary({ origin: ORIGIN, workspaceId: '999', periodDays: 7 }), (e) => e.dcc.code === 'WORKSPACE_MISMATCH');
});

test('results that finish after the connection changed are discarded as stale', async () => {
  const env = await connectedEnv();
  let release;
  const gate = new Promise((r) => (release = r));
  const orig = env.fake.fetchImpl;
  const data = dataService.create({
    store: env.store,
    secrets: env.secrets,
    helper: null,
    now: () => NOW,
    fetch: async (url, init) => {
      if (init.method === 'POST') await gate;
      return orig(url, init);
    },
  });
  const pending = data.summary({ origin: ORIGIN, workspaceId: WS, periodDays: 7 });
  await new Promise((r) => setTimeout(r, 10));
  await env.store.saveConnection({ origin: ORIGIN, workspaceId: WS, authMode: 'pat', priceTable: 'system.billing.account_prices' });
  release();
  assert.deepEqual(await pending, { stale: true });
});

test('connected mode without a token reports expired sign-in, not a generic error', async () => {
  const env = await connectedEnv();
  await env.secrets.clearPat(ORIGIN);
  await assert.rejects(env.data.summary({ origin: ORIGIN, workspaceId: WS, periodDays: 7 }), (e) => e.dcc.code === 'AUTH_EXPIRED');
});

/* ------------------------------------------------------------------ router */

const EXT_ID = 'jfhjmnhnmkgknkjhmchcjddonpngcgna';
const EXT_ORIGIN = 'chrome-extension://' + EXT_ID;

async function routerEnv() {
  const env = await connectedEnv({ mode: 'demo' });
  const opened = [];
  const router = routerMod.create({
    store: env.store,
    secrets: env.secrets,
    data: env.data,
    helper: helperClient.create({ fetch: async () => { throw new Error('no helper'); }, getBridge: async () => null }),
    helperFactory: (o) => helperClient.create({ fetch: async () => jsonResponse(200, { ok: true, version: '0.1.0', capabilities: { priceAdapterVersion: 2, accountPrices: true, jobPipelineAttribution: true, monitor: true } }), getBridge: o.getBridge }),
    chromeApi: {},
    registration,
    extensionId: EXT_ID,
    extensionOrigin: EXT_ORIGIN,
    helperPort: 8766,
    openPage: async (p) => opened.push(p),
  });
  return { ...env, router, opened };
}

const content = (url = ORIGIN + '/jobs?o=' + WS) => ({ id: EXT_ID, url, tab: { id: 1 }, frameId: 0 });
const page = (path) => ({ id: EXT_ID, url: EXT_ORIGIN + path });

test('router validates content senders and workspace IDs on every request', async () => {
  const { router } = await routerEnv();
  const ok = await router.dispatch({ type: 'dcc:summary', origin: ORIGIN, workspaceId: WS, periodDays: 7 }, content());
  assert.equal(ok.ok, true);
  assert.equal(ok.data.synthetic, true);
  const wrongWs = await router.dispatch({ type: 'dcc:summary', origin: ORIGIN, workspaceId: '777', periodDays: 7 }, content(ORIGIN + '/jobs'));
  assert.equal(wrongWs.ok, false);
  assert.equal(wrongWs.error.code, 'WORKSPACE_MISMATCH');
  const fromPage = await router.dispatch({ type: 'dcc:summary', origin: ORIGIN, workspaceId: WS, periodDays: 7 }, page('/ui/popup.html'));
  assert.equal(fromPage.ok, false);
  const foreign = await router.dispatch({ type: 'dcc:summary', origin: ORIGIN, workspaceId: WS, periodDays: 7 }, { ...content(), id: 'other' });
  assert.equal(foreign.ok, false);
  const unknown = await router.dispatch({ type: 'dcc:evil', origin: ORIGIN, workspaceId: WS }, content());
  assert.equal(unknown.ok, false);
});

test('router sanitizes, dedupes and caps badge refs at 40', async () => {
  const { router } = await routerEnv();
  const refs = [];
  for (let i = 0; i < 60; i++) refs.push({ type: 'job', jobId: String(i) });
  refs.push({ type: 'job', jobId: '1' }, { type: 'job', jobId: '1 OR 1=1' }, { type: 'nope' });
  const clean = router.sanitizeRefs(refs);
  assert.equal(clean.length, 40);
  assert.equal(new Set(clean.map((r) => r.key)).size, 40);
  assert.ok(clean.every((r) => /^\d+$/.test(r.jobId)));
});

test('admin messages only from options; page:state never returns secrets', async () => {
  const { router } = await routerEnv();
  const denied = await router.dispatch({ type: 'admin:setPat', origin: ORIGIN, token: PAT }, page('/ui/popup.html'));
  assert.equal(denied.ok, false);
  const allowed = await router.dispatch({ type: 'admin:setPat', origin: ORIGIN, token: PAT }, page('/ui/options.html'));
  assert.equal(allowed.ok, true);
  const state = await router.dispatch({ type: 'page:state' }, page('/ui/popup.html'));
  assert.equal(state.ok, true);
  assert.ok(!JSON.stringify(state).includes(PAT));
  assert.equal(state.data.connections[ORIGIN].secrets.hasPat, true);
});

test('setup pairing only through the external channel from the exact helper origin', async () => {
  const { router, opened, secrets } = await routerEnv();
  const key = '0123456789abcdef01234567';
  const viaRuntime = await router.dispatch({ type: 'setup:pair', key }, page('/ui/options.html'));
  assert.equal(viaRuntime.ok, false);
  const wrongOrigin = await router.dispatch({ type: 'setup:pair', key }, { url: 'http://127.0.0.1:9000/setup', origin: 'http://127.0.0.1:9000' }, { external: true });
  assert.equal(wrongOrigin.ok, false);
  const contentViaExternal = await router.dispatch({ type: 'dcc:summary', origin: ORIGIN, workspaceId: WS, periodDays: 7 }, content(), { external: true });
  assert.equal(contentViaExternal.ok, false);
  const ok = await router.dispatch({ type: 'setup:pair', key }, { url: 'http://127.0.0.1:8766/setup', origin: 'http://127.0.0.1:8766' }, { external: true });
  assert.equal(ok.ok, true);
  assert.equal((await secrets.getBridge()).key, key);
  assert.deepEqual(opened, ['ui/options.html#paired']);
  assert.ok(!opened.some((p) => p.includes(key)), 'pairing key never in the options URL');
});

test('diagnostics are recorded sanitized', async () => {
  const { router, store } = await routerEnv();
  await router.dispatch({ type: 'admin:setPat', origin: ORIGIN, token: 'x' }, page('/ui/options.html'));
  const diag = await store.getDiagnostics();
  assert.ok(diag.length >= 1);
  assert.ok(!JSON.stringify(diag).includes('dapi'));
});

/* ------------------------------------------------------------------ helper capability + registration */

test('helper capability gating blocks SQL an old helper could build incorrectly', async () => {
  const need = helperClient.requiredCapabilities('rows', { priceTable: 'system.billing.account_prices' }, { refs: [{ type: 'job_run' }] });
  assert.deepEqual(helperClient.missingCapabilities({ priceAdapterVersion: 1 }, need).sort(), ['accountPrices', 'jobPipelineAttribution', 'priceAdapterVersion>=2']);
  assert.deepEqual(helperClient.missingCapabilities({ priceAdapterVersion: 2, accountPrices: true, jobPipelineAttribution: true }, need), []);
  const hc = helperClient.create({ fetch: async () => jsonResponse(200, {}), getBridge: async () => ({ key: 'k', port: 8766, capabilities: { priceAdapterVersion: 1 } }) });
  await assert.rejects(hc.assertCapable('summary', { priceTable: 'system.billing.list_prices' }, {}), (e) => e.dcc.code === 'HELPER_OUTDATED');
});

test('content scripts register only for supported granted patterns', () => {
  assert.equal(registration.isSupportedPattern('https://adb-123.7.azuredatabricks.net/*'), true);
  assert.equal(registration.isSupportedPattern('https://*.cloud.databricks.com/*'), true);
  assert.equal(registration.isSupportedPattern('http://127.0.0.1:8765/*'), true);
  assert.equal(registration.isSupportedPattern('https://accounts.cloud.databricks.com/*'), false);
  assert.equal(registration.isSupportedPattern('<all_urls>'), false);
  assert.equal(registration.isSupportedPattern('https://example.com/*'), false);
  assert.equal(registration.isSupportedPattern('http://127.0.0.1:8766/*'), false);
});

test('Settings/Resume work without an identified workspace but still require our top-frame script', async () => {
  const { router, opened, store } = await routerEnv();
  const noId = { id: EXT_ID, url: ORIGIN + '/jobs', tab: { id: 1 }, frameId: 0 };
  assert.equal((await router.dispatch({ type: 'dcc:open', page: 'options', origin: ORIGIN }, noId)).ok, true);
  assert.deepEqual(opened, ['ui/options.html']);
  await store.updateSettings({ showCosts: false });
  assert.equal((await router.dispatch({ type: 'dcc:resume', origin: ORIGIN }, noId)).ok, true);
  assert.equal((await store.getSettings()).showCosts, true);
  assert.equal((await router.dispatch({ type: 'dcc:resume', origin: ORIGIN }, { ...noId, frameId: 2 })).ok, false);
  assert.equal((await router.dispatch({ type: 'dcc:resume', origin: ORIGIN }, { ...noId, url: 'https://evil.example/' })).ok, false);
  assert.equal((await router.dispatch({ type: 'dcc:summary', origin: ORIGIN, workspaceId: '777', periodDays: 7 }, noId)).ok, false, 'data requests still validate the workspace');
});

/** Fake chrome.scripting that behaves like Chrome: async lookups, duplicate IDs rejected. */
function fakeScriptingChrome(origins) {
  const registered = new Map();
  const tick = () => new Promise((r) => setTimeout(r, 1));
  return {
    registered,
    permissions: { getAll: async () => (await tick(), { origins }) },
    scripting: {
      async getRegisteredContentScripts({ ids }) { await tick(); return ids.filter((id) => registered.has(id)).map((id) => registered.get(id)); },
      async registerContentScripts(defs) { await tick(); for (const d of defs) { if (registered.has(d.id)) throw new Error(`Duplicate script ID '${d.id}'`); registered.set(d.id, d); } },
      async updateContentScripts(defs) { await tick(); for (const d of defs) registered.set(d.id, d); },
      async unregisterContentScripts({ ids }) { await tick(); for (const id of ids) registered.delete(id); },
    },
  };
}

test('concurrent registration syncs (grant listener + page request) never fail with a duplicate ID', async () => {
  const c = fakeScriptingChrome(['https://dbc-00000000-test.cloud.databricks.com/*']);
  const results = await Promise.allSettled([registration.sync(c), registration.sync(c), registration.sync(c)]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled']);
  assert.equal(c.registered.size, 1);
  assert.deepEqual(c.registered.get('dcc-main').matches, ['https://dbc-00000000-test.cloud.databricks.com/*']);
});

test('registration recovers when another context registered the script first', async () => {
  const c = fakeScriptingChrome(['https://dbc-1.cloud.databricks.com/*']);
  const realGet = c.scripting.getRegisteredContentScripts;
  let first = true;
  c.scripting.getRegisteredContentScripts = async (q) => {
    const out = await realGet(q);
    if (first) { first = false; c.registered.set('dcc-main', { id: 'dcc-main', matches: [] }); return []; }
    return out;
  };
  await registration.sync(c);
  assert.deepEqual(c.registered.get('dcc-main').matches, ['https://dbc-1.cloud.databricks.com/*']);
});
