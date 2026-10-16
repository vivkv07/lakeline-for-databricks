// Genie against the local fixture server: the REAL background module and the REAL allowlisted
// HTTP client talk to the fixture's MOCK Genie API over real HTTP on 127.0.0.1. SIMULATED: the
// fixture imitates the documented API (notes/GENIE.md); it is not Databricks. chrome.* is a fake
// and time is a fake clock (sleep advances it instantly).
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, fakeArea } from './support/load.mjs';
import { startFixtureServer, FIXTURE_TOKEN, FIXTURE_ORIGIN } from './fixture-server.mjs';
import { GENIE_SPACES, GENIE_FAILING_SPACE, genieAnswer } from './fixture-data.mjs';

const genieMod = load('background/genie.js');
const storeMod = load('background/store.js');
const secretsMod = load('background/secrets.js');

const SALES = GENIE_SPACES[0].space_id;
const OPS = GENIE_SPACES[1].space_id;

let fx;
const api = [];
test.before(async () => {
  fx = await startFixtureServer({ port: 0, log: () => {}, onApiRequest: (r) => api.push(r) });
});
test.after(async () => {
  if (fx) await fx.close();
});

async function env({ token = FIXTURE_TOKEN } = {}) {
  const chrome = {
    runtime: { id: 'testext', getURL: (p) => 'chrome-extension://testext/' + p },
    storage: { local: fakeArea(), session: fakeArea() },
    permissions: { contains: async () => true },
    alarms: { get: async () => null, create: async () => {}, clear: async () => {} },
    action: null,
  };
  const store = storeMod.create(chrome.storage.local);
  await store.migrate();
  await store.saveConnection({ origin: FIXTURE_ORIGIN, workspaceId: '1234567890', authMode: 'pat', warehouse: { mode: 'auto', resolvedId: 'a1b2c3d4e5f60001' } });
  const secrets = secretsMod.create(chrome.storage.session);
  await secrets.setPat(FIXTURE_ORIGIN, token);
  let t = Date.parse('2026-10-15T12:00:00Z');
  // The extension only accepts the fixture origin 127.0.0.1:8765; the test server runs on an
  // ephemeral port, so the fetch stand-in rewrites the port and nothing else.
  const fetchImpl = (url, init) => fetch(String(url).replace(FIXTURE_ORIGIN, fx.origin), init);
  const g = genieMod.create({ store, secrets, chromeApi: chrome, fetch: fetchImpl, now: () => t, sleep: async (ms) => (t += ms), log: () => {} });
  const h = (type, msg = {}) => g.handlers[type].handle(Object.assign({ type }, msg));
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.all([...g.jobs.values()]);
  };
  return { g, h, settle, store, chrome };
}

test('fixture Genie: list agents, ask, poll SUBMITTED → COMPLETED over HTTP, read the result table', async () => {
  const e = await env();
  const start = api.length;
  const spaces = await e.h('genie:spaces', { origin: FIXTURE_ORIGIN });
  assert.deepEqual(spaces.spaces.map((s) => s.title), ['Broken agent (fixture)', 'Job operations (fixture)', 'Sales analytics (fixture)']);
  await e.h('genie:ask', { origin: FIXTURE_ORIGIN, spaceId: SALES, question: 'What was revenue by region last month?' });
  await e.settle();
  const turn = (await e.h('genie:state', { origin: FIXTURE_ORIGIN, spaceId: SALES })).thread.turns[0];
  assert.equal(turn.phase, 'done', JSON.stringify(turn.error));
  const a = genieAnswer(SALES);
  assert.deepEqual(turn.texts, [{ content: a.text, purpose: 'answer' }]);
  assert.equal(turn.query.sql, a.sql);
  assert.deepEqual(turn.table.columns.map((c) => [c.name, c.numeric]), [['region', false], ['revenue_usd', true], ['orders', true]]);
  assert.deepEqual(turn.table.rows, a.rows);
  assert.equal(turn.table.totalRows, 4);
  assert.deepEqual(turn.suggested, a.suggested);
  const mine = api.slice(start);
  assert.deepEqual(
    mine.map((r) => r.method + ' ' + r.path.replace(/[0-9a-f]{32}/g, ':id')),
    [
      'GET /api/2.0/genie/spaces',
      'POST /api/2.0/genie/spaces/:id/start-conversation',
      'GET /api/2.0/genie/spaces/:id/conversations/:id/messages/:id',
      'GET /api/2.0/genie/spaces/:id/conversations/:id/messages/:id',
      'GET /api/2.0/genie/spaces/:id/conversations/:id/messages/:id',
      'GET /api/2.0/genie/spaces/:id/conversations/:id/messages/:id',
      'GET /api/2.0/genie/spaces/:id/conversations/:id/messages/:id/attachments/:id/query-result',
    ]
  );
  assert.deepEqual(JSON.parse(mine[1].body), { content: 'What was revenue by region last month?' }, 'only the question is sent');
});

test('fixture Genie: follow-up in the same conversation, the failing agent, and a rejected token', async () => {
  const e = await env();
  const before = fx.state.genie.followUps;
  await e.h('genie:ask', { origin: FIXTURE_ORIGIN, spaceId: OPS, question: 'Which jobs failed?' });
  await e.settle();
  await e.h('genie:ask', { origin: FIXTURE_ORIGIN, spaceId: OPS, question: 'And the slowest runs?' });
  await e.settle();
  const st = await e.h('genie:state', { origin: FIXTURE_ORIGIN, spaceId: OPS });
  assert.deepEqual(st.thread.turns.map((t) => t.phase), ['done', 'done']);
  assert.equal(fx.state.genie.followUps, before + 1);
  assert.equal(st.thread.turns[1].table.rows[0][0], 'Orders ingest and pipeline refresh (fixture)');

  await e.h('genie:ask', { origin: FIXTURE_ORIGIN, spaceId: GENIE_FAILING_SPACE, question: 'Anything' });
  await e.settle();
  const failed = (await e.h('genie:state', { origin: FIXTURE_ORIGIN, spaceId: GENIE_FAILING_SPACE })).thread.turns[0];
  assert.deepEqual([failed.phase, failed.error.code], ['failed', 'GENIE_FAILED']);
  assert.match(failed.error.detail, /always fails/);

  const bad = await env({ token: 'dapi-not-the-fixture-token-000000000000' });
  await assert.rejects(bad.h('genie:spaces', { origin: FIXTURE_ORIGIN }), (err) => err.dcc.code === 'AUTH_EXPIRED');
});

test('fixture Genie: the mock rejects unknown agents and empty questions like the API does', async () => {
  const call = (method, path, body) => fetch(fx.origin + path, { method, headers: { Authorization: 'Bearer ' + FIXTURE_TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await call('POST', '/api/2.0/genie/spaces/' + 'f'.repeat(32) + '/start-conversation', { content: 'q' })).status, 404);
  assert.equal((await call('POST', '/api/2.0/genie/spaces/' + SALES + '/start-conversation', { content: '  ' })).status, 400);
  assert.equal((await call('GET', '/api/2.0/genie/spaces/' + SALES + '/conversations/' + 'a'.repeat(32) + '/messages/' + 'b'.repeat(32))).status, 404);
  assert.equal((await fetch(fx.origin + '/api/2.0/genie/spaces')).status, 401, 'needs the fake fixture token');
  const page = await (await call('GET', '/api/2.0/genie/spaces?page_size=2')).json();
  assert.equal(page.spaces.length, 2);
  assert.equal(page.next_page_token, 'o2');
});
