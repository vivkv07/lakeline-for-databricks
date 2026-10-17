// "Sign in with Databricks" (OAuth PKCE) and one-click connect. Chrome identity, permissions,
// scripting and the Databricks endpoints are FAKES; this is a simulated test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { load, fakeArea } from './support/load.mjs';

const oauthMod = load('background/oauth.js');
const storeMod = load('background/store.js');
const secretsMod = load('background/secrets.js');
const dataService = load('background/data-service.js');
const helperClient = load('background/helper-client.js');

const ORIGIN = 'https://dbc-4f2a91c7-0e3b.cloud.databricks.com';
const CLIENT = 'lakeline-client-0001';
const REDIRECT = 'https://gcadffgngihfjameoafjagofiompdngo.chromiumapp.org/';
const WH = 'a1b2c3d4e5f60001';
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const BUILTIN_REDIRECT = 'http://localhost:8020';
const PAT = 'dapi' + 'feedface'.repeat(4);
const BAD_PAT = 'dapi' + 'deadbeef'.repeat(4);

/**
 * onTab(url, id) decides what the built-in sign-in tab does: return a URL to navigate to (the
 * default is the localhost redirect with a code), 'close' to close the tab, or null to stay put.
 */
function fakeChrome({ onAuth, onTab, deny = [] } = {}) {
  const session = fakeArea();
  const registered = new Map();
  const calls = { auth: [], scripts: [], removedTabs: [] };
  const listeners = { updated: new Set(), removed: new Set() };
  const on = (set) => ({ addListener: (f) => set.add(f), removeListener: (f) => set.delete(f) });
  return {
    calls,
    registered,
    storage: { session, local: fakeArea() },
    identity: {
      getRedirectURL: () => REDIRECT,
      async launchWebAuthFlow({ url, interactive }) {
        const u = new URL(url);
        calls.auth.push({ url: u, interactive });
        return onAuth ? onAuth(u, interactive) : `${REDIRECT}?code=code-123&state=${u.searchParams.get('state')}`;
      },
    },
    permissions: { contains: async ({ origins }) => !origins.some((o) => deny.includes(o)), getAll: async () => ({ origins: [ORIGIN + '/*'] }) },
    runtime: { getPlatformInfo: (cb) => cb && cb({}) },
    scripting: {
      getRegisteredContentScripts: async ({ ids }) => ids.filter((i) => registered.has(i)).map((i) => registered.get(i)),
      registerContentScripts: async (defs) => defs.forEach((d) => registered.set(d.id, d)),
      updateContentScripts: async (defs) => defs.forEach((d) => registered.set(d.id, d)),
      unregisterContentScripts: async ({ ids }) => ids.forEach((i) => registered.delete(i)),
      executeScript: async () => calls.scripts.push(1),
    },
    tabs: {
      query: async () => [{ id: 7 }],
      async create({ url }) {
        const u = new URL(url);
        calls.auth.push({ url: u, interactive: true, tab: true });
        const id = 100 + calls.auth.length;
        setTimeout(() => {
          // A login page first (ignored), then wherever the sign-in ends.
          for (const f of listeners.updated) f(id, { url: ORIGIN + '/login.html' }, { id });
          const next = onTab ? onTab(u, id) : `${BUILTIN_REDIRECT}/?code=code-123&state=${u.searchParams.get('state')}`;
          if (next === 'close') for (const f of listeners.removed) f(id);
          else if (next) for (const f of listeners.updated) f(id, { url: next }, { id, url: next });
        }, 0);
        return { id };
      },
      async remove(id) {
        calls.removedTabs.push(id);
      },
      onUpdated: on(listeners.updated),
      onRemoved: on(listeners.removed),
    },
    listeners,
  };
}

/** Fake workspace: OIDC token endpoint (checks PKCE) + warehouses list with the org-id header. */
function fakeWorkspace(chrome, { orgId = '1234567890', refreshOk = true } = {}) {
  const seen = { token: [], api: [] };
  async function fetchImpl(url, init) {
    const u = new URL(url);
    if (u.pathname === '/oidc/v1/token') {
      const form = new URLSearchParams(init.body);
      seen.token.push(form);
      assert.equal(init.redirect, 'error');
      if (form.get('grant_type') === 'authorization_code') {
        const auth = chrome.calls.auth.at(-1).url;
        assert.equal(b64url(createHash('sha256').update(form.get('code_verifier')).digest()), auth.searchParams.get('code_challenge'), 'PKCE verifier matches challenge');
        assert.equal(form.get('redirect_uri'), auth.searchParams.get('redirect_uri'));
        assert.ok([REDIRECT, BUILTIN_REDIRECT].includes(form.get('redirect_uri')));
        assert.equal(form.get('client_id'), auth.searchParams.get('client_id'));
        assert.equal(form.get('code'), 'code-123');
        return json(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' });
      }
      if (form.get('grant_type') === 'refresh_token') return refreshOk ? json(200, { access_token: 'at-2', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
    }
    seen.api.push({ path: u.pathname, auth: init.headers.Authorization });
    if (init.headers.Authorization === 'Bearer ' + BAD_PAT) return json(401, { error_code: 'UNAUTHENTICATED', message: 'Invalid access token.' });
    if (u.pathname === '/api/2.0/sql/warehouses') return json(200, { warehouses: [{ id: WH, name: 'Serverless Starter', state: 'RUNNING', cluster_size: 'Small' }] }, { 'x-databricks-org-id': orgId });
    return json(404, { error_code: 'NOT_FOUND', message: 'no route' });
  }
  return { fetchImpl, seen };
}

function json(status, obj, headers = {}) {
  const h = new Map(Object.entries(headers));
  return { ok: status < 300, status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, json: async () => obj, text: async () => JSON.stringify(obj) };
}

test('sign-in uses PKCE S256, the workspace OIDC endpoints and SQL-only scope for costs', async () => {
  const chrome = fakeChrome();
  const ws = fakeWorkspace(chrome);
  const o = oauthMod.create({ chromeApi: chrome, fetch: ws.fetchImpl, cryptoApi: globalThis.crypto });
  await o.signIn({ origin: ORIGIN, clientId: CLIENT });
  const auth = chrome.calls.auth[0].url;
  assert.equal(auth.origin + auth.pathname, ORIGIN + '/oidc/v1/authorize');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('scope'), 'sql offline_access');
  assert.equal(auth.searchParams.get('client_id'), CLIENT);
  assert.equal(await o.getAccessToken(ORIGIN), 'at-1');
  const stored = JSON.stringify(chrome.storage.session.data);
  assert.match(stored, /at-1/, 'tokens live in session storage');
  assert.deepEqual(await o.describe(ORIGIN), { cost: true, apis: false, monitor: false, genie: false, builtin: false });
});

test('monitor sign-in asks separately for all-apis', async () => {
  const chrome = fakeChrome();
  const o = oauthMod.create({ chromeApi: chrome, fetch: fakeWorkspace(chrome).fetchImpl });
  await o.signIn({ origin: ORIGIN, clientId: CLIENT, purpose: 'monitor' });
  assert.equal(chrome.calls.auth[0].url.searchParams.get('scope'), 'all-apis offline_access');
});

test('expired tokens refresh; a failed refresh falls back to a silent sign-in, then AUTH_EXPIRED', async () => {
  let t = 0;
  const chrome = fakeChrome();
  const ws = fakeWorkspace(chrome);
  const o = oauthMod.create({ chromeApi: chrome, fetch: ws.fetchImpl, now: () => t });
  await o.signIn({ origin: ORIGIN, clientId: CLIENT });
  t = 4000 * 1000;
  assert.equal(await o.getAccessToken(ORIGIN), 'at-2');
  assert.equal(ws.seen.token.at(-1).get('grant_type'), 'refresh_token');

  const chrome2 = fakeChrome({ onAuth: (u, interactive) => { if (!interactive) throw new Error('User interaction required.'); return `${REDIRECT}?code=code-123&state=${u.searchParams.get('state')}`; } });
  const ws2 = fakeWorkspace(chrome2, { refreshOk: false });
  let t2 = 0;
  const o2 = oauthMod.create({ chromeApi: chrome2, fetch: ws2.fetchImpl, now: () => t2 });
  await o2.signIn({ origin: ORIGIN, clientId: CLIENT });
  t2 = 4000 * 1000;
  await assert.rejects(o2.getAccessToken(ORIGIN), (e) => e.dcc.code === 'AUTH_EXPIRED');
  assert.equal(chrome2.calls.auth.at(-1).interactive, false, 'silent attempt before giving up');
});

test('state mismatch, provider errors, cancellation and bad client IDs are reported specifically', async () => {
  const mk = (onAuth) => {
    const chrome = fakeChrome({ onAuth });
    return oauthMod.create({ chromeApi: chrome, fetch: fakeWorkspace(chrome).fetchImpl });
  };
  await assert.rejects(mk(() => `${REDIRECT}?code=x&state=forged`).signIn({ origin: ORIGIN, clientId: CLIENT }), (e) => e.dcc.code === 'AUTH_INVALID');
  await assert.rejects(mk((u) => `${REDIRECT}?error=invalid_client&state=${u.searchParams.get('state')}`).signIn({ origin: ORIGIN, clientId: CLIENT }), (e) => e.dcc.code === 'OAUTH_CLIENT_INVALID');
  await assert.rejects(mk(() => { throw new Error('The user did not approve access.'); }).signIn({ origin: ORIGIN, clientId: CLIENT }), (e) => e.dcc.code === 'AUTH_CANCELLED');
  await assert.rejects(mk().signIn({ origin: ORIGIN, clientId: 'x' }), (e) => e.dcc.code === 'OAUTH_CLIENT_MISSING');
  await assert.rejects(mk().signIn({ origin: 'https://evil.example', clientId: CLIENT }));
  await assert.rejects(mk(() => 'https://evil.example/?code=x').signIn({ origin: ORIGIN, clientId: CLIENT }), (e) => e.dcc.code === 'AUTH_INVALID');
});

/* ------------------------------------------------------------------ one-click connect */

async function connectEnv({ clientId = CLIENT, orgId, chromeOpts } = {}) {
  globalThis.DCC = {};
  for (const f of ['core/validate.js', 'core/ids.js', 'errors.js', 'databricks/pricing.js', 'databricks/warehouses.js', 'background/registration.js', 'background/oauth.js']) {
    const mod = load(f);
    const ns = { 'core/validate.js': 'validate', 'core/ids.js': 'ids', 'errors.js': 'errors', 'databricks/pricing.js': 'pricing', 'databricks/warehouses.js': 'warehouses', 'background/registration.js': 'registration', 'background/oauth.js': 'oauth' }[f];
    globalThis.DCC[ns] = mod;
  }
  // Classic script: re-run it against the fresh DCC namespace each time.
  vm.runInThisContext(readFileSync(new URL('../extension/src/background/connect-handlers.js', import.meta.url), 'utf8'));
  const chrome = fakeChrome(chromeOpts);
  const ws = fakeWorkspace(chrome, { orgId });
  const store = storeMod.create(fakeArea());
  await store.migrate();
  if (clientId) await store.updateSettings({ oauth: { clientId } });
  const secrets = secretsMod.create(fakeArea());
  const oauth = oauthMod.create({ chromeApi: chrome, fetch: ws.fetchImpl });
  const helper = helperClient.create({ fetch: async () => { throw new Error('no helper'); }, getBridge: async () => null });
  const data = dataService.create({ store, secrets, helper, oauth, fetch: ws.fetchImpl });
  const handlers = globalThis.DCC.handlerFactories.at(-1)({ store, secrets, data, helper, oauth, chromeApi: chrome });
  return { chrome, ws, store, data, handlers, secrets };
}

test('one click: sign in, detect workspace ID from the API, pick the warehouse, save, register scripts', async () => {
  const env = await connectEnv();
  const out = await env.handlers['connect:oneClick'].handle({ url: ORIGIN + '/jobs' });
  assert.deepEqual({ connected: out.connected, workspaceId: out.workspaceId, warehouse: out.warehouseName }, { connected: true, workspaceId: '1234567890', warehouse: 'Serverless Starter' });
  const conn = await env.store.getConnection(ORIGIN);
  assert.equal(conn.authMode, 'oauth');
  assert.equal(conn.priceTable, 'system.billing.list_prices');
  assert.deepEqual(conn.warehouse, { mode: 'auto', resolvedId: WH, resolvedName: 'Serverless Starter' });
  assert.equal((await env.store.getSettings()).mode, 'connected');
  assert.ok(env.chrome.registered.has('dcc-main'));
  assert.equal(env.ws.seen.api[0].auth, 'Bearer at-1');
  const status = await env.handlers['connect:status'].handle();
  assert.equal(status.state, 'connected');
});

test('one click without a client ID signs in through the built-in client in a tab; one token serves costs, Genie and the monitor', async () => {
  const env = await connectEnv({ clientId: null });
  const out = await env.handlers['connect:oneClick'].handle({ url: ORIGIN + '/jobs' });
  assert.equal(out.connected, true);
  assert.equal(out.method, 'oauth');
  const auth = env.chrome.calls.auth[0];
  assert.equal(auth.tab, true, 'a normal tab, not launchWebAuthFlow');
  assert.equal(auth.url.origin + auth.url.pathname, ORIGIN + '/oidc/v1/authorize');
  assert.equal(auth.url.searchParams.get('client_id'), 'databricks-cli');
  assert.equal(auth.url.searchParams.get('redirect_uri'), BUILTIN_REDIRECT);
  assert.equal(auth.url.searchParams.get('scope'), 'all-apis offline_access');
  assert.equal(auth.url.searchParams.get('code_challenge_method'), 'S256');
  assert.deepEqual(env.chrome.calls.removedTabs, [101], 'the sign-in tab is closed');
  assert.equal(env.chrome.listeners.updated.size + env.chrome.listeners.removed.size, 0, 'tab listeners are removed');
  assert.equal((await env.store.getSettings()).oauth.clientId, null, 'nothing to configure');
  const o = oauthMod.create({ chromeApi: env.chrome, fetch: env.ws.fetchImpl });
  assert.equal(await o.getAccessToken(ORIGIN, 'cost'), 'at-1');
  assert.equal(await o.getAccessToken(ORIGIN, 'genie'), 'at-1');
  assert.equal(await o.getAccessToken(ORIGIN, 'monitor'), 'at-1');
  assert.deepEqual(await o.describe(ORIGIN), { cost: true, apis: true, monitor: true, genie: true, builtin: true });
  assert.equal(env.ws.seen.api.at(-1).auth, 'Bearer at-1');
});

test('a typed client ID that is not valid asks again; a valid one is saved once for every workspace', async () => {
  const env = await connectEnv({ clientId: null });
  const out = await env.handlers['connect:oneClick'].handle({ url: ORIGIN + '/jobs', clientId: 'x' });
  assert.deepEqual(out, { needsChoice: true, needsClientId: true, redirectUrl: REDIRECT });
  assert.equal(env.chrome.calls.auth.length, 0);
  const second = await env.handlers['connect:oneClick'].handle({ url: ORIGIN + '/jobs', clientId: CLIENT });
  assert.equal(second.connected, true);
  assert.equal(env.chrome.calls.auth[0].tab, undefined, 'a registered app uses launchWebAuthFlow');
  assert.equal((await env.store.getSettings()).oauth.clientId, CLIENT, 'saved once for every workspace');
});

test('built-in sign-in: no localhost access refuses before any tab opens; a closed tab cancels; a refused client says so; never silent', async () => {
  const denied = oauthMod.create({ chromeApi: fakeChrome({ deny: ['http://localhost:8020/*'] }), fetch: async () => { throw new Error('no network'); } });
  await assert.rejects(denied.signIn({ origin: ORIGIN, clientId: 'databricks-cli' }), (e) => e.dcc.code === 'PERMISSION_NOT_GRANTED');

  const closing = fakeChrome({ onTab: () => 'close' });
  await assert.rejects(oauthMod.create({ chromeApi: closing, fetch: async () => { throw new Error('no network'); } }).signIn({ origin: ORIGIN, clientId: 'databricks-cli' }), (e) => e.dcc.code === 'AUTH_CANCELLED');
  assert.equal(closing.listeners.updated.size + closing.listeners.removed.size, 0);

  const refused = fakeChrome({ onTab: (u) => `${BUILTIN_REDIRECT}/?error=access_denied&state=${u.searchParams.get('state')}` });
  await assert.rejects(oauthMod.create({ chromeApi: refused, fetch: async () => { throw new Error('no network'); } }).signIn({ origin: ORIGIN, clientId: 'databricks-cli' }), (e) => e.dcc.code === 'BUILTIN_SIGNIN_BLOCKED');

  const wrongState = fakeChrome({ onTab: () => `${BUILTIN_REDIRECT}/?code=code-123&state=forged` });
  await assert.rejects(oauthMod.create({ chromeApi: wrongState, fetch: async () => { throw new Error('no network'); } }).signIn({ origin: ORIGIN, clientId: 'databricks-cli' }), (e) => e.dcc.code === 'AUTH_INVALID');

  const quiet = fakeChrome();
  await assert.rejects(oauthMod.create({ chromeApi: quiet, fetch: async () => { throw new Error('no network'); } }).signIn({ origin: ORIGIN, clientId: 'databricks-cli', interactive: false }), (e) => e.dcc.code === 'AUTH_EXPIRED');
  assert.equal(quiet.calls.auth.length, 0, 'no tab opens without a click');
});

test('built-in sign-in: an expired token refreshes with the built-in client and never opens a tab on its own', async () => {
  let t = 0;
  const chrome = fakeChrome();
  const ws = fakeWorkspace(chrome);
  const o = oauthMod.create({ chromeApi: chrome, fetch: ws.fetchImpl, now: () => t });
  await o.signIn({ origin: ORIGIN, clientId: 'databricks-cli' });
  t = 4000 * 1000;
  assert.equal(await o.getAccessToken(ORIGIN, 'cost'), 'at-2');
  assert.equal(ws.seen.token.at(-1).get('client_id'), 'databricks-cli');
  assert.equal(await o.getAccessToken(ORIGIN, 'genie'), 'at-2', 'the refreshed token is shared');

  const chrome2 = fakeChrome();
  const ws2 = fakeWorkspace(chrome2, { refreshOk: false });
  let t2 = 0;
  const o2 = oauthMod.create({ chromeApi: chrome2, fetch: ws2.fetchImpl, now: () => t2 });
  await o2.signIn({ origin: ORIGIN, clientId: 'databricks-cli' });
  t2 = 4000 * 1000;
  await assert.rejects(o2.getAccessToken(ORIGIN, 'cost'), (e) => e.dcc.code === 'AUTH_EXPIRED');
  assert.equal(chrome2.calls.auth.length, 1, 'no extra sign-in tab');
});

test('one click with a pasted token: saved only after Databricks accepts it; a refused or malformed token is not kept', async () => {
  const env = await connectEnv({ clientId: null });
  await assert.rejects(env.handlers['connect:oneClick'].handle({ url: ORIGIN + '/jobs', method: 'pat', token: 'short' }), (e) => e.dcc.code === 'PAT_FORMAT');
  await assert.rejects(env.handlers['connect:oneClick'].handle({ url: ORIGIN + '/jobs', method: 'pat', token: BAD_PAT, remember: true }), (e) => e.dcc.code === 'PAT_REJECTED');
  assert.equal(await env.secrets.hasPat(ORIGIN), false, 'a refused token is not kept');
  assert.equal(await env.secrets.isPatRemembered(ORIGIN), false);
  assert.equal(await env.store.getConnection(ORIGIN), null);
  assert.equal(env.chrome.calls.auth.length, 0, 'no OAuth for a token');
  const out = await env.handlers['connect:oneClick'].handle({ url: ORIGIN + '/jobs', method: 'pat', token: PAT, remember: false });
  assert.equal(out.connected, true);
  assert.equal(out.method, 'pat');
  assert.equal((await env.store.getConnection(ORIGIN)).authMode, 'pat');
  assert.equal(env.ws.seen.api.at(-1).auth, 'Bearer ' + PAT);
  assert.equal(await env.secrets.getPat(ORIGIN), PAT);
  assert.equal(await env.secrets.isPatRemembered(ORIGIN), false, 'remembered only when asked');
});

test('one click refuses conflicting workspace IDs and non-workspace pages', async () => {
  const env = await connectEnv({ orgId: '999' });
  await assert.rejects(env.handlers['connect:oneClick'].handle({ url: ORIGIN + '/jobs?o=1234567890' }), (e) => e.dcc.code === 'WORKSPACE_MISMATCH');
  await assert.rejects(env.handlers['connect:oneClick'].handle({ url: 'https://accounts.cloud.databricks.com/' }));
  await assert.rejects(env.handlers['connect:oneClick'].handle({ url: 'http://127.0.0.1:8765/jobs' }));
});
