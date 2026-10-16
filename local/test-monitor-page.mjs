// Monitor page rendering. SIMULATED: jsdom with a fake chrome.runtime standing in for the service
// worker. Document Picture-in-Picture is faked too; the real API from a chrome-extension:// page
// is unverified until a real browser test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from './support/load.mjs';

const labels = load('core/labels.js');
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension');
const HTML = readFileSync(path.join(EXT, 'ui/monitor.html'), 'utf8');
const ORIGIN = 'https://dbc-1.cloud.databricks.com';
const WS = '1234567890123';
const NOW = Date.now();
const runUrl = (job, run) => `${ORIGIN}/?o=${WS}#job/${job}/run/${run}`;
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function liveModel(over = {}) {
  return {
    settings: { enabled: true, autoOpen: false, notifyFailures: false, intervalSec: 60, origin: ORIGIN },
    mode: 'connected',
    showCosts: true,
    periodDays: 30,
    connections: [ORIGIN, 'https://dbc-2.cloud.databricks.com'],
    monitorOrigin: ORIGIN,
    notificationsGranted: false,
    state: {
      status: 'ok',
      origin: ORIGIN,
      workspaceId: WS,
      authMode: 'pat',
      at: NOW - 5000,
      attemptAt: NOW - 5000,
      runs: [
        { runId: '1', jobId: '11', name: 'Streaming ingest', outcome: 'running', statusText: 'Running', active: true, startMs: NOW - 600000, endMs: null, durationMs: null, code: null, url: runUrl(11, 1) },
        { runId: '2', jobId: '11', name: 'Tampered link', outcome: 'pending', statusText: 'Queued', active: true, startMs: NOW - 60000, endMs: null, durationMs: null, code: null, url: 'https://evil.example/#job/11/run/2' },
        { runId: '3', jobId: '11', name: 'Nightly ETL', outcome: 'failed', statusText: 'Failed', active: false, startMs: NOW - 7200000, endMs: NOW - 3600000, durationMs: 3600000, code: 'RUN_EXECUTION_ERROR', url: runUrl(11, 3) },
        { runId: '4', jobId: '11', name: 'Script link', outcome: 'succeeded', statusText: 'Succeeded', active: false, startMs: NOW - 9000000, endMs: NOW - 8000000, durationMs: 1000000, code: 'SUCCESS', url: 'javascript:alert(1)' },
        { runId: '5', jobId: '12', name: null, outcome: 'succeeded', statusText: 'Succeeded', active: false, startMs: null, endMs: null, durationMs: null, code: null, url: runUrl(11, 5) },
      ],
      pipelines: [
        { pipelineId: '00000001-aaaa-bbbb-cccc-dddddddddddd', name: 'orders_dlt', state: 'RUNNING', health: 'HEALTHY', active: true, recentFailure: false, update: { updateId: '00000002-aaaa-bbbb-cccc-dddddddddddd', state: 'SETTING_UP_TABLES', outcome: 'running', statusText: 'Setting up tables', createdMs: NOW - 120000 } },
      ],
      warehouses: [
        { id: '0123456789abcdef', name: 'Starter', state: 'RUNNING', size: 'Small', type: 'PRO', serverless: true, activeClusters: 1 },
        { id: 'fedcba9876543210', name: 'Reporting', state: 'STOPPED', size: 'Large', type: 'PRO', serverless: false, activeClusters: null },
      ],
      clusters: [{ clusterId: '0923-164208-meows279', name: 'Shared autoscaling', state: 'RUNNING', statusText: 'Running', source: 'UI', workers: null, autoscale: { min: 2, max: 8 }, startMs: NOW - 3600000, active: true }],
      counts: { running: 1, pending: 1, failed: 1, succeeded: 2, partial: 0, canceled: 0, skipped: 0, pipelinesActive: 1, pipelinesFailed: 0, warehousesRunning: 1, warehousesStarting: 0, warehousesStopped: 1, warehousesTotal: 2, clustersActive: 1 },
      truncated: { runsActive: false, runsRecent: false, pipelines: false, warehouses: false, clusters: false },
      sectionAt: { runsActive: NOW - 5000, runsRecent: NOW - 5000, pipelines: NOW - 5000, warehouses: NOW - 5000, clusters: NOW - 5000 },
      errors: {},
      next: null,
      failures: 0,
      retryAt: null,
      unseenFailures: 1,
    },
    ...over,
  };
}

/**
 * @param {object} o
 * @param {(msg)=>object} o.respond returns the response `data` (or {__error}) per message
 * @param {boolean} [o.pip] provide a fake documentPictureInPicture
 */
async function openPage({ respond, pip = null, windowType = 'popup' }) {
  const dom = new JSDOM(HTML, { url: 'chrome-extension://testext/ui/monitor.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const messages = [];
  const tabs = [];
  w.chrome = {
    runtime: {
      id: 'testext',
      async sendMessage(msg) {
        messages.push(structuredClone(msg));
        const data = await respond(msg);
        if (data && data.__error) return { ok: false, error: data.__error };
        return { ok: true, data: data === undefined ? null : structuredClone(data) };
      },
    },
    tabs: { create: async (o) => tabs.push(structuredClone(o)) },
    windows: { getCurrent: async () => ({ type: windowType }) },
  };
  if (pip) w.documentPictureInPicture = pip(w);
  for (const src of [...w.document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'))) {
    const file = path.join(EXT, 'ui', src);
    w.eval(readFileSync(file, 'utf8') + '\n//# sourceURL=' + src);
  }
  await w.DCC.monitorPage.ready;
  await settle();
  return { dom, window: w, document: w.document, messages, tabs, close: () => (w.DCC.monitorPage.stop(), w.close()) };
}

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

test('page is CSP-safe: external scripts only, no inline handlers, no innerHTML in the page script', () => {
  const dom = new JSDOM(HTML);
  const scripts = [...dom.window.document.querySelectorAll('script')];
  assert.ok(scripts.length > 0);
  for (const s of scripts) {
    assert.ok(s.getAttribute('src'), 'every script has src');
    assert.equal(s.textContent.trim(), '');
  }
  for (const el of dom.window.document.querySelectorAll('*')) for (const a of el.getAttributeNames()) assert.ok(!/^on/i.test(a), 'inline handler ' + a);
  const js = readFileSync(path.join(EXT, 'ui/monitor.js'), 'utf8');
  assert.doesNotMatch(js, /\.(innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write|\beval\(|new Function/);
});

test('renders status text (not only color), counts, sections, and only validated run links', async () => {
  const model = liveModel();
  const p = await openPage({ respond: (m) => (m.type === 'monitor:loadCost' ? { notCached: true, periodDays: 30 } : model) });
  try {
    const d = p.document;
    assert.match(text(d.getElementById('updated')), /^Updated .* · checks every minute$/);
    const tiles = [...d.querySelectorAll('#counts .tile')].map(text);
    assert.deepEqual(tiles, ['2Running1 queued', '1Failedlast 24 h', '2Succeededlast 24 h']);

    const chips = [...d.querySelectorAll('#runs .st')].map(text);
    assert.deepEqual(chips, ['Running', 'Queued', 'Failed', 'Succeeded', 'Succeeded']);
    assert.ok(d.querySelector('#runs .st-failed'), 'status class for styling, alongside the text');

    const links = [...d.querySelectorAll('a')];
    assert.deepEqual(links.map((a) => a.getAttribute('href')), [runUrl(11, 1), runUrl(11, 3)], 'tampered, script and mismatched-job links are not rendered');
    for (const a of links) assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
    assert.match(text(d.getElementById('runs')), /Tampered link/);
    assert.match(text(d.getElementById('runs')), /Run 5/, 'missing name falls back to the run ID');
    assert.match(text(d.getElementById('runs')), /Run execution error/);

    links[1].dispatchEvent(new p.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.deepEqual(p.tabs, [{ url: runUrl(11, 3) }]);

    assert.match(text(d.getElementById('pipelines')), /Setting up tables.*orders_dlt/);
    const wh = text(d.getElementById('warehouses'));
    assert.match(wh, /1 running · 1 stopped/);
    assert.match(wh, /Starter/);
    assert.doesNotMatch(wh, /Reporting/, 'stopped warehouses are collapsed');
    d.querySelector('#warehouses button').click();
    assert.match(text(d.getElementById('warehouses')), /Stopped.*Reporting/);
    assert.match(text(d.getElementById('clusters')), /Running.*Shared autoscaling.*Interactive · 2–8 workers/);

    assert.equal(text(d.getElementById('disclaimer')), labels.DISCLAIMER);
    const sel = d.getElementById('ws');
    assert.deepEqual([...sel.options].map((o) => o.textContent), ['dbc-1.cloud.databricks.com', 'dbc-2.cloud.databricks.com']);
    assert.equal(sel.value, ORIGIN);

    assert.ok(p.messages.some((m) => m.type === 'monitor:state' && m.ack === true), 'visible page acknowledges failures');
    assert.ok(p.messages.some((m) => m.type === 'monitor:refresh' && m.ifStale === true));
    assert.ok(p.messages.some((m) => m.type === 'monitor:loadCost' && m.cachedOnly === true));
    assert.ok(!p.messages.some((m) => m.type === 'monitor:loadCost' && !m.cachedOnly), 'no cost query without a click');
  } finally {
    p.close();
  }
});

test('cost line: asks before starting a stopped warehouse, then shows a labeled estimate', async () => {
  const model = liveModel();
  const costCalls = [];
  const p = await openPage({
    respond: (m) => {
      if (m.type !== 'monitor:loadCost') return model;
      costCalls.push(m);
      if (m.cachedOnly) return { notCached: true, periodDays: 30 };
      if (!m.confirmStart) return { needsConfirm: true, warehouseId: '0123456789abcdef', warehouseName: 'Starter', state: 'STOPPED', periodDays: 30 };
      return { amount: 1234.5, coverage: 'partial', basis: 'list', priceTable: 'system.billing.list_prices', currency: 'USD', period: { days: 30, start: '2026-09-15', endExclusive: '2026-10-15' }, latestUsageMs: null, cached: false };
    },
  });
  try {
    const d = p.document;
    const cost = () => text(d.getElementById('cost'));
    assert.match(cost(), /asked first/);
    [...d.querySelectorAll('#cost button')].find((b) => b.textContent === 'Load cost').click();
    await settle();
    assert.match(cost(), /“Starter” is stopped\. Loading cost runs a query that starts it/);
    const start = [...d.querySelectorAll('#cost button')].find((b) => /Start warehouse/.test(b.textContent));
    assert.ok(start);
    start.click();
    await settle();
    assert.equal(costCalls.at(-1).confirmStart, true);
    assert.match(cost(), /\$1,234\.50 30d est\./);
    assert.match(cost(), /List price/);
    assert.match(cost(), /Priced subtotal/);
    assert.match(cost(), /Last 30 complete UTC days \(2026-09-15 to 2026-10-14\)/);
    assert.equal(text(d.getElementById('disclaimer')), 'Estimated costs. Billing can be delayed; final invoices may differ.');
  } finally {
    p.close();
  }
});

test('missing cost is never shown as zero', async () => {
  const p = await openPage({
    respond: (m) => (m.type === 'monitor:loadCost' ? { amount: null, coverage: 'empty', basis: 'list', currency: 'USD', period: { days: 7, start: '2026-10-08', endExclusive: '2026-10-15' }, cached: true } : liveModel()),
  });
  try {
    const t = text(p.document.getElementById('cost'));
    assert.match(t, /No cost data for this period/);
    assert.doesNotMatch(t, /\$0\.00/);
  } finally {
    p.close();
  }
});

test('Float on top: inline fallback message when Document PiP is missing or throws', async () => {
  const p = await openPage({ respond: (m) => (m.type === 'monitor:loadCost' ? { notCached: true } : liveModel()), windowType: 'normal' });
  try {
    const note = p.document.getElementById('float-note');
    assert.equal(note.hidden, true);
    p.document.getElementById('float').click();
    await settle();
    assert.equal(note.hidden, false);
    assert.match(text(note), /not available here\. You can keep this small monitor window open instead/);
    const openSmall = [...note.querySelectorAll('button')].find((b) => /small window/.test(b.textContent));
    assert.ok(openSmall, 'a tab offers to open the small popup window');
    openSmall.click();
    await settle();
    assert.ok(p.messages.some((m) => m.type === 'monitor:open'));
  } finally {
    p.close();
  }

  const throwing = await openPage({
    respond: (m) => (m.type === 'monitor:loadCost' ? { notCached: true } : liveModel()),
    pip: () => ({ requestWindow: async () => Promise.reject(new Error('NotAllowedError')) }),
  });
  try {
    throwing.document.getElementById('float').click();
    await settle();
    const note = throwing.document.getElementById('float-note');
    assert.equal(note.hidden, false);
    assert.equal(note.querySelector('button'), null, 'already a popup window: no extra button');
  } finally {
    throwing.close();
  }
});

test('Float on top: moves the app into the PiP document with styles and back on pagehide', async () => {
  let pipDom = null;
  let requested = null;
  const p = await openPage({
    respond: (m) => (m.type === 'monitor:loadCost' ? { notCached: true } : liveModel()),
    pip: () => ({
      requestWindow: async (opts) => {
        requested = structuredClone(opts);
        pipDom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'about:blank', pretendToBeVisual: true });
        const pw = pipDom.window;
        pw.close = () => pw.dispatchEvent(new pw.Event('pagehide'));
        return pw;
      },
    }),
  });
  try {
    const d = p.document;
    d.getElementById('float').click();
    await settle();
    assert.deepEqual(requested, { width: 360, height: 520 });
    const pd = pipDom.window.document;
    assert.ok(pd.getElementById('app'), 'app moved into the PiP window');
    assert.equal(d.getElementById('app'), null);
    assert.equal(d.getElementById('pip-placeholder').hidden, false);
    assert.equal(pd.getElementById('float').getAttribute('aria-pressed'), 'true');
    assert.ok(pd.head.querySelector('style, link[rel="stylesheet"]'), 'stylesheet copied');
    // Still interactive after the move: rendering keeps working inside the PiP document.
    await p.window.DCC.monitorPage.tick();
    await settle();
    assert.match(text(pd.getElementById('runs')), /Nightly ETL/);

    pipDom.window.close();
    await settle();
    assert.ok(d.getElementById('app'), 'app returned on pagehide');
    assert.equal(d.getElementById('pip-placeholder').hidden, true);
    assert.equal(d.getElementById('float').getAttribute('aria-pressed'), 'false');
  } finally {
    p.close();
  }
});

test('states: monitoring off offers to turn it on; sign-in next step links to Connection preferences', async () => {
  let enabled = false;
  const off = liveModel({ settings: { enabled: false, intervalSec: 60 }, state: null });
  const p = await openPage({
    respond: (m) => {
      if (m.type === 'page:updateSettings') {
        enabled = m.patch.monitor.enabled === true;
        return {};
      }
      if (m.type === 'monitor:loadCost') return { notCached: true };
      return enabled ? liveModel() : off;
    },
  });
  try {
    const d = p.document;
    assert.match(text(d.getElementById('notice')), /Monitoring is off/);
    assert.equal(d.getElementById('counts').hidden, true);
    assert.equal(d.getElementById('runs').parentElement.hidden, true);
    const btn = [...d.querySelectorAll('#notice button')].find((b) => b.textContent === 'Turn on monitoring');
    btn.click();
    await settle();
    assert.ok(p.messages.some((m) => m.type === 'page:updateSettings' && m.patch.monitor.enabled === true));
    assert.ok(p.messages.some((m) => m.type === 'monitor:refresh' && !m.ifStale));
    assert.equal(d.getElementById('notice').hidden, true);
    assert.equal(d.getElementById('counts').hidden, false);
  } finally {
    p.close();
  }

  const signin = liveModel();
  signin.state = Object.assign({}, signin.state, { status: 'signin', runs: [], next: { code: 'MONITOR_SIGNIN', title: 'Sign in for monitor', steps: ['Start the local helper, then select "Sign in for monitor".'] } });
  const s = await openPage({ respond: (m) => (m.type === 'monitor:loadCost' ? { notCached: true } : signin) });
  try {
    const d = s.document;
    assert.match(text(d.getElementById('notice')), /Sign in for monitor/);
    assert.equal(d.getElementById('runs').parentElement.hidden, true);
    [...d.querySelectorAll('#notice button')].find((b) => /Connection preferences/.test(b.textContent)).click();
    await settle();
    assert.ok(s.messages.some((m) => m.type === 'page:open' && m.page === 'options'));
  } finally {
    s.close();
  }
});

test('section errors keep the last data with a note; workspace, interval and preferences controls message the service worker', async () => {
  const model = liveModel();
  model.state.status = 'ok';
  model.state.errors = { warehouses: { code: 'NETWORK', title: 'Could not reach Databricks', steps: ['Check your network or VPN, then select Refresh.'] } };
  const p = await openPage({ respond: (m) => (m.type === 'monitor:loadCost' ? { notCached: true } : model) });
  try {
    const d = p.document;
    assert.match(text(d.getElementById('warehouses')), /Couldn't refresh: Could not reach Databricks\. Showing data from/);
    const sel = d.getElementById('ws');
    sel.value = 'https://dbc-2.cloud.databricks.com';
    sel.dispatchEvent(new p.window.Event('change'));
    await settle();
    assert.ok(p.messages.some((m) => m.type === 'monitor:setOrigin' && m.origin === 'https://dbc-2.cloud.databricks.com'));
    const interval = d.getElementById('interval');
    assert.equal(interval.value, '60');
    interval.value = '300';
    interval.dispatchEvent(new p.window.Event('change'));
    await settle();
    assert.ok(p.messages.some((m) => m.type === 'page:updateSettings' && m.patch.monitor.intervalSec === 300));
    d.getElementById('settings').click();
    await settle();
    assert.ok(p.messages.some((m) => m.type === 'page:open' && m.page === 'options' && m.anchor === 'auth'));
  } finally {
    p.close();
  }
});
