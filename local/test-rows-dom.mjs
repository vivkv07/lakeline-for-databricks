import { legacyFragment } from './fixture-data.mjs';
// Inline badges (row-refs, row-data, inline) in the SIMULATED jsdom environment with the real
// content bootstrap (content-main.js) and a stand-in service worker. Not proof of behavior in a
// real Databricks tab: jsdom has no layout, so geometry checks fall back to "unknown" except
// where a test stubs getBoundingClientRect.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContentEnv, BASE_CONTENT_FILES, settle } from './support/content-harness.mjs';
import { load } from './support/load.mjs';

const ids = load('core/ids.js');
const inlineMod = load('content/inline.js');
const rowRefs = load('content/row-refs.js');

const ORIGIN = 'https://dbc-1.cloud.databricks.com';
const WSID = '1234567890';
const FILES = [...BASE_CONTENT_FILES, 'src/content/row-refs.js', 'src/content/row-data.js', 'src/content/inline.js', 'src/content/content-main.js'];
const fixture = (name) => legacyFragment(readFileSync(new URL('./fixture/' + name, import.meta.url), 'utf8'));
const page = (fragment) => `<!doctype html><html><head></head><body><nav aria-label="Top Navigation"><a href="/jobs?o=${WSID}">Jobs</a></nav><main data-testid="main-content">${fragment}</main></body></html>`;

const summary = {
  kind: 'summary', pricingBasis: 'list', priceTable: 'system.billing.list_prices', currency: 'USD',
  period: { days: 30, start: '2026-09-15', endExclusive: '2026-10-15', prevStart: '2026-08-16', prevEndExclusive: '2026-09-15' },
  current: { coverage: 'complete', total: 100 }, previous: { coverage: 'complete', total: 90 },
  currentAmount: 100, previousAmount: 90, daily: [], freeQuantity: {}, latestUsageMs: Date.now() - 3600e3,
};

const EXEC = new Set(['job_run', 'pipeline_update']);
const LABEL = { job: 'Job total', job_run: 'Run cost', pipeline: 'Pipeline total', pipeline_update: 'Update cost', warehouse: 'Warehouse total', notebook: 'Notebook total', app: 'App total' };

/** Stand-in service worker. `amounts[key]` / `overrides[key]` shape items; `delay(msg)` delays replies. */
function makeSw({ amounts = {}, overrides = {}, delay = () => 0, mode = 'connected' } = {}) {
  const state = { settings: { mode, periodDays: 30, showCosts: true, revision: 1 }, rowsCalls: [], amounts, overrides };
  async function handler(msg) {
    switch (msg.type) {
      case 'dcc:hello':
        return { ok: true, data: { origin: ORIGIN, kind: 'workspace', workspaceId: WSID, idSource: 'param:o', idConflict: false, settings: { ...state.settings }, connection: mode === 'connected' ? { workspaceId: WSID, authMode: 'pat', priceTable: 'system.billing.list_prices', currency: 'USD' } : null, connectionMismatch: false } };
      case 'dcc:summary':
        return { ok: true, data: summary };
      case 'dcc:setPeriod':
        state.settings.periodDays = msg.periodDays;
        return { ok: true, data: { periodDays: msg.periodDays } };
      case 'dcc:rows': {
        state.rowsCalls.push(msg);
        const wait = delay(msg);
        if (wait) await settle(wait);
        if (!state.settings.showCosts) return { ok: true, data: { paused: true } };
        const items = {};
        for (const r of msg.refs) {
          const key = ids.refKey(ids.sanitizeRef(r));
          const exec = EXEC.has(r.type);
          const base = key in state.amounts ? state.amounts[key] : (exec ? 0.5 : msg.periodDays);
          items[key] = Object.assign(
            { key, type: r.type, status: 'ok', amount: base, coverage: 'complete', scope: exec ? 'execution' : 'period', attribution: r.type === 'job' || r.type === 'job_run' ? 'direct+pipelines' : 'direct', label: LABEL[r.type], warnings: [] },
            state.overrides[key] || {}
          );
        }
        return { ok: true, data: { pricingBasis: 'list', priceTable: 'system.billing.list_prices', priceField: 'pricing.effective_list.default', currency: 'USD', items } };
      }
      default:
        return { ok: true, data: null };
    }
  }
  return { state, handler };
}

// Every environment is closed after its test, even when an assertion fails (jsdom timers would
// otherwise keep the process alive).
const opened = [];
afterEach(() => {
  while (opened.length) opened.pop().close();
});
function track(env) {
  opened.push(env);
  return env;
}

function open(path, fragment, swOpts) {
  const sw = makeSw(swOpts);
  const env = track(createContentEnv({ url: ORIGIN + path, html: page(fragment), files: FILES, onMessage: sw.handler }));
  return { env, sw, doc: env.document };
}

async function waitFor(fn, { timeout = 3000, interval = 20, msg = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('Timed out waiting for ' + msg);
    await settle(interval);
  }
}

const badges = (doc, kind) => [...doc.querySelectorAll(kind ? `[data-dcc="inline"][data-dcc-kind="${kind}"]` : '[data-dcc="inline"]')];
const keysOf = (list) => list.map((b) => b.getAttribute('data-dcc-key')).sort();
const settled = (doc, kind, n) => () => {
  const b = badges(doc, kind);
  return b.length === n && b.every((x) => !x.classList.contains('dcc-inline--pending')) ? b : null;
};
const sentKeys = (sw) => sw.state.rowsCalls.flatMap((m) => m.refs.map((r) => ids.refKey(ids.sanitizeRef(r))));

test('job runs grid: badges for the current job runs only, never the Launched workflow', async () => {
  const { env, sw, doc } = open(`/jobs/1001/runs?o=${WSID}`, fixture('job-runs.html'), {
    amounts: { 'job:1001': 12.34, 'job_run:1001:50103': 0.001234 },
  });
  const rows = await waitFor(settled(doc, 'row', 4), { msg: 'four run badges' });
  assert.deepEqual(keysOf(rows), ['job_run:1001:50101', 'job_run:1001:50102', 'job_run:1001:50103', 'job_run:1001:50104']);
  // Launched column (job 777) never requested or badged; launcher-only row has no badge.
  assert.ok(!sentKeys(sw).some((k) => /777|89999|90001/.test(k)), 'launching workflow never requested');
  assert.equal(doc.querySelector('[data-fx-run="launcher-only"] [data-dcc]'), null);
  // One badge per row, right after the start-time link (even when Run ID links the same run).
  for (const id of ['50101', '50102', '50103', '50104']) {
    const tr = doc.querySelector(`[data-fx-run="${id}"]`);
    const b = tr.querySelectorAll('[data-dcc="inline"]');
    assert.equal(b.length, 1, 'row ' + id);
    assert.equal(b[0].previousElementSibling.tagName, 'A');
    assert.match(b[0].previousElementSibling.textContent, /Oct/);
  }
  // Dense timeline bars and status dots stay native.
  assert.equal(doc.querySelector('.fx-timeline [data-dcc]'), null);
  assert.equal(doc.querySelectorAll('.fx-status + [data-dcc]').length, 0);
  // Execution amounts: small values keep up to 6 decimals; tooltip discloses the search window.
  const small = rows.find((b) => b.getAttribute('data-dcc-key') === 'job_run:1001:50103');
  assert.equal(small.textContent, '$0.001234 est.');
  assert.match(small.getAttribute('title'), /365 UTC dates/);
  assert.match(small.getAttribute('aria-label'), /this execution only|This execution only/i);
  assert.match(small.getAttribute('title'), /pipeline updates it triggered \(this run only\)/);
  // Title total beside the native title.
  const title = await waitFor(settled(doc, 'title', 1), { msg: 'title badge' });
  assert.equal(title[0].textContent, 'Job total: $12.34 · 30d est.');
  assert.equal(title[0].previousElementSibling, doc.querySelector('h1'));
  assert.match(title[0].getAttribute('title'), /not lifetime spend/i);
  assert.match(title[0].getAttribute('title'), /Estimated costs\. Billing can be delayed; final invoices may differ\./);
  assert.equal(doc.querySelectorAll('style[data-dcc="inline-style"]').length, 1);
});

test('title totals: direct-only, partial, missing and pipeline pages', async () => {
  {
    const { env, doc } = open(`/jobs/1001?o=${WSID}`, fixture('job-runs.html'), {
      overrides: {
        'job:1001': { amount: 5, attribution: 'direct-only', label: 'Direct job cost', warnings: [{ code: 'PIPELINE_ATTRIBUTION_UNAVAILABLE', text: 'Pipeline updates triggered by this job could not be attributed.' }] },
        'job_run:1001:50101': { amount: 2, attribution: 'direct-only', label: 'Direct job cost (this run)', warnings: [{ code: 'PIPELINE_ATTRIBUTION_UNAVAILABLE', text: 'x' }] },
      },
    });
    const [t] = await waitFor(settled(doc, 'title', 1));
    assert.equal(t.textContent, 'Direct job cost: $5.00 · 30d est.');
    assert.match(t.getAttribute('title'), /could not be attributed/);
    assert.match(t.getAttribute('title'), /not a complete job total/);
    const runBadge = await waitFor(() => doc.querySelector('[data-dcc-key="job_run:1001:50101"]:not(.dcc-inline--pending)'));
    assert.equal(runBadge.textContent, 'Direct $2.00 est.');
  }
  {
    const { env, doc } = open(`/jobs/1001?o=${WSID}`, fixture('job-runs.html'), {
      overrides: { 'job:1001': { status: 'partial', coverage: 'partial', amount: 7.5, label: 'Job total (priced subtotal)', warnings: [{ code: 'UNPRICED_USAGE', text: '1 usage record had no single matching price' }] } },
    });
    const [t] = await waitFor(settled(doc, 'title', 1));
    assert.equal(t.textContent, 'Job total (priced subtotal): $7.50 · 30d est.');
  }
  {
    const { env, doc } = open(`/jobs/1001?o=${WSID}`, fixture('job-runs.html'), {
      overrides: { 'job:1001': { status: 'none', coverage: 'empty', amount: null }, 'job_run:1001:50101': { status: 'none', coverage: 'empty', amount: null } },
    });
    const [t] = await waitFor(settled(doc, 'title', 1));
    assert.equal(t.textContent, 'Job total: no usage recorded · 30d');
    const rb = await waitFor(() => doc.querySelector('[data-dcc-key="job_run:1001:50101"]:not(.dcc-inline--pending)'));
    assert.equal(rb.textContent, 'No usage');
    assert.ok(!/\$0/.test(t.textContent + rb.textContent), 'missing never shown as $0');
  }
  {
    const P = '0a1b2c3d-1111-4a2b-8c3d-000000000001';
    const { env, sw, doc } = open(`/pipelines/${P}?o=${WSID}`, fixture('pipeline-updates.html'), { amounts: { ['pipeline:' + P]: 88.1 } });
    const [t] = await waitFor(settled(doc, 'title', 1));
    assert.equal(t.textContent, 'Pipeline total: $88.10 · 30d est.');
    const rows = await waitFor(settled(doc, 'row', 3));
    assert.deepEqual(keysOf(rows), ['11', '12', '13'].map((n) => `pipeline_update:${P}:0a1b2c3d-2222-4a2b-8c3d-0000000000${n}`));
    assert.ok(!sentKeys(sw).some((k) => k.startsWith('job')), 'Triggered-by job run link is not badged');
    assert.equal(doc.querySelector('[data-fx-update="other-pipeline"] [data-dcc]'), null);
    assert.equal(doc.querySelector('.fx-graph [data-dcc]'), null);
  }
});

test('list pages: jobs, warehouses, notebooks, apps; none on Query History', async () => {
  const cases = [
    ['/jobs?o=' + WSID, 'jobs.html', ['job:1001', 'job:1002', 'job:777', 'pipeline:0a1b2c3d-1111-4a2b-8c3d-000000000001']],
    ['/sql/warehouses?o=' + WSID, 'warehouses-list.html', ['warehouse:a1b2c3d4e5f60001', 'warehouse:a1b2c3d4e5f60002', 'warehouse:a1b2c3d4e5f60003']],
    ['/browse/folders/2001?o=' + WSID, 'notebooks.html', ['notebook:3001', 'notebook:3002']],
    ['/apps?o=' + WSID, 'apps.html', ['app:ops-assistant', 'app:sales-dashboard']],
  ];
  for (const [path, fx, expected] of cases) {
    const { env, sw, doc } = open(path, fixture(fx));
    const rows = await waitFor(settled(doc, 'row', expected.length), { msg: fx });
    assert.deepEqual(keysOf(rows), expected, fx);
    assert.deepEqual([...new Set(sentKeys(sw))].sort(), expected, fx + ' requests');
    for (const b of rows) {
      assert.equal(b.previousElementSibling.tagName, 'A', fx);
      assert.match(b.textContent, /^\$30\.00 est\.$/, fx);
    }
    assert.equal(badges(doc, 'title').length, 0, fx + ': no title totals on lists');
  }
  // Jobs list: status dots stay native, other-workspace and nav-only links ignored.
  {
    const { env, doc } = open('/jobs?o=' + WSID, fixture('jobs.html'));
    await waitFor(settled(doc, 'row', 4));
    assert.equal(doc.querySelectorAll('.fx-dots [data-dcc]').length, 0);
    assert.equal(doc.querySelector('[data-fx-row="other-workspace"] [data-dcc]'), null);
  }
  // Query History: no generic warehouse badges at all.
  {
    const { env, sw, doc } = open('/sql/history?o=' + WSID, fixture('warehouses-list.html'));
    await settle(700);
    assert.equal(badges(doc).length, 0);
    assert.equal(sw.state.rowsCalls.length, 0);
  }
});

test('period change re-requests and drops late responses for the old period', async () => {
  const { env, sw, doc } = open(`/jobs/1001/runs?o=${WSID}`, fixture('job-runs.html'), { delay: (m) => (m.periodDays === 30 ? 400 : 0) });
  await waitFor(() => sw.state.rowsCalls.length > 0, { msg: 'first request' });
  const bannerBtn = await waitFor(() => doc.querySelector('[data-dcc="banner"]').shadowRoot.querySelector('button[title^="Last 7 complete UTC days"]'));
  bannerBtn.click();
  const [t] = await waitFor(() => {
    const b = badges(doc, 'title');
    return b.length === 1 && b[0].textContent === 'Job total: $7.00 · 7d est.' ? b : null;
  }, { msg: '7d title' });
  assert.ok(sw.state.rowsCalls.some((m) => m.periodDays === 7 && m.refs.some((r) => r.type === 'job')));
  await settle(600); // the delayed 30d responses arrive now and must be ignored
  assert.equal(t.textContent, 'Job total: $7.00 · 7d est.');
  assert.equal(badges(doc, 'title')[0].textContent, 'Job total: $7.00 · 7d est.');
});

test('SPA route change: stale badges removed, new route badged, Query History cleared', async () => {
  const { env, sw, doc } = open(`/jobs/1001/runs?o=${WSID}`, fixture('job-runs.html'));
  await waitFor(settled(doc, 'row', 4));
  // Route moves to another job while the old table is still on screen (SPA lag).
  env.navigate(`/jobs/1002/runs?o=${WSID}`);
  doc.querySelector('h1').textContent = 'hourly_events';
  await waitFor(() => badges(doc, 'row').length === 0 && keysOf(badges(doc, 'title')).join() === 'job:1002', { msg: 'old run badges removed' });
  // The SPA renders the new page.
  doc.querySelector('main').lastElementChild.replaceWith(Object.assign(doc.createElement('section'), { innerHTML: fixture('jobs.html') }));
  env.navigate(`/jobs?o=${WSID}`);
  await waitFor(settled(doc, 'row', 4), { msg: 'jobs list badges' });
  assert.equal(badges(doc, 'title').length, 0);
  // Query History: everything removed.
  env.navigate(`/sql/history?o=${WSID}`);
  doc.body.appendChild(doc.createElement('div'));
  await waitFor(() => badges(doc).length === 0, { msg: 'cleared on query history' });
  const before = sw.state.rowsCalls.length;
  await settle(400);
  assert.equal(sw.state.rowsCalls.length, before);
});

test('continuous DOM mutation cannot postpone badge rendering beyond the bound', async () => {
  const { env, doc } = open(`/jobs?o=${WSID}`, fixture('jobs.html') + '<span id="clock">0</span>');
  const clock = doc.getElementById('clock');
  let n = 0;
  const timer = setInterval(() => {
    clock.textContent = String(++n);
  }, 15);
  const t0 = Date.now();
  await waitFor(settled(doc, 'row', 4), { timeout: 2500, msg: 'badges under mutation storm' });
  const elapsed = Date.now() - t0;
  clearInterval(timer);
  assert.ok(elapsed < 2500, 'rendered in ' + elapsed + ' ms');
});

test('recycled, replaced, cloned and inserted rows: no duplicate or stale badges', async () => {
  const { env, doc } = open(`/jobs?o=${WSID}`, fixture('jobs.html'));
  await waitFor(settled(doc, 'row', 4));
  // 1) Virtualized recycling: the same anchor element now points to another job.
  const a = doc.querySelector('[data-fx-row="job-1001"] a[href^="/jobs/1001?"]');
  a.setAttribute('href', `/jobs/5555?o=${WSID}`);
  a.textContent = 'recycled_job';
  await waitFor(() => {
    const b = doc.querySelectorAll('[data-fx-row="job-1001"] [data-dcc="inline"]');
    return b.length === 1 && b[0].getAttribute('data-dcc-key') === 'job:5555' && !b[0].classList.contains('dcc-inline--pending');
  }, { msg: 'recycled row re-keyed' });
  // 2) Native re-render replaces the anchor element: old badge removed, one new badge.
  const old = doc.querySelector('[data-fx-row="job-1002"] a[href="/jobs/1002"]');
  const fresh = doc.createElement('a');
  fresh.setAttribute('href', '/jobs/1002');
  fresh.textContent = 'hourly_events';
  old.replaceWith(fresh);
  await waitFor(() => {
    const b = doc.querySelectorAll('[data-fx-row="job-1002"] [data-dcc="inline"]');
    return b.length === 1 && b[0].previousSibling === fresh;
  }, { msg: 'replaced anchor' });
  // 3) A foreign copy of a badge (e.g. cloned by the page) is removed.
  const clone = badges(doc, 'row')[0].cloneNode(true);
  doc.querySelector('[data-fx-row="pipeline-1"] [role="gridcell"]:last-child').appendChild(clone);
  await waitFor(() => !clone.isConnected, { msg: 'clone removed' });
  // 4) Inserted rows get badges; removed rows take theirs away.
  const grid = doc.querySelector('[role="grid"] [role="rowgroup"]:last-child');
  const row = doc.createElement('div');
  row.setAttribute('role', 'row');
  row.innerHTML = `<div role="gridcell"><a href="/jobs/6006?o=${WSID}">new_job</a></div>`;
  grid.appendChild(row);
  doc.querySelector('[data-fx-row="job-777"]').remove();
  const final = await waitFor(settled(doc, 'row', 4), { msg: 'inserted row badged' });
  assert.deepEqual(keysOf(final), ['job:1002', 'job:5555', 'job:6006', 'pipeline:0a1b2c3d-1111-4a2b-8c3d-000000000001']);
  for (const r of doc.querySelectorAll('[role="row"]')) assert.ok(r.querySelectorAll('[data-dcc="inline"]').length <= 1);
});

test('batches ≤ 40 refs, no duplicate requests for in-flight refs', async () => {
  const rows = Array.from({ length: 95 }, (_, i) => `<div role="row"><div role="gridcell"><a href="/jobs/${2000 + i}?o=${WSID}">job_${i}</a></div></div>`).join('');
  const { env, sw, doc } = open(`/jobs?o=${WSID}`, `<h1>Jobs</h1><div role="grid">${rows}</div><span id="tick">0</span>`, { delay: () => 250 });
  // Keep the DOM busy while requests are in flight.
  let n = 0;
  const timer = setInterval(() => {
    doc.getElementById('tick').textContent = String(++n);
  }, 30);
  await waitFor(settled(doc, 'row', 95), { timeout: 4000, msg: '95 badges' });
  clearInterval(timer);
  const sizes = sw.state.rowsCalls.map((m) => m.refs.length);
  assert.ok(sizes.every((s) => s >= 1 && s <= 40), 'batch sizes ' + sizes);
  const keys = sentKeys(sw);
  assert.equal(keys.length, 95, 'each ref requested once');
  assert.equal(new Set(keys).size, 95);
});

test('only rows near the viewport are requested; scrolling requests the rest', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => `<div role="row" data-i="${i}"><div role="gridcell"><a href="/jobs/${3000 + i}?o=${WSID}">job_${i}</a></div></div>`).join('');
  const sw = makeSw();
  const env = track(createContentEnv({ url: `${ORIGIN}/jobs?o=${WSID}`, html: page(`<div role="grid">${rows}</div>`), files: FILES, onMessage: sw.handler }));
  const doc = env.document;
  let offset = 0;
  for (const a of doc.querySelectorAll('[role="row"] a')) {
    const i = Number(a.closest('[role="row"]').dataset.i);
    a.getBoundingClientRect = () => {
      const top = i * 200 - offset; // 20 px rows spaced out; viewport height 768 in jsdom
      return { top, bottom: top + 20, left: 0, right: 120, width: 120, height: 20, x: 0, y: top };
    };
  }
  await waitFor(() => badges(doc, 'row').length > 0 && sw.state.rowsCalls.length > 0);
  await settle(300);
  const first = new Set(sentKeys(sw));
  assert.ok(first.size < 30 && first.has('job:3000') && !first.has('job:3029'), 'only near-viewport rows: ' + first.size);
  offset = 5000;
  doc.dispatchEvent(new env.window.Event('scroll'));
  await waitFor(() => sentKeys(sw).includes('job:3029'), { msg: 'scrolled rows requested' });
});

test('pause removes all badges and stops requests; resume restores them', async () => {
  const { env, sw, doc } = open(`/jobs/1001/runs?o=${WSID}`, fixture('job-runs.html'));
  await waitFor(settled(doc, 'row', 4));
  sw.state.settings.showCosts = false;
  await env.setStorage({ 'dcc.settings': { ...sw.state.settings } });
  await waitFor(() => badges(doc).length === 0, { msg: 'badges removed on pause' });
  const calls = sw.state.rowsCalls.length;
  doc.body.appendChild(doc.createElement('div'));
  await settle(500);
  assert.equal(sw.state.rowsCalls.length, calls, 'no requests while paused');
  assert.equal(badges(doc).length, 0);
  sw.state.settings.showCosts = true;
  await env.setStorage({ 'dcc.settings': { ...sw.state.settings } });
  await waitFor(settled(doc, 'row', 4), { msg: 'badges back after resume' });
});

test('no DOM writes when nothing changed', async () => {
  const { env, doc } = open(`/jobs/1001/runs?o=${WSID}`, fixture('job-runs.html'));
  await waitFor(settled(doc, 'row', 4));
  await waitFor(settled(doc, 'title', 1));
  await settle(300);
  const ours = [];
  const OURS = '[data-dcc="inline"], style[data-dcc="inline-style"]';
  const elOf = (n) => (n.nodeType === 1 ? n : n.parentElement);
  const isOurs = (n) => Boolean(elOf(n) && elOf(n).closest(OURS));
  const holdsOurs = (n) => n.nodeType === 1 && (n.matches(OURS) || Boolean(n.querySelector(OURS)));
  const mo = new env.window.MutationObserver((recs) => {
    for (const r of recs) {
      if (isOurs(r.target) || [...r.addedNodes, ...r.removedNodes].some(holdsOurs)) ours.push(r);
    }
  });
  mo.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  for (let i = 0; i < 5; i++) {
    env.window.__dccTest.scheduler.request();
    doc.body.setAttribute('data-x', String(i)); // unrelated native mutation
    await settle(300);
  }
  mo.disconnect();
  assert.equal(ours.length, 0, 'mutations on our nodes: ' + ours.length);
});

test('demo and import responses keep their own labels; import rows without data stay quiet', async () => {
  {
    const { env, doc } = open(`/jobs/1001/runs?o=${WSID}`, fixture('job-runs.html'), {
      mode: 'demo',
      overrides: { 'job:1001': { attribution: 'demo', label: undefined, amount: 3 } },
    });
    const [t] = await waitFor(settled(doc, 'title', 1));
    assert.equal(t.textContent, 'Job total: $3.00 · 30d DEMO');
    assert.match(t.getAttribute('title'), /Synthetic demo figure/);
  }
  const imported = { attribution: 'import', status: 'unavailable', reason: 'not-imported', amount: null };
  {
    const { env, doc } = open(`/jobs/1001/runs?o=${WSID}`, fixture('job-runs.html'), {
      mode: 'import',
      overrides: Object.fromEntries(['50101', '50102', '50103', '50104'].map((r) => ['job_run:1001:' + r, imported])),
    });
    await waitFor(settled(doc, 'title', 1));
    await settle(300);
    assert.equal(badges(doc, 'row').length, 0, 'runs are not in imported summaries');
  }
});

test('viewFor: labels, small amounts, negatives, errors (unit)', () => {
  const env = { pricingBasis: 'account', currency: 'USD' };
  const ready = (item) => ({ state: 'ready', env, item: { warnings: [], ...item } });
  const run = { type: 'job_run', jobId: '1', runId: '2' };
  let v = inlineMod.viewFor('row', run, ready({ status: 'ok', amount: 0.000412, attribution: 'direct+pipelines', scope: 'execution' }), 30);
  assert.equal(v.text, '$0.000412 est.');
  assert.match(v.tip, /invoice adjustments/i, 'account-price basis note');
  v = inlineMod.viewFor('row', { type: 'warehouse', warehouseId: 'a1b2c3d4e5f60001' }, ready({ status: 'ok', amount: -2, attribution: 'direct' }), 7);
  assert.equal(v.text, '-$2.00 est.');
  assert.match(v.tip, /7 complete UTC days/);
  v = inlineMod.viewFor('row', run, ready({ status: 'unavailable', reason: 'price-unavailable', amount: null }), 30);
  assert.equal(v.text, 'No price');
  v = inlineMod.viewFor('title', { type: 'job', jobId: '1' }, { state: 'error', error: { code: 'BILLING_ACCESS_DENIED', title: 'No permission to read billing system tables', steps: ['Ask an admin.'] } }, 30);
  assert.equal(v.text, 'Job total: unavailable');
  assert.match(v.tip, /No permission/);
  assert.equal(inlineMod.viewFor('row', run, { state: 'error', error: { code: 'NOT_CONNECTED' } }, 30), null);
  assert.equal(inlineMod.viewFor('row', run, null, 30), null);
  assert.equal(inlineMod.viewFor('row', run, { state: 'pending' }, 30).text, '…');
  // Page policies come from the URL only.
  assert.equal(rowRefs.pageContext(`${ORIGIN}/sql/history?o=${WSID}`).policy, 'none');
  assert.equal(rowRefs.pageContext(`${ORIGIN}/jobs/1001/runs`).jobId, '1001');
  assert.equal(rowRefs.pageContext(`${ORIGIN}/jobs/runs`).policy, 'runs_list');
  assert.equal(rowRefs.pageContext(`${ORIGIN}/jobs/1/runs/2`).policy, 'job_run');
});
