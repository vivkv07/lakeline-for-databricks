// Sign-in methods: remembered tokens and the default connect path. Chrome APIs and Databricks are
// FAKES (simulated).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { load, fakeArea } from './support/load.mjs';

const secretsMod = load('background/secrets.js');
const storeMod = load('background/store.js');
const dataService = load('background/data-service.js');
const helperClient = load('background/helper-client.js');
const config = load('databricks/config.js');
const ORIGIN = 'https://dbc-00000000-test.cloud.databricks.com';

test('tokens are session-only unless the user chooses "Remember on this computer"', async () => {
  const session = fakeArea();
  const kept = fakeArea(); // the extension-only IndexedDB area in the service worker
  const s = secretsMod.create(session, kept);
  const T = ('dapi' + '0123456789abcdef'.repeat(2));
  await s.setPat(ORIGIN, T);
  assert.equal(JSON.stringify(kept.data).includes(T), false);
  await s.setPat(ORIGIN, T, { remember: true });
  assert.equal(await s.isPatRemembered(ORIGIN), true);
  // Browser restart: session storage is empty, the remembered token comes back.
  const afterRestart = secretsMod.create(fakeArea(), kept);
  assert.equal(await afterRestart.getPat(ORIGIN), T);
  const d = await afterRestart.describe(ORIGIN);
  assert.deepEqual([d.hasPat, d.patRemembered], [true, true]);
  assert.equal(JSON.stringify(d).includes(T), false);
  await afterRestart.clearPat(ORIGIN);
  assert.equal(await secretsMod.create(fakeArea(), kept).getPat(ORIGIN), null, 'clearing forgets it everywhere');
  await s.setPat(ORIGIN, T, { remember: false });
  assert.equal(await s.isPatRemembered(ORIGIN), false, 'saving without remember drops an earlier remembered copy');
});

async function connectEnv(oauth) {
  globalThis.DCC = {};
  const map = { 'core/validate.js': 'validate', 'core/ids.js': 'ids', 'errors.js': 'errors', 'databricks/pricing.js': 'pricing', 'databricks/warehouses.js': 'warehouses', 'background/registration.js': 'registration', 'background/oauth.js': 'oauth' };
  for (const [f, ns] of Object.entries(map)) globalThis.DCC[ns] = load(f);
  vm.runInThisContext(readFileSync(new URL('../extension/src/background/connect-handlers.js', import.meta.url), 'utf8'));
  const chrome = {
    storage: { session: fakeArea() },
    identity: { getRedirectURL: () => 'https://x.chromiumapp.org/' },
    permissions: { contains: async () => true, getAll: async () => ({ origins: [ORIGIN + '/*'] }) },
  };
  const store = storeMod.create(fakeArea());
  await store.migrate();
  const data = dataService.create({ store, secrets: secretsMod.create(fakeArea()), helper: helperClient.create({ fetch: async () => { throw new Error('no'); }, getBridge: async () => null }), fetch: async () => { throw new Error('no network in this test'); } });
  const handlers = globalThis.DCC.handlerFactories.at(-1)({ store, data, chromeApi: chrome, oauth });
  return { handlers, store };
}

test('no method and no client ID signs in with Databricks through the built-in client', async () => {
  const signIns = [];
  const oauth = { signIn: async (a) => { signIns.push(a); throw new globalThis.DCC.errors.DccError({ code: 'AUTH_CANCELLED', message: 'closed' }); } };
  const env = await connectEnv(oauth);
  await assert.rejects(env.handlers['connect:oneClick'].handle({ url: ORIGIN + '/jobs' }), (e) => e.dcc.code === 'AUTH_CANCELLED');
  assert.deepEqual(signIns.map((a) => [a.clientId, a.purpose, a.interactive]), [['databricks-cli', 'cost', true]]);
});

test('only Sign in with Databricks, a token or the local helper exist; the old browser login is refused', async () => {
  const signIns = [];
  const env = await connectEnv({ signIn: async (a) => signIns.push(a) });
  await assert.rejects(env.handlers['connect:oneClick'].handle({ url: ORIGIN + '/jobs', method: 'session' }), (e) => e.dcc.code === 'UNKNOWN');
  assert.equal(signIns.length, 0);
  assert.deepEqual([...config.AUTH_MODES].sort(), ['helper', 'oauth', 'pat']);
  // A connection saved by an older development build with the browser login doesn't validate, so
  // it is dropped on migration and the user reconnects.
  assert.equal(config.validateConnection({ origin: ORIGIN, workspaceId: '1234567890', authMode: 'session', warehouse: { mode: 'auto' } }).ok, false);
  const registration = readFileSync(new URL('../extension/src/background/registration.js', import.meta.url), 'utf8');
  assert.ok(!registration.includes('session-bridge'), 'no bridge script is injected into workspace tabs');
});
