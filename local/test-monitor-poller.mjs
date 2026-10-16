// Monitor poller, badge, notifications, window and cost line. SIMULATED: fake `chrome` APIs
// (alarms, action, notifications, permissions, storage, windows, tabs) and a fake Databricks
// REST/helper fetch. Not proof of behavior in a real browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './support/load.mjs';

const monitorMod = load('background/monitor.js');
const mapi = load('databricks/monitor-api.js');
const storeMod = load('background/store.js');
const secretsMod = load('background/secrets.js');
const dataService = load('background/data-service.js');
const helperClient = load('background/helper-client.js');
const cacheMod = load('background/cache.js');

const ORIGIN = 'https://dbc-1.cloud.databricks.com';
const ORIGIN2 = 'https://dbc-2.cloud.databricks.com';
const WS = '1234567890123';
const WH = '0123456789abcdef';
const PAT = ('dapi' + '0123456789abcdef'.repeat(2));
const T0 = Date.parse('2026-10-15T12:00:00Z');
const MIN = 60 * 1000;
const H = 60 * MIN;

const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const json = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj), json: async () => obj });
const runUrl = (job, run) => `${ORIGIN}/?o=${WS}#job/${job}/run/${run}`;

function event() {
  const fns = [];
  return { addListener: (fn) => fns.push(fn), fire: (...a) => fns.map((fn) => fn(...a)), get count() { return fns.length; } };
}

/** chrome.storage area that reports changes to chrome.storage.onChanged. */
function area(name, onChanged) {
  const data = {};
  return {
    data,
    async get(key) {
      if (key == null) return structuredClone(data);
      const out = {};
      for (const k of [].concat(key)) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: data[k] === undefined ? undefined : structuredClone(data[k]), newValue: structuredClone(v) };
        data[k] = structuredClone(v);
      }
      onChanged.fire(changes, name);
    },
    async remove(key) {
      const changes = {};
      for (const k of [].concat(key)) {
        if (k in data) changes[k] = { oldValue: data[k] };
        delete data[k];
      }
      if (Object.keys(changes).length) onChanged.fire(changes, name);
    },
  };
}

function fakeChrome() {
  const onChanged = event();
  const alarms = new Map();
  const granted = new Set();
  const hostGranted = new Set([ORIGIN + '/*', ORIGIN2 + '/*']);
  const windows = new Map();
  let nextWindowId = 100;
  const c = {
    log: { badge: [], notifications: [], cleared: [], tabs: [], windowsCreated: [], windowsUpdated: [] },
    badge: { text: '', color: null, title: null },
    granted,
    hostGranted,
    windowsMap: windows,
    runtime: { id: 'testext', getURL: (p) => 'chrome-extension://testext/' + p, onStartup: event(), onInstalled: event() },
    alarms: {
      map: alarms,
      async create(name, info) {
        alarms.set(name, { name, periodInMinutes: info.periodInMinutes, delayInMinutes: info.delayInMinutes });
      },
      async get(name) {
        return alarms.get(name);
      },
      async clear(name) {
        return alarms.delete(name);
      },
      onAlarm: event(),
    },
    action: {
      async setBadgeText({ text }) {
        c.badge.text = text;
        c.log.badge.push(text);
      },
      async setBadgeBackgroundColor({ color }) {
        c.badge.color = color;
      },
      async setBadgeTextColor() {},
      async setTitle({ title }) {
        c.badge.title = title;
      },
    },
    notifications: {
      async create(id, opts) {
        c.log.notifications.push({ id, opts });
        return id;
      },
      async clear(id) {
        c.log.cleared.push(id);
        return true;
      },
      onClicked: event(),
    },
    permissions: {
      async contains(q) {
        if (q.permissions) return q.permissions.every((p) => granted.has(p));
        return (q.origins || []).every((o) => hostGranted.has(o));
      },
      onAdded: event(),
    },
    storage: { onChanged },
    windows: {
      async create(opts) {
        const w = { id: nextWindowId++, type: opts.type, state: 'normal', opts };
        windows.set(w.id, w);
        c.log.windowsCreated.push(opts);
        return { id: w.id, type: w.type };
      },
      async get(id) {
        const w = windows.get(id);
        if (!w) throw new Error('No window with id: ' + id);
        return { id: w.id, type: w.type, state: w.state };
      },
      async update(id, info) {
        c.log.windowsUpdated.push({ id, info });
        return { id };
      },
      onRemoved: event(),
    },
    tabs: {
      async create(o) {
        c.log.tabs.push(o);
        return { id: 1 };
      },
    },
  };
  c.storage.local = area('local', onChanged);
  c.storage.session = area('session', onChanged);
  return c;
}

/** Fake workspace REST. `ws.runsActive` etc. are mutable between polls. */
function fakeWorkspace() {
  const ws = {
    calls: [],
    failWith: null,
    delayMs: 0,
    runsActive: [],
    runsRecent: [],
    pipelines: [],
    warehouses: [{ id: WH, name: 'Starter', state: 'RUNNING', cluster_size: 'Small', enable_serverless_compute: true, num_clusters: 1 }],
    clusters: [],
  };
  ws.fetch = async (url, init) => {
    const u = new URL(url);
    ws.calls.push({ method: init.method, origin: u.origin, path: u.pathname, query: Object.fromEntries(u.searchParams), auth: init.headers && init.headers.Authorization });
    if (ws.delayMs) await settle(ws.delayMs);
    if (ws.failWith === 'network') throw new TypeError('Failed to fetch');
    if (ws.failWith) return json(ws.failWith.status, ws.failWith.body);
    if (init.headers.Authorization !== 'Bearer ' + PAT) return json(401, { error_code: 'UNAUTHENTICATED', message: 'Invalid access token' });
    if (u.pathname === '/api/2.2/jobs/runs/list') return json(200, { runs: u.searchParams.get('active_only') === 'true' ? ws.runsActive : ws.runsRecent, has_more: false });
    if (u.pathname === '/api/2.0/pipelines') return json(200, { statuses: ws.pipelines });
    if (u.pathname === '/api/2.0/sql/warehouses') return json(200, { warehouses: ws.warehouses });
    if (u.pathname === '/api/2.1/clusters/list') return json(200, { clusters: ws.clusters });
    if (u.pathname.startsWith('/api/2.0/sql/statements')) return json(500, { message: 'statement endpoint must never be reached in these tests' });
    return json(404, { error_code: 'NOT_FOUND', message: 'no route' });
  };
  return ws;
}

const failedRun = (id, endMs, name = 'Job ' + id) => ({
  job_id: 11,
  run_id: id,
  run_name: name,
  start_time: endMs - 10 * MIN,
  end_time: endMs,
  run_page_url: runUrl(11, id),
  status: { state: 'TERMINATED', termination_details: { code: 'RUN_EXECUTION_ERROR', type: 'CLIENT_ERROR', message: 'SELECT secret FROM t' } },
});
const okRun = (id, endMs) => ({ ...failedRun(id, endMs), status: { state: 'TERMINATED', termination_details: { code: 'SUCCESS', type: 'SUCCESS' } } });
const activeRun = (id, state = 'RUNNING', url = runUrl(11, id)) => ({ job_id: 11, run_id: id, run_name: 'Active ' + id, start_time: T0 - 5 * MIN, end_time: 0, run_page_url: url, status: { state } });

async function setup({ enabled = true, authMode = 'pat', notify = false, grantNotifications = false, connections = [ORIGIN], pat = true, bridge = null, helperFetch = null, dataOverride = null, autoOpen = false, firstPoll = enabled } = {}) {
  const chrome = fakeChrome();
  if (grantNotifications) chrome.granted.add('notifications');
  const clock = { now: T0 };
  const ws = fakeWorkspace();
  const store = storeMod.create(chrome.storage.local);
  const secrets = secretsMod.create(chrome.storage.session);
  for (const origin of connections) {
    const r = await store.saveConnection({ origin, workspaceId: WS, authMode, warehouse: { mode: 'manual', id: WH } });
    assert.ok(r.ok, JSON.stringify(r));
    if (pat && authMode === 'pat') await secrets.setPat(origin, PAT);
  }
  if (bridge) await secrets.setBridge(bridge);
  const helperCalls = [];
  const helper = helperClient.create({
    fetch: async (url, init) => {
      helperCalls.push({ url, body: JSON.parse(init.body) });
      return helperFetch ? helperFetch(url, JSON.parse(init.body)) : json(503, {});
    },
    getBridge: () => secrets.getBridge(),
  });
  const data = dataOverride ? dataOverride({ store, secrets, helper, fetch: ws.fetch, now: () => clock.now }) : dataService.create({ store, secrets, helper, fetch: ws.fetch, now: () => clock.now });
  await store.updateSettings({ monitor: { enabled, notifyFailures: notify, autoOpen } });
  const mon = monitorMod.create({ store, secrets, data, helper, chromeApi: chrome, fetch: ws.fetch, now: () => clock.now, log: () => {} });
  mon.init();
  await settle();
  // Enabled before init (no settings change observed): poll once, like the first alarm tick.
  if (firstPoll) await mon.poll({});
  return { chrome, clock, ws, store, secrets, data, helper, helperCalls, mon, h: mon.handlers };
}

const sessionState = (env) => env.chrome.storage.session.data[monitorMod.STATE_KEY];
const callPage = (env, type, msg = {}) => env.h[type].handle(Object.assign({ type }, msg), {});

/* ------------------------------------------------------------------ lifecycle */

test('init registers alarm, startup, storage, window and notification listeners synchronously', async () => {
  const chrome = fakeChrome();
  const store = storeMod.create(chrome.storage.local);
  const mon = monitorMod.create({ store, secrets: secretsMod.create(chrome.storage.session), data: {}, helper: {}, chromeApi: chrome, fetch: async () => json(500, {}), log: () => {} });
  mon.init();
  assert.equal(chrome.alarms.onAlarm.count, 1);
  assert.equal(chrome.runtime.onStartup.count, 1);
  assert.equal(chrome.runtime.onInstalled.count, 1);
  assert.equal(chrome.storage.onChanged.count, 1);
  assert.equal(chrome.windows.onRemoved.count, 1);
  assert.equal(chrome.notifications.onClicked.count, 1);
  assert.equal(chrome.permissions.onAdded.count, 1);
  for (const t of ['monitor:open', 'monitor:state', 'monitor:refresh', 'monitor:setOrigin', 'monitor:loadCost']) assert.equal(mon.handlers[t].trust, 'page');
  await settle();
});

test('polls only while enabled; alarm follows the interval and is cleared (with the badge) when disabled', async () => {
  const env = await setup({ enabled: false });
  assert.equal(env.chrome.alarms.map.size, 0);
  env.chrome.alarms.onAlarm.fire({ name: 'dcc-monitor' });
  await settle();
  assert.equal(await env.mon.poll(), null);
  assert.equal(env.ws.calls.length, 0, 'no network while disabled');

  await env.store.updateSettings({ monitor: { enabled: true } });
  await settle(30);
  assert.equal(env.chrome.alarms.map.get('dcc-monitor').periodInMinutes, 1);
  assert.ok(env.ws.calls.length > 0, 'enabling polls right away');
  assert.equal(sessionState(env).status, 'ok');

  await env.store.updateSettings({ monitor: { intervalSec: 300 } });
  await settle();
  assert.equal(env.chrome.alarms.map.get('dcc-monitor').periodInMinutes, 5);

  env.chrome.badge.text = 'x';
  await env.store.updateSettings({ monitor: { enabled: false } });
  await settle();
  assert.equal(env.chrome.alarms.map.size, 0);
  assert.equal(sessionState(env), undefined, 'session state cleared');
  assert.equal(env.chrome.badge.text, '');
  const before = env.ws.calls.length;
  env.chrome.alarms.onAlarm.fire({ name: 'dcc-monitor' });
  env.chrome.alarms.onAlarm.fire({ name: 'other-alarm' });
  await settle();
  assert.equal(env.ws.calls.length, before);
});

test('PAT polling uses only allowlisted monitor GETs (never SQL statements) and stores validated state', async () => {
  const env = await setup({ enabled: false });
  env.ws.runsActive = [activeRun(1), activeRun(2, 'QUEUED'), activeRun(3, 'RUNNING', 'https://evil.example/#job/11/run/3')];
  env.ws.runsRecent = [okRun(4, T0 - H), failedRun(5, T0 - 2 * H)];
  env.ws.pipelines = [{ pipeline_id: '00000001-aaaa-bbbb-cccc-dddddddddddd', name: 'orders', state: 'RUNNING', latest_updates: [{ update_id: '00000002-aaaa-bbbb-cccc-dddddddddddd', state: 'RUNNING', creation_time: '2026-10-15T11:58:00Z' }] }];
  env.ws.clusters = [{ cluster_id: '0923-164208-meows279', cluster_name: 'Shared', state: 'RUNNING', num_workers: 2 }];
  await env.store.updateSettings({ monitor: { enabled: true } });
  await settle(30);

  assert.ok(env.ws.calls.length >= 5);
  for (const c of env.ws.calls) {
    assert.equal(c.method, 'GET');
    assert.equal(c.origin, ORIGIN);
    assert.ok(mapi.MONITOR_PATHS.includes(c.path), c.path);
    assert.equal(c.auth, 'Bearer ' + PAT);
  }
  assert.ok(!env.ws.calls.some((c) => c.path.startsWith('/api/2.0/sql/statements')));
  const active = env.ws.calls.find((c) => c.query.active_only === 'true');
  assert.equal(active.query.limit, '25');
  const recent = env.ws.calls.find((c) => c.query.completed_only === 'true');
  assert.equal(recent.query.start_time_from, String(T0 - 24 * H));

  const st = sessionState(env);
  for (const k of ['at', 'origin', 'runs', 'pipelines', 'warehouses', 'clusters', 'errors', 'counts']) assert.ok(k in st, k);
  assert.equal(st.origin, ORIGIN);
  assert.equal(st.at, T0);
  assert.deepEqual(st.errors, {});
  assert.equal(st.counts.running, 2);
  assert.equal(st.counts.pending, 1);
  assert.equal(st.counts.failed, 1);
  assert.equal(st.counts.succeeded, 1);
  assert.equal(st.counts.warehousesRunning, 1);
  assert.equal(st.counts.clustersActive, 1);
  assert.equal(st.counts.pipelinesActive, 1);
  assert.equal(st.runs.find((r) => r.runId === '3').url, null, 'foreign run URL dropped');
  assert.equal(st.runs.find((r) => r.runId === '1').url, runUrl(11, 1));
  assert.doesNotMatch(JSON.stringify(st), /SELECT secret/);

  const page = await callPage(env, 'monitor:state');
  assert.deepEqual(page.connections, [ORIGIN]);
  assert.equal(page.monitorOrigin, ORIGIN);
  assert.equal(page.settings.enabled, true);
  assert.equal(page.state.counts.running, 2);
  assert.equal('failedSeen' in page.state, false, 'internal bookkeeping stays private');
  assert.equal('links' in page.state, false);
});

test('concurrent polls are deduplicated', async () => {
  const env = await setup({ enabled: true });
  await settle(30);
  env.ws.calls.length = 0;
  env.clock.now += 10 * MIN;
  env.ws.delayMs = 20;
  const [a, b, c] = await Promise.all([env.mon.poll({ manual: true }), env.mon.poll({ manual: true }), callPage(env, 'monitor:refresh')]);
  assert.equal(a, b);
  assert.equal(env.ws.calls.filter((x) => x.query.active_only === 'true').length, 1);
  assert.equal(env.ws.calls.length, 5, 'one poll: active runs, recent runs, pipelines, warehouses, clusters');
  assert.equal(c.state.status, 'ok');
});

test('errors back off exponentially by skipping alarm ticks; manual refresh still works', async () => {
  const env = await setup({ enabled: false });
  env.ws.failWith = 'network';
  await env.store.updateSettings({ monitor: { enabled: true } });
  await settle(30);
  let st = sessionState(env);
  assert.equal(st.status, 'error');
  assert.equal(st.backoff.failures, 1);
  assert.equal(st.backoff.nextAt, T0 + 2 * MIN);
  assert.equal(st.errors.runsActive.code, 'NETWORK');
  const calls = env.ws.calls.length;

  env.clock.now = T0 + MIN;
  env.chrome.alarms.onAlarm.fire({ name: 'dcc-monitor' });
  await settle();
  assert.equal(env.ws.calls.length, calls, 'tick inside the backoff window is skipped');
  assert.equal(env.mon.stats.skipped, 1);

  env.clock.now = T0 + 2 * MIN;
  env.chrome.alarms.onAlarm.fire({ name: 'dcc-monitor' });
  await settle();
  st = sessionState(env);
  assert.ok(env.ws.calls.length > calls);
  assert.equal(st.backoff.failures, 2);
  assert.equal(st.backoff.nextAt, T0 + 2 * MIN + 4 * MIN);

  // Cap at 30 minutes.
  for (let i = 0; i < 6; i++) {
    env.clock.now = sessionState(env).backoff.nextAt;
    await env.mon.poll({});
  }
  st = sessionState(env);
  assert.equal(st.backoff.nextAt - st.attemptAt, monitorMod.MAX_BACKOFF_MS);

  env.ws.failWith = null;
  env.clock.now += 10 * 1000;
  const page = await callPage(env, 'monitor:refresh');
  assert.equal(page.state.status, 'ok', 'manual refresh bypasses backoff');
  assert.equal(sessionState(env).backoff.failures, 0);
});

test('expired PAT or missing token: data cleared with a "Sign in for monitor" next step', async () => {
  const env = await setup({ enabled: true });
  await settle(30);
  assert.ok(sessionState(env).runs !== undefined);
  env.ws.runsActive = [activeRun(1)];
  env.clock.now += 10 * MIN;
  env.ws.failWith = { status: 401, body: { error_code: 'UNAUTHENTICATED', message: 'Invalid access token' } };
  await env.mon.poll({ manual: true });
  let st = sessionState(env);
  assert.equal(st.status, 'signin');
  assert.equal(st.next.title, 'Sign in for monitor');
  assert.deepEqual(st.runs, []);
  assert.equal(st.counts.running, null);
  assert.equal(env.chrome.badge.text, '');

  await env.secrets.clearPat(ORIGIN);
  env.ws.calls.length = 0;
  env.clock.now += 10 * MIN;
  await env.mon.poll({ manual: true });
  st = sessionState(env);
  assert.equal(st.status, 'signin');
  assert.match(st.next.steps[0], /personal access token/);
  assert.equal(env.ws.calls.length, 0, 'no request without a token');
});

test('workspace choice: several connections need an explicit monitor origin; setOrigin accepts saved ones only', async () => {
  const env = await setup({ enabled: true, connections: [ORIGIN, ORIGIN2] });
  await env.mon.poll({ manual: true });
  assert.equal(sessionState(env).status, 'choose-workspace');
  assert.equal(env.ws.calls.length, 0);
  await assert.rejects(callPage(env, 'monitor:setOrigin', { origin: 'https://dbc-9.cloud.databricks.com' }), (e) => e.dcc.code === 'NOT_CONNECTED');
  await assert.rejects(callPage(env, 'monitor:setOrigin', { origin: 'https://evil.example' }));
  const page = await callPage(env, 'monitor:setOrigin', { origin: ORIGIN2 });
  assert.equal(page.monitorOrigin, ORIGIN2);
  assert.deepEqual(page.connections, [ORIGIN, ORIGIN2]);
  assert.equal(page.state.status, 'ok');
  assert.ok(env.ws.calls.every((c) => c.origin === ORIGIN2));
});

test('demo mode makes no Databricks requests', async () => {
  const env = await setup({ enabled: true });
  await settle(30);
  env.ws.calls.length = 0;
  await env.store.updateSettings({ mode: 'demo' });
  await settle(30);
  env.clock.now += 10 * MIN;
  await env.mon.poll({ manual: true });
  assert.equal(sessionState(env).status, 'demo-mode');
  assert.equal(env.ws.calls.length, 0);
});

/* ------------------------------------------------------------------ notifications */

test('notifications: opt-in + permission gated, one per newly failed run, never for failures before monitoring started', async () => {
  const env = await setup({ enabled: false, notify: true, grantNotifications: false });
  env.ws.runsRecent = [failedRun(100, T0 - H)];
  await env.store.updateSettings({ monitor: { enabled: true } });
  await settle(30);
  assert.equal(env.chrome.log.notifications.length, 0, 'first poll never notifies');
  const baseline = sessionState(env).baselineAt;
  assert.equal(baseline, T0);

  // Permission not granted: a new failure is recorded but not notified.
  env.clock.now = T0 + 2 * MIN;
  env.ws.runsRecent = [failedRun(101, T0 + MIN), failedRun(100, T0 - H)];
  await env.mon.poll({});
  assert.equal(env.chrome.log.notifications.length, 0);

  // Grant permission: only failures first seen from now on are notified.
  env.chrome.granted.add('notifications');
  env.clock.now = T0 + 4 * MIN;
  env.ws.runsRecent = [failedRun(102, T0 + 3 * MIN, 'Orders load'), failedRun(101, T0 + MIN), failedRun(100, T0 - H), okRun(103, T0 + 3 * MIN)];
  await env.mon.poll({});
  assert.deepEqual(env.chrome.log.notifications.map((n) => n.id), ['dcc-run-102']);
  const n = env.chrome.log.notifications[0].opts;
  assert.equal(n.type, 'basic');
  assert.match(n.message, /Orders load/);
  assert.match(n.message, /Failed/);
  assert.equal(n.contextMessage, 'dbc-1.cloud.databricks.com');
  assert.doesNotMatch(JSON.stringify(n), /SELECT secret/);

  // Same run again: deduplicated across polls.
  env.clock.now = T0 + 6 * MIN;
  await env.mon.poll({});
  assert.equal(env.chrome.log.notifications.length, 1);

  // A failure that ended before monitoring started, first seen now: never notified.
  env.clock.now = T0 + 8 * MIN;
  env.ws.runsRecent = [failedRun(99, T0 - 30 * MIN)].concat(env.ws.runsRecent);
  await env.mon.poll({});
  assert.equal(env.chrome.log.notifications.length, 1);

  // Click opens the validated run page and clears the notification.
  await env.mon.onNotificationClicked('dcc-run-102');
  assert.deepEqual(env.chrome.log.tabs, [{ url: runUrl(11, 102) }]);
  assert.deepEqual(env.chrome.log.cleared, ['dcc-run-102']);

  // notifyFailures off: nothing, but the run is still marked seen (no flood when turned on later).
  await env.store.updateSettings({ monitor: { notifyFailures: false } });
  env.clock.now = T0 + 10 * MIN;
  env.ws.runsRecent = [failedRun(104, T0 + 9 * MIN)].concat(env.ws.runsRecent);
  await env.mon.poll({});
  await env.store.updateSettings({ monitor: { notifyFailures: true } });
  env.clock.now = T0 + 12 * MIN;
  await env.mon.poll({});
  assert.equal(env.chrome.log.notifications.length, 1);
  assert.ok(sessionState(env).failedSeen.includes('104'));
});

test('notifications: burst is capped with one summary; tampered stored link is not opened', async () => {
  const env = await setup({ enabled: true, notify: true, grantNotifications: true });
  await settle(30);
  env.clock.now = T0 + 2 * MIN;
  env.ws.runsRecent = [1, 2, 3, 4, 5, 6, 7].map((i) => failedRun(200 + i, T0 + MIN));
  await env.mon.poll({});
  const ids = env.chrome.log.notifications.map((n) => n.id);
  assert.equal(ids.filter((id) => id.startsWith('dcc-run-')).length, monitorMod.NOTIFY_PER_POLL);
  assert.equal(ids.filter((id) => id.startsWith('dcc-more-')).length, 1);
  assert.equal(env.chrome.log.notifications.find((n) => n.id.startsWith('dcc-more-')).opts.title, '2 more job runs failed');

  // Tamper with the stored link: click falls back to opening the monitor window.
  const st = sessionState(env);
  const id = ids[0];
  st.links[id].url = 'https://evil.example/#job/11/run/201';
  await env.chrome.storage.session.set({ [monitorMod.STATE_KEY]: st });
  await env.mon.onNotificationClicked(id);
  assert.equal(env.chrome.log.tabs.length, 0);
  assert.equal(env.chrome.log.windowsCreated.length, 1);
});

/* ------------------------------------------------------------------ badge */

test('badge: active run count; new failures add "!" and a distinct color until the window shows them', async () => {
  const env = await setup({ enabled: false });
  env.ws.runsActive = [activeRun(1), activeRun(2), activeRun(3, 'QUEUED')];
  await env.store.updateSettings({ monitor: { enabled: true } });
  await settle(30);
  assert.equal(env.chrome.badge.text, '3');
  assert.equal(env.chrome.badge.color, monitorMod.BADGE.normal);
  assert.match(env.chrome.badge.title, /3 active runs/);

  env.clock.now = T0 + 2 * MIN;
  env.ws.runsRecent = [failedRun(300, T0 + MIN)];
  await env.mon.poll({});
  assert.equal(env.chrome.badge.text, '3!');
  assert.equal(env.chrome.badge.color, monitorMod.BADGE.failure);
  assert.match(env.chrome.badge.title, /1 new failed run in the last 24 h/);

  // monitor:state without ack (window hidden) keeps it; with ack it clears.
  await callPage(env, 'monitor:state', { ack: false });
  assert.equal(env.chrome.badge.text, '3!');
  const page = await callPage(env, 'monitor:state', { ack: true });
  assert.equal(page.state.unseenFailures, 0);
  assert.equal(env.chrome.badge.text, '3');
  assert.equal(env.chrome.badge.color, monitorMod.BADGE.normal);

  env.clock.now = T0 + 4 * MIN;
  env.ws.runsActive = [];
  env.ws.runsRecent = [failedRun(301, T0 + 3 * MIN), failedRun(300, T0 + MIN)];
  await env.mon.poll({});
  assert.equal(env.chrome.badge.text, '!', 'no active runs, one unseen failure');

  await env.store.updateSettings({ monitor: { enabled: false } });
  await settle();
  assert.equal(env.chrome.badge.text, '');
});

/* ------------------------------------------------------------------ window */

test('monitor:open opens one popup window (380×600) and focuses it afterwards; onStartup auto-opens only when asked', async () => {
  const env = await setup({ enabled: true });
  const [a, b] = await Promise.all([callPage(env, 'monitor:open'), callPage(env, 'monitor:open')]);
  assert.equal(env.chrome.log.windowsCreated.length, 1, 'concurrent opens share one window');
  assert.equal(a.windowId, b.windowId);
  const opts = env.chrome.log.windowsCreated[0];
  assert.deepEqual([opts.type, opts.width, opts.height, opts.url], ['popup', 380, 600, 'chrome-extension://testext/ui/monitor.html']);

  const again = await callPage(env, 'monitor:open');
  assert.equal(again.focused, true);
  assert.equal(env.chrome.log.windowsCreated.length, 1);
  assert.deepEqual(env.chrome.log.windowsUpdated.at(-1), { id: a.windowId, info: { focused: true } });

  env.chrome.windowsMap.delete(a.windowId);
  env.chrome.windows.onRemoved.fire(a.windowId);
  await settle();
  assert.equal(env.chrome.storage.session.data[monitorMod.WINDOW_KEY], undefined);
  await callPage(env, 'monitor:open');
  assert.equal(env.chrome.log.windowsCreated.length, 2);

  // Startup without autoOpen: no window. With autoOpen: one.
  const quiet = await setup({ enabled: true, autoOpen: false });
  quiet.chrome.runtime.onStartup.fire();
  await settle(30);
  assert.equal(quiet.chrome.log.windowsCreated.length, 0);
  const auto = await setup({ enabled: true, autoOpen: true });
  auto.chrome.runtime.onStartup.fire();
  await settle(30);
  assert.equal(auto.chrome.log.windowsCreated.length, 1);
  const off = await setup({ enabled: false, autoOpen: true });
  off.chrome.runtime.onStartup.fire();
  await settle(30);
  assert.equal(off.chrome.log.windowsCreated.length, 0, 'disabled monitor never auto-opens');
});

/* ------------------------------------------------------------------ cost line */

test('loadCost: a stopped warehouse needs confirmation and no SQL is executed; cached values need no network', async () => {
  const env = await setup({ enabled: true });
  await settle(30);
  env.ws.warehouses = [{ id: WH, name: 'Starter', state: 'STOPPED', cluster_size: 'Small' }];
  env.ws.calls.length = 0;

  const cachedOnly = await callPage(env, 'monitor:loadCost', { cachedOnly: true });
  assert.equal(cachedOnly.notCached, true);
  assert.equal(env.ws.calls.length, 0, 'cache check is local');

  const res = await callPage(env, 'monitor:loadCost', {});
  assert.deepEqual(res, { needsConfirm: true, warehouseId: WH, warehouseName: 'Starter', state: 'STOPPED', periodDays: 30 });
  assert.deepEqual(env.ws.calls.map((c) => c.method + ' ' + c.path), ['GET /api/2.0/sql/warehouses']);
  assert.ok(!env.ws.calls.some((c) => c.path.startsWith('/api/2.0/sql/statements')), 'no SQL statement sent');

  // A summary already in the data-service cache is returned without any request.
  const conn = await env.store.getConnection(ORIGIN);
  const key = cacheMod.key({ origin: ORIGIN, workspaceId: WS, source: 'pat:' + conn.priceTable + ':' + conn.currency, connRev: conn.revision, kind: 'summary', periodDays: 30 });
  env.data.cache.set(key, { kind: 'summary', pricingBasis: 'list', priceTable: 'system.billing.list_prices', currency: 'USD', period: { days: 30, start: '2026-09-15', endExclusive: '2026-10-15' }, current: { coverage: 'complete' }, currentAmount: 123.45, latestUsageMs: T0 - H });
  env.ws.calls.length = 0;
  const hit = await callPage(env, 'monitor:loadCost', {});
  assert.equal(hit.amount, 123.45);
  assert.equal(hit.basis, 'list');
  assert.equal(hit.cached, true);
  assert.deepEqual(hit.period, { days: 30, start: '2026-09-15', endExclusive: '2026-10-15' });
  assert.equal(env.ws.calls.length, 0);

  await env.store.updateSettings({ showCosts: false });
  assert.deepEqual(await callPage(env, 'monitor:loadCost', {}), { paused: true });
});

test('loadCost: confirmed start (or a running warehouse) calls the summary once; missing amount stays null', async () => {
  const summaries = [];
  const env = await setup({
    enabled: true,
    dataOverride: (o) => {
      const real = dataService.create(o);
      return Object.assign({}, real, {
        async summary(req) {
          summaries.push(req);
          return { kind: 'summary', pricingBasis: 'account', priceTable: 'system.billing.account_prices', currency: 'EUR', period: { days: 30, start: '2026-09-15', endExclusive: '2026-10-15' }, current: { coverage: 'empty' }, currentAmount: null };
        },
      });
    },
  });
  env.ws.warehouses = [{ id: WH, name: 'Starter', state: 'STOPPED' }];
  assert.equal((await callPage(env, 'monitor:loadCost', {})).needsConfirm, true);
  assert.equal(summaries.length, 0);
  const res = await callPage(env, 'monitor:loadCost', { confirmStart: true });
  assert.equal(summaries.length, 1);
  assert.deepEqual(summaries[0], { origin: ORIGIN, workspaceId: WS, periodDays: 30, force: false });
  assert.equal(res.amount, null, 'missing is null, not zero');
  assert.equal(res.basis, 'account');
  assert.equal(res.currency, 'EUR');

  env.ws.warehouses = [{ id: WH, name: 'Starter', state: 'RUNNING' }];
  await callPage(env, 'monitor:loadCost', {});
  assert.equal(summaries.length, 2, 'running warehouse needs no confirmation');
});

/* ------------------------------------------------------------------ helper mode */

test('helper mode: capability-gated, forwards only monitor GET paths through /bridge/api', async () => {
  const bridge = { key: '0123456789abcdef01234567', port: 8766, helperVersion: '1.0.0', capabilities: { priceAdapterVersion: 2, monitor: true, protocol: 1 } };
  const env = await setup({
    enabled: true,
    authMode: 'helper',
    bridge,
    helperFetch: async (url, body) => {
      if (!url.endsWith('/bridge/api')) return json(404, { ok: false });
      if (body.path === '/api/2.2/jobs/runs/list') return json(200, { ok: true, data: { runs: body.query.active_only === 'true' ? [activeRun(7)] : [] } });
      if (body.path === '/api/2.0/sql/warehouses') return json(200, { ok: true, data: { warehouses: [] } });
      return json(200, { ok: true, data: {} });
    },
  });
  await settle(30);
  const st = sessionState(env);
  assert.equal(st.status, 'ok');
  assert.equal(st.counts.running, 1);
  assert.ok(env.helperCalls.length >= 5);
  for (const c of env.helperCalls) {
    assert.equal(c.url, 'http://127.0.0.1:8766/bridge/api');
    assert.equal(c.body.origin, ORIGIN);
    assert.ok(mapi.MONITOR_PATHS.includes(c.body.path), c.body.path);
  }
  assert.equal(env.ws.calls.length, 0, 'no direct workspace calls in helper mode');

  // Old helper without the monitor capability: specific error, no bridge call.
  const old = await setup({ enabled: true, authMode: 'helper', bridge: Object.assign({}, bridge, { capabilities: { priceAdapterVersion: 2 } }) });
  await settle(30);
  assert.equal(sessionState(old).status, 'error');
  assert.equal(sessionState(old).next.code, 'HELPER_OUTDATED');
  assert.equal(old.helperCalls.length, 0);

  // Not paired: sign-in next step.
  const unpaired = await setup({ enabled: true, authMode: 'helper' });
  await settle(30);
  assert.equal(sessionState(unpaired).status, 'signin');
  assert.match(sessionState(unpaired).next.steps[0], /Sign in for monitor/);
});
