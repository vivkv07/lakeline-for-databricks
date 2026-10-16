// Flexible sign-in: "Use my Databricks login" bridge + transport, and remembered tokens.
// Chrome APIs and Databricks are FAKES (simulated); the bridge runs in jsdom.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, fakeArea } from './support/load.mjs';
import { createContentEnv, settle } from './support/content-harness.mjs';

const transportMod = load('background/session-transport.js');
const secretsMod = load('background/secrets.js');
const http = load('databricks/http.js');
const ORIGIN = 'https://dbc-66f420e5-6b1d.cloud.databricks.com';
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
