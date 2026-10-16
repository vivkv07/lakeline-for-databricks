// Flexible sign-in: "Use my Databricks login" bridge + transport, and remembered tokens.
// Chrome APIs and Databricks are FAKES (simulated); the bridge runs in jsdom.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, fakeArea } from './support/load.mjs';
import { createContentEnv, settle } from './support/content-harness.mjs';

const transportMod = load('background/session-transport.js');
const secretsMod = load('background/secrets.js');
const http = load('databricks/http.js');
const ORIGIN = 'https://dbc-00000000-test.cloud.databricks.com';
const EXT = 'testextensionid';

function chromeWithTab(reply, tabs = [{ id: 3, active: true, status: 'complete' }]) {
  const sent = [];
  return { sent, tabs: { query: async () => tabs, sendMessage: async (id, msg) => (sent.push({ id, msg }), typeof reply === 'function' ? reply(msg) : reply) } };
}

test('transport relays allowlisted calls through the open workspace tab and surfaces the org-id header', async () => {
  const c = chromeWithTab({ ok: true, status: 200, orgId: '1234567890', contentType: 'application/json', text: JSON.stringify({ warehouses: [] }) });
  const f = transportMod.create({ chromeApi: c }).fetchFor(ORIGIN);
  const client = http.create({ origin: ORIGIN, token: null, fetch: f });
  let org = null;
  const res = await http.create({ origin: ORIGIN, token: null, fetch: f, onHeaders: (h) => (org = h.get('x-databricks-org-id')) }).get('/api/2.0/sql/warehouses');
  assert.deepEqual(res, { warehouses: [] });
  assert.equal(org, '1234567890');
  assert.equal(c.sent[0].id, 3);
  assert.deepEqual(c.sent[0].msg, { type: 'dcc:sessionFetch', method: 'GET', path: '/api/2.0/sql/warehouses', body: undefined });
  await assert.rejects(client.post('/api/2.1/jobs/run-now', {}), (e) => /Blocked/.test(e.dcc.details.message));
});

test('transport failures are specific: no tab, unreachable tab, expired login, workspace refusal; API errors pass through', async () => {
  const mk = (reply, tabs) => http.create({ origin: ORIGIN, token: null, fetch: transportMod.create({ chromeApi: chromeWithTab(reply, tabs) }).fetchFor(ORIGIN) });
  await assert.rejects(mk({}, []).get('/api/2.0/sql/warehouses'), (e) => e.dcc.code === 'SESSION_TAB_REQUIRED');
  await assert.rejects(mk(() => { throw new Error('Receiving end does not exist'); }).get('/api/2.0/sql/warehouses'), (e) => e.dcc.code === 'SESSION_TAB_REQUIRED');
  await assert.rejects(mk({ ok: false, network: true, message: 'redirect' }).get('/api/2.0/sql/warehouses'), (e) => e.dcc.code === 'SESSION_EXPIRED');
  await assert.rejects(mk({ ok: true, status: 403, text: '<html>Forbidden</html>' }).get('/api/2.0/sql/warehouses'), (e) => e.dcc.code === 'SESSION_REJECTED');
  await assert.rejects(mk({ ok: true, status: 403, text: JSON.stringify({ error_code: 'PERMISSION_DENIED', message: 'You do not have permission to use the SQL warehouse (CAN_USE)' }) }).get('/api/2.0/sql/warehouses'), (e) => e.dcc.code === 'WAREHOUSE_ACCESS_DENIED');
  assert.throws(() => transportMod.create({ chromeApi: chromeWithTab({}) }).fetchFor('https://evil.example'));
});

test('http client sends no Authorization header in browser-login mode', async () => {
  let seen;
  const client = http.create({ origin: ORIGIN, token: null, fetch: async (url, init) => ((seen = init), { ok: true, status: 200, text: async () => '{}', headers: { get: () => null } }) });
  await client.get('/api/2.0/sql/warehouses');
  assert.equal('Authorization' in seen.headers, false);
});

const BRIDGE_FILES = ['src/core/validate.js', 'src/core/ids.js', 'src/errors.js', 'src/databricks/http.js', 'src/content/session-bridge.js'];

function bridgeEnv(pageFetch) {
  const env = createContentEnv({ url: ORIGIN + '/jobs?o=1234567890', html: '<body><main></main></body>', files: [] });
  const listeners = [];
  env.window.chrome.runtime.onMessage = { addListener: (fn) => listeners.push(fn) };
  env.window.chrome.runtime.id = EXT;
  env.window.fetch = pageFetch;
  for (const f of BRIDGE_FILES) env.window.eval(env.read ? env.read(f) : require_(f));
  return { env, deliver: (msg, sender) => new Promise((resolve) => { const handled = listeners[0](msg, sender, resolve); if (!handled) resolve('ignored'); }) };
}

import { readFileSync } from 'node:fs';
function require_(f) { return readFileSync(new URL('../extension/' + f, import.meta.url), 'utf8'); }

test('bridge answers only our service worker, same origin, allowlisted paths, with the page login (credentials same-origin)', async () => {
  const calls = [];
  const { deliver } = bridgeEnv(async (url, init) => (calls.push({ url, init }), { status: 200, headers: { get: (k) => (k === 'x-databricks-org-id' ? '1234567890' : 'application/json') }, text: async () => '{"warehouses":[]}' }));
  const fromSw = { id: EXT, url: 'chrome-extension://' + EXT + '/src/background/service-worker.js' };
  const ok = await deliver({ type: 'dcc:sessionFetch', method: 'GET', path: '/api/2.0/sql/warehouses' }, fromSw);
  assert.equal(ok.ok, true);
  assert.equal(ok.orgId, '1234567890');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(await deliver({ type: 'dcc:sessionFetch', method: 'GET', path: '/api/2.0/sql/warehouses' }, { id: 'other-extension' }), 'ignored');
  assert.equal(await deliver({ type: 'dcc:sessionFetch', method: 'GET', path: '/api/2.0/sql/warehouses' }, { id: EXT, tab: { id: 1 } }), 'ignored', 'content scripts in other tabs cannot use it');
  assert.equal((await deliver({ type: 'dcc:sessionFetch', method: 'POST', path: '/api/2.1/jobs/run-now', body: '{}' }, fromSw)).blocked, 'path');
  assert.equal((await deliver({ type: 'dcc:sessionFetch', method: 'GET', path: 'https://evil.example/api/2.0/sql/warehouses' }, fromSw)).blocked, 'cross-origin');
  assert.equal(calls.length, 1, 'refused requests never reach fetch');
});

test('bridge reports a redirect to the sign-in page as an expired login', async () => {
  const { deliver } = bridgeEnv(async () => { throw new TypeError('Failed to fetch'); });
  const r = await deliver({ type: 'dcc:sessionFetch', method: 'GET', path: '/api/2.0/sql/warehouses' }, { id: EXT });
  assert.equal(r.network, true);
});

test('tokens are session-only unless the user chooses "Remember on this computer"', async () => {
  const session = fakeArea();
  const local = fakeArea();
  const s = secretsMod.create(session, local);
  const T = ('dapi' + '0123456789abcdef'.repeat(2));
  await s.setPat(ORIGIN, T);
  assert.equal(JSON.stringify(local.data).includes(T), false);
  await s.setPat(ORIGIN, T, { remember: true });
  assert.equal(await s.isPatRemembered(ORIGIN), true);
  // Browser restart: session storage is empty, the remembered token comes back.
  const afterRestart = secretsMod.create(fakeArea(), local);
  assert.equal(await afterRestart.getPat(ORIGIN), T);
  const d = await afterRestart.describe(ORIGIN);
  assert.deepEqual([d.hasPat, d.patRemembered], [true, true]);
  assert.equal(JSON.stringify(d).includes(T), false);
  await afterRestart.clearPat(ORIGIN);
  assert.equal(await secretsMod.create(fakeArea(), local).getPat(ORIGIN), null, 'clearing forgets it everywhere');
  await s.setPat(ORIGIN, T, { remember: false });
  assert.equal(await s.isPatRemembered(ORIGIN), false, 'saving without remember drops an earlier remembered copy');
});

/* ------------------------------------------------------------------ connect with my login */
import vm from 'node:vm';
const storeMod = load('background/store.js');
const dataService = load('background/data-service.js');
const helperClient = load('background/helper-client.js');

async function sessionConnectEnv(reply) {
  globalThis.DCC = {};
  const map = { 'core/validate.js': 'validate', 'core/ids.js': 'ids', 'errors.js': 'errors', 'databricks/pricing.js': 'pricing', 'databricks/warehouses.js': 'warehouses', 'background/registration.js': 'registration', 'background/oauth.js': 'oauth' };
  for (const [f, ns] of Object.entries(map)) globalThis.DCC[ns] = load(f);
  vm.runInThisContext(readFileSync(new URL('../extension/src/background/connect-handlers.js', import.meta.url), 'utf8'));
  const registered = new Map();
  const injected = [];
  const sent = [];
  const chrome = {
    storage: { session: fakeArea() },
    identity: { getRedirectURL: () => 'https://x.chromiumapp.org/' },
    permissions: { contains: async () => true, getAll: async () => ({ origins: [ORIGIN + '/*'] }) },
    scripting: {
      getRegisteredContentScripts: async ({ ids }) => ids.filter((i) => registered.has(i)).map((i) => registered.get(i)),
      registerContentScripts: async (d) => d.forEach((x) => registered.set(x.id, x)),
      updateContentScripts: async (d) => d.forEach((x) => registered.set(x.id, x)),
      unregisterContentScripts: async () => {},
      executeScript: async (o) => injected.push(o.target.tabId),
    },
    tabs: { query: async () => [{ id: 9, active: true, status: 'complete' }], sendMessage: async (id, msg) => (sent.push(msg), typeof reply === 'function' ? reply(msg) : reply) },
  };
  const store = storeMod.create(fakeArea());
  await store.migrate();
  const data = dataService.create({ store, secrets: secretsMod.create(fakeArea()), helper: helperClient.create({ fetch: async () => { throw new Error('no'); }, getBridge: async () => null }), sessionTransport: transportMod.create({ chromeApi: chrome }), fetch: async () => { throw new Error('direct fetch must not be used in browser-login mode'); } });
  const handlers = globalThis.DCC.handlerFactories.at(-1)({ store, data, chromeApi: chrome, oauth: null });
  return { handlers, store, sent, injected, registered };
}

test('connect with my Databricks login: bridge injected first, warehouses via the tab, ID from header, saved as session', async () => {
  const env = await sessionConnectEnv({ ok: true, status: 200, orgId: '1234567890', text: JSON.stringify({ warehouses: [{ id: 'a1b2c3d4e5f60001', name: 'Starter', state: 'RUNNING', cluster_size: 'Small' }] }) });
  const out = await env.handlers['connect:oneClick'].handle({ url: ORIGIN + '/jobs', method: 'session' });
  assert.deepEqual([out.connected, out.method, out.workspaceId, out.warehouseName], [true, 'session', '1234567890', 'Starter']);
  assert.ok(env.injected.includes(9), 'bridge injected into the open tab before the first request');
  assert.equal(env.sent[0].path, '/api/2.0/sql/warehouses');
  const conn = await env.store.getConnection(ORIGIN);
  assert.equal(conn.authMode, 'session');
  assert.equal(conn.workspaceId, '1234567890');
});

test('connect with my Databricks login reports a refusing workspace instead of claiming success', async () => {
  const env = await sessionConnectEnv({ ok: true, status: 401, text: '<html>login</html>' });
  await assert.rejects(env.handlers['connect:oneClick'].handle({ url: ORIGIN + '/jobs', method: 'session' }), (e) => e.dcc.code === 'SESSION_REJECTED');
  assert.equal(await env.store.getConnection(ORIGIN), null, 'nothing saved');
});

test('no method and no client ID asks the user to choose instead of failing', async () => {
  const env = await sessionConnectEnv({});
  const out = await env.handlers['connect:oneClick'].handle({ url: ORIGIN + '/jobs' });
  assert.equal(out.needsChoice, true);
  assert.equal(env.sent.length, 0);
});

test('Genie over browser login: only requests tagged with the Genie scope reach Genie paths', async () => {
  const calls = [];
  const { deliver } = bridgeEnv(async (url, init) => (calls.push({ url, init }), { status: 200, headers: { get: () => 'application/json' }, text: async () => '{"conversation_id":"c1"}' }));
  const fromSw = { id: EXT };
  const space = '01ef0a1b2c3d4e5f8a9b0c1d2e3f4a5b';
  const path = '/api/2.0/genie/spaces/' + space + '/start-conversation';
  const untagged = await deliver({ type: 'dcc:sessionFetch', method: 'POST', path, body: '{"content":"q"}' }, fromSw);
  const tagged = await deliver({ type: 'dcc:sessionFetch', method: 'POST', path, body: '{"content":"q"}', scope: 'genie' }, fromSw);
  const genieCannotRunSql = await deliver({ type: 'dcc:sessionFetch', method: 'POST', path: '/api/2.0/sql/statements', body: '{}', scope: 'genie' }, fromSw);
  if (http.isAllowed('POST', path, { scope: 'genie' })) {
    assert.equal(untagged.blocked, 'path', 'default allowlist never reaches Genie');
    assert.equal(tagged.ok, true);
  }
  assert.equal(genieCannotRunSql.blocked, 'path', 'a Genie-scoped request cannot reach other APIs');
});

test('transport tags Genie-scoped requests and leaves others untagged', async () => {
  const c = chromeWithTab({ ok: true, status: 200, text: '{}' });
  const t = transportMod.create({ chromeApi: c });
  await t.fetchFor(ORIGIN, { scope: 'genie' })(ORIGIN + '/api/2.0/genie/spaces', {});
  await t.fetchFor(ORIGIN)(ORIGIN + '/api/2.0/sql/warehouses', {});
  assert.equal(c.sent[0].msg.scope, 'genie');
  assert.equal('scope' in c.sent[1].msg, false);
});

test('a 401 in browser-login mode is a refused login, never "sign-in expired" (real Databricks wording)', async () => {
  const reply = { ok: true, status: 401, text: JSON.stringify({ error_code: 401, message: 'Credential was not sent or was of an unsupported type for this API. [ReqId: 0000]' }) };
  const client = http.create({ origin: ORIGIN, token: null, fetch: transportMod.create({ chromeApi: chromeWithTab(reply) }).fetchFor(ORIGIN) });
  await assert.rejects(client.get('/api/2.0/sql/warehouses'), (e) => e.dcc.code === 'SESSION_REJECTED' && /browser login/.test(e.dcc.title));
});

test('store build flag: the background refuses browser login when sessionLogin is false', async () => {
  const env = await sessionConnectEnv({ ok: true, status: 200, orgId: '1234567890', text: '{"warehouses":[]}' });
  globalThis.DCC.flags = Object.freeze({ sessionLogin: false });
  await assert.rejects(env.handlers['connect:oneClick'].handle({ url: ORIGIN + '/jobs', method: 'session' }), (e) => /not available in this build/.test(e.dcc.details.message));
  assert.equal(env.sent.length, 0, 'no request reaches the tab');
  delete globalThis.DCC.flags;
});
