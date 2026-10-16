// Unit tests for src/background/ui-handlers.js (popup → options connect hand-off).
// Runs the module as CommonJS with an in-memory storage area; the router test uses the real
// router and sender validation with synthetic sender objects (no browser involved).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { load, fakeArea } from './support/load.mjs';

const require = createRequire(import.meta.url);
const uiHandlers = load('background/ui-handlers.js');
const routerMod = load('background/router.js');
const storeMod = load('background/store.js');
const secretsMod = load('background/secrets.js');

const ORIGIN = 'https://dbc-1.cloud.databricks.com';
const EXT_ID = 'testextensionid';
const EXT_ORIGIN = 'chrome-extension://' + EXT_ID;
const T0 = Date.parse('2026-10-15T12:00:00Z');

function make({ now = () => T0, secrets } = {}) {
  const session = fakeArea();
  const handlers = uiHandlers.create({ chromeApi: { storage: { session } }, secrets: secrets || secretsMod.create(fakeArea()) }, { now });
  return { session, handlers };
}

test('handlers declare the expected trust classes', () => {
  const { handlers } = make();
  assert.equal(handlers['page:setPendingConnect'].trust, 'page');
  assert.equal(handlers['admin:takePendingConnect'].trust, 'admin');
  assert.equal(handlers['admin:secretStatus'].trust, 'admin');
});

test('setPendingConnect keeps only the origin and a numeric workspace ID', async () => {
  const { session, handlers } = make();
  const url = ORIGIN + '/editor/notebooks/123?o=4242&token=abc123secretvalue#cell';
  const out = await handlers['page:setPendingConnect'].handle({ url });
  assert.deepEqual(out, { origin: ORIGIN, workspaceId: '4242', conflict: false });
  const stored = session.data[uiHandlers.PENDING_KEY];
  assert.deepEqual(Object.keys(stored).sort(), ['at', 'conflict', 'origin', 'workspaceId']);
  assert.equal(stored.origin, ORIGIN);
  const raw = JSON.stringify(session.data);
  assert.ok(!raw.includes('notebooks'), 'path is not stored');
  assert.ok(!raw.includes('abc123secretvalue'), 'other query params are not stored');
});

test('setPendingConnect resolves host-encoded IDs and flags conflicting IDs', async () => {
  const { handlers } = make();
  const azure = await handlers['page:setPendingConnect'].handle({ url: 'https://adb-777.12.azuredatabricks.net/' });
  assert.deepEqual(azure, { origin: 'https://adb-777.12.azuredatabricks.net', workspaceId: '777', conflict: false });
  const conflict = await handlers['page:setPendingConnect'].handle({ url: ORIGIN + '/?o=1&w=2' });
  assert.deepEqual(conflict, { origin: ORIGIN, workspaceId: null, conflict: true });
});

test('setPendingConnect rejects account consoles, unrelated sites and bad input', async () => {
  const { session, handlers } = make();
  for (const url of ['https://accounts.cloud.databricks.com/', 'https://example.com/', 'http://dbc-1.cloud.databricks.com/', 'https://u:p@dbc-1.cloud.databricks.com/', 'x'.repeat(5000), 42, null]) {
    await assert.rejects(handlers['page:setPendingConnect'].handle({ url }), (e) => e.dcc && e.dcc.code === 'UNKNOWN');
  }
  assert.equal(session.data[uiHandlers.PENDING_KEY], undefined);
  // The local fixture is a supported origin.
  const fx = await handlers['page:setPendingConnect'].handle({ url: 'http://127.0.0.1:8765/workspace.html?o=9' });
  assert.deepEqual(fx, { origin: 'http://127.0.0.1:8765', workspaceId: '9', conflict: false });
});

test('takePendingConnect returns the hand-off once, then clears it', async () => {
  const { session, handlers } = make();
  await handlers['page:setPendingConnect'].handle({ url: ORIGIN + '/jobs?o=42' });
  const first = await handlers['admin:takePendingConnect'].handle({});
  assert.deepEqual(first, { origin: ORIGIN, cloud: 'aws', kind: 'workspace', workspaceId: '42', conflict: false });
  assert.equal(session.data[uiHandlers.PENDING_KEY], undefined);
  assert.equal(await handlers['admin:takePendingConnect'].handle({}), null);
});

test('expired, future-dated and tampered hand-offs are dropped', async () => {
  let now = T0;
  const { session, handlers } = make({ now: () => now });
  await handlers['page:setPendingConnect'].handle({ url: ORIGIN + '/?o=42' });
  now = T0 + uiHandlers.PENDING_TTL_MS + 1;
  assert.equal(await handlers['admin:takePendingConnect'].handle({}), null);
  assert.equal(session.data[uiHandlers.PENDING_KEY], undefined, 'expired entry is still cleared');

  const s = uiHandlers.sanitizePending;
  assert.equal(s({ origin: ORIGIN, workspaceId: '42', at: T0 + 5 * 60 * 1000 }, T0), null, 'future-dated');
  assert.equal(s({ origin: 'https://evil.example.com', workspaceId: '42', at: T0 }, T0), null, 'unsupported origin');
  assert.equal(s({ origin: ORIGIN + '/path', workspaceId: '42', at: T0 }, T0), null, 'non-canonical origin');
  assert.equal(s({ origin: ORIGIN, at: 'yesterday' }, T0), null, 'bad timestamp');
  assert.equal(s(null, T0), null);
  assert.deepEqual(s({ origin: ORIGIN, workspaceId: '0042x', conflict: 'yes', at: T0 }, T0), { origin: ORIGIN, cloud: 'aws', kind: 'workspace', workspaceId: null, conflict: false });
});

test('secretStatus reports whether a token exists, never the token', async () => {
  const secrets = secretsMod.create(fakeArea());
  const token = 'dapi' + '0123456789abcdef'.repeat(2);
  await secrets.setPat(ORIGIN, token);
  const { handlers } = make({ secrets });
  const yes = await handlers['admin:secretStatus'].handle({ origin: ORIGIN });
  assert.deepEqual(yes, { origin: ORIGIN, hasPat: true });
  assert.ok(!JSON.stringify(yes).includes(token));
  const no = await handlers['admin:secretStatus'].handle({ origin: 'https://dbc-2.cloud.databricks.com' });
  assert.deepEqual(no, { origin: 'https://dbc-2.cloud.databricks.com', hasPat: false });
  await assert.rejects(handlers['admin:secretStatus'].handle({ origin: 'https://example.com' }));
});

test('missing session storage fails with a sanitized error', async () => {
  const handlers = uiHandlers.create({ chromeApi: {} });
  await assert.rejects(handlers['page:setPendingConnect'].handle({ url: ORIGIN }), (e) => e.dcc && e.dcc.code === 'UNKNOWN');
});

test('through the real router: popup may hand off, only the options page may take it', async () => {
  const session = fakeArea();
  const store = storeMod.create(fakeArea());
  const secrets = secretsMod.create(fakeArea());
  const router = routerMod.create({
    store,
    secrets,
    extensionId: EXT_ID,
    extensionOrigin: EXT_ORIGIN,
    helperPort: 8766,
    extra: uiHandlers.create({ store, secrets, chromeApi: { storage: { session } } }),
  });
  const popup = { id: EXT_ID, url: EXT_ORIGIN + '/ui/popup.html' };
  const options = { id: EXT_ID, url: EXT_ORIGIN + '/ui/options.html#connect' };
  const content = { id: EXT_ID, url: ORIGIN + '/jobs?o=42', tab: { id: 1 }, frameId: 0 };

  const set = await router.dispatch({ type: 'page:setPendingConnect', url: ORIGIN + '/jobs?o=42' }, popup);
  assert.equal(set.ok, true);
  const fromContent = await router.dispatch({ type: 'page:setPendingConnect', url: ORIGIN + '/jobs?o=42' }, content);
  assert.equal(fromContent.ok, false, 'content scripts are not page senders');
  const fromPopup = await router.dispatch({ type: 'admin:takePendingConnect' }, popup);
  assert.equal(fromPopup.ok, false, 'popup is not an admin page');
  const taken = await router.dispatch({ type: 'admin:takePendingConnect' }, options);
  assert.equal(taken.ok, true);
  assert.equal(taken.data.origin, ORIGIN);
  assert.equal(taken.data.workspaceId, '42');
  const again = await router.dispatch({ type: 'admin:takePendingConnect' }, options);
  assert.deepEqual(again, { ok: true, data: null });
});

test('as a classic script it registers a handler factory on DCC.handlerFactories', () => {
  const src = readFileSync(new URL('../extension/src/background/ui-handlers.js', import.meta.url), 'utf8');
  const DCC = {
    validate: require('../extension/src/core/validate.js'),
    ids: require('../extension/src/core/ids.js'),
    errors: require('../extension/src/errors.js'),
    handlerFactories: [() => ({ 'monitor:open': { trust: 'page', handle: () => null } })],
  };
  const ctx = vm.createContext({ DCC });
  ctx.globalThis = ctx;
  vm.runInContext(src, ctx);
  assert.equal(DCC.handlerFactories.length, 2, 'appends without replacing other add-ons');
  const made = DCC.handlerFactories[1]({ chromeApi: { storage: { session: fakeArea() } } });
  assert.deepEqual(Object.keys(made).sort(), ['admin:secretStatus', 'admin:takePendingConnect', 'page:setPendingConnect']);
  assert.ok(DCC.uiHandlers && typeof DCC.uiHandlers.create === 'function');
});
