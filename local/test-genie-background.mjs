// Genie side panel, background half: routing, polling, storage, notifications and auth.
// SIMULATED: chrome.* is a fake, the Databricks workspace is a fake fetch that imitates the
// documented Genie API (notes/GENIE.md), and time is a fake clock (sleep advances it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, fakeArea } from './support/load.mjs';

const genieMod = load('background/genie.js');
const storeMod = load('background/store.js');
const secretsMod = load('background/secrets.js');
const oauthMod = load('background/oauth.js');
const routerMod = load('background/router.js');
const gapi = load('databricks/genie-api.js');

const A = 'https://dbc-aaa.cloud.databricks.com';
const B = 'https://dbc-bbb.cloud.databricks.com';
const PAT = 'dapi-test-not-a-real-token-0000000000';
const SALES = 'aaaa0000000000000000000000000001';
const BROKEN = 'aaaa0000000000000000000000000002';
const QUESTION = 'What was revenue by region last month for ACME-SECRET-CUSTOMER?';
const ANSWER = 'Revenue was 1.24M, led by EMEA (CONFIDENTIAL-ANSWER-TEXT).';
const CELL = 'CONFIDENTIAL-CELL-VALUE';
const T0 = Date.parse('2026-10-15T12:00:00Z');
const EXT = 'testext';

function event() {
  const fns = [];
  return { addListener: (fn) => fns.push(fn), fire: (...a) => fns.map((fn) => fn(...a)), fns };
}

function fakeChrome({ granted = [A, B], notificationsGranted = true } = {}) {
  const alarms = new Map();
  const calls = { notifications: [], cleared: [], badge: [], titles: [], sidePanel: [], tabs: [], alarmsCreated: 0 };
  return {
    calls,
    alarmsMap: alarms,
    runtime: { id: EXT, getURL: (p) => `chrome-extension://${EXT}/${p}`, onConnect: event(), onStartup: event() },
    storage: { local: fakeArea(), session: fakeArea(), onChanged: event() },
    alarms: {
      onAlarm: event(),
      async create(name, info) {
        calls.alarmsCreated++;
        alarms.set(name, info);
      },
      get: async (name) => alarms.get(name),
      clear: async (name) => alarms.delete(name),
    },
    permissions: {
      onAdded: event(),
      contains: async (req) => (req.origins || []).every((o) => granted.includes(o.replace(/\/\*$/, ''))) && (req.permissions || []).every((p) => p !== 'notifications' || notificationsGranted),
    },
    notifications: {
      onClicked: event(),
      create: async (id, opts) => calls.notifications.push({ id, opts }),
      clear: async (id) => calls.cleared.push(id),
    },
    action: {
      setBadgeText: async (o) => calls.badge.push(o.text),
      setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {},
      setTitle: async (o) => calls.titles.push(o.title),
    },
    sidePanel: { open: async (o) => calls.sidePanel.push(o) },
    windows: { getLastFocused: async () => ({ id: 42 }) },
    tabs: { create: async (o) => calls.tabs.push(o) },
  };
}

function res(status, obj) {
  const text = JSON.stringify(obj);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => obj };
}

/**
 * Fake workspace speaking the documented Genie API. Each GET of a message advances one status.
 * @param o {statuses?, failSpace?, neverComplete?, postStatus?, pollErrors?, resultRows?, expired?}
 */
function fakeGenie(o = {}) {
  const statuses = o.statuses || ['SUBMITTED', 'FILTERING_CONTEXT', 'ASKING_AI', 'EXECUTING_QUERY', 'COMPLETED'];
  const seen = [];
  const messages = new Map();
  let n = 0;
  let pollErrors = o.pollErrors || 0;
  const id = (p) => p + String(++n).padStart(32 - p.length, '0');
  function message(m) {
    const status = m.space === BROKEN ? (m.polls >= 2 ? 'FAILED' : 'ASKING_AI') : o.neverComplete ? 'ASKING_AI' : o.expired && m.polls >= statuses.length - 1 ? 'QUERY_RESULT_EXPIRED' : statuses[Math.min(m.polls, statuses.length - 1)];
    const out = { message_id: m.id, conversation_id: m.conv, space_id: m.space, status, content: m.content, attachments: [] };
    if (status === 'FAILED') out.error = { error: 'The agent could not find a table for this question.', type: 'TABLES_MISSING_EXCEPTION' };
    if (['EXECUTING_QUERY', 'COMPLETED', 'QUERY_RESULT_EXPIRED'].includes(status)) out.attachments.push({ attachment_id: 'q' + m.id.slice(-6), query: { title: 'Revenue by region', description: 'Sum of orders', query: 'SELECT region, SUM(amount) FROM sales GROUP BY region', statement_id: '01ef0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b', query_result_metadata: { row_count: 3, is_truncated: false } } });
    if (status === 'COMPLETED' || status === 'QUERY_RESULT_EXPIRED') {
      out.attachments.unshift({ attachment_id: 't' + m.id.slice(-6), text: { content: ANSWER, purpose: 'TEXT_ATTACHMENT_PURPOSE_ANSWER' } });
      out.attachments.push({ attachment_id: 's' + m.id.slice(-6), suggested_questions: { questions: ['By month?', 'Top products?'] } });
    }
    return out;
  }
  function table() {
    const rows = o.resultRows || [['EMEA', '412300'], ['APAC', '301750'], [CELL, null]];
    return { statement_response: { statement_id: '01ef0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b', status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'region', type_name: 'STRING', position: 0 }, { name: 'revenue', type_name: 'DECIMAL', position: 1 }] }, total_row_count: rows.length, total_chunk_count: 1 }, result: { data_array: rows } } };
  }
  async function fetchImpl(url, init) {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push({ method: init.method, path: u.pathname, search: u.search, body, auth: init.headers.Authorization, redirect: init.redirect, credentials: init.credentials });
    const p = u.pathname;
    if (init.method === 'GET' && p === '/api/2.0/genie/spaces') return res(200, { spaces: [{ space_id: SALES, title: 'Sales analytics', description: 'Orders' }, { space_id: BROKEN, title: 'Broken agent' }] });
    let m = /^\/api\/2\.0\/genie\/spaces\/(\w{32})\/start-conversation$/.exec(p);
    if (m && init.method === 'POST') {
      if (o.postStatus) return res(o.postStatus, { error_code: o.postStatus === 429 ? 'REQUEST_LIMIT_EXCEEDED' : 'BAD_REQUEST', message: 'Rejected (fake)' });
      const conv = id('c0');
      const msg = { id: id('d0'), conv, space: m[1], content: body.content, polls: 0 };
      messages.set(msg.id, msg);
      return res(200, { conversation_id: conv, conversation: { conversation_id: conv, title: 'Fake conversation' }, message_id: msg.id, message: message(msg) });
    }
    m = /^\/api\/2\.0\/genie\/spaces\/(\w{32})\/conversations\/(\w{32})\/messages$/.exec(p);
    if (m && init.method === 'POST') {
      const msg = { id: id('d0'), conv: m[2], space: m[1], content: body.content, polls: 0 };
      messages.set(msg.id, msg);
      return res(200, message(msg));
    }
    m = /^\/api\/2\.0\/genie\/spaces\/\w{32}\/conversations\/\w{32}\/messages\/(\w{32})(\/attachments\/[\w-]+\/(query-result|execute-query))?$/.exec(p);
    if (m) {
      const msg = messages.get(m[1]);
      if (!msg) return res(404, { error_code: 'RESOURCE_DOES_NOT_EXIST', message: 'No message' });
      if (m[2]) return res(200, table());
      if (pollErrors > 0) {
        pollErrors--;
        return res(503, { error_code: 'TEMPORARILY_UNAVAILABLE', message: 'Try later (fake)' });
      }
      msg.polls++;
      return res(200, message(msg));
    }
    return res(404, { error_code: 'ENDPOINT_NOT_FOUND', message: 'no route' });
  }
  return { fetchImpl, seen, messages };
}

async function env({ mode = 'connected', authMode = 'pat', withPat = true, genie = {}, chromeOpts, monitorEnabled = false, notify = true, oauth } = {}) {
  const chrome = fakeChrome(chromeOpts);
  const ws = fakeGenie(genie);
  const store = storeMod.create(chrome.storage.local);
  await store.migrate();
  await store.updateSettings({ mode, monitor: { enabled: monitorEnabled }, genie: { notify } });
  for (const origin of [A, B]) await store.saveConnection({ origin, workspaceId: origin === A ? '1001' : '1002', authMode, warehouse: { mode: 'auto', resolvedId: 'a1b2c3d4e5f60001' } });
  const secrets = secretsMod.create(chrome.storage.session);
  if (withPat) await secrets.setPat(A, PAT);
  let t = T0;
  const sleeps = [];
  const logs = [];
  const g = genieMod.create({
    store,
    secrets,
    oauth: oauth ? oauth(chrome, ws) : null,
    chromeApi: chrome,
    fetch: ws.fetchImpl,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    log: (...a) => logs.push(a.join(' ')),
  });
  const h = (type, msg = {}) => g.handlers[type].handle(Object.assign({ type }, msg), { id: EXT, url: `chrome-extension://${EXT}/ui/sidepanel.html` });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.all([...g.jobs.values()]);
  };
  return { chrome, ws, store, secrets, g, h, settle, sleeps, logs, advance: (ms) => (t += ms), now: () => t };
}

const getsOf = (ws) => ws.seen.filter((r) => r.method === 'GET' && /\/messages\/\w{32}$/.test(r.path));

test('ask → background start-conversation → polls through statuses → result table → Answer ready', async () => {
  const e = await env();
  const spaces = await e.h('genie:spaces', { origin: A });
  assert.deepEqual(spaces.spaces.map((s) => s.title), ['Broken agent', 'Sales analytics']);
  const { threadId, turnId } = await e.h('genie:ask', { origin: A, spaceId: SALES, question: QUESTION });
  assert.ok(threadId && turnId);
  // While in flight: state is visible and the resume alarm is armed.
  const mid = await e.h('genie:state', { origin: A, spaceId: SALES });
  assert.ok(['sending', 'working', 'query'].includes(mid.thread.turns[0].phase));
  assert.ok(e.chrome.alarmsMap.has(genieMod.ALARM), 'alarm armed while a question is in flight');
  await e.settle();
  const st = await e.h('genie:state', { origin: A, spaceId: SALES });
  const turn = st.thread.turns[0];
  assert.equal(turn.phase, 'done');
  assert.equal(turn.question, QUESTION);
  assert.deepEqual(turn.texts, [{ content: ANSWER, purpose: 'answer' }]);
  assert.equal(turn.query.sql, 'SELECT region, SUM(amount) FROM sales GROUP BY region');
  assert.deepEqual(turn.table.columns.map((c) => c.name), ['region', 'revenue']);
  assert.deepEqual(turn.table.rows[2], [CELL, null]);
  assert.equal(turn.tableState, 'ready');
  assert.deepEqual(turn.suggested, ['By month?', 'Top products?']);
  assert.equal(st.inflight, 0);
  assert.equal(e.chrome.alarmsMap.has(genieMod.ALARM), false, 'alarm cleared when nothing is in flight');

  // Requests: one POST with only the question, GET polls, one result fetch. PAT, no cookies, no redirects.
  const posts = e.ws.seen.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, `/api/2.0/genie/spaces/${SALES}/start-conversation`);
  assert.deepEqual(posts[0].body, { content: QUESTION });
  assert.equal(getsOf(e.ws).length, 4, 'SUBMITTED (POST) → FILTERING_CONTEXT → ASKING_AI → EXECUTING_QUERY → COMPLETED');
  assert.equal(e.ws.seen.filter((r) => /query-result$/.test(r.path)).length, 1);
  for (const r of e.ws.seen) {
    assert.equal(r.auth, 'Bearer ' + PAT);
    assert.equal(r.redirect, 'error');
    assert.equal(r.credentials, 'omit');
  }
  // Backoff: 1 s, then ×1.5 per poll.
  assert.deepEqual(e.sleeps.slice(0, 4), [1000, 1500, 2250, 3375]);
});

test('follow-up reuses the conversation; one question at a time per conversation', async () => {
  const e = await env();
  await e.h('genie:spaces', { origin: A });
  const first = await e.h('genie:ask', { origin: A, spaceId: SALES, question: 'First question' });
  await assert.rejects(e.h('genie:ask', { origin: A, spaceId: SALES, question: 'Too soon' }), (err) => err.dcc.code === 'GENIE_BUSY');
  await e.settle();
  const second = await e.h('genie:ask', { origin: A, spaceId: SALES, question: 'And by month?' });
  assert.equal(second.threadId, first.threadId);
  await e.settle();
  const posts = e.ws.seen.filter((r) => r.method === 'POST');
  const conv = e.ws.messages.values().next().value.conv;
  assert.equal(posts[1].path, `/api/2.0/genie/spaces/${SALES}/conversations/${conv}/messages`);
  assert.deepEqual(posts[1].body, { content: 'And by month?' });
  const st = await e.h('genie:state', { origin: A, spaceId: SALES });
  assert.deepEqual(st.thread.turns.map((t) => t.phase), ['done', 'done']);
  // New conversation: the next question starts a fresh one.
  const fresh = await e.h('genie:new', { origin: A, spaceId: SALES });
  assert.equal(fresh.thread, null);
  const third = await e.h('genie:ask', { origin: A, spaceId: SALES, question: 'Fresh start' });
  assert.notEqual(third.threadId, first.threadId);
  await e.settle();
  assert.equal(e.ws.seen.filter((r) => /start-conversation$/.test(r.path)).length, 2);
});

test('a failing agent ends as Failed with a plain reason; Genie error text kept only as a detail', async () => {
  const e = await env();
  await e.h('genie:ask', { origin: A, spaceId: BROKEN, question: 'Anything' });
  await e.settle();
  const turn = (await e.h('genie:state', { origin: A, spaceId: BROKEN })).thread.turns[0];
  assert.equal(turn.phase, 'failed');
  assert.equal(turn.error.code, 'GENIE_FAILED');
  assert.equal(turn.error.title, "Genie couldn't answer");
  assert.match(turn.error.detail, /could not find a table/);
  assert.equal(turn.table, null);
});

test('rate limit on send: explained, never re-sent automatically', async () => {
  const e = await env({ genie: { postStatus: 429 } });
  await e.h('genie:ask', { origin: A, spaceId: SALES, question: QUESTION });
  await e.settle();
  const turn = (await e.h('genie:state', { origin: A, spaceId: SALES })).thread.turns[0];
  assert.equal(turn.phase, 'failed');
  assert.equal(turn.error.code, 'GENIE_RATE_LIMITED');
  assert.match(turn.error.steps[0], /Wait a minute/);
  assert.equal(e.ws.seen.filter((r) => r.method === 'POST').length, 1);
  assert.equal(getsOf(e.ws).length, 0);
});

test('transient poll errors back off (≥ 2 s) and recover; persistent ones fail after a bounded number', async () => {
  const e = await env({ genie: { pollErrors: 2 } });
  await e.h('genie:ask', { origin: A, spaceId: SALES, question: 'q' });
  await e.settle();
  assert.equal((await e.h('genie:state', { origin: A, spaceId: SALES })).thread.turns[0].phase, 'done');
  assert.deepEqual(e.sleeps.slice(0, 3), [1000, 2000, 4000], 'first poll, then backoff after each 503');

  const f = await env({ genie: { pollErrors: 50 } });
  await f.h('genie:ask', { origin: A, spaceId: SALES, question: 'q' });
  await f.settle();
  const turn = (await f.h('genie:state', { origin: A, spaceId: SALES })).thread.turns[0];
  assert.equal(turn.phase, 'failed');
  assert.equal(getsOf(f.ws).length, genieMod.POLL.maxErrors);
  assert.ok(f.sleeps.every((ms) => ms <= genieMod.POLL.errorMaxMs));
});

test('hard timeout: polling stops after 10 minutes with GENIE_TIMEOUT; delays never exceed 10 s on success', async () => {
  const e = await env({ genie: { neverComplete: true } });
  await e.h('genie:ask', { origin: A, spaceId: SALES, question: 'slow' });
  await e.settle();
  const turn = (await e.h('genie:state', { origin: A, spaceId: SALES })).thread.turns[0];
  assert.equal(turn.phase, 'failed');
  assert.equal(turn.error.code, 'GENIE_TIMEOUT');
  assert.ok(e.now() - T0 >= genieMod.HARD_TIMEOUT_MS && e.now() - T0 < genieMod.HARD_TIMEOUT_MS + 11000);
  assert.ok(Math.max(...e.sleeps) <= genieMod.POLL.maxMs);
  const gets = getsOf(e.ws).length;
  assert.ok(gets > 50 && gets < 80, 'bounded polls: ' + gets);
  // Nothing is in flight now: no alarm, no jobs, and no further requests happen.
  const before = e.ws.seen.length;
  await e.g.resume();
  assert.equal(e.g.jobs.size, 0);
  assert.equal(e.ws.seen.length, before);
  assert.equal(e.chrome.alarmsMap.size, 0);
});

test('panel closed: badge + data-free notification only with the setting and permission; panel open: neither', async () => {
  const e = await env();
  await e.h('genie:spaces', { origin: A });
  await e.h('genie:ask', { origin: A, spaceId: SALES, question: QUESTION });
  await e.settle();
  assert.equal(e.chrome.calls.notifications.length, 1);
  const n = e.chrome.calls.notifications[0];
  assert.ok(n.id.startsWith(genieMod.NOTIFY_PREFIX));
  assert.deepEqual([n.opts.title, n.opts.message, n.opts.contextMessage], ['Genie answer ready', 'Answer ready in Sales analytics', 'dbc-aaa.cloud.databricks.com']);
  const text = JSON.stringify(n);
  for (const secret of [QUESTION, 'ACME', ANSWER, 'CONFIDENTIAL', CELL, 'SELECT']) assert.ok(!text.includes(secret), 'notification leaks ' + secret);
  assert.deepEqual(e.chrome.calls.badge, ['1']);
  assert.match(e.chrome.calls.titles.at(-1), /1 Genie answer ready/);

  // Opening the panel (validated port) marks answers seen: badge and notification cleared.
  const port = { name: genieMod.PORT_NAME, sender: { id: EXT, url: `chrome-extension://${EXT}/ui/sidepanel.html` }, posted: [], postMessage(m) { this.posted.push(m); }, onDisconnect: event() };
  assert.equal(e.g.onConnect(port), true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(e.chrome.calls.badge.at(-1), '');
  assert.deepEqual(e.chrome.calls.cleared, [n.id]);

  // With the panel open, an answer neither notifies nor badges; the port gets change signals only.
  await e.h('genie:ask', { origin: A, spaceId: SALES, question: 'Next' });
  await e.settle();
  assert.equal(e.chrome.calls.notifications.length, 1);
  assert.ok(port.posted.length > 0 && port.posted.every((m) => m.type === 'genie:changed' && Object.keys(m).join() === 'type,rev'), 'port carries no data');
  port.onDisconnect.fire();
  assert.equal(e.g.ports.size, 0);

  // Setting off: badge only. Permission missing: badge only. Monitor on: it owns the badge.
  const off = await env({ notify: false });
  await off.h('genie:ask', { origin: A, spaceId: SALES, question: 'q' });
  await off.settle();
  assert.deepEqual([off.chrome.calls.notifications.length, off.chrome.calls.badge.at(-1)], [0, '1']);
  const noPerm = await env({ chromeOpts: { notificationsGranted: false } });
  await noPerm.h('genie:ask', { origin: A, spaceId: SALES, question: 'q' });
  await noPerm.settle();
  assert.equal(noPerm.chrome.calls.notifications.length, 0);
  const mon = await env({ monitorEnabled: true });
  await mon.h('genie:ask', { origin: A, spaceId: SALES, question: 'q' });
  await mon.settle();
  assert.equal(mon.chrome.calls.badge.length, 0, 'never overwrites the run monitor badge');
  assert.equal(mon.chrome.calls.notifications.length, 1);
});

test('panel port: only the side panel page of this extension is accepted', async () => {
  const e = await env();
  const mk = (sender, name = genieMod.PORT_NAME) => ({ name, sender, disconnected: false, disconnect() { this.disconnected = true; }, postMessage() {}, onDisconnect: event() });
  const bad = [mk({ id: 'other', url: `chrome-extension://other/ui/sidepanel.html` }), mk({ id: EXT, url: `chrome-extension://${EXT}/ui/options.html` }), mk({ id: EXT, url: 'https://dbc-aaa.cloud.databricks.com/', tab: { id: 1 } })];
  for (const p of bad) {
    assert.equal(e.g.onConnect(p), false);
    assert.equal(p.disconnected, true);
  }
  assert.equal(e.g.onConnect(mk({ id: EXT, url: `chrome-extension://${EXT}/ui/sidepanel.html` }, 'other-port')), false);
  assert.equal(e.g.ports.size, 0);
});

test('notification click opens the side panel, or the panel page in a tab when that is refused', async () => {
  const e = await env();
  assert.equal(await e.g.onNotificationClicked('dcc-run-1'), null, 'monitor notifications are not ours');
  assert.equal(await e.g.onNotificationClicked(genieMod.NOTIFY_PREFIX + 'q1'), 'sidePanel');
  assert.deepEqual(e.chrome.calls.sidePanel, [{ windowId: 42 }]);
  e.chrome.sidePanel.open = async () => {
    throw new Error('`sidePanel.open()` may only be called in response to a user gesture.');
  };
  assert.equal(await e.g.onNotificationClicked(genieMod.NOTIFY_PREFIX + 'q2'), 'tab');
  assert.deepEqual(e.chrome.calls.tabs, [{ url: `chrome-extension://${EXT}/ui/sidepanel.html` }]);
  assert.deepEqual(e.chrome.calls.cleared, [genieMod.NOTIFY_PREFIX + 'q1', genieMod.NOTIFY_PREFIX + 'q2']);
});

test('conversations live only in session storage; never local storage, logs or diagnostics', async () => {
  const e = await env();
  await e.h('genie:ask', { origin: A, spaceId: SALES, question: QUESTION });
  await e.settle();
  await e.h('genie:ask', { origin: A, spaceId: BROKEN, question: QUESTION + ' (2)' });
  await e.settle();
  const local = JSON.stringify(e.chrome.storage.local.data);
  for (const secret of ['ACME-SECRET', 'CONFIDENTIAL', 'SELECT region']) assert.ok(!local.includes(secret), 'local storage has ' + secret);
  assert.ok(local.includes(BROKEN), 'only the remembered agent ID is in settings');
  assert.deepEqual((await e.store.getSettings()).genie.lastSpace, { [A]: BROKEN });
  const session = JSON.stringify(e.chrome.storage.session.data[genieMod.STATE_KEY]);
  assert.ok(session.includes('ACME-SECRET') && session.includes('CONFIDENTIAL-ANSWER-TEXT'));
  assert.ok(!session.includes(PAT), 'no token in the conversation state');
  assert.deepEqual(await e.store.getDiagnostics(), []);
  assert.ok(!e.logs.join('\n').match(/ACME|CONFIDENTIAL|could not find/));
  // Clear removes everything.
  await e.h('genie:clear');
  assert.equal((await e.h('genie:state', { origin: A, spaceId: SALES })).thread, null);
  assert.ok(!JSON.stringify(e.chrome.storage.session.data).includes('ACME'));
});

test('size caps: at most 8 conversations, 20 turns each, and big tables are trimmed before history', async () => {
  const e = await env();
  for (let i = 0; i < 10; i++) {
    await e.h('genie:new', { origin: A, spaceId: SALES });
    await e.h('genie:ask', { origin: A, spaceId: SALES, question: 'Q' + i });
    await e.settle();
  }
  let st = await e.g.readState();
  assert.equal(st.threads.length, genieMod.LIMITS.threads);
  assert.ok(!JSON.stringify(st).includes('"Q0"') && JSON.stringify(st).includes('"Q9"'), 'oldest conversations dropped first');

  const f = await env();
  for (let i = 0; i < 23; i++) {
    await f.h('genie:ask', { origin: A, spaceId: SALES, question: 'Turn ' + i });
    await f.settle();
  }
  st = await f.g.readState();
  assert.equal(st.threads[0].turns.length, genieMod.LIMITS.turns);
  assert.equal(st.threads[0].turns[0].question, 'Turn 3');
  assert.equal(f.ws.seen.filter((r) => /start-conversation$/.test(r.path)).length, 1, 'still one Genie conversation');

  const wide = Array.from({ length: 200 }, (_, i) => ['x'.repeat(290) + i, 'y'.repeat(290)]);
  const big = await env({ genie: { resultRows: wide } });
  for (let i = 0; i < 16; i++) {
    await big.h('genie:ask', { origin: A, spaceId: SALES, question: 'Big ' + i });
    await big.settle();
  }
  st = await big.g.readState();
  assert.ok(JSON.stringify(st).length <= genieMod.LIMITS.stateChars, 'total state ≤ cap: ' + JSON.stringify(st).length);
  const states = st.threads[0].turns.map((t) => t.tableState);
  assert.equal(states.length, 16, 'history kept; only tables were dropped');
  assert.equal(states.at(-1), 'ready', 'the newest answer keeps its table');
  assert.equal(states[0], 'trimmed', 'the oldest tables go first: ' + states.join(','));
  assert.ok(st.threads[0].turns.every((t) => t.texts.length === 1), 'answer text is kept');
});

test('service-worker restart: in-flight questions resume from session storage; an unconfirmed send is not re-sent', async () => {
  const e = await env();
  await e.h('genie:spaces', { origin: A });
  // Instance 1 sends the question, then "dies": its first sleep never resolves.
  const g1 = genieMod.create({ store: e.store, secrets: e.secrets, oauth: null, chromeApi: e.chrome, fetch: e.ws.fetchImpl, now: e.now, sleep: () => new Promise(() => {}), log: () => {} });
  await g1.ask({ origin: A, spaceId: SALES, question: 'Resume me' });
  for (let i = 0; i < 20 && !(await g1.readState()).threads[0].turns[0].messageId; i++) await new Promise((r) => setTimeout(r, 2));
  const before = (await g1.readState()).threads[0].turns[0];
  assert.ok(before.messageId && ['working', 'query'].includes(before.phase), 'sent and waiting when the worker stops');
  assert.equal(getsOf(e.ws).length, 0);
  // Instance 2 (fresh memory, same session storage), as after a restart or the 30 s alarm.
  const g2 = genieMod.create({ store: e.store, secrets: e.secrets, oauth: null, chromeApi: e.chrome, fetch: e.ws.fetchImpl, now: e.now, sleep: async (ms) => e.advance(ms), log: () => {} });
  assert.equal(await g2.resume(), 1, 'one job resumed');
  await Promise.all([...g2.jobs.values()]);
  const turn = (await g2.readState()).threads[0].turns[0];
  assert.equal(turn.phase, 'done');
  assert.equal(turn.table.rows.length, 3);
  assert.equal(e.ws.seen.filter((r) => r.method === 'POST').length, 1, 'never sent twice');
  // The alarm handler resumes too, and nothing is left in flight afterwards.
  e.chrome.alarms.onAlarm.fns.length = 0;
  g2.init();
  assert.equal(e.chrome.alarms.onAlarm.fns.length, 1);
  assert.equal(await g2.resume(), 0);

  // A turn stuck in "sending" after a restart (sentAt set, no message ID) fails as unconfirmed.
  const f = await env();
  await f.chrome.storage.session.set({
    [genieMod.STATE_KEY]: { v: 1, rev: 1, unseen: 0, notified: [], badge: false, current: { [A + '|' + SALES]: 'c1' }, threads: [{ id: 'c1', origin: A, spaceId: SALES, spaceTitle: 'Sales', conversationId: null, createdAt: T0, updatedAt: T0, turns: [{ id: 'q1', question: 'lost', askedAt: T0, phase: 'sending', sentAt: T0, messageId: null, texts: [], suggested: [] }] }] },
  });
  await f.g.resume();
  await f.settle();
  const lost = (await f.h('genie:state', { origin: A, spaceId: SALES })).thread.turns[0];
  assert.deepEqual([lost.phase, lost.error.code], ['failed', 'GENIE_SEND_UNCONFIRMED']);
  assert.equal(f.ws.seen.length, 0);
});

test('expired results can be re-run with execute-query (the only other POST)', async () => {
  const e = await env({ genie: { expired: true } });
  await e.h('genie:ask', { origin: A, spaceId: SALES, question: 'q' });
  await e.settle();
  let st = await e.h('genie:state', { origin: A, spaceId: SALES });
  assert.equal(st.thread.turns[0].tableState, 'expired');
  assert.equal(st.thread.turns[0].query.canRerun, true);
  st = await e.h('genie:rerunQuery', { threadId: st.thread.id, turnId: st.thread.turns[0].id });
  assert.equal(st.thread.turns[0].tableState, 'ready');
  assert.ok(e.ws.seen.some((r) => r.method === 'POST' && /execute-query$/.test(r.path)));
});

test('auth and mode gating: helper, missing PAT, import mode, unconnected and unsupported origins', async () => {
  const helper = await env({ authMode: 'helper' });
  await assert.rejects(helper.h('genie:ask', { origin: A, spaceId: SALES, question: 'q' }), (e) => e.dcc.code === 'GENIE_HELPER_MODE');
  const init = await helper.h('genie:init', { activeUrl: B + '/jobs?o=1002' });
  assert.deepEqual(init.workspaces.map((w) => w.status), ['helper', 'helper']);
  assert.equal(init.defaultOrigin, B, 'defaults to the active tab when it is a connected workspace');
  assert.equal(init.fromActiveTab, true);

  // Browser login (relayed through an open tab) is supported through the data service's
  // Genie-scoped session client; without that client the module refuses explicitly.
  if (load('databricks/config.js').AUTH_MODES.includes('session')) {
    const sess = await env({ authMode: 'session', withPat: false });
    assert.equal((await sess.h('genie:init', {})).workspaces[0].status, 'ready');
    await assert.rejects(sess.h('genie:ask', { origin: A, spaceId: SALES, question: 'q' }), (e) => e.dcc.code === 'GENIE_AUTH_UNSUPPORTED');
    assert.equal(sess.ws.seen.length, 0);
  }

  const noPat = await env({ withPat: false });
  await assert.rejects(noPat.h('genie:spaces', { origin: A }), (e) => e.dcc.code === 'GENIE_PAT_MISSING');
  assert.equal(noPat.ws.seen.length, 0);

  const imp = await env({ mode: 'import' });
  const ii = await imp.h('genie:init', {});
  assert.deepEqual([ii.workspaces.length, ii.modeError.code], [0, 'GENIE_MODE']);
  await assert.rejects(imp.h('genie:ask', { origin: A, spaceId: SALES, question: 'q' }), (e) => e.dcc.code === 'GENIE_MODE');

  const e = await env();
  await assert.rejects(e.h('genie:ask', { origin: 'https://evil.example', spaceId: SALES, question: 'q' }));
  await assert.rejects(e.h('genie:ask', { origin: 'https://dbc-zzz.cloud.databricks.com', spaceId: SALES, question: 'q' }), (err) => err.dcc.code === 'NOT_CONNECTED');
  await assert.rejects(e.h('genie:ask', { origin: A, spaceId: '../x', question: 'q' }));
  await assert.rejects(e.h('genie:ask', { origin: A, spaceId: SALES, question: ' ' }));
  const nogrant = await env({ chromeOpts: { granted: [] } });
  await assert.rejects(nogrant.h('genie:spaces', { origin: A }), (err) => err.dcc.code === 'PERMISSION_NOT_GRANTED');
  assert.equal(e.ws.seen.length, 0, 'nothing was sent for rejected questions');
});

test('Sign in with Databricks: Genie and the run monitor share ONE all-apis consent', async () => {
  const CLIENT = 'lakeline-client-0001';
  const REDIRECT = `https://${EXT}.chromiumapp.org/`;
  const auths = [];
  const e = await env({
    authMode: 'oauth',
    withPat: false,
    oauth: (chrome, ws) => {
      chrome.identity = {
        getRedirectURL: () => REDIRECT,
        async launchWebAuthFlow({ url, interactive }) {
          const u = new URL(url);
          auths.push({ scope: u.searchParams.get('scope'), interactive });
          if (!interactive) throw new Error('User interaction required.');
          return `${REDIRECT}?code=c1&state=${u.searchParams.get('state')}`;
        },
      };
      const fetchImpl = async (url, init) => {
        if (new URL(url).pathname === '/oidc/v1/token') return res(200, { access_token: 'at-apis', refresh_token: 'rt', expires_in: 3600 });
        return ws.fetchImpl(url, init);
      };
      return oauthMod.create({ chromeApi: chrome, fetch: fetchImpl });
    },
  });
  await e.store.updateSettings({ oauth: { clientId: CLIENT } });
  const init = await e.h('genie:init', {});
  assert.equal(init.workspaces[0].status, 'signin');
  await assert.rejects(e.h('genie:spaces', { origin: A }), (err) => err.dcc.code === 'GENIE_SIGNIN');
  assert.deepEqual(await e.h('genie:signIn', { origin: A }), { signedIn: true });
  assert.equal(auths.at(-1).scope, 'all-apis offline_access');
  assert.equal(auths.at(-1).interactive, true);
  const spaces = await e.h('genie:spaces', { origin: A });
  assert.equal(spaces.spaces.length, 2);
  assert.equal(e.ws.seen.at(-1).auth, 'Bearer at-apis');
  // The same consent serves the monitor: no second sign-in.
  const o = oauthMod.create({ chromeApi: e.chrome, fetch: async () => res(500, {}) });
  assert.equal(await o.getAccessToken(A, 'monitor'), 'at-apis');
  assert.equal(await o.getAccessToken(A, 'apis'), 'at-apis');
  assert.deepEqual(await o.describe(A), { cost: false, apis: true, monitor: true, genie: true });
  await assert.rejects(o.getAccessToken(A, 'cost'), (err) => err.dcc.code === 'AUTH_EXPIRED', 'cost keeps its own SQL-only sign-in');
  assert.equal(auths.filter((a) => a.interactive).length, 1);
  assert.equal(oauthMod.canonicalPurpose('monitor'), 'apis');
  assert.equal(oauthMod.canonicalPurpose('genie'), 'apis');
  assert.equal(oauthMod.canonicalPurpose('nope'), null);
});

test('a monitor token saved by an earlier version counts as the shared consent', async () => {
  const chrome = fakeChrome();
  await chrome.storage.session.set({ [oauthMod.KEY]: { [A]: { monitor: { accessToken: 'old-monitor', refreshToken: null, expiresAt: T0 + 3600e3, clientId: 'lakeline-client-0001', scope: 'all-apis offline_access' } } } });
  const o = oauthMod.create({ chromeApi: chrome, fetch: async () => res(500, {}), now: () => T0 });
  assert.equal(await o.getAccessToken(A, 'genie'), 'old-monitor');
  assert.equal((await o.describe(A)).genie, true);
});

test('demo mode: synthetic agents and answers, no network at all', async () => {
  const e = await env({ mode: 'demo' });
  const init = await e.h('genie:init', {});
  assert.deepEqual(init.workspaces.map((w) => [w.origin, w.status]), [['demo', 'ready']]);
  const spaces = await e.h('genie:spaces', { origin: 'demo' });
  assert.ok(spaces.demo && spaces.spaces.every((s) => /DEMO/.test(s.title)));
  await assert.rejects(e.h('genie:spaces', { origin: A }));
  const sp = spaces.spaces.find((s) => /Revenue/.test(s.title)).id;
  await e.h('genie:ask', { origin: 'demo', spaceId: sp, question: 'Revenue by region?' });
  await e.settle();
  const turn = (await e.h('genie:state', { origin: 'demo', spaceId: sp })).thread.turns[0];
  assert.equal(turn.phase, 'done');
  assert.match(turn.texts[0].content, /DEMO/);
  assert.equal(turn.table.rows.length, 5);
  assert.equal(e.ws.seen.length, 0, 'no fetch in demo mode');
});

test('router integration: genie:* answer only the side panel and other extension pages, never content scripts', async () => {
  const e = await env();
  const router = routerMod.create({ store: e.store, secrets: e.secrets, data: { cache: { clear() {} } }, helper: null, chromeApi: e.chrome, extensionId: EXT, extensionOrigin: `chrome-extension://${EXT}`, helperPort: 8766, openPage: async () => {}, extra: e.g.handlers });
  const panel = { id: EXT, url: `chrome-extension://${EXT}/ui/sidepanel.html` };
  const ok = await router.dispatch({ type: 'genie:init' }, panel);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const fromContent = await router.dispatch({ type: 'genie:ask', origin: A, spaceId: SALES, question: QUESTION, workspaceId: '1001' }, { id: EXT, url: A + '/jobs?o=1001', tab: { id: 3 }, frameId: 0 });
  assert.equal(fromContent.ok, false);
  const external = await router.dispatch({ type: 'genie:init' }, { url: 'http://127.0.0.1:8766/setup' }, { external: true });
  assert.equal(external.ok, false);
  // A failed ask records a diagnostic with a code, never the question.
  const bad = await router.dispatch({ type: 'genie:ask', origin: A, spaceId: '../x', question: QUESTION }, panel);
  assert.equal(bad.ok, false);
  assert.ok(!JSON.stringify(await e.store.getDiagnostics()).includes('ACME'));
  assert.equal(e.ws.seen.length, 0);
});

test('store: settings.genie migrates from v2, validates remembered agents and merges per origin', async () => {
  const s = storeMod.migrateSettings({ schemaVersion: 2, mode: 'demo', monitor: { enabled: true } });
  assert.deepEqual(s.genie, { notify: false, lastSpace: {} });
  assert.equal(s.schemaVersion, storeMod.SCHEMA_VERSION);
  assert.equal(s.monitor.enabled, true);
  const dirty = storeMod.migrateSettings({ genie: { notify: 'yes', lastSpace: { [A]: SALES, demo: 'de300000000000000000000000000001', 'javascript:alert(1)': SALES, [B]: '../x', 'http://127.0.0.1:8765': SALES }, extra: 1 } });
  assert.deepEqual(dirty.genie, { notify: false, lastSpace: { [A]: SALES, demo: 'de300000000000000000000000000001', 'http://127.0.0.1:8765': SALES } });
  const many = storeMod.migrateGenie({ notify: true, lastSpace: Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['https://dbc-' + i + '.cloud.databricks.com', SALES])) });
  assert.equal(Object.keys(many.lastSpace).length, 20);
  assert.equal(many.notify, true);

  const store = storeMod.create(fakeArea());
  await store.migrate();
  await store.updateSettings({ genie: { lastSpace: { [A]: SALES } } });
  await store.updateSettings({ genie: { lastSpace: { [B]: BROKEN } } });
  const next = await store.updateSettings({ genie: { notify: true } });
  assert.deepEqual(next.genie, { notify: true, lastSpace: { [A]: SALES, [B]: BROKEN } });
  const removed = await store.updateSettings({ genie: { lastSpace: { [A]: null } } });
  assert.deepEqual(removed.genie.lastSpace, { [B]: BROKEN });
  assert.equal((await store.updateSettings({ monitor: { enabled: true } })).genie.notify, true, 'other patches keep Genie prefs');
});

test('genieError maps HTTP failures onto the Genie catalog', () => {
  const g = genieMod.create({ store: {}, secrets: {}, chromeApi: fakeChrome(), log: () => {} });
  const err = (status, errorCode) => ({ dcc: { code: 'UNKNOWN', details: { httpStatus: status, errorCode, message: 'x' } } });
  assert.equal(g.genieError(err(429), 'send').code, 'GENIE_RATE_LIMITED');
  assert.equal(g.genieError(err(403), 'poll').code, 'GENIE_ACCESS_DENIED');
  assert.equal(g.genieError(err(404), 'list').code, 'GENIE_UNAVAILABLE');
  assert.equal(g.genieError(err(404), 'send').code, 'GENIE_NOT_FOUND');
  assert.equal(g.genieError(err(401), 'poll', 'oauth').code, 'GENIE_SIGNIN');
  assert.equal(g.genieError(err(401), 'poll', 'pat').code, 'AUTH_EXPIRED');
  assert.equal(g.genieError(err(400, 'INVALID_PARAMETER_VALUE'), 'send').code, 'GENIE_FAILED');
  assert.equal(g.genieError(err(503), 'poll').code, 'UNKNOWN', '5xx stays retryable');
  assert.equal(g.genieError({ dcc: { code: 'NETWORK', details: {} } }, 'poll').code, 'NETWORK');
  assert.ok(gapi.isId(SALES));
});
