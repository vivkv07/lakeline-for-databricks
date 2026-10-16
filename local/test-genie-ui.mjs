// Genie side panel page and the popup's "Ask Genie" entry point. SIMULATED: the real HTML and
// scripts run in jsdom with a fake `chrome`. Most tests answer messages with a stand-in service
// worker; the demo test wires the REAL background module and router behind the page (demo mode,
// so no network). This checks page logic and DOM output, not a real browser side panel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { load, fakeArea } from './support/load.mjs';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension');
const HTML = readFileSync(path.join(EXT, 'ui/sidepanel.html'), 'utf8');
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

const A = 'https://dbc-aaa.cloud.databricks.com';
const B = 'https://dbc-bbb.cloud.databricks.com';
const SALES = 'aaaa0000000000000000000000000001';
const OPS = 'aaaa0000000000000000000000000002';
const EVIL = '<img src=x onerror="window.__pwned=1">';
const SQL = 'SELECT region, SUM(amount) AS revenue\nFROM sales\nGROUP BY region';

function event() {
  const fns = [];
  return { addListener: (fn) => fns.push(fn), fns, fire: (...a) => fns.forEach((f) => f(...a)) };
}

/**
 * @param o {respond(msg) → data | {__error}, tabs, clipboard, route?(msg, sender) → full response}
 */
async function openPanel({ respond, tabs = [], route = null } = {}) {
  const dom = new JSDOM(HTML, { url: 'chrome-extension://testext/ui/sidepanel.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const messages = [];
  const ports = [];
  const clipboard = [];
  w.chrome = {
    runtime: {
      id: 'testext',
      async sendMessage(msg) {
        messages.push(structuredClone(msg));
        if (route) return structuredClone(await route(structuredClone(msg), { id: 'testext', url: 'chrome-extension://testext/ui/sidepanel.html' }));
        const data = await respond(structuredClone(msg));
        if (data && data.__error) return { ok: false, error: data.__error };
        return { ok: true, data: data === undefined ? null : structuredClone(data) };
      },
      connect({ name }) {
        const port = { name, onMessage: event(), onDisconnect: event(), disconnect() {}, postMessage() {} };
        ports.push(port);
        return port;
      },
    },
    tabs: { query: async () => structuredClone(tabs) },
  };
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t) => clipboard.push(t) }, configurable: true });
  for (const src of [...w.document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'))) {
    w.eval(readFileSync(path.join(EXT, 'ui', src), 'utf8') + '\n//# sourceURL=' + src);
  }
  await w.DCC.sidePanel.ready;
  await settle();
  const $ = (id) => w.document.getElementById(id);
  return { dom, window: w, document: w.document, $, messages, ports, clipboard, close: () => (w.DCC.sidePanel.stop(), w.close()) };
}

const ready = (origin = A) => ({ origin, host: new URL(origin).host, workspaceId: '1001', authMode: 'pat', status: 'ready' });
const initData = (o = {}) => Object.assign({ mode: 'connected', modeError: null, workspaces: [ready(A), ready(B)], defaultOrigin: A, fromActiveTab: true, lastSpace: {}, notify: false, notificationsGranted: false, monitorEnabled: false, inflight: 0 }, o);
const spacesData = { spaces: [{ id: SALES, title: 'Sales analytics', description: 'Orders and revenue' }, { id: OPS, title: 'Operations', description: null }], more: false, demo: false, lastSpace: OPS };

const T = Date.now();
function turn(phase, o = {}) {
  return Object.assign({ id: 'q-' + phase, question: 'Question in ' + phase, askedAt: T - 5000, finishedAt: phase === 'done' || phase === 'failed' ? T - 1000 : null, phase, status: null, step: null, texts: [], query: null, table: null, tableState: 'none', tableError: null, suggested: [], error: null }, o);
}
const doneTurn = (o = {}) =>
  turn('done', Object.assign({
    texts: [{ content: 'Revenue grew 6%. ' + EVIL, purpose: 'answer' }],
    query: { title: 'Revenue by region', description: 'Sum of orders', sql: SQL, rowCount: 1234, truncated: false, canRerun: true },
    table: { columns: [{ name: 'region', type: 'STRING', numeric: false }, { name: 'revenue', type: 'DECIMAL', numeric: true }], rows: [['EMEA', '412300'], [EVIL, null], ['APAC', '301750']], totalRows: 1234, shown: 3, clipped: true, serverTruncated: false, columnsHidden: 0 },
    tableState: 'ready',
    suggested: ['By month?', 'Top products?'],
  }, o));

function worker({ init = initData(), spaces = spacesData, thread = null, hooks = {} } = {}) {
  const state = { thread, rev: 1 };
  const fn = async (msg) => {
    if (hooks[msg.type]) return hooks[msg.type](msg, state);
    if (msg.type === 'genie:init') return init;
    if (msg.type === 'genie:spaces') return spaces;
    if (msg.type === 'genie:state') return { rev: state.rev, thread: state.thread, inflight: 0, unseen: 0 };
    if (msg.type === 'genie:remember') return { remembered: true };
    if (msg.type === 'genie:ask') return { threadId: 'c1', turnId: 'q1' };
    if (msg.type === 'genie:new') return { rev: 2, thread: null };
    return { __error: { code: 'UNKNOWN', title: 'Unexpected ' + msg.type, steps: [] } };
  };
  return { fn, state };
}

test('side panel page is CSP-safe: external scripts only, no inline handlers, no innerHTML', () => {
  const dom = new JSDOM(HTML);
  for (const s of dom.window.document.querySelectorAll('script')) {
    assert.ok(s.getAttribute('src'));
    assert.equal(s.textContent.trim(), '');
  }
  for (const el of dom.window.document.querySelectorAll('*')) for (const a of el.getAttributeNames()) assert.ok(!/^on/i.test(a), 'inline handler ' + a);
  const js = readFileSync(path.join(EXT, 'ui/sidepanel.js'), 'utf8');
  assert.doesNotMatch(js, /\.(innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  const css = readFileSync(path.join(EXT, 'ui/sidepanel.css'), 'utf8');
  assert.doesNotMatch(css, /--dcc-[a-z0-9-]+\s*:/, 'no token redefinitions; brand.css owns them');
  assert.ok(!/—/.test(HTML + js), 'no em dashes in copy');
});

test('opens on the active tab workspace, remembers the last agent, connects the presence port', async () => {
  const sw = worker();
  const env = await openPanel({ respond: sw.fn, tabs: [{ id: 3, url: A + '/jobs?o=1001' }] });
  const init = env.messages.find((m) => m.type === 'genie:init');
  assert.equal(init.activeUrl, A + '/jobs?o=1001');
  assert.equal(env.$('ws').value, A);
  assert.equal(env.$('space').value, OPS, 'last used agent');
  assert.deepEqual([...env.$('space').options].map((o) => o.textContent), ['Sales analytics', 'Operations']);
  assert.deepEqual(env.ports.map((p) => p.name), ['dcc-genie-panel']);
  assert.match(text(env.$('thread')), /Ask Operations/);
  assert.equal(env.$('question').disabled, false);
  assert.equal(env.$('send').disabled, true, 'nothing typed yet');
  // Switching agents remembers the choice and reloads that agent's conversation.
  env.$('space').value = SALES;
  env.$('space').dispatchEvent(new env.window.Event('change'));
  await settle();
  assert.ok(env.messages.some((m) => m.type === 'genie:remember' && m.spaceId === SALES));
  assert.equal(text(env.$('space-desc')), 'Orders and revenue');
  env.close();
});

test('per-message statuses: Sending, Genie is working, Running query, Answer ready, Failed with a plain reason', async () => {
  const thread = {
    id: 'c1',
    turns: [
      turn('sending'),
      turn('working', { step: 'Finding relevant context' }),
      turn('query', { step: 'Running the query', query: { title: 'Revenue', description: null, sql: SQL, rowCount: null, truncated: false, canRerun: true } }),
      doneTurn({ suggested: [] }),
      turn('failed', { error: { code: 'GENIE_RATE_LIMITED', title: 'Genie is busy right now', steps: ['Wait a minute, then ask again.'], detail: 'Too many requests' } }),
    ],
  };
  const env = await openPanel({ respond: worker({ thread }).fn });
  const chips = [...env.document.querySelectorAll('.gp-chip')].map((c) => [c.getAttribute('data-phase'), c.textContent]);
  assert.deepEqual(chips, [
    ['sending', 'Sending'],
    ['working', 'Genie is working'],
    ['query', 'Running query'],
    ['done', 'Answer ready'],
    ['failed', 'Failed'],
  ]);
  const arts = [...env.document.querySelectorAll('article.gp-turn')];
  assert.match(text(arts[1]), /Finding relevant context · \d+s/);
  assert.match(text(arts[2]), /The query is running/);
  assert.match(text(arts[3]), /in 4s/);
  assert.match(text(arts[4]), /Genie is busy right now.*Wait a minute.*Details: Too many requests/);
  assert.equal(arts[0].getAttribute('aria-busy'), 'true');
  assert.equal(arts[3].getAttribute('aria-busy'), 'false');
  assert.ok(arts[4].querySelector('button'), 'the last failed question offers Ask again');
  // The panel says Genie is answering and keeps Send disabled; it doesn't poll.
  assert.match(text(env.$('composer-hint')), /Genie is answering/);
  env.$('question').value = 'x';
  env.$('question').dispatchEvent(new env.window.Event('input'));
  assert.equal(env.$('send').disabled, true);
  const stateReads = env.messages.filter((m) => m.type === 'genie:state').length;
  await settle(1200);
  assert.equal(env.messages.filter((m) => m.type === 'genie:state').length, stateReads, 'no polling from the page');
  env.close();
});

test('answer: text via textContent, a real table with headers, "showing N of M", SQL behind Show SQL, copy', async () => {
  const env = await openPanel({ respond: worker({ thread: { id: 'c1', turns: [doneTurn()] } }).fn });
  const art = env.document.querySelector('article.gp-turn');
  assert.equal(env.document.querySelector('img'), null, 'markup in answers and cells is shown as text');
  assert.equal(env.window.__pwned, undefined);
  assert.match(text(art.querySelector('.gp-text')), /Revenue grew 6%\. <img src=x/);
  const table = art.querySelector('table');
  assert.deepEqual([...table.querySelectorAll('thead th')].map((th) => [th.textContent, th.getAttribute('scope'), th.className]), [['region', 'col', ''], ['revenue', 'col', 'num']]);
  const cells = [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent));
  assert.deepEqual(cells, [['EMEA', '412300'], [EVIL, 'null'], ['APAC', '301750']]);
  assert.ok(table.querySelector('tbody tr:nth-child(2) td:nth-child(2) .gp-null'), 'null is labeled, not blank and not 0');
  assert.equal(text(table.querySelector('caption')), 'Revenue by region');
  assert.match(text(art.querySelector('.gp-table-meta')), /Showing 3 of 1,234 rows/);
  const wrap = art.querySelector('.gp-table-wrap');
  assert.deepEqual([wrap.getAttribute('tabindex'), wrap.getAttribute('role')], ['0', 'region'], 'the scrollable table is keyboard reachable');
  const details = art.querySelector('details.gp-sql');
  assert.equal(details.open, false, 'SQL hidden until asked');
  assert.equal(text(details.querySelector('summary')), 'Show SQL');
  assert.equal(details.querySelector('pre code').textContent, SQL);
  details.open = true;
  details.dispatchEvent(new env.window.Event('toggle'));
  // A re-render (e.g. a port change signal) keeps the disclosure open.
  env.ports[0].onMessage.fire({ type: 'genie:changed', rev: 99 });
  await settle();
  assert.equal(env.document.querySelector('details.gp-sql').open, true);
  // Copy answer: the text plus the shown rows as tab-separated values.
  const copyBtn = art.querySelector('[data-copy]');
  copyBtn.click();
  await settle();
  assert.equal(env.clipboard[0], 'Revenue grew 6%. ' + EVIL + '\n\nregion\trevenue\nEMEA\t412300\n' + EVIL + '\t\nAPAC\t301750');
  assert.equal(env.document.querySelector('[data-copy]').textContent, 'Copied');
  env.close();
});

test('keyboard: Enter sends, Shift+Enter does not, suggestions send as follow-ups, New conversation clears', async () => {
  const sw = worker({ thread: { id: 'c1', turns: [doneTurn()] } });
  const env = await openPanel({ respond: sw.fn });
  const input = env.$('question');
  const key = (o) => input.dispatchEvent(new env.window.KeyboardEvent('keydown', Object.assign({ key: 'Enter', bubbles: true, cancelable: true }, o)));
  input.value = 'Revenue by month?';
  input.dispatchEvent(new env.window.Event('input'));
  assert.equal(env.$('send').disabled, false);
  key({ shiftKey: true });
  await settle();
  assert.equal(env.messages.filter((m) => m.type === 'genie:ask').length, 0, 'Shift+Enter is a newline');
  key({});
  await settle();
  const asks = env.messages.filter((m) => m.type === 'genie:ask');
  assert.deepEqual(asks.map((m) => [m.origin, m.spaceId, m.question, m.spaceTitle]), [[A, OPS, 'Revenue by month?', 'Operations']]);
  assert.equal(input.value, '', 'cleared after sending');
  const sugg = [...env.document.querySelectorAll('.gp-suggest-list button')];
  assert.deepEqual(sugg.map((b) => b.textContent), ['By month?', 'Top products?']);
  sugg[1].click();
  await settle();
  assert.equal(env.messages.filter((m) => m.type === 'genie:ask').at(-1).question, 'Top products?');
  env.$('new-conv').click();
  await settle();
  assert.ok(env.messages.some((m) => m.type === 'genie:new' && m.spaceId === OPS));
  assert.match(text(env.$('thread')), /New conversation/);
  env.close();
});

test('notices: Allow Genie for sign-in, helper mode, missing token, no workspace, import mode, errors with retry', async () => {
  let signedIn = false;
  const sw = worker({
    init: initData({ workspaces: [Object.assign(ready(A), { authMode: 'oauth', status: 'signin' })] }),
    hooks: { 'genie:signIn': () => ((signedIn = true), { signedIn: true }) },
  });
  const env = await openPanel({ respond: sw.fn });
  assert.match(text(env.$('notice')), /Allow Genie for this workspace/);
  assert.equal(env.$('question').disabled, true);
  assert.equal(env.messages.filter((m) => m.type === 'genie:spaces').length, 0, 'no agent listing before consent');
  const btn = env.$('notice').querySelector('[data-action="signin"]');
  assert.equal(btn.textContent, 'Allow Genie and run status');
  btn.click();
  await settle();
  assert.equal(signedIn, true);
  assert.equal(env.$('notice').hidden, true);
  assert.equal(env.$('question').disabled, false);
  env.close();

  const helper = await openPanel({ respond: worker({ init: initData({ workspaces: [Object.assign(ready(A), { authMode: 'helper', status: 'helper' })] }) }).fn });
  assert.match(text(helper.$('notice')), /Genie needs Sign in with Databricks or a personal access token/);
  assert.match(text(helper.$('ws')), /helper not supported/);
  helper.close();

  const pat = await openPanel({ respond: worker({ init: initData({ workspaces: [Object.assign(ready(A), { status: 'pat' })] }) }).fn });
  assert.match(text(pat.$('notice')), /Save a personal access token first/);
  pat.close();

  const none = await openPanel({ respond: worker({ init: initData({ workspaces: [], defaultOrigin: null }) }).fn });
  assert.match(text(none.$('notice')), /No connected workspace/);
  none.close();

  const imp = await openPanel({ respond: worker({ init: initData({ mode: 'import', workspaces: [], modeError: { code: 'GENIE_MODE', title: 'Genie is off in Local import mode', steps: ['Switch modes.'] } }) }).fn });
  assert.match(text(imp.$('notice')), /Genie is off in Local import mode/);
  assert.equal(imp.$('question').disabled, true);
  imp.close();

  let calls = 0;
  const failing = await openPanel({ respond: worker({ hooks: { 'genie:spaces': () => (++calls === 1 ? { __error: { code: 'GENIE_ACCESS_DENIED', title: 'No access to this Genie Agent', steps: ['Ask the owner.'] } } : spacesData) } }).fn });
  assert.match(text(failing.$('notice')), /No access to this Genie Agent/);
  failing.$('notice').querySelector('[data-action="retry"]').click();
  await settle();
  assert.equal(failing.$('notice').hidden, true);
  assert.equal(failing.$('space').disabled, false);
  failing.close();

  const empty = await openPanel({ respond: worker({ spaces: { spaces: [], more: false, lastSpace: null } }).fn });
  assert.match(text(empty.$('notice')), /No Genie Agents here yet/);
  empty.close();
});

test('port: a change signal re-reads state; a dropped port reconnects', async () => {
  const sw = worker();
  const env = await openPanel({ respond: sw.fn });
  const before = env.messages.filter((m) => m.type === 'genie:state').length;
  sw.state.thread = { id: 'c1', turns: [doneTurn()] };
  env.ports[0].onMessage.fire({ type: 'genie:changed', rev: 7 });
  await settle();
  assert.equal(env.messages.filter((m) => m.type === 'genie:state').length, before + 1);
  assert.equal(env.document.querySelectorAll('article.gp-turn').length, 1);
  env.ports[0].onDisconnect.fire();
  await settle(1100);
  assert.equal(env.ports.length, 2, 'reconnected after the service worker went away');
  env.close();
});

test('demo mode end to end in jsdom: real background + router, ask with Enter, DEMO answer with a table', async () => {
  // The REAL genie background module and router, in demo mode (synthetic, no network).
  const genieMod = load('background/genie.js');
  const storeMod = load('background/store.js');
  const routerMod = load('background/router.js');
  const secretsMod = load('background/secrets.js');
  const chromeBg = { runtime: { id: 'testext', getURL: (p) => 'chrome-extension://testext/' + p }, storage: { local: fakeArea(), session: fakeArea() }, permissions: { contains: async () => false }, alarms: { get: async () => null, create: async () => {}, clear: async () => {} }, action: null };
  const store = storeMod.create(chromeBg.storage.local);
  await store.migrate();
  await store.updateSettings({ mode: 'demo' });
  let fetched = 0;
  const g = genieMod.create({ store, secrets: secretsMod.create(chromeBg.storage.session), chromeApi: chromeBg, fetch: async () => (fetched++, null), log: () => {} });
  const router = routerMod.create({ store, secrets: null, data: { cache: { clear() {} } }, chromeApi: chromeBg, extensionId: 'testext', extensionOrigin: 'chrome-extension://testext', helperPort: 8766, openPage: async () => {}, extra: g.handlers });
  const env = await openPanel({ route: (msg, sender) => router.dispatch(msg, sender) });
  assert.equal(env.$('demo-chip').hidden, false);
  assert.equal(text(env.$('ws')), 'Demo workspace');
  assert.match(env.$('space').selectedOptions[0].textContent, /DEMO/);
  const revenue = [...env.$('space').options].find((o) => /Revenue/.test(o.textContent)).value;
  env.$('space').value = revenue;
  env.$('space').dispatchEvent(new env.window.Event('change'));
  await settle();
  const starters = [...env.document.querySelectorAll('.gp-starters button')].map((b) => b.textContent);
  assert.ok(starters.includes('What was revenue by region last month?'));
  // Connect the panel port to the background so it gets change signals.
  const bgPort = { name: 'dcc-genie-panel', sender: { id: 'testext', url: 'chrome-extension://testext/ui/sidepanel.html' }, postMessage: (m) => env.ports[0].onMessage.fire(m), onDisconnect: { addListener() {} } };
  assert.equal(g.onConnect(bgPort), true);
  env.$('question').value = 'What was revenue by region last month?';
  env.$('question').dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle(50);
  assert.equal(env.$('notice').hidden, true, text(env.$('notice')));
  assert.match(text(env.document.querySelector('.gp-chip')), /Sending|Genie is working/);
  for (let i = 0; i < 80 && !env.document.querySelector('.gp-turn[data-phase="done"]'); i++) await settle(100);
  const done = env.document.querySelector('.gp-turn[data-phase="done"]');
  assert.ok(done, 'the DEMO answer arrived through the port signal');
  assert.match(text(done.querySelector('.gp-text')), /DEMO answer \(synthetic\)/);
  assert.equal(done.querySelectorAll('tbody tr').length, 5);
  assert.match(text(done.querySelector('.gp-table-meta')), /5 rows/);
  assert.equal(fetched, 0, 'demo mode makes no requests');
  env.close();
});

/* ------------------------------------------------------------------ popup entry point */

function openPopup({ sidePanel = true, permissionAnswer = true } = {}) {
  const html = readFileSync(path.join(EXT, 'ui/popup.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'chrome-extension://testext/ui/popup.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const log = [];
  let closed = false;
  w.chrome = {
    runtime: {
      id: 'testext',
      async sendMessage(msg) {
        log.push(['message', msg.type, structuredClone(msg)]);
        if (msg.type === 'page:state') return { ok: true, data: { settings: { mode: 'connected', periodDays: 30, showCosts: true, monitor: {}, genie: { notify: false, lastSpace: {} }, oauth: {}, revision: 1 }, connections: {}, diagnostics: [], observed: {} } };
        if (msg.type === 'genie:settings') return { ok: true, data: { notify: msg.notify } };
        return { ok: true, data: null };
      },
      getURL: (p) => 'chrome-extension://testext/' + p,
    },
    tabs: { query: async () => [{ id: 5, windowId: 77, url: 'https://example.com/' }] },
    windows: { WINDOW_ID_CURRENT: -2 },
    permissions: {
      request(req) {
        log.push(['permission', structuredClone(req)]);
        return Promise.resolve(permissionAnswer);
      },
      contains: async () => false,
    },
  };
  if (sidePanel) w.chrome.sidePanel = { open: (o) => (log.push(['sidePanel.open', structuredClone(o)]), Promise.resolve()) };
  w.close = () => {
    closed = true;
  };
  for (const s of [...w.document.querySelectorAll('script[src]')]) {
    const src = s.getAttribute('src');
    const file = path.resolve(EXT, 'ui', src);
    if (src === 'workspace-appearance.js' || !existsSync(file)) continue;
    w.eval(readFileSync(file, 'utf8') + '\n//# sourceURL=' + src);
  }
  return { w, d: w.document, log, isClosed: () => closed };
}

test('popup: Ask Genie opens the side panel inside the click (no await before it), then closes', async () => {
  const p = openPopup();
  await p.w.DCC.popupPage.ready;
  await settle();
  const before = p.log.length;
  p.d.getElementById('genie-open').click();
  // Synchronously, in the same task as the click: sidePanel.open is the very next call.
  assert.deepEqual(p.log[before], ['sidePanel.open', { windowId: 77 }]);
  await settle();
  assert.equal(p.isClosed(), true);

  const old = openPopup({ sidePanel: false });
  await old.w.DCC.popupPage.ready;
  old.d.getElementById('genie-open').click();
  await settle();
  assert.match(text(old.d.getElementById('genie-status')), /side panel isn't available/);
});

test('popup: "Notify me when Genie answers" asks for the optional permission first, then saves', async () => {
  const p = openPopup();
  await p.w.DCC.popupPage.ready;
  await settle();
  const sw = p.d.getElementById('genie-notify');
  assert.equal(sw.checked, false);
  sw.checked = true;
  sw.dispatchEvent(new p.w.Event('change'));
  await settle();
  const i = p.log.findIndex((e) => e[0] === 'permission');
  assert.deepEqual(p.log[i][1], { permissions: ['notifications'] });
  const save = p.log.findIndex((e) => e[0] === 'message' && e[1] === 'genie:settings');
  assert.ok(save > i, 'permission requested before the setting is saved');
  assert.equal(p.log[save][2].notify, true);
  assert.equal(sw.checked, true);

  const no = openPopup({ permissionAnswer: false });
  await no.w.DCC.popupPage.ready;
  await settle();
  const sw2 = no.d.getElementById('genie-notify');
  sw2.checked = true;
  sw2.dispatchEvent(new no.w.Event('change'));
  await settle();
  assert.equal(sw2.checked, false);
  assert.ok(!no.log.some((e) => e[1] === 'genie:settings'));
  assert.match(text(no.d.getElementById('genie-status')), /Notifications were not allowed/);
});
