// SIMULATED: in-process helper with a fake Databricks CLI and a fake Databricks REST server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHelper, readExtensionId, VERSION, PROTOCOL } from './server.mjs';
import { createOAuthBridge, profileName } from './oauth-bridge.mjs';
import { fakeCliDir, rawRequest, startFakeDatabricks, rewriteFetch } from './test-helper-fakes.mjs';
import { load } from './support/load.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pricing = load('databricks/pricing.js');
const EXT_ID = readExtensionId();
const EXT_ORIGIN = 'chrome-extension://' + EXT_ID;
const WS = 'https://fixture-helper.cloud.databricks.com';
const WS_OTHER = 'https://fixture-other.cloud.databricks.com';
const WH = 'aaaaaaaaaaaaaaaa';

let helper;
let fakeDb;
let fake;
const logs = [];
const bodies = [];
let openerUrls = [];

async function req(o) {
  const r = await rawRequest(Object.assign({ port: helper.port }, o));
  bodies.push(r.text);
  return r;
}

function bridge(p, body, { origin = EXT_ORIGIN, key = helper.key, protocol = '1', contentType = 'application/json', raw } = {}) {
  const headers = { Host: '127.0.0.1:' + helper.port };
  if (origin !== null) headers.Origin = origin;
  if (key !== null) headers['X-DCC-Key'] = key;
  if (protocol !== null) headers['X-DCC-Protocol'] = protocol;
  if (contentType !== null) headers['Content-Type'] = contentType;
  return req({ method: 'POST', path: p, headers, body: raw !== undefined ? raw : JSON.stringify(body || {}) });
}

const host = () => ({ Host: '127.0.0.1:' + helper.port });
const conn = (over = {}) => Object.assign({ priceTable: 'system.billing.list_prices', usageSource: 'system.billing.usage', historySource: 'system.query.history', currency: 'USD', warehouseId: WH, cloud: 'aws' }, over);

test.before(async () => {
  fake = fakeCliDir();
  fakeDb = await startFakeDatabricks();
  helper = await startHelper({
    port: 0,
    extensionId: EXT_ID,
    oauth: createOAuthBridge({ cliPath: fake.cli, log: (l) => logs.push(l) }),
    fetch: (url, init) => {
      const u = String(url);
      for (const o of [WS, WS_OTHER]) if (u.startsWith(o + '/')) return rewriteFetch(o, fakeDb.origin)(u, init);
      throw new Error('unexpected fetch target');
    },
    log: (l) => logs.push(l),
    opener: async (url) => {
      openerUrls.push(url);
      return { ok: true, label: 'test opener' };
    },
  });
});

test.after(async () => {
  await helper.close();
  await fakeDb.close();
});

test('binds 127.0.0.1 only and rejects any Host header other than 127.0.0.1:<port>', async () => {
  assert.equal(helper.server.address().address, '127.0.0.1');
  for (const h of ['localhost:' + helper.port, '127.0.0.1', 'evil.example', 'evil.example:' + helper.port, '127.0.0.1:' + helper.port + '.evil.example', '[::1]:' + helper.port]) {
    const r = await req({ path: '/health', headers: { Host: h } });
    assert.equal(r.status, 403, h);
    assert.equal(r.json, null);
  }
  const noHost = await req({ path: '/health', setHost: false });
  assert.ok(noHost.status >= 400);
  const bridgeWrongHost = await req({ method: 'POST', path: '/bridge/hello', headers: { Host: 'localhost:' + helper.port, Origin: EXT_ORIGIN, 'X-DCC-Key': helper.key, 'X-DCC-Protocol': '1', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(bridgeWrongHost.status, 403);
  const ok = await req({ path: '/health', headers: host() });
  assert.equal(ok.status, 200);
});

test('/health returns only name, version and protocol', async () => {
  const r = await req({ path: '/health', headers: host() });
  assert.deepEqual(r.json, { name: 'dcc-helper', version: VERSION, protocol: PROTOCOL });
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('setup page is static, CSP-locked, has no inline script, and embeds the public extension ID', async () => {
  const html = await req({ path: '/setup', headers: host() });
  assert.equal(html.status, 200);
  assert.match(html.headers['content-type'], /text\/html/);
  assert.match(html.headers['content-security-policy'], /script-src 'self'/);
  assert.match(html.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(html.headers['referrer-policy'], 'no-referrer');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html.text), 'no inline script');
  assert.ok(!/\son[a-z]+=/i.test(html.text), 'no inline handlers');
  const js = await req({ path: '/setup.js', headers: host() });
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
  assert.match(js.text, new RegExp("EXTENSION_ID = '" + EXT_ID + "'"));
  assert.match(js.text, /history\.replaceState\(null, '', '\/setup'\)/);
  assert.ok(!/innerHTML/.test(js.text));
  const css = await req({ path: '/setup.css', headers: host() });
  assert.equal(css.status, 200);
  for (const r of [html, js, css]) assert.ok(!r.text.includes(helper.key));
  assert.equal((await req({ path: '/setup?k=' + helper.key, headers: host() })).text.includes(helper.key), false);
  assert.equal((await req({ path: '/', headers: host() })).status, 404);
  assert.equal((await req({ path: '/server.mjs', headers: host() })).status, 404);
});

test('bridge requires the exact extension origin and the key (401/403 without detail)', async () => {
  const good = await bridge('/bridge/hello');
  assert.equal(good.status, 200);
  assert.equal(good.headers['access-control-allow-origin'], EXT_ORIGIN);
  assert.match(good.headers.vary, /Origin/);
  const edge = await bridge('/bridge/hello', {}, { origin: 'extension://' + EXT_ID });
  assert.equal(edge.status, 200);

  for (const origin of [null, 'https://evil.example', 'http://127.0.0.1:' + helper.port, 'null', 'chrome-extension://' + 'b'.repeat(32), EXT_ORIGIN + '.evil', 'chrome-extension://' + EXT_ID.toUpperCase()]) {
    const r = await bridge('/bridge/hello', {}, { origin });
    assert.equal(r.status, 403, String(origin));
    assert.equal(r.text, '{"ok":false}');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
  for (const key of [null, '', 'f'.repeat(24), helper.key.slice(0, 23), helper.key + '0', helper.key.toUpperCase()]) {
    if (key === helper.key.toUpperCase() && key === helper.key) continue;
    const r = await bridge('/bridge/hello', {}, { key });
    assert.equal(r.status, 401, String(key));
    assert.equal(r.text, '{"ok":false}');
  }
  const proto = await bridge('/bridge/hello', {}, { protocol: '2' });
  assert.equal(proto.status, 409);
  assert.equal(proto.json.error.code, 'HELPER_OUTDATED');
  assert.equal((await bridge('/bridge/hello', {}, { protocol: null })).status, 409);
  assert.equal((await bridge('/bridge/hello', {}, { contentType: 'text/plain' })).status, 415);
  assert.equal((await bridge('/bridge/nope', {})).status, 404);
  const get = await req({ method: 'GET', path: '/bridge/hello', headers: Object.assign(host(), { Origin: EXT_ORIGIN, 'X-DCC-Key': helper.key }) });
  assert.equal(get.status, 405);
});

test('CORS preflight is answered only for the extension origin', async () => {
  const pre = (origin, method = 'POST') => req({ method: 'OPTIONS', path: '/bridge/query', headers: Object.assign(host(), origin ? { Origin: origin } : {}, { 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'content-type,x-dcc-key,x-dcc-protocol', 'Access-Control-Request-Private-Network': 'true' }) });
  const ok = await pre(EXT_ORIGIN);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers['access-control-allow-origin'], EXT_ORIGIN);
  assert.equal(ok.headers['access-control-allow-methods'], 'POST');
  assert.equal(ok.headers['access-control-allow-headers'], 'Content-Type, X-DCC-Key, X-DCC-Protocol');
  assert.equal(ok.headers['access-control-allow-private-network'], 'true');
  assert.match(ok.headers.vary, /Origin/);
  assert.equal((await pre('extension://' + EXT_ID)).status, 204);
  for (const o of ['https://evil.example', 'null', 'http://127.0.0.1:' + helper.port, null]) {
    const r = await pre(o);
    assert.equal(r.status, 403, String(o));
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    assert.equal(r.headers['access-control-allow-private-network'], undefined);
  }
  assert.equal((await pre(EXT_ORIGIN, 'GET')).status, 403);
  const otherPre = await req({ method: 'OPTIONS', path: '/health', headers: Object.assign(host(), { Origin: EXT_ORIGIN, 'Access-Control-Request-Method': 'GET' }) });
  assert.equal(otherPre.status, 403);
});

test('launcher: refuses web origins, browser metadata and preflight; requires its header; never returns credentials', async () => {
  const launch = (headers = {}, method = 'POST') => req({ method, path: '/launcher/open-setup', headers: Object.assign(host(), headers) });
  for (const origin of ['http://evil.example', 'https://evil.example', 'null', EXT_ORIGIN, 'http://127.0.0.1:' + helper.port]) {
    const r = await launch({ 'X-DCC-Launcher': '1', Origin: origin });
    assert.equal(r.status, 403, origin);
  }
  assert.equal((await launch({ 'X-DCC-Launcher': '1', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await launch({ 'X-DCC-Launcher': '1', 'Sec-Fetch-Mode': 'no-cors' })).status, 403);
  assert.equal((await launch({ 'X-DCC-Launcher': '1', Referer: 'https://evil.example/' })).status, 403);
  assert.equal((await launch({})).status, 403);
  assert.equal((await launch({ 'X-DCC-Launcher': '0' })).status, 403);
  assert.equal((await launch({ 'X-DCC-Launcher': '1', Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }, 'OPTIONS')).status, 403);
  assert.equal((await launch({ 'X-DCC-Launcher': '1' }, 'GET')).status, 405);
  assert.equal(openerUrls.length, 0, 'nothing opened for rejected requests');

  const ok = await launch({ 'X-DCC-Launcher': '1' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { opened: true });
  assert.equal(ok.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(openerUrls, ['http://127.0.0.1:' + helper.port + '/setup#k=' + helper.key]);
  assert.equal((await launch({ 'X-DCC-Launcher': '1' })).status, 429, 'throttled');
  assert.equal(openerUrls.length, 1);
});

test('request bodies over 256 KB are refused', async () => {
  const big = JSON.stringify({ origin: WS, pad: 'x'.repeat(300 * 1024) });
  const r = await bridge('/bridge/warehouses', null, { raw: big });
  assert.equal(r.status, 413);
  assert.equal(r.json.ok, false);
  const notObject = await bridge('/bridge/warehouses', null, { raw: '[1,2]' });
  assert.equal(notObject.status, 400);
  const notJson = await bridge('/bridge/warehouses', null, { raw: '{oops' });
  assert.equal(notJson.status, 400);
});

test('/bridge/hello reports capabilities and CLI status, nothing secret', async () => {
  const r = await bridge('/bridge/hello');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.version, VERSION);
  assert.equal(r.json.protocol, 1);
  assert.deepEqual(r.json.capabilities, { accountPrices: true, priceAdapterVersion: pricing.ADAPTER_VERSION, jobPipelineAttribution: true, monitor: true, protocol: 1 });
  assert.deepEqual(r.json.cli, { found: true, version: '1.21.0', supported: true });
});

test('/bridge/login: workspace origins only; dedicated profiles; reuse; monitor uses all-apis', async () => {
  for (const origin of ['http://127.0.0.1:8765', 'https://accounts.cloud.databricks.com', 'https://example.com', WS + '/path']) {
    const r = await bridge('/bridge/login', { origin, purpose: 'cost' });
    assert.equal(r.status, 400, origin);
    assert.equal(r.json.ok, false);
  }
  assert.equal((await bridge('/bridge/login', { origin: WS, purpose: 'admin' })).status, 400);
  const first = await bridge('/bridge/login', { origin: WS, purpose: 'cost' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { ok: true, signedIn: true, reused: false, profile: profileName(WS, 'cost') });
  const again = await bridge('/bridge/login', { origin: WS, purpose: 'cost' });
  assert.equal(again.json.reused, true);
  const mon = await bridge('/bridge/login', { origin: WS, purpose: 'monitor' });
  assert.equal(mon.json.profile, profileName(WS, 'monitor'));
  assert.equal(mon.json.reused, false);
  const loginArgs = fake.calls().filter((c) => c.args[1] === 'login').map((c) => c.args);
  assert.deepEqual(loginArgs, [
    ['auth', 'login', '--host', WS, '--profile', profileName(WS, 'cost'), '--scopes', 'sql'],
    ['auth', 'login', '--host', WS, '--profile', profileName(WS, 'monitor'), '--scopes', 'all-apis'],
  ]);
});

test('old or missing CLI: hello says unsupported, login answers HELPER_CLI_MISSING (never 401/403)', async () => {
  const old = fakeCliDir({ version: '1.11.4' });
  const h2 = await startHelper({ port: 0, extensionId: EXT_ID, oauth: createOAuthBridge({ cliPath: old.cli }), log: (l) => logs.push(l), opener: async () => ({ ok: true }) });
  try {
    const call = (p, body) => rawRequest({ port: h2.port, method: 'POST', path: p, headers: { Host: '127.0.0.1:' + h2.port, Origin: EXT_ORIGIN, 'X-DCC-Key': h2.key, 'X-DCC-Protocol': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const hello = await call('/bridge/hello', {});
    assert.deepEqual(hello.json.cli, { found: true, version: '1.11.4', supported: false });
    const login = await call('/bridge/login', { origin: WS, purpose: 'cost' });
    assert.equal(login.status, 502);
    assert.equal(login.json.error.code, 'HELPER_CLI_MISSING');
    const q = await call('/bridge/query', { origin: WS, workspaceId: '1234567890', kind: 'summary', args: { periodDays: 7 }, conn: conn() });
    assert.equal(q.json.error.code, 'HELPER_CLI_MISSING');
    for (const r of [hello, login, q]) bodies.push(r.text);
  } finally {
    await h2.close();
  }
});

test('/bridge/warehouses returns filtered raw warehouse objects across pages using the cost token', async () => {
  const r = await bridge('/bridge/warehouses', { origin: WS });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.warehouses.map((w) => w.id), [WH, 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc']);
  assert.deepEqual(Object.keys(r.json.warehouses[0]).sort(), ['cluster_size', 'enable_serverless_compute', 'id', 'max_num_clusters', 'min_num_clusters', 'name', 'state', 'warehouse_type']);
  assert.equal(r.json.warehouses[0].enable_serverless_compute, true);
  const gets = fakeDb.seen.gets.filter((g) => g.path === '/api/2.0/sql/warehouses');
  assert.deepEqual(gets.map((g) => g.query.page_token || null), [null, 'page2']);
  assert.ok(gets.every((g) => g.auth === 'Bearer FAKEACCESS-' + profileName(WS, 'cost')));
  // The extension-side normalizer accepts the helper's objects.
  const warehouses = load('databricks/warehouses.js');
  const normalized = r.json.warehouses.map(warehouses.normalize).filter(Boolean);
  assert.equal(normalized.length, 3);
  assert.equal(warehouses.autoSelect(normalized).id, WH);
  const fixture = await bridge('/bridge/warehouses', { origin: 'http://127.0.0.1:8765' });
  assert.equal(fixture.status, 400, 'fixture origin refused unless started with --fixture');
});

test('/bridge/query: only named kinds, no SQL text, validated connection', async () => {
  const before = fakeDb.seen.statements.length;
  const base = { origin: WS, workspaceId: '1234567890', kind: 'summary', args: { periodDays: 7 }, conn: conn() };
  const cases = [
    Object.assign({}, base, { kind: 'dropEverything' }),
    Object.assign({}, base, { kind: 'monitor' }),
    Object.assign({}, base, { kind: undefined }),
    Object.assign({}, base, { statement: 'SELECT 1' }),
    Object.assign({}, base, { sql: 'SELECT 1' }),
    Object.assign({}, base, { conn: conn({ priceTable: 'system.billing.custom_prices' }) }),
    Object.assign({}, base, { conn: conn({ usageSource: 'system.billing.list_prices' }) }),
    Object.assign({}, base, { conn: conn({ warehouseId: 'not-a-warehouse' }) }),
    Object.assign({}, base, { conn: conn({ currency: 'usd; DROP' }) }),
    Object.assign({}, base, { workspaceId: '12a' }),
    Object.assign({}, base, { origin: 'https://evil.example' }),
    Object.assign({}, base, { origin: 'http://127.0.0.1:8765' }),
  ];
  for (const body of cases) {
    const r = await bridge('/bridge/query', body);
    assert.equal(r.status, 400, JSON.stringify(Object.keys(body)) + ' ' + body.kind);
    assert.equal(r.json.ok, false);
  }
  assert.equal(fakeDb.seen.statements.length, before, 'nothing executed');
});

test('/bridge/query runs summary end to end against the fake Databricks server with the CLI token', async () => {
  const r = await bridge('/bridge/query', { origin: WS, workspaceId: '1234567890', kind: 'summary', args: { periodDays: 7, statement: 'DROP TABLE x' }, conn: conn() });
  assert.equal(r.status, 200, r.text);
  const res = r.json.result;
  assert.equal(res.kind, 'summary');
  assert.equal(res.pricingBasis, 'list');
  assert.equal(res.priceTable, 'system.billing.list_prices');
  assert.equal(res.currency, 'USD');
  assert.equal(res.current.coverage, 'complete');
  assert.equal(res.currentAmount, 20);
  assert.equal(res.previousAmount, 10);
  const sent = fakeDb.seen.statements.at(-1);
  assert.equal(sent.auth, 'Bearer FAKEACCESS-' + profileName(WS, 'cost'));
  assert.equal(sent.body.warehouse_id, WH);
  assert.equal(sent.body.disposition, 'INLINE');
  assert.match(sent.body.statement, /FROM `system`\.`billing`\.`usage` u/);
  assert.match(sent.body.statement, /`system`\.`billing`\.`list_prices` p/);
  assert.ok(!/DROP/i.test(sent.body.statement));
  assert.deepEqual(sent.body.parameters.find((p) => p.name === 'workspace_id'), { name: 'workspace_id', value: '1234567890', type: 'STRING' });
  // Account prices: same request shape, other table and field.
  const acct = await bridge('/bridge/query', { origin: WS, workspaceId: '1234567890', kind: 'summary', args: { periodDays: 7 }, conn: conn({ priceTable: 'system.billing.account_prices' }) });
  assert.equal(acct.json.result.pricingBasis, 'account');
  assert.match(fakeDb.seen.statements.at(-1).body.statement, /`system`\.`billing`\.`account_prices` p/);
  assert.ok(!/effective_list/.test(fakeDb.seen.statements.at(-1).body.statement));
});

test('sign-in and upstream auth failures are AUTH_EXPIRED with a non-401/403 status', async () => {
  const notSigned = await bridge('/bridge/query', { origin: WS_OTHER, workspaceId: '1234567890', kind: 'summary', args: { periodDays: 7 }, conn: conn() });
  assert.equal(notSigned.status, 502);
  assert.equal(notSigned.json.error.code, 'AUTH_EXPIRED');
  assert.ok(Array.isArray(notSigned.json.error.steps) && notSigned.json.error.steps.length > 0);
  fakeDb.mode.reject401 = true;
  try {
    const r = await bridge('/bridge/query', { origin: WS, workspaceId: '1234567890', kind: 'summary', args: { periodDays: 7 }, conn: conn() });
    assert.equal(r.status, 502);
    assert.equal(r.json.error.code, 'AUTH_EXPIRED');
    const w = await bridge('/bridge/warehouses', { origin: WS });
    assert.equal(w.status, 502);
    assert.equal(w.json.error.code, 'AUTH_EXPIRED');
  } finally {
    fakeDb.mode.reject401 = false;
  }
});

test('/bridge/api forwards only allowlisted read-only GETs with the monitor token', async () => {
  const id = '11111111-2222-4333-8444-555555555555';
  for (const p of ['/api/2.0/sql/statements', '/api/2.0/sql/statements/' + id, '/api/2.0/sql/statements/' + id + '/cancel', '/api/2.0/clusters/delete', '/api/2.1/clusters/list/../../x', '/api/2.0/sql/warehouses/' + WH + '/start', 'https://evil.example/api/2.1/clusters/list', '/api/2.1/clusters/list?x=1', 42]) {
    const r = await bridge('/bridge/api', { origin: WS, path: p });
    assert.equal(r.status, 400, String(p));
  }
  for (const query of [{ limit: { $gt: 1 } }, { 'bad key': '1' }, { limit: '1&x=2' }, [1]]) {
    const r = await bridge('/bridge/api', { origin: WS, path: '/api/2.2/jobs/runs/list', query });
    assert.equal(r.status, 400, JSON.stringify(query));
  }
  const gets = fakeDb.seen.gets.length;
  const ok = await bridge('/bridge/api', { origin: WS, path: '/api/2.2/jobs/runs/list', query: { limit: 25, active_only: true } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.data.runs[0].status, { state: 'RUNNING' });
  const seen = fakeDb.seen.gets.slice(gets);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].query, { limit: '25', active_only: 'true' });
  assert.equal(seen[0].auth, 'Bearer FAKEACCESS-' + profileName(WS, 'monitor'));
  const notSigned = await bridge('/bridge/api', { origin: WS_OTHER, path: '/api/2.1/clusters/list' });
  assert.equal(notSigned.json.error.code, 'AUTH_EXPIRED');
});

test('the pairing key, CLI tokens and refresh tokens never appear in responses or logs', async () => {
  assert.ok(bodies.length > 50);
  assert.ok(logs.length > 0);
  const all = bodies.join('\n') + '\n' + logs.join('\n');
  assert.ok(!all.includes(helper.key), 'pairing key leaked');
  assert.ok(!/FAKEACCESS|FAKEREFRESH/.test(all), 'CLI token leaked');
  // Sanity: the fake CLI really issued tokens that went to the fake Databricks server.
  assert.ok(fakeDb.seen.statements.some((s) => /FAKEACCESS/.test(s.auth)));
  // The setup files on disk never contain a key-shaped value.
  for (const f of ['setup.html', 'setup.js', 'setup.css']) assert.ok(!/[0-9a-f]{24}/.test(fs.readFileSync(path.join(HERE, f), 'utf8')), f);
});
