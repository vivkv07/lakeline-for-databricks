// Banner bootstrap (content-main) end to end in a SIMULATED jsdom window with a scripted
// service-worker stand-in. Not proof of behavior in a real Databricks tab; see the browser tests.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createContentEnv, BASE_CONTENT_FILES, settle } from './support/content-harness.mjs';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension');
// DCC_CONTENT_MAIN lets mutation checks run against a scratch copy instead of the shared file.
const CONTENT_MAIN = readFileSync(process.env.DCC_CONTENT_MAIN || path.join(EXT, 'src/content/content-main.js'), 'utf8') + '\n//# sourceURL=content-main.js';

// Every window is closed after each test, pass or fail, so a failure can't leave timers running.
const openEnvs = [];
afterEach(() => {
  for (const env of openEnvs.splice(0)) {
    try {
      env.close();
    } catch (_) {
      /* already closed */
    }
  }
});
const ORIGIN = 'https://dbc-1.cloud.databricks.com';
const PAGE = '<body><nav aria-label="Top Navigation">nav</nav><main><h1>Jobs</h1><p>native</p></main></body>';
const STATEMENT_ID = '01ef0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
const BASE_AMOUNT = { 42: 1000, 43: 2000 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Amount encodes workspace and period so the banner text proves which response is shown. */
const amountFor = (ws, days) => (BASE_AMOUNT[ws] || 500) + days;
const money = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function summary(days, amount, extra = {}) {
  return Object.assign(
    {
      kind: 'summary',
      pricingBasis: 'list',
      priceTable: 'system.billing.list_prices',
      currency: 'USD',
      period: { days, start: '2026-09-15', endExclusive: '2026-10-15', prevStart: '2026-08-16', prevEndExclusive: '2026-09-15' },
      current: { coverage: 'complete', total: amount, unpricedRecords: 0, unpricedSkus: [] },
      previous: { coverage: 'complete', total: amount / 2 },
      currentAmount: amount,
      previousAmount: amount / 2,
      daily: [],
      freeQuantity: {},
      latestUsageMs: Date.now() - 3600e3,
    },
    extra
  );
}

/** Scripted stand-in for the router: hello resolves IDs from the URL like ids.resolveWorkspaceId. */
function createSw() {
  const sw = {
    env: null,
    settings: { mode: 'connected', periodDays: 30, showCosts: true, revision: 1 },
    savedWorkspace: null,
    delays: {},
    summaryFor: null,
    helloFails: false,
    openOk: true,
    async persistSettings() {
      sw.settings = Object.assign({}, sw.settings, { revision: sw.settings.revision + 1 });
      if (sw.env) await sw.env.setStorage({ 'dcc.settings': Object.assign({}, sw.settings) });
    },
    async handle(msg) {
      const d = typeof sw.delays[msg.type] === 'function' ? sw.delays[msg.type](msg) : sw.delays[msg.type];
      if (d) await sleep(d);
      switch (msg.type) {
        case 'dcc:hello': {
          if (sw.helloFails) return { ok: false, error: { code: 'UNKNOWN', title: 'Something went wrong', steps: ['Select Refresh.'] } };
          const url = new URL(msg.href);
          const found = ['o', 'w', 'workspace_id'].flatMap((k) => url.searchParams.getAll(k));
          const distinct = [...new Set(found)];
          const conflict = distinct.length > 1;
          const pageId = conflict ? null : distinct[0] || sw.savedWorkspace || null;
          const connection = sw.savedWorkspace ? { workspaceId: sw.savedWorkspace, authMode: 'pat', priceTable: 'system.billing.list_prices', currency: 'USD' } : null;
          return {
            ok: true,
            data: {
              origin: ORIGIN,
              workspaceId: pageId,
              idSource: pageId ? 'param:o' : null,
              idConflict: conflict,
              settings: Object.assign({}, sw.settings),
              connection,
              connectionMismatch: Boolean(connection && pageId && connection.workspaceId !== pageId),
            },
          };
        }
        case 'dcc:summary':
          if (!sw.settings.showCosts) return { ok: true, data: { paused: true } };
          if (sw.summaryFor) return sw.summaryFor(msg);
          if (sw.settings.mode === 'demo') return { ok: true, data: summary(msg.periodDays, 77, { pricingBasis: 'demo', synthetic: true }) };
          return { ok: true, data: summary(msg.periodDays, amountFor(msg.workspaceId, msg.periodDays)) };
        case 'dcc:setPeriod':
          sw.settings.periodDays = msg.periodDays;
          await sw.persistSettings();
          return { ok: true, data: { periodDays: msg.periodDays } };
        case 'dcc:resume':
          sw.settings.showCosts = true;
          await sw.persistSettings();
          return { ok: true, data: { showCosts: true } };
        case 'dcc:open':
          return sw.openOk ? { ok: true, data: { opened: msg.page } } : { ok: false, error: { code: 'UNKNOWN', title: 'Something went wrong', steps: [] } };
        default:
          return { ok: true, data: null };
      }
    },
  };
  return sw;
}

/** Base scripts first, then test features (as feature modules would register), then content-main. */
function boot({ url = ORIGIN + '/jobs?o=42', html = PAGE, sw = createSw(), storage = {}, features = [] } = {}) {
  const env = createContentEnv({ url, html, files: BASE_CONTENT_FILES, onMessage: (m) => sw.handle(m), storage });
  openEnvs.push(env);
  sw.env = env;
  const w = env.window;
  for (const f of features) (w.DCC.features || (w.DCC.features = [])).push(f);
  w.eval(CONTENT_MAIN);
  const host = () => env.document.querySelector('[data-dcc="banner"]');
  const t = {
    env,
    sw,
    w,
    doc: env.document,
    host,
    text: () => (host() ? host().shadowRoot.textContent : ''),
    $: (sel) => host().shadowRoot.querySelector(sel),
    click: (key) => host().shadowRoot.querySelector('[data-k="' + key + '"]').click(),
    sent: (type) => env.messages.filter((m) => m.type === type),
    test: () => w.__dccTest,
    close: () => env.close(),
  };
  return t;
}

async function waitFor(fn, timeout = 3000, label = '') {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out ' + label + ': ' + fn.toString());
    await sleep(10);
  }
}

test('mounts once as the first child of main; a second injection in the same world is a no-op', async () => {
  const t = boot();
  await waitFor(() => t.text().includes(money(1030)));
  const main = t.doc.querySelector('main');
  assert.equal(main.firstElementChild, t.host());
  assert.equal(t.doc.querySelectorAll('[data-dcc="banner"]').length, 1);
  assert.equal(t.sent('dcc:summary')[0].force, false);
  t.w.eval(CONTENT_MAIN); // injectIntoOpenTabs re-runs every content file
  await settle(300);
  assert.equal(t.doc.querySelectorAll('[data-dcc="banner"]').length, 1);
  assert.equal(t.sent('dcc:hello').length, 1);
  assert.equal(t.sent('dcc:summary').length, 1);
  t.close();
});

test('SPA navigation that changes o= sends a new hello and reloads the summary for the new workspace', async () => {
  const t = boot();
  await waitFor(() => t.text().includes(money(1030)));
  t.env.navigate('/jobs?o=43');
  t.doc.querySelector('main').appendChild(t.doc.createElement('section')); // the SPA renders the new route
  await waitFor(() => t.text().includes(money(2030)), 3000, 'new workspace amount');
  assert.equal(t.sent('dcc:hello').length, 2);
  const s = t.sent('dcc:summary');
  assert.equal(s.length, 2);
  assert.equal(s[1].workspaceId, '43');
  assert.equal(t.doc.querySelectorAll('[data-dcc="banner"]').length, 1);
  t.close();
});

test('a route change in the same workspace re-identifies without reloading; pushState without DOM changes is caught by the URL poll', async () => {
  const t = boot();
  await waitFor(() => t.text().includes(money(1030)));
  t.env.navigate('/jobs/101/runs?o=42'); // no DOM mutation at all
  await waitFor(() => t.sent('dcc:hello').length === 2, 2500, 'poll-driven hello');
  await settle(200);
  assert.equal(t.sent('dcc:summary').length, 1, 'same workspace and settings: no new summary');
  t.env.window.dispatchEvent(new t.env.window.HashChangeEvent('hashchange'));
  t.env.navigate('/jobs/101/runs?o=42#x');
  t.env.window.dispatchEvent(new t.env.window.PopStateEvent('popstate'));
  await waitFor(() => t.sent('dcc:hello').length === 3, 1500, 'popstate-driven hello');
  t.close();
});

test('rapid route changes converge on the newest identity even when hello responses arrive out of order', async () => {
  const sw = createSw();
  // The hello for o=43 is slow; the later one for o=42 is fast.
  sw.delays['dcc:hello'] = (m) => (m.href.includes('o=43') ? 400 : 10);
  const t = boot({ sw });
  await waitFor(() => t.text().includes(money(1030)));
  t.env.navigate('/jobs?o=43');
  t.doc.querySelector('main').appendChild(t.doc.createElement('i'));
  await waitFor(() => t.sent('dcc:hello').length === 2);
  t.env.navigate('/jobs?o=42');
  await t.env.setStorage({ 'dcc.settings': Object.assign({}, sw.settings) }); // a second, concurrent trigger
  await settle(900);
  assert.equal(t.test().state.workspaceId, '42');
  assert.match(t.text(), /\$1,030\.00/);
  assert.ok(!t.sent('dcc:summary').some((m) => m.workspaceId === '43'), 'no summary for the superseded workspace');
  t.close();
});

test('main container replacement re-mounts the banner exactly once, without reloading data', async () => {
  const t = boot();
  await waitFor(() => t.text().includes(money(1030)));
  await settle(300);
  const placements = t.test().banner.stats().placements;
  const inserted = [];
  new t.w.MutationObserver((rs) => {
    for (const r of rs) for (const n of r.addedNodes) if (n === t.host()) inserted.push(r.target);
  }).observe(t.doc.body, { childList: true, subtree: true });
  const fresh = t.doc.createElement('main');
  fresh.innerHTML = '<h1>Job runs</h1><table><tr><td>run</td></tr></table>';
  t.doc.querySelector('main').replaceWith(fresh);
  await waitFor(() => fresh.firstElementChild === t.host(), 2000, 're-mount');
  await settle(800);
  assert.equal(inserted.length, 1, 'one insertion');
  assert.equal(inserted[0], fresh);
  assert.equal(t.test().banner.stats().placements, placements + 1);
  assert.equal(t.doc.querySelectorAll('[data-dcc="banner"]').length, 1);
  assert.equal(t.sent('dcc:summary').length, 1);
  assert.match(t.text(), /\$1,030\.00/);
  t.close();
});

test('a hidden host that is already first in the correct container is never reinserted', async () => {
  const t = boot();
  await waitFor(() => t.text().includes(money(1030)));
  const main = t.doc.querySelector('main');
  const style = t.doc.createElement('style');
  style.textContent = '[data-dcc="banner"] { display: none !important; }';
  t.doc.head.appendChild(style);
  await settle(300);
  const placements = t.test().banner.stats().placements;
  const records = [];
  new t.w.MutationObserver((rs) => records.push(...rs)).observe(main, { childList: true });
  for (let i = 0; i < 4; i++) {
    main.appendChild(t.doc.createElement('div'));
    await settle(300);
  }
  assert.equal(main.firstElementChild, t.host());
  assert.equal(records.filter((r) => [...r.addedNodes].includes(t.host())).length, 0);
  assert.equal(t.test().banner.stats().placements, placements);
  t.close();
});

test('mutation storm cannot postpone ticks beyond maxWait; idle pages and our own writes do no repeated work', async () => {
  const ticks = [];
  const probe = {
    name: 'probe',
    onTick(ctx) {
      ticks.push(Date.now());
      // Insert a badge once, then (carelessly) rewrite its text on every tick: writes inside our
      // own nodes must never feed the observer.
      const h1 = ctx.doc.querySelector('main h1');
      let b = h1 && h1.querySelector('[data-dcc="probe"]');
      if (h1 && !b) {
        b = ctx.doc.createElement('span');
        b.setAttribute('data-dcc', 'probe');
        h1.appendChild(b);
      }
      if (b) b.textContent = 'badge ' + ticks.length;
    },
  };
  const t = boot({ features: [probe] });
  await waitFor(() => t.text().includes(money(1030)));
  await settle(800);
  const idle = t.test().state.ticks;
  t.test().sync(); // banner re-render (shadow DOM only)
  await settle(1500);
  assert.equal(t.test().state.ticks, idle, 'idle page: no ticks from our own badge or banner writes');

  const clock = t.doc.createElement('span');
  t.doc.querySelector('main').appendChild(clock);
  const t0 = Date.now();
  const timer = setInterval(() => {
    clock.textContent = String(Date.now()); // continuous mutation every 20 ms
  }, 20);
  await sleep(3500);
  clearInterval(timer);
  const during = ticks.filter((x) => x > t0);
  assert.ok(during.length >= 2, 'ticks during the storm: ' + during.length);
  const points = [t0, ...during];
  for (let i = 1; i < points.length; i++) assert.ok(points[i] - points[i - 1] <= 1200 + 300, 'gap ' + (points[i] - points[i - 1]) + ' ms');
  await settle(1500);
  const after = t.test().state.ticks;
  await settle(1500);
  assert.equal(t.test().state.ticks, after, 'back to idle after the storm');
  assert.equal(t.doc.querySelectorAll('[data-dcc="probe"]').length, 1);
  t.close();
});

test('banner states through content-main: empty, none, partial, error, disconnected', async () => {
  const cases = [
    [() => ({ ok: true, data: summary(30, null, { current: { coverage: 'empty' }, currentAmount: null, previousAmount: null, latestUsageMs: null }) }), /No usage recorded in this period/],
    [() => ({ ok: true, data: summary(30, null, { current: { coverage: 'none', unpricedRecords: 2, unpricedSkus: ['SKU_A'], firstUnpricedDate: '2026-09-20', lastUnpricedDate: '2026-09-21' }, currentAmount: null, previousAmount: null }) }), /No priced usage.*2 usage records without a matching price/],
    [() => ({ ok: true, data: summary(30, 800, { current: { coverage: 'partial', pricedSubtotal: 800, unpricedRecords: 4, unpricedSkus: ['SKU_A', 'SKU_B'], firstUnpricedDate: '2026-09-20', lastUnpricedDate: '2026-10-02' } }) }), /Priced subtotal\$800\.00.*4 usage records.*SKUs: SKU_A, SKU_B.*2026-09-20 to 2026-10-02/],
    [() => ({ ok: false, error: { code: 'SQL_TIMEOUT', title: 'The cost query is taking too long', steps: ['Wait a minute and select Refresh.'], details: { errorCode: 'DEADLINE_EXCEEDED', statementId: STATEMENT_ID, message: 'timed out; Authorization: Bearer ' + 'dapi' + '0123456789abcdef'.repeat(2) } } }), /The cost query is taking too long.*Wait a minute.*DEADLINE_EXCEEDED.*01ef0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b/],
    [() => ({ ok: false, error: { code: 'NOT_CONNECTED', title: 'Not connected', steps: [] } }), /not connected to this workspace/],
  ];
  for (const [respond, expected] of cases) {
    const sw = createSw();
    sw.summaryFor = respond;
    const t = boot({ sw });
    await waitFor(() => t.sent('dcc:summary').length === 1 && !t.text().includes('Loading costs'));
    const text = t.text();
    assert.match(text, expected);
    assert.doesNotMatch(text, /\$0\.00/);
    assert.doesNotMatch(text, /dapi0123|Bearer dapi/);
    t.close();
  }
});

test('unidentified, conflicting and mismatched workspaces send no summary request', async () => {
  const noId = boot({ url: ORIGIN + '/jobs' });
  await waitFor(() => noId.text().includes('Workspace ID not identified'));
  const conflict = boot({ url: ORIGIN + '/jobs?o=42&w=43' });
  await waitFor(() => conflict.text().includes('Conflicting workspace IDs'));
  const sw = createSw();
  sw.savedWorkspace = '99';
  const mismatch = boot({ sw });
  await waitFor(() => mismatch.text().includes('This page belongs to a different workspace'));
  assert.match(mismatch.text(), /This page: workspace 42/);
  assert.match(mismatch.text(), /Saved connection: workspace 99/);
  await settle(300);
  for (const t of [noId, conflict, mismatch]) {
    assert.equal(t.sent('dcc:summary').length, 0);
    t.close();
  }
});

test('a failed hello shows an error, not "Workspace ID not identified"', async () => {
  const sw = createSw();
  sw.helloFails = true;
  const t = boot({ sw });
  await waitFor(() => t.text().includes('Something went wrong'));
  assert.doesNotMatch(t.text(), /Workspace ID not identified/);
  assert.equal(t.sent('dcc:summary').length, 0);
  t.close();
});

test('paused: Resume shown, no dcc:summary; Resume requests exactly one summary', async () => {
  const sw = createSw();
  sw.settings.showCosts = false;
  const t = boot({ sw });
  await waitFor(() => t.text().includes('Cost display paused'));
  await settle(300);
  assert.equal(t.sent('dcc:summary').length, 0);
  assert.equal(t.$('[data-k="period-30"]'), null);
  assert.ok(t.$('[data-k="resume"]'));
  t.click('resume');
  await waitFor(() => t.text().includes(money(1030)));
  await settle(300);
  assert.equal(t.sent('dcc:resume').length, 1);
  assert.equal(t.sent('dcc:summary').length, 1, 'resume response and storage event converge on one request');
  t.close();
});

test('pausing while a summary is in flight drops the response and stops new requests', async () => {
  const sw = createSw();
  sw.delays['dcc:summary'] = 300;
  const t = boot({ sw });
  await waitFor(() => t.sent('dcc:summary').length === 1);
  sw.settings.showCosts = false;
  await sw.persistSettings();
  await settle(600);
  assert.match(t.text(), /Cost display paused/);
  assert.doesNotMatch(t.text(), /\$\d/);
  t.env.navigate('/jobs?o=43');
  t.doc.querySelector('main').appendChild(t.doc.createElement('p'));
  await settle(600);
  assert.equal(t.sent('dcc:summary').length, 1, 'no requests while paused, even after a workspace change');
  t.close();
});

test('period click sends dcc:setPeriod and a summary for the new period; late responses and stale hellos are ignored', async () => {
  const sw = createSw();
  sw.delays['dcc:summary'] = (m) => (m.periodDays === 30 ? 500 : 20);
  sw.delays['dcc:setPeriod'] = 250;
  const t = boot({ sw });
  await waitFor(() => t.sent('dcc:summary').length === 1); // 30d, slow
  await waitFor(() => t.$('[data-k="period-7"]'));
  t.click('period-7');
  assert.equal(t.$('[data-k="period-7"]').getAttribute('aria-pressed'), 'true', 'pressed state updates immediately');
  assert.equal(t.$('[data-k="period-30"]').getAttribute('aria-pressed'), 'false');
  // A hello triggered before the setPeriod write lands reads the old period; it must not win.
  await t.env.setStorage({ 'dcc.settings': Object.assign({}, sw.settings) });
  await waitFor(() => t.text().includes(money(1007)), 2000, '7d amount');
  await settle(900); // the 30d response (500 ms) and the setPeriod storage event have landed
  assert.match(t.text(), /\$1,007\.00/);
  assert.doesNotMatch(t.text(), /\$1,030\.00/);
  assert.equal(t.$('[data-k="period-7"]').getAttribute('aria-pressed'), 'true');
  const set = t.sent('dcc:setPeriod');
  assert.equal(set.length, 1);
  assert.equal(set[0].periodDays, 7);
  assert.equal(set[0].workspaceId, '42');
  assert.deepEqual(t.sent('dcc:summary').map((m) => m.periodDays), [30, 7]);
  t.close();
});

test('Refresh sends force:true and shows the refreshed result', async () => {
  const t = boot();
  await waitFor(() => t.text().includes(money(1030)));
  t.click('refresh');
  await waitFor(() => t.sent('dcc:summary').length === 2);
  assert.equal(t.sent('dcc:summary')[1].force, true);
  assert.equal(t.sent('dcc:summary')[1].periodDays, 30);
  await waitFor(() => t.text().includes(money(1030)));
  t.close();
});

test('storage changes: dcc.settings / own dcc.connections / dcc.import re-request; unrelated changes do not', async () => {
  const sw = createSw();
  const t = boot({ sw });
  await waitFor(() => t.text().includes(money(1030)));
  // Revision-only settings change (e.g. monitor prefs): re-identify, no new summary.
  await sw.persistSettings();
  await waitFor(() => t.sent('dcc:hello').length === 2);
  await settle(150);
  assert.equal(t.sent('dcc:summary').length, 1);
  // Mode change: new summary, demo label.
  sw.settings.mode = 'demo';
  await sw.persistSettings();
  await waitFor(() => t.text().includes('DEMO'), 2000, 'demo');
  assert.equal(t.sent('dcc:summary').length, 2);
  // Connection saved for this origin: reload. For another origin only: no reload.
  await t.env.setStorage({ 'dcc.connections': { [ORIGIN]: { workspaceId: '42', revision: 2 } } });
  await waitFor(() => t.sent('dcc:summary').length === 3, 2000, 'connection reload');
  await t.env.setStorage({ 'dcc.connections': { [ORIGIN]: { workspaceId: '42', revision: 2 }, 'https://dbc-2.cloud.databricks.com': { workspaceId: '7', revision: 1 } } });
  await settle(300);
  assert.equal(t.sent('dcc:summary').length, 3);
  // Import changes matter in import mode.
  sw.settings.mode = 'import';
  await sw.persistSettings();
  await waitFor(() => t.sent('dcc:summary').length === 4);
  await t.env.setStorage({ 'dcc.import': { entries: [], importedAt: Date.now() } });
  await waitFor(() => t.sent('dcc:summary').length === 5, 2000, 'import reload');
  t.close();
});

test('Settings falls back to a visible notice when the extension page cannot be opened', async () => {
  const sw = createSw();
  sw.openOk = false;
  const t = boot({ sw });
  await waitFor(() => t.text().includes(money(1030)));
  t.click('settings');
  await waitFor(() => t.text().includes('Open the Cost Companion popup'));
  assert.equal(t.sent('dcc:open')[0].page, 'options');
  t.close();
});

test('features: deduplicated by name (first wins), late registrations start, failures are isolated', async () => {
  const calls = [];
  const first = { name: 'dup', onStart: () => calls.push('first:start'), onTick: () => calls.push('first:tick') };
  const second = { name: 'dup', onStart: () => calls.push('second:start'), onTick: () => calls.push('second:tick') };
  const broken = { name: 'broken', onStart: () => { throw new Error('bug'); }, onTick: () => Promise.reject(new Error('async bug')) };
  const t = boot({ features: [first, broken, second] });
  await waitFor(() => t.text().includes(money(1030)));
  await waitFor(() => calls.includes('first:tick'));
  assert.ok(!calls.some((c) => c.startsWith('second')), 'duplicate name ignored');
  assert.equal(calls.filter((c) => c === 'first:start').length, 1);
  // A feature registered after start (e.g. by a later injection) is picked up at the next notify.
  const late = { name: 'late', onStart: () => calls.push('late:start'), onTick: () => calls.push('late:tick') };
  t.w.DCC.features.push(late, Object.assign({}, late, { onStart: () => calls.push('late-dup:start') }));
  t.doc.querySelector('main').appendChild(t.doc.createElement('p'));
  await waitFor(() => calls.includes('late:tick'));
  assert.equal(calls.filter((c) => c === 'late:start').length, 1);
  assert.ok(!calls.includes('late-dup:start'));
  t.close();
});

test('after an extension reload the orphaned instance tears down and the new one takes over without fighting', async () => {
  const stops = [];
  const t = boot({ features: [{ name: 'old-feature', onStop: () => stops.push('old') }] });
  await waitFor(() => t.text().includes(money(1030)));
  const oldInstance = t.test();
  const oldHost = t.host();
  // Simulate the old isolated world losing its runtime, then a fresh injection with a new one.
  const oldChrome = t.w.chrome;
  t.w.chrome = Object.assign({}, oldChrome, { runtime: Object.assign({}, oldChrome.runtime) });
  oldChrome.runtime.id = undefined;
  t.w.__dccMainLoaded = false;
  t.w.eval(CONTENT_MAIN);
  const newInstance = t.test();
  assert.notEqual(newInstance, oldInstance);
  await waitFor(() => oldInstance.state.stopped, 2000, 'old instance teardown');
  assert.deepEqual(stops, ['old']);
  const main = t.doc.querySelector('main');
  const inserted = [];
  new t.w.MutationObserver((rs) => {
    for (const r of rs) for (const n of r.addedNodes) if (n.nodeType === 1 && n.getAttribute('data-dcc') === 'banner') inserted.push(n);
  }).observe(main, { childList: true });
  for (let i = 0; i < 5; i++) {
    main.appendChild(t.doc.createElement('p'));
    await settle(250);
  }
  assert.equal(t.doc.querySelectorAll('[data-dcc="banner"]').length, 1);
  assert.equal(main.firstElementChild, newInstance.banner.host);
  assert.notEqual(main.firstElementChild, oldHost);
  assert.equal(inserted.length, 0, 'no ping-pong between instances');
  t.close();
});
