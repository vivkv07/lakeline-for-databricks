// SIMULATED tests for the popup and options pages: the real HTML and scripts run in jsdom with a
// fake `chrome` (runtime.sendMessage answered by a stand-in service worker, permissions, tabs).
// This checks page logic and message payloads; it is not proof of behavior in a real browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { load } from './support/load.mjs';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension');
const ids = load('core/ids.js');
const whMod = load('databricks/warehouses.js');
const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// Another agent owns these; the pages must work without them (a missing file is a 404 in Chrome).
const SKIP_SCRIPTS = new Set(['workspace-appearance.js']);

const A = 'https://dbc-aaa.cloud.databricks.com';
const B = 'https://dbc-bbb.cloud.databricks.com';
const ok = (data) => ({ ok: true, data });
const unknown = (message) => ({ ok: false, error: { code: 'UNKNOWN', title: 'Something went wrong', steps: ['Select Refresh.'], details: { message } } });

/**
 * Load extension/ui/<name>.html and its <script src> files into jsdom.
 * @param {string} name 'popup' | 'options'
 * @param {object} o {onMessage(msg) → response, tabs, granted, permissionAnswer, hash}
 */
function openPage(name, { onMessage, tabs = [], granted = [], permissionAnswer = true, hash = '' } = {}) {
  const html = readFileSync(path.join(EXT, 'ui', name + '.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'chrome-extension://testextensionid/ui/' + name + '.html' + hash, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const events = []; // ordered log of messages and permission requests
  const messages = [];
  const perms = { origins: new Set(granted), permissions: new Set(), requests: [], removals: [], answer: permissionAnswer };
  let closed = false;
  w.chrome = {
    runtime: {
      id: 'testextensionid',
      async sendMessage(msg) {
        const copy = structuredClone(msg);
        messages.push(copy);
        events.push({ kind: 'message', msg: copy });
        const res = onMessage ? await onMessage(copy) : undefined;
        return res === undefined ? unknown('Unknown message') : structuredClone(res);
      },
      getURL: (p) => 'chrome-extension://testextensionid/' + p,
    },
    tabs: { query: async () => structuredClone(tabs) },
    permissions: {
      request(req) {
        perms.requests.push(structuredClone(req));
        events.push({ kind: 'permission', req: structuredClone(req) });
        const yes = typeof perms.answer === 'function' ? perms.answer(req) : perms.answer;
        if (yes) {
          for (const o of req.origins || []) perms.origins.add(o);
          for (const p of req.permissions || []) perms.permissions.add(p);
        }
        return Promise.resolve(Boolean(yes));
      },
      contains: async (req) => (req.origins || []).every((o) => perms.origins.has(o)) && (req.permissions || []).every((p) => perms.permissions.has(p)),
      getAll: async () => ({ origins: [...perms.origins], permissions: [...perms.permissions] }),
      async remove(req) {
        perms.removals.push(structuredClone(req));
        for (const o of req.origins || []) perms.origins.delete(o);
        return true;
      },
    },
  };
  const realClose = w.close.bind(w);
  w.close = () => {
    closed = true;
  };
  const loaded = [];
  const skipped = [];
  for (const s of [...w.document.querySelectorAll('script[src]')]) {
    const src = s.getAttribute('src');
    const file = path.resolve(EXT, 'ui', src);
    if (SKIP_SCRIPTS.has(src) || !existsSync(file)) {
      skipped.push(src);
      continue;
    }
    w.eval(readFileSync(file, 'utf8') + '\n//# sourceURL=' + src);
    loaded.push(src);
  }
  const $ = (id) => w.document.getElementById(id);
  return {
    window: w,
    document: w.document,
    $,
    messages,
    events,
    perms,
    loaded,
    skipped,
    get closed() {
      return closed;
    },
    sent: (type) => messages.filter((m) => m.type === type),
    /** Visible-ish text: text nodes joined with spaces (element boundaries read as breaks). */
    text(id) {
      const walker = w.document.createTreeWalker(id ? $(id) : w.document.body, w.NodeFilter.SHOW_TEXT);
      const parts = [];
      while (walker.nextNode()) parts.push(walker.currentNode.data);
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    },
    type(id, value, event = 'input') {
      $(id).value = value;
      $(id).dispatchEvent(new w.Event(event, { bubbles: true }));
    },
    close: realClose,
  };
}

/* ------------------------------------------------------------------ stand-in service workers */

function baseSettings(patch = {}) {
  return Object.assign(
    { schemaVersion: 2, mode: 'connected', periodDays: 30, showCosts: true, monitor: { enabled: false, autoOpen: false, notifyFailures: false, intervalSec: 60, origin: null }, revision: 1 },
    patch
  );
}

function popupWorker({ settings, connections = {}, diagnostics = [], hooks = {} } = {}) {
  const st = { settings: baseSettings(settings), connections, observed: {}, diagnostics, importSummary: null, bridge: { hasPat: false, bridgePaired: false, helperVersion: null, capabilities: null }, extensionId: 'testextensionid' };
  const fn = async (msg) => {
    if (hooks[msg.type]) {
      const r = await hooks[msg.type](msg, st);
      if (r !== undefined) return r;
    }
    switch (msg.type) {
      case 'page:state':
        return ok(st);
      case 'page:updateSettings': {
        const p = msg.patch || {};
        const next = Object.assign({}, st.settings, p, { monitor: Object.assign({}, st.settings.monitor, p.monitor) });
        next.revision = st.settings.revision + 1;
        st.settings = next;
        return ok(next);
      }
      case 'page:open':
        return ok({ opened: msg.page });
      case 'page:setPendingConnect':
        return ok({ origin: ids.classifyOrigin(msg.url).origin, workspaceId: null, conflict: false });
      case 'page:clearDiagnostics':
        st.diagnostics = [];
        return ok(null);
      default:
        return undefined;
    }
  };
  return { fn, st };
}

const WH = {
  [A]: [
    { id: '1111111111111111', name: 'Shared Small', state: 'STOPPED', size: 'Small', serverless: false },
    { id: '2222222222222222', name: 'BI Serverless', state: 'RUNNING', size: 'Medium', serverless: true },
    { id: '3333333333333333', name: 'Tiny', state: 'STOPPED', size: '2X-Small', serverless: false },
  ],
  [B]: [{ id: 'bbbbbbbbbbbbbbbb', name: 'Bravo Warehouse', state: 'RUNNING', size: 'X-Small', serverless: false }],
};

function optionsWorker({ connections = {}, observed = {}, bridge, pending = null, settings, hooks = {} } = {}) {
  const st = {
    settings: baseSettings(settings),
    connections,
    observed,
    diagnostics: [],
    importSummary: null,
    bridge: bridge || { hasPat: false, bridgePaired: false, helperVersion: null, capabilities: null },
    extensionId: 'testextensionid',
  };
  let pend = pending;
  const fn = async (msg) => {
    if (hooks[msg.type]) {
      const r = await hooks[msg.type](msg, st);
      if (r !== undefined) return r;
    }
    switch (msg.type) {
      case 'page:state':
        return ok(st);
      case 'admin:takePendingConnect': {
        const p = pend;
        pend = null;
        return ok(p);
      }
      case 'admin:prepare': {
        const cls = ids.classifyOrigin(msg.url || msg.origin);
        if (!cls.ok) return unknown('Not a supported Databricks workspace URL');
        const fromUrl = ids.resolveWorkspaceId(msg.url || cls.origin, {});
        const conn = st.connections[cls.origin];
        const ob = st.observed[cls.origin];
        const candidates = [...new Set([fromUrl.id, ob && ob.workspaceId, conn && conn.workspaceId].filter(Boolean))];
        return ok({ origin: cls.origin, cloud: cls.cloud, candidates, conflict: Boolean(fromUrl.conflict), connection: conn || null });
      }
      case 'admin:secretStatus': {
        const c = st.connections[msg.origin];
        return ok({ origin: msg.origin, hasPat: Boolean(c && c.secrets && c.secrets.hasPat) });
      }
      case 'admin:listWarehouses': {
        const list = WH[msg.origin] || [];
        const auto = whMod.autoSelect(list);
        return ok({ origin: msg.origin, requestId: msg.requestId, warehouses: list, automatic: auto ? { id: auto.id, name: auto.name } : null });
      }
      case 'admin:saveConnection': {
        const c = msg.connection;
        const saved = Object.assign({}, c, { cloud: 'aws', revision: 1, savedAt: 1 });
        if (c.warehouse.mode === 'auto') {
          const auto = whMod.autoSelect(WH[c.origin] || []);
          saved.warehouse = { mode: 'auto', resolvedId: auto.id, resolvedName: auto.name };
        }
        st.connections[c.origin] = Object.assign({}, saved, { secrets: { hasPat: false } });
        return ok(saved);
      }
      case 'admin:removeConnection':
        delete st.connections[msg.origin];
        return ok({ removed: true });
      case 'admin:setPat':
        return ok({ saved: true });
      case 'admin:syncScripts':
        return ok({ matches: [], injected: 1 });
      case 'admin:helperLogin':
        return ok({ signedIn: true, reused: false, profile: 'dcc-test' });
      case 'admin:pairManual':
        return ok({ paired: true, rotated: false, helperVersion: '0.1.0' });
      case 'admin:importCosts':
        return ok({ ok: true, entries: 2 });
      case 'page:clearDiagnostics':
        return ok(null);
      default:
        return undefined;
    }
  };
  return { fn, st };
}

function savedConn(origin, patch = {}) {
  return Object.assign(
    {
      origin,
      cloud: 'aws',
      workspaceId: '42',
      authMode: 'pat',
      priceTable: 'system.billing.list_prices',
      usageSource: 'system.billing.usage',
      historySource: 'system.query.history',
      currency: 'USD',
      warehouse: { mode: 'auto', resolvedId: '2222222222222222', resolvedName: 'BI Serverless' },
      revision: 3,
      savedAt: 1,
      secrets: { hasPat: true, bridgePaired: false, helperVersion: null, capabilities: null },
    },
    patch
  );
}

/* ================================================================== popup */

test('popup: loads without workspace-appearance.js, keeps its container, shows the disclaimer', async () => {
  const sw = popupWorker();
  const env = openPage('popup', { onMessage: sw.fn });
  await env.window.DCC.popupPage.ready;
  assert.ok(env.skipped.includes('workspace-appearance.js'));
  const panel = env.$('appearance-panel');
  assert.equal(panel.tagName, 'SECTION');
  assert.equal(panel.getAttribute('aria-label'), 'Workspace colors');
  assert.equal(panel.children.length, 0, 'the container is left for workspace-appearance.js');
  assert.ok(env.document.querySelector('link[rel="stylesheet"][href="workspace-appearance.css"]'));
  assert.match(env.text('disclaimer'), /^Estimated costs\. Billing can be delayed; final invoices may differ\.$/);
  assert.equal(env.$('mode-connected').checked, true);
  assert.equal(env.$('period-30').checked, true);
  assert.equal(env.$('show-costs').checked, true);
  assert.equal(env.document.querySelectorAll('script:not([src])').length, 0, 'no inline scripts (CSP)');
  assert.equal(env.document.querySelectorAll('[onclick],[onchange],[oninput]').length, 0, 'no inline handlers');
  const css = readFileSync(path.join(EXT, 'ui/popup.css'), 'utf8');
  assert.match(css, /width: 360px/);
  assert.equal(env.$('fixture-link').getAttribute('href'), 'http://127.0.0.1:8765/workspace.html');
  env.close();
});

test('popup: mode, period and show-costs send page:updateSettings', async () => {
  const sw = popupWorker();
  const env = openPage('popup', { onMessage: sw.fn });
  await env.window.DCC.popupPage.ready;
  env.$('mode-demo').click();
  await settle();
  env.$('period-90').click();
  await settle();
  env.$('show-costs').click();
  await settle();
  assert.deepEqual(env.sent('page:updateSettings').map((m) => m.patch), [{ mode: 'demo' }, { periodDays: 90 }, { showCosts: false }]);
  assert.match(env.text('mode-summary'), /Demo mode · 90 days · Paused/);
  assert.match(env.text('mode-hint'), /DEMO/);
  env.$('show-costs').click();
  await settle();
  assert.deepEqual(env.sent('page:updateSettings').at(-1).patch, { showCosts: true });
  env.close();
});

test('popup: a failed settings update reverts the control and shows the error', async () => {
  const sw = popupWorker({ hooks: { 'page:updateSettings': () => ({ ok: false, error: { code: 'UNKNOWN', title: 'Something went wrong', steps: ['Select Refresh.'], details: {} } }) } });
  const env = openPage('popup', { onMessage: sw.fn });
  await env.window.DCC.popupPage.ready;
  env.$('period-7').click();
  await settle();
  assert.equal(env.$('period-30').checked, true);
  assert.equal(env.$('period-7').checked, false);
  assert.match(env.text('page-alert'), /Something went wrong/);
  env.close();
});

test('popup: "Connect this workspace" hands the active tab URL to options', async () => {
  const sw = popupWorker();
  const env = openPage('popup', { onMessage: sw.fn, tabs: [{ id: 7, url: A + '/jobs/12?o=42' }] });
  await env.window.DCC.popupPage.ready;
  assert.equal(env.$('connect-btn').textContent, 'Connect this workspace');
  assert.match(env.text('tab-status'), /dbc-aaa\.cloud\.databricks\.com/);
  assert.match(env.text('tab-status'), /Site access is not granted yet/);
  env.$('connect-btn').click();
  await settle();
  const order = env.messages.filter((m) => m.type === 'page:setPendingConnect' || m.type === 'page:open');
  assert.deepEqual(order, [
    { type: 'page:setPendingConnect', url: A + '/jobs/12?o=42' },
    { type: 'page:open', page: 'options', anchor: 'connect' },
  ]);
  assert.equal(env.closed, true);
  env.close();
});

test('popup: saved connection with a different tab workspace ID asks for review', async () => {
  const sw = popupWorker({ connections: { [A]: savedConn(A) } });
  const env = openPage('popup', { onMessage: sw.fn, tabs: [{ id: 7, url: A + '/?o=99' }], granted: [A + '/*'] });
  await env.window.DCC.popupPage.ready;
  assert.equal(env.$('connect-btn').textContent, 'Review connection');
  assert.match(env.text('tab-status'), /workspace 99.*saved connection is for workspace 42/);
  env.close();
});

test('popup: an account-console tab gets no hand-off, just Connection preferences', async () => {
  const sw = popupWorker();
  const env = openPage('popup', { onMessage: sw.fn, tabs: [{ id: 7, url: 'https://accounts.cloud.databricks.com/workspaces' }] });
  await env.window.DCC.popupPage.ready;
  assert.equal(env.$('connect-btn').textContent, 'Connect Databricks');
  assert.match(env.text('tab-status'), /account console/);
  env.$('connect-btn').click();
  await settle();
  assert.equal(env.sent('page:setPendingConnect').length, 0);
  assert.deepEqual(env.sent('page:open'), [{ type: 'page:open', page: 'options', anchor: 'connect' }]);
  env.close();
});

test('popup: notifications permission is requested before notifyFailures is saved', async () => {
  const sw = popupWorker({ settings: { monitor: { enabled: true, autoOpen: false, notifyFailures: false, intervalSec: 60, origin: null } } });
  const env = openPage('popup', { onMessage: sw.fn });
  await env.window.DCC.popupPage.ready;
  assert.equal(env.$('monitor-notify').disabled, false);
  env.$('monitor-notify').click();
  await settle();
  assert.deepEqual(env.perms.requests, [{ permissions: ['notifications'] }]);
  const permAt = env.events.findIndex((e) => e.kind === 'permission');
  const saveAt = env.events.findIndex((e) => e.kind === 'message' && e.msg.type === 'page:updateSettings');
  assert.ok(permAt !== -1 && saveAt > permAt, 'permission request comes first');
  assert.deepEqual(env.sent('page:updateSettings')[0].patch, { monitor: { notifyFailures: true } });
  assert.equal(env.$('monitor-notify').checked, true);

  env.$('monitor-enabled').click();
  await settle();
  assert.deepEqual(env.sent('page:updateSettings').at(-1).patch, { monitor: { enabled: false } });
  assert.equal(env.$('monitor-autoopen').disabled, true);
  env.close();
});

test('popup: a denied notifications permission keeps failure alerts off', async () => {
  const sw = popupWorker({ settings: { monitor: { enabled: true, autoOpen: false, notifyFailures: false, intervalSec: 60, origin: null } } });
  const env = openPage('popup', { onMessage: sw.fn, permissionAnswer: false });
  await env.window.DCC.popupPage.ready;
  env.$('monitor-notify').click();
  await settle();
  assert.equal(env.perms.requests.length, 1);
  assert.equal(env.sent('page:updateSettings').length, 0);
  assert.equal(env.$('monitor-notify').checked, false);
  assert.match(env.text('monitor-status'), /Notifications were not allowed/);
  env.$('monitor-autoopen').click();
  await settle();
  assert.deepEqual(env.sent('page:updateSettings')[0].patch, { monitor: { autoOpen: true } });
  env.close();
});

test('popup: Open monitor shows a friendly error when the monitor is unavailable', async () => {
  const sw = popupWorker();
  const env = openPage('popup', { onMessage: sw.fn });
  await env.window.DCC.popupPage.ready;
  env.$('monitor-open').click();
  await settle();
  assert.deepEqual(env.sent('monitor:open'), [{ type: 'monitor:open' }]);
  assert.match(env.text('monitor-status'), /The monitor could not be opened/);
  assert.equal(env.closed, false);

  const sw2 = popupWorker({ hooks: { 'monitor:open': () => ok({ opened: true }) } });
  const env2 = openPage('popup', { onMessage: sw2.fn });
  await env2.window.DCC.popupPage.ready;
  env2.$('monitor-open').click();
  await settle();
  assert.equal(env2.closed, true);
  env.close();
  env2.close();
});

test('popup: diagnostics are sanitized and can be cleared; guide link opens the guide', async () => {
  const secret = 'dapi' + 'abcdef0123456789'.repeat(2);
  const sw = popupWorker({
    diagnostics: [
      { at: Date.parse('2026-10-15T10:00:00Z'), type: 'dcc:summary', code: 'BILLING_ACCESS_DENIED', details: { statementId: '01ef0000-1111-2222-3333-444455556666', message: 'denied ' + secret } },
    ],
  });
  const env = openPage('popup', { onMessage: sw.fn });
  await env.window.DCC.popupPage.ready;
  const diag = env.text('diag-list');
  assert.match(diag, /No permission to read billing system tables/);
  assert.match(diag, /BILLING_ACCESS_DENIED/);
  assert.match(diag, /01ef0000-1111-2222-3333-444455556666/);
  assert.ok(!env.text().includes(secret));
  assert.match(env.text('diag-count'), /\(1\)/);
  env.$('diag-clear').click();
  await settle();
  assert.equal(env.sent('page:clearDiagnostics').length, 1);
  assert.match(env.text('diag-list'), /No recent errors/);
  env.$('guide-link').click();
  await settle();
  assert.deepEqual(env.sent('page:open').at(-1), { type: 'page:open', page: 'guide' });
  env.close();
});

/* ================================================================== options */

async function openOptions(cfg = {}, pageOpts = {}) {
  const sw = optionsWorker(cfg);
  const env = openPage('options', Object.assign({ onMessage: sw.fn }, pageOpts));
  await env.window.DCC.optionsPage.ready;
  await settle();
  return { env, sw };
}

test('options: price-table dropdown has exactly the two allowed tables', async () => {
  const { env } = await openOptions();
  const opts = [...env.$('price-table').options];
  assert.deepEqual(
    opts.map((o) => o.value),
    ['system.billing.list_prices', 'system.billing.account_prices']
  );
  assert.deepEqual(
    opts.map((o) => o.textContent),
    [
      'List prices (system.billing.list_prices) — excludes private discounts',
      'Account prices (system.billing.account_prices) — may be unavailable on some clouds/accounts; invoice adjustments not modeled',
    ]
  );
  assert.equal(env.$('price-table').value, 'system.billing.list_prices');
  assert.equal(env.document.querySelectorAll('input[id*="price"]').length, 0, 'no free-text price table');
  assert.equal(env.document.querySelectorAll('script:not([src])').length, 0, 'no inline scripts (CSP)');
  env.close();
});

test('options: pending connect from the popup is selected and its ID prefilled', async () => {
  const { env } = await openOptions({ pending: { origin: A, workspaceId: '42', conflict: false }, observed: { [B]: { workspaceId: '7', seenAt: 1 } } });
  assert.equal(env.sent('admin:takePendingConnect').length, 1);
  const checked = env.document.querySelector('input[name="ws"]:checked');
  assert.equal(checked && checked.value, A);
  assert.equal(env.$('ws-id').value, '42');
  assert.match(env.text('pending-note'), /Connecting dbc-aaa\.cloud\.databricks\.com from the popup/);
  assert.deepEqual(env.sent('admin:prepare')[0], { type: 'admin:prepare', url: A });
  env.close();
});

test('options: several candidate workspaces are never selected automatically', async () => {
  const { env } = await openOptions({ connections: { [A]: savedConn(A) }, observed: { [B]: { workspaceId: '7', seenAt: 1 } } });
  assert.equal(env.document.querySelectorAll('input[name="ws"]').length, 2);
  assert.equal(env.document.querySelector('input[name="ws"]:checked'), null);
  assert.equal(env.$('ws-detail').hidden, true);
  assert.equal(env.sent('admin:prepare').length, 0);
  assert.equal(env.$('save-btn').disabled, true);
  env.close();
});

test('options: conflicting workspace IDs for one origin require an explicit choice', async () => {
  const { env } = await openOptions({ pending: { origin: A, workspaceId: '99', conflict: false }, connections: { [A]: savedConn(A, { workspaceId: '42' }) } });
  assert.equal(env.$('ws-id').value, '', 'no ID is chosen silently');
  const choices = [...env.document.querySelectorAll('input[name="ws-id-choice"]')].map((r) => r.value).sort();
  assert.deepEqual(choices, ['42', '99']);
  env.document.querySelector('input[name="ws-id-choice"][value="99"]').click();
  await settle();
  assert.equal(env.$('ws-id').value, '99');
  assert.match(env.text('save-summary'), /replaces the saved workspace ID 42/);
  env.close();
});

test('options: warehouse list renders Automatic plus one row per warehouse', async () => {
  const { env } = await openOptions({ pending: { origin: A, workspaceId: '42', conflict: false } });
  env.$('wh-list').click();
  await settle();
  const req = env.sent('admin:listWarehouses')[0];
  assert.equal(req.origin, A);
  assert.equal(req.authMode, 'helper');
  assert.match(req.requestId, /^wh-/);
  const radios = [...env.document.querySelectorAll('input[name="wh"]')];
  assert.equal(radios[0].value, 'auto');
  assert.equal(radios[0].checked, true, 'Automatic is the default for a new connection');
  assert.equal(radios.length, 1 + WH[A].length);
  const body = env.text('wh-body');
  assert.match(body, /Automatic \(prefer running, then smallest\)/);
  assert.match(body, /Would use BI Serverless 2222222222222222/);
  const rows = [...env.$('wh-body').querySelectorAll('tbody tr')].map((tr) => [...tr.cells].slice(1).map((td) => td.textContent.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(rows, [
    ['BI Serverless Serverless', '2222222222222222', 'Running', 'Medium'],
    ['Tiny', '3333333333333333', 'Stopped', '2X-Small'],
    ['Shared Small', '1111111111111111', 'Stopped', 'Small'],
  ]);
  env.close();
});

test('options: a late listWarehouses response for a previously selected origin is ignored', async () => {
  let releaseA = null;
  const hooks = {
    'admin:listWarehouses': (msg) =>
      msg.origin === A
        ? new Promise((resolve) => {
            releaseA = () => resolve(ok({ origin: A, requestId: msg.requestId, warehouses: WH[A], automatic: { id: '2222222222222222', name: 'BI Serverless' } }));
          })
        : undefined,
  };
  const { env } = await openOptions({ observed: { [A]: { workspaceId: '42', seenAt: 1 }, [B]: { workspaceId: '7', seenAt: 1 } }, hooks });
  env.document.querySelector(`input[name="ws"][value="${A}"]`).click();
  await settle();
  env.$('wh-list').click();
  await settle();
  assert.match(env.text('wh-body'), /Listing warehouses/);
  assert.ok(releaseA, 'listing for A is in flight');

  env.document.querySelector(`input[name="ws"][value="${B}"]`).click();
  await settle();
  releaseA();
  await settle();
  assert.ok(!env.text('wh-body').includes('BI Serverless'), "A's late list is not shown for B");
  assert.ok(!env.text('wh-body').includes('Listing warehouses'));

  env.$('wh-list').click();
  await settle();
  assert.match(env.text('wh-body'), /Bravo Warehouse/);
  assert.ok(!env.text('wh-body').includes('Shared Small'));
  env.close();
});

test('options: a superseded listing for the same origin is ignored too', async () => {
  const pendingResolvers = [];
  const hooks = {
    'admin:listWarehouses': (msg) =>
      new Promise((resolve) => {
        pendingResolvers.push(() => resolve(ok({ origin: msg.origin, requestId: msg.requestId, warehouses: pendingResolvers.length === 1 ? [] : WH[A], automatic: null })));
      }),
  };
  const { env } = await openOptions({ pending: { origin: A, workspaceId: '42', conflict: false }, hooks });
  env.$('wh-list').click();
  await settle();
  env.$('wh-list').click();
  await settle();
  pendingResolvers[1]();
  await settle();
  pendingResolvers[0](); // older request, empty list — must not replace the newer one
  await settle();
  assert.match(env.text('wh-body'), /Shared Small/);
  assert.ok(!env.text('wh-body').includes('No SQL warehouses are visible'));
  env.close();
});

test('options: a saved manual warehouse that is missing is shown as unavailable and stays selected', async () => {
  const conn = savedConn(A, { warehouse: { mode: 'manual', id: 'deadbeefdeadbeef', name: 'Old Finance WH' } });
  const { env } = await openOptions({ connections: { [A]: conn } });
  assert.equal(env.document.querySelector('input[name="ws"]:checked').value, A, 'single candidate is preselected');
  assert.match(env.text('wh-saved'), /Saved choice: Old Finance WH deadbeefdeadbeef/);
  const patRadio = env.document.querySelector('input[name="auth"]:checked');
  assert.equal(patRadio.value, 'pat', 'saved auth mode is preserved');
  env.$('wh-list').click();
  await settle();
  const missing = env.$('wh-opt-deadbeefdeadbeef');
  assert.ok(missing, 'the saved warehouse is listed explicitly');
  assert.equal(missing.checked, true, 'saved choice is preserved');
  assert.equal(env.document.querySelector('input[name="wh"][value="auto"]').checked, false);
  const row = missing.closest('tr');
  assert.ok(row.classList.contains('is-unavailable'));
  assert.match(row.textContent, /Old Finance WH/);
  assert.match(row.textContent, /Unavailable/);
  assert.match(env.text('wh-body'), /Your saved warehouse is unavailable/);
  env.close();
});

test('options: save sends the expected payload', async () => {
  const { env } = await openOptions({ pending: { origin: A, workspaceId: '42', conflict: false } });
  env.$('auth-pat-radio').click();
  await settle();
  env.$('wh-list').click();
  await settle();
  env.$('wh-opt-3333333333333333').click();
  env.$('price-table').value = 'system.billing.account_prices';
  env.$('price-table').dispatchEvent(new env.window.Event('change'));
  env.type('currency', 'eur');
  env.$('advanced').open = true;
  env.type('usage-source', 'main.finops.usage_view');
  env.$('save-btn').click();
  await settle();
  const saves = env.sent('admin:saveConnection');
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0], {
    type: 'admin:saveConnection',
    connection: {
      origin: A,
      workspaceId: '42',
      authMode: 'pat',
      priceTable: 'system.billing.account_prices',
      currency: 'EUR',
      usageSource: 'main.finops.usage_view',
      historySource: 'system.query.history',
      warehouse: { mode: 'manual', id: '3333333333333333', name: 'Tiny' },
    },
  });
  assert.match(env.text('save-result'), /Connection saved for dbc-aaa\.cloud\.databricks\.com/);
  assert.match(env.text('save-result'), /doesn't prove CAN USE/);
  assert.equal(env.$('disconnect').hidden, false);
  env.close();
});

test('options: Automatic is saved as {mode:"auto"} and invalid sources are blocked client-side', async () => {
  const { env } = await openOptions({ pending: { origin: A, workspaceId: '42', conflict: false } });
  env.$('save-btn').click();
  await settle();
  assert.equal(env.sent('admin:saveConnection').length, 0, 'must list warehouses first for a new connection');
  assert.match(env.text('save-result'), /List warehouses in step 4 first/);

  env.$('wh-list').click();
  await settle();
  env.type('usage-source', 'system.billing.list_prices');
  env.$('save-btn').click();
  await settle();
  assert.equal(env.sent('admin:saveConnection').length, 0);
  assert.equal(env.$('usage-source').getAttribute('aria-invalid'), 'true');
  assert.equal(env.$('advanced').open, true);

  env.type('usage-source', '');
  env.$('save-btn').click();
  await settle();
  const sent = env.sent('admin:saveConnection');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].connection.warehouse, { mode: 'auto' });
  assert.equal(sent[0].connection.usageSource, 'system.billing.usage');
  assert.match(env.text('save-result'), /Automatic → BI Serverless/);
  env.close();
});

test('options: a personal access token is never displayed or kept in the page', async () => {
  const token = 'dapi' + '0123456789abcdef'.repeat(2);
  const conn = savedConn(A);
  const { env } = await openOptions({ connections: { [A]: conn } });
  assert.match(env.text('pat-status'), /A token is saved for dbc-aaa\.cloud\.databricks\.com/);
  assert.equal(env.$('pat-input').type, 'password');
  env.type('pat-input', token);
  env.$('pat-save').click();
  await settle();
  assert.deepEqual(env.sent('admin:setPat'), [{ type: 'admin:setPat', origin: A, token }]);
  assert.equal(env.$('pat-input').value, '', 'field is cleared after save');
  assert.match(env.text('pat-result'), /Token saved for this browser session \(cleared when the browser closes\)/);
  const html = env.document.documentElement.outerHTML;
  assert.ok(!html.includes(token), 'token not in markup');
  assert.ok(![...env.document.querySelectorAll('input')].some((i) => i.value.includes(token)), 'token not in any field');

  env.type('pat-input', 'short');
  env.$('pat-save').click();
  await settle();
  assert.equal(env.sent('admin:setPat').length, 1, 'implausible tokens are not sent');
  assert.equal(env.$('pat-input').value, '');
  env.close();
});

test('options: error rendering shows title, steps and statement ID without secret-looking strings', async () => {
  const pat = 'dapi' + 'fedcba9876543210'.repeat(2);
  const hooks = {
    'admin:saveConnection': () => ({
      ok: false,
      error: {
        code: 'BILLING_ACCESS_DENIED',
        title: 'No permission to read billing system tables',
        steps: ['Ask an account or metastore admin to grant SELECT on system.billing.usage.'],
        details: {
          errorCode: 'INSUFFICIENT_PERMISSIONS',
          sqlState: '42501',
          statementId: '01EF1234-ABCD-4ABC-8DEF-0123456789AB',
          httpStatus: 403,
          message: 'User lacks SELECT. Authorization: Bearer abcdefghij.klmnopqrst.uvwxyz12345 ' + pat + ' token=supersecretvalue key 0123456789abcdef01234567',
        },
      },
    }),
  };
  const { env } = await openOptions({ connections: { [A]: savedConn(A) }, hooks });
  env.$('save-btn').click();
  await settle();
  const out = env.$('save-result');
  const text = env.text('save-result');
  assert.match(text, /No permission to read billing system tables/);
  assert.match(text, /Ask an account or metastore admin/);
  assert.equal(out.querySelector('details summary').textContent, 'Technical details');
  assert.match(text, /BILLING_ACCESS_DENIED/);
  assert.match(text, /INSUFFICIENT_PERMISSIONS/);
  assert.match(text, /01ef1234-abcd-4abc-8def-0123456789ab/);
  assert.match(text, /HTTP status 403/);
  for (const secret of [pat, 'supersecretvalue', 'abcdefghij.klmnopqrst', '0123456789abcdef01234567']) assert.ok(!text.includes(secret), 'redacted: ' + secret.slice(0, 8));
  assert.equal(out.querySelector('[role="alert"]') !== null, true);
  env.close();
});

test('options: site access requests exactly the selected origin, then syncs scripts', async () => {
  const { env } = await openOptions({ pending: { origin: A, workspaceId: '42', conflict: false } });
  assert.match(env.text('access-status'), /Not allowed yet/);
  env.$('access-grant').click();
  await settle();
  assert.deepEqual(env.perms.requests, [{ origins: [A + '/*'] }]);
  assert.deepEqual(env.sent('admin:syncScripts'), [{ type: 'admin:syncScripts', origin: A }]);
  assert.match(env.text('access-status'), /Access allowed/);
  assert.match(env.text('access-result'), /Cost display started in 1 open tab/);
  env.$('access-remove').click();
  await settle();
  assert.deepEqual(env.perms.removals, [{ origins: [A + '/*'] }]);
  assert.match(env.text('access-status'), /Not allowed yet/);
  env.close();
});

test('options: granted origins appear as candidates; wildcard grants do not', async () => {
  const { env } = await openOptions({}, { granted: [B + '/*', 'https://*.cloud.databricks.com/*'] });
  const values = [...env.document.querySelectorAll('input[name="ws"]')].map((i) => i.value);
  assert.deepEqual(values, [B]);
  assert.match(env.text('ws-candidates'), /Site access allowed/);
  env.close();
});

test('options: helper sign-in sends cost and monitor purposes; manual pairing key is validated and cleared', async () => {
  const bridge = { hasPat: false, bridgePaired: true, helperVersion: '0.1.0', capabilities: { accountPrices: true, priceAdapterVersion: 2, jobPipelineAttribution: true, monitor: true, protocol: 1 } };
  const { env } = await openOptions({ pending: { origin: A, workspaceId: '42', conflict: false }, bridge });
  assert.match(env.text('helper-status'), /Paired with the local helper v0\.1\.0/);
  env.$('helper-login').click();
  await settle();
  env.$('helper-login-monitor').click();
  await settle();
  assert.deepEqual(env.sent('admin:helperLogin'), [
    { type: 'admin:helperLogin', origin: A, purpose: 'cost' },
    { type: 'admin:helperLogin', origin: A, purpose: 'monitor' },
  ]);
  assert.match(env.text('auth'), /all-apis/);

  env.type('pair-key', 'not-a-key');
  env.$('pair-submit').click();
  await settle();
  assert.equal(env.sent('admin:pairManual').length, 0);
  assert.match(env.text('pair-result'), /pairing key isn't valid/);
  const key = 'abcdef0123456789abcdef01';
  env.type('pair-key', key.toUpperCase());
  env.$('pair-submit').click();
  await settle();
  assert.deepEqual(env.sent('admin:pairManual'), [{ type: 'admin:pairManual', key }]);
  assert.equal(env.$('pair-key').value, '');
  assert.ok(!env.document.documentElement.outerHTML.toLowerCase().includes(key));
  env.close();
});

test('options: #paired shows the pairing result', async () => {
  const bridge = { hasPat: false, bridgePaired: true, helperVersion: '0.1.0', capabilities: { accountPrices: true, priceAdapterVersion: 2, jobPipelineAttribution: true, monitor: true, protocol: 1 } };
  const { env } = await openOptions({ bridge }, { hash: '#paired' });
  assert.match(env.text('page-alert'), /Paired with the local helper v0\.1\.0/);
  env.close();
  const { env: env2 } = await openOptions({}, { hash: '#paired' });
  assert.match(env2.text('page-alert'), /No active helper pairing found/);
  env2.close();
});

test('options: manual URL entry rejects account consoles and resolves ?o= IDs', async () => {
  const { env } = await openOptions();
  env.type('ws-url', 'accounts.cloud.databricks.com');
  env.$('ws-url-use').click();
  await settle();
  assert.match(env.text('ws-url-error'), /account-console URL/);
  assert.equal(env.$('ws-detail').hidden, true);
  env.type('ws-url', 'dbc-ccc.cloud.databricks.com/?o=77');
  env.$('ws-url-use').click();
  await settle();
  assert.equal(env.$('ws-url-error').hidden, true);
  assert.deepEqual(env.sent('admin:prepare').at(-1), { type: 'admin:prepare', url: 'https://dbc-ccc.cloud.databricks.com/?o=77' });
  assert.equal(env.$('ws-id').value, '77');
  assert.match(env.text('ws-candidates'), /Entered here/);
  env.close();
});

test('options: disconnect asks first and does not touch other settings', async () => {
  const { env } = await openOptions({ connections: { [A]: savedConn(A) } });
  assert.equal(env.$('disconnect').hidden, false);
  env.$('disconnect-btn').click();
  await settle();
  assert.equal(env.$('disconnect-confirm').hidden, false);
  assert.equal(env.sent('admin:removeConnection').length, 0, 'nothing removed before confirmation');
  env.$('disconnect-no').click();
  assert.equal(env.$('disconnect-confirm').hidden, true);
  env.$('disconnect-btn').click();
  env.$('disconnect-yes').click();
  await settle();
  assert.deepEqual(env.sent('admin:removeConnection'), [{ type: 'admin:removeConnection', origin: A }]);
  assert.match(env.text('save-result'), /Workspace colors were not changed/);
  assert.equal(env.$('disconnect').hidden, true);
  const touched = env.messages.filter((m) => m.type === 'page:updateSettings' || /appearance/i.test(m.type));
  assert.deepEqual(touched, []);
  env.close();
});

test('options: local import shows validation errors and success', async () => {
  let reply = ok({ ok: false, errors: ['Entry 1: type must be one of workspace, job, pipeline, warehouse, notebook, app.', 'Entry 2: periodDays must be 7, 30 or 90.'] });
  const { env } = await openOptions({ hooks: { 'admin:importCosts': () => reply } });
  const input = env.$('import-file');
  const pick = (text) => {
    const file = new env.window.File([text], 'costs.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new env.window.Event('change'));
  };
  pick('[{"workspace":"42","type":"cluster"}]');
  await settle(40);
  assert.deepEqual(env.sent('admin:importCosts'), [{ type: 'admin:importCosts', text: '[{"workspace":"42","type":"cluster"}]' }]);
  assert.match(env.text('import-result'), /The file was not imported/);
  assert.match(env.text('import-result'), /Entry 2: periodDays must be 7, 30 or 90\./);
  reply = ok({ ok: true, entries: 2 });
  pick('[]');
  await settle(40);
  assert.match(env.text('import-result'), /Imported 2 summaries/);
  env.close();
});
