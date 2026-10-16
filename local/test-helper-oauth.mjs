// SIMULATED: the Databricks CLI is replaced by a small fake script (no network, no real OAuth).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createOAuthBridge, profileName, parseCliVersion, isSupportedVersion, cliEnv, SCOPES } from './oauth-bridge.mjs';
import { fakeCliDir, future } from './test-helper-fakes.mjs';

const WS = 'https://fixture-oauth.cloud.databricks.com';
const WS2 = 'https://adb-1234567890123456.7.azuredatabricks.net';


test('profile names are deterministic, origin-specific, purpose-specific and never DEFAULT', () => {
  const a = profileName(WS, 'cost');
  assert.equal(a, profileName(WS, 'cost'));
  assert.match(a, /^dcc-fixture-oauth-cloud-databricks-com-[0-9a-f]{8}$/);
  const m = profileName(WS, 'monitor');
  assert.match(m, /^dcc-mon-fixture-oauth-cloud-databricks-com-[0-9a-f]{8}$/);
  assert.notEqual(a, m);
  const b = profileName(WS2, 'cost');
  assert.notEqual(a, b);
  for (const p of [a, m, b, profileName('https://' + 'x'.repeat(60) + '.cloud.databricks.com')]) {
    assert.match(p, /^dcc-[a-z0-9-]+$/);
    assert.ok(p.length <= 80);
    assert.notEqual(p.toUpperCase(), 'DEFAULT');
  }
  // Long hosts that share a truncated slug still differ by the origin hash.
  const long1 = profileName('https://' + 'a'.repeat(50) + '1.cloud.databricks.com');
  const long2 = profileName('https://' + 'a'.repeat(50) + '2.cloud.databricks.com');
  assert.notEqual(long1, long2);
  for (const bad of ['http://127.0.0.1:8765', 'https://accounts.cloud.databricks.com', 'http://fixture-oauth.cloud.databricks.com', 'https://example.com', WS + '/', 'DEFAULT', '']) {
    assert.throws(() => profileName(bad), (e) => e.dcc && e.dcc.code === 'UNKNOWN', bad);
  }
  assert.throws(() => profileName(WS, 'admin'));
});

test('CLI version parsing and the v1.12 minimum', () => {
  assert.deepEqual(parseCliVersion('Databricks CLI v1.21.0'), { major: 1, minor: 21, patch: 0, text: '1.21.0' });
  assert.equal(isSupportedVersion(parseCliVersion('Databricks CLI v1.21.0')), true);
  assert.equal(isSupportedVersion(parseCliVersion('Databricks CLI v1.12.0')), true);
  assert.equal(isSupportedVersion(parseCliVersion('Databricks CLI v1.11.9')), false);
  assert.equal(isSupportedVersion(parseCliVersion('Databricks CLI v0.287.0')), false);
  assert.equal(isSupportedVersion(parseCliVersion('Databricks CLI v2.0.0')), true);
  assert.equal(parseCliVersion('no version here'), null);
  assert.equal(isSupportedVersion(null), false);
});

test('CLI environment drops variables that would override the dedicated profile', () => {
  const env = cliEnv({ PATH: '/bin', HOME: '/h', DATABRICKS_HOST: 'h', DATABRICKS_TOKEN: 't', DATABRICKS_CONFIG_PROFILE: 'DEFAULT', DATABRICKS_CLIENT_SECRET: 's', DATABRICKS_CONFIG_FILE: '/cfg', ARM_CLIENT_SECRET: 'x' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', DATABRICKS_CONFIG_FILE: '/cfg' });
});

test('missing CLI and old CLI map to HELPER_CLI_MISSING without running auth commands', async () => {
  const missing = createOAuthBridge({ cliPath: path.join(os.tmpdir(), 'dcc-no-such-dir', 'databricks') });
  assert.deepEqual(await missing.cliInfo(), { found: false, version: null, supported: false });
  await assert.rejects(missing.login(WS, 'cost'), (e) => e.dcc.code === 'HELPER_CLI_MISSING');
  await assert.rejects(missing.getToken(WS, 'cost'), (e) => e.dcc.code === 'HELPER_CLI_MISSING');

  const old = fakeCliDir({ version: '1.11.0', state: { [profileName(WS)]: { expiry: future() } } });
  const bridge = createOAuthBridge({ cliPath: old.cli });
  assert.deepEqual(await bridge.cliInfo(), { found: true, version: '1.11.0', supported: false });
  await assert.rejects(bridge.login(WS, 'cost'), (e) => e.dcc.code === 'HELPER_CLI_MISSING' && /older than v1\.12\.0/.test(e.dcc.details.message));
  await assert.rejects(bridge.getToken(WS, 'cost'), (e) => e.dcc.code === 'HELPER_CLI_MISSING');
  assert.ok(old.calls().every((c) => c.args[0] === '--version'), 'no auth command ran');
});

test('a valid session is reused: auth token only, no login', async () => {
  const p = profileName(WS, 'cost');
  const fake = fakeCliDir({ state: { [p]: { expiry: future() } } });
  const bridge = createOAuthBridge({ cliPath: fake.cli });
  const out = await bridge.login(WS, 'cost');
  assert.deepEqual(out, { signedIn: true, reused: true, profile: p });
  const calls = fake.calls().map((c) => c.args);
  assert.deepEqual(calls.filter((a) => a[0] === 'auth'), [['auth', 'token', '--profile', p]]);
  assert.ok(!JSON.stringify(out).includes('FAKE'));
});

test('no session → interactive login with --host, --profile and --scopes sql (cost) / all-apis (monitor)', async () => {
  const fake = fakeCliDir();
  const bridge = createOAuthBridge({ cliPath: fake.cli });
  const cost = await bridge.login(WS, 'cost');
  assert.equal(cost.reused, false);
  assert.equal(cost.signedIn, true);
  const mon = await bridge.login(WS, 'monitor');
  assert.equal(mon.reused, false);
  assert.match(mon.profile, /^dcc-mon-/);
  const logins = fake.calls().filter((c) => c.args[1] === 'login').map((c) => c.args);
  assert.deepEqual(logins, [
    ['auth', 'login', '--host', WS, '--profile', profileName(WS, 'cost'), '--scopes', SCOPES.cost],
    ['auth', 'login', '--host', WS, '--profile', profileName(WS, 'monitor'), '--scopes', SCOPES.monitor],
  ]);
  assert.equal(SCOPES.cost, 'sql');
  assert.equal(SCOPES.monitor, 'all-apis');
  for (const c of fake.calls()) {
    assert.ok(!c.args.some((a) => /FAKEACCESS|FAKEREFRESH/.test(a)), 'no token on any command line');
    assert.ok(!c.args.includes('DEFAULT'));
  }
  // Second call reuses.
  assert.equal((await bridge.login(WS, 'cost')).reused, true);
});

test('an expired session triggers login; the CLI child never sees DATABRICKS_* overrides', async () => {
  const p = profileName(WS, 'cost');
  const fake = fakeCliDir({ state: { [p]: { expiry: new Date(Date.now() - 1000).toISOString() } } });
  const bridge = createOAuthBridge({ cliPath: fake.cli, env: Object.assign({}, process.env, { DATABRICKS_TOKEN: 'leak', DATABRICKS_HOST: 'https://other', DATABRICKS_CONFIG_PROFILE: 'DEFAULT', DATABRICKS_CONFIG_FILE: '/tmp/dcc-cfg' }) });
  const out = await bridge.login(WS, 'cost');
  assert.equal(out.reused, false);
  for (const c of fake.calls()) {
    assert.equal(c.env.DATABRICKS_TOKEN, null);
    assert.equal(c.env.DATABRICKS_HOST, null);
    assert.equal(c.env.DATABRICKS_CONFIG_PROFILE, null);
    assert.equal(c.env.DATABRICKS_CONFIG_FILE, '/tmp/dcc-cfg');
  }
});

test('failed and timed-out logins are AUTH_EXPIRED; concurrent logins share one CLI run', async () => {
  const failing = fakeCliDir({ loginMode: 'fail' });
  await assert.rejects(createOAuthBridge({ cliPath: failing.cli }).login(WS, 'cost'), (e) => e.dcc.code === 'AUTH_EXPIRED' && /denied/.test(e.dcc.details.message));

  const hanging = fakeCliDir({ loginMode: 'hang' });
  const t0 = Date.now();
  await assert.rejects(createOAuthBridge({ cliPath: hanging.cli, loginTimeoutMs: 400 }).login(WS, 'cost'), (e) => e.dcc.code === 'AUTH_EXPIRED' && /timed out/.test(e.dcc.details.message));
  assert.ok(Date.now() - t0 < 5000);

  const slow = fakeCliDir({ loginMode: 'slow' });
  const bridge = createOAuthBridge({ cliPath: slow.cli });
  const [a, b] = await Promise.all([bridge.login(WS, 'cost'), bridge.login(WS, 'cost')]);
  assert.deepEqual(a, b);
  assert.equal(slow.calls().filter((c) => c.args[1] === 'login').length, 1);
});

test('getToken: AUTH_EXPIRED when not signed in, cached access token after, never the refresh token', async () => {
  const fake = fakeCliDir();
  const bridge = createOAuthBridge({ cliPath: fake.cli });
  await assert.rejects(bridge.getToken(WS, 'cost'), (e) => e.dcc.code === 'AUTH_EXPIRED' && /Sign in with browser/.test(e.dcc.details.message));
  await bridge.login(WS, 'cost');
  const before = fake.calls().length;
  const t = await bridge.getToken(WS, 'cost');
  assert.equal(t, 'FAKEACCESS-' + profileName(WS, 'cost'));
  assert.equal(await bridge.getToken(WS, 'cost'), t);
  assert.equal(fake.calls().length, before, 'served from memory after login');
  bridge.forget(WS, 'cost');
  assert.equal(await bridge.getToken(WS, 'cost'), t);
  assert.ok(fake.calls().length > before);
  // The monitor profile is separate.
  await assert.rejects(bridge.getToken(WS, 'monitor'), (e) => e.dcc.code === 'AUTH_EXPIRED');
  await assert.rejects(bridge.getToken('http://127.0.0.1:8765', 'cost'), (e) => e.dcc.code === 'UNKNOWN');
});
