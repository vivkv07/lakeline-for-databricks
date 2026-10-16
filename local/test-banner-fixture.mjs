// Synthetic fixture SPA (local/workspace.html + workspace.js) in a SIMULATED jsdom window with a
// stubbed fetch, plus the banner running inside it. Real-browser checks belong to the browser tests.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createContentEnv, BASE_CONTENT_FILES, settle } from './support/content-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../extension');
const WORKSPACE_HTML = readFileSync(path.join(HERE, 'workspace.html'), 'utf8');
const WORKSPACE_JS = readFileSync(path.join(HERE, 'workspace.js'), 'utf8') + '\n//# sourceURL=workspace.js';
const CONTENT_MAIN = readFileSync(path.join(EXT, 'src/content/content-main.js'), 'utf8') + '\n//# sourceURL=content-main.js';
const SHELL_HOME = readFileSync(path.join(HERE, 'fixture/shell-home.html'), 'utf8');
const FIXTURE = 'http://127.0.0.1:8765';
const O = '?o=1234567890';
const PIPELINE = '7d1f0b4e-2c3a-4b5d-9e6f-0a1b2c3d4e5f';

const run = (id, launcher) =>
  `<tr><td>Oct 14, 2026</td><td><a href="/jobs/101/runs/${id}${O}">Run ${id}</a></td><td><a href="/jobs/202/runs/${launcher}${O}">Nightly launcher</a></td></tr>`;
const JOB_RUNS = `<h1>Job 101</h1>
<table role="grid"><thead><tr><th>Start</th><th>Run</th><th>Launched by</th></tr></thead>
<tbody>${run(5001, 7001)}${run(5002, 7002)}${run(5003, 7003)}</tbody></table>
<a id="external" href="https://example.com/docs">External docs</a>
<script>window.__fragmentScriptRan = true;</script>`;
const UPDATES = `<h1>Pipeline</h1><div role="grid">
<div role="row"><span role="columnheader">Update</span></div>
<div role="row"><a href="/pipelines/${PIPELINE}/updates/0a0b0c0d-1e1f-4a2b-8c3d-4e5f6a7b0001${O}">Update 0001</a></div>
<div role="row"><a href="/pipelines/${PIPELINE}/updates/0a0b0c0d-1e1f-4a2b-8c3d-4e5f6a7b0002${O}">Update 0002</a></div></div>`;
const TOPBAR = `<style data-fixture="topbar">.fx-topnav { height: 48px; }</style>
<nav aria-label="Top Navigation" class="fx-topnav"><svg viewBox="0 0 20 20"><path fill="#E8590C" d="M0 0h20v20H0z"/></svg><input type="search" aria-label="Search"></nav>
<main data-testid="main-content"><p>topbar demo body (ignored)</p></main>`;

// Objects from the jsdom realm have foreign prototypes; compare their JSON shape.
const plain = (v) => JSON.parse(JSON.stringify(v));

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

function swStub() {
  return async (msg) => {
    if (msg.type === 'dcc:hello') {
      const id = new URL(msg.href).searchParams.get('o');
      return { ok: true, data: { origin: FIXTURE, workspaceId: id, idSource: 'param:o', idConflict: false, settings: { mode: 'demo', periodDays: 30, showCosts: true, revision: 1 }, connection: null, connectionMismatch: false } };
    }
    if (msg.type === 'dcc:summary') {
      return {
        ok: true,
        data: { kind: 'summary', synthetic: true, pricingBasis: 'demo', currency: 'USD', period: { days: 30, start: '2026-09-15', endExclusive: '2026-10-15' }, current: { coverage: 'complete', total: 321.5 }, previous: { coverage: 'complete', total: 300 }, currentAmount: 321.5, previousAmount: 300, daily: [], freeQuantity: {}, latestUsageMs: Date.now() - 3600e3 },
      };
    }
    return { ok: true, data: null };
  };
}

/** Boot the fixture page; workspace.js runs first (defer), content scripts after (document_idle). */
async function bootFixture({ at = '/' + O, fragments = { 'shell-home.html': SHELL_HOME }, withContent = false } = {}) {
  const env = createContentEnv({ url: FIXTURE + at, html: WORKSPACE_HTML, files: withContent ? BASE_CONTENT_FILES : [], onMessage: swStub() });
  openEnvs.push(env);
  const w = env.window;
  const fetched = [];
  w.fetch = async (url) => {
    const u = new URL(url, w.location.href);
    fetched.push(u.pathname);
    const m = /^\/fixture\/([a-z0-9-]+\.html)$/.exec(u.pathname);
    const body = m ? fragments[m[1]] : undefined;
    return { ok: typeof body === 'string', status: typeof body === 'string' ? 200 : 404, text: async () => (typeof body === 'string' ? body : 'Not found') };
  };
  const rendered = [];
  w.document.addEventListener('fixture:rendered', (e) => rendered.push(e.detail));
  w.eval(WORKSPACE_JS);
  if (withContent) w.eval(CONTENT_MAIN);
  await w.__fixture.ready;
  const fx = w.__fixture;
  return { env, w, doc: w.document, fx, fetched, rendered, main: () => w.document.querySelector('main') };
}

async function waitFor(fn, timeout = 3000) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out: ' + fn.toString());
    await settle(10);
  }
}

test('boots a clearly labeled synthetic shell: top nav, side nav, toolbar outside main, home fragment', async () => {
  const f = await bootFixture();
  const nav = f.doc.querySelector('nav[aria-label="Top Navigation"]');
  assert.ok(nav);
  assert.ok(nav.querySelector('svg path[fill]'), 'logo SVG with its own fill');
  assert.ok(nav.querySelector('input[type="search"]'));
  assert.ok(nav.querySelectorAll('button').length >= 2);
  const bar = f.doc.querySelector('[data-fixture-toolbar]');
  assert.match(bar.textContent, /SYNTHETIC FIXTURE/);
  assert.match(bar.textContent, /Not Databricks/);
  assert.equal(bar.closest('main'), null);
  assert.equal(f.doc.querySelectorAll('main').length, 1);
  assert.equal(f.fx.info().route, 'home');
  assert.match(f.main().textContent, /Synthetic workspace/);
  assert.equal(f.fx.WORKSPACE_ID, '1234567890');
  for (const a of f.doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    assert.ok(href.startsWith('/'), 'root-relative: ' + href);
    assert.match(href, /[?&]o=1234567890/, 'workspace 1234567890 everywhere: ' + href);
  }
  assert.ok(f.doc.querySelector('link[href="/workspace.css"]') && f.doc.querySelector('script[src="/workspace.js"]'));
  assert.deepEqual(f.fetched.sort(), ['/fixture/shell-home.html', '/fixture/topbar.html']);
});

test('routes deep links and pushState navigation to fragments; missing fragments render a friendly placeholder', async () => {
  const f = await bootFixture({ at: '/jobs/101/runs' + O, fragments: { 'job-runs.html': JOB_RUNS } });
  assert.equal(f.fx.info().route, 'job-runs');
  assert.ok(f.main().querySelector('[data-fx-page="job-runs"] table[role="grid"]'));
  assert.equal(f.main().querySelector('script'), null, 'fragment scripts are dropped');
  assert.equal(f.w.__fragmentScriptRan, undefined);
  await f.fx.navigate('/sql/history' + O);
  assert.equal(f.w.location.pathname, '/sql/history');
  const ph = f.main().querySelector('[data-fx-placeholder="query-history.html"]');
  assert.ok(ph, 'placeholder for a missing fragment');
  assert.match(ph.textContent, /local\/fixture\/query-history\.html/);
  assert.deepEqual(plain(f.rendered.at(-1)), { route: 'query-history', fragment: 'query-history.html', missing: true });
  const expect = {
    '/jobs': 'jobs',
    '/jobs/101': 'job-runs',
    '/jobs/101/runs': 'job-runs',
    '/jobs/101/runs/5001': 'job-run',
    ['/pipelines/' + PIPELINE]: 'pipeline-updates',
    ['/pipelines/' + PIPELINE + '/updates/0a0b0c0d-1e1f-4a2b-8c3d-4e5f6a7b0001']: 'pipeline-updates',
    '/sql/history': 'query-history',
    '/sql/warehouses/0123456789abcdef': 'warehouse-size',
    '/sql/warehouses': 'warehouses',
    '/sql/warehouses/a1b2c3d4e5f60001/edit': 'warehouse-size',
    '/compute/create': 'compute-create',
    '/compute/clusters/create': 'compute-create',
    '/browse/folders/2001': 'notebooks',
    '/apps': 'apps',
    '/apps/cost-report-app': 'apps',
    '/workspace': 'notebooks',
    '/editor/notebooks/2001': 'notebooks',
    '/no/such/page': 'unknown',
    ['/' + O + '#job/101/run/5001']: 'legacy-job-run',
  };
  for (const [p, name] of Object.entries(expect)) {
    await f.fx.navigate(p.includes('?') ? p : p + O);
    assert.equal(f.fx.info().route, name, p);
    assert.equal(f.doc.querySelectorAll('main').length, 1);
  }
  assert.ok(f.main().querySelector('[data-fx-page="legacy-job-run"] table'), 'legacy hash route renders the job-runs fragment');
  assert.match(f.doc.title, /Job run \(legacy route\)/);
});

test('a fragment with its own <main> or top nav is unwrapped into the shell', async () => {
  const f = await bootFixture({ at: '/apps' + O, fragments: { 'apps.html': '<nav aria-label="Top Navigation">dup</nav><main data-testid="main-content"><h1>Apps</h1></main>' } });
  assert.equal(f.doc.querySelectorAll('main').length, 1);
  assert.equal(f.doc.querySelectorAll('nav[aria-label="Top Navigation"]').length, 1);
  assert.equal(f.main().querySelector('h1').textContent, 'Apps');
});

test('same-origin link clicks navigate in place; modified clicks and external links are left alone', async () => {
  const f = await bootFixture({ fragments: { 'shell-home.html': SHELL_HOME, 'job-runs.html': JOB_RUNS } });
  const w = f.w;
  f.doc.querySelector('[data-fx-nav="job-runs"]').click();
  await waitFor(() => f.fx.info().route === 'job-runs' && f.main().querySelector('table'));
  assert.equal(w.location.pathname + w.location.search, '/jobs/101/runs' + O);
  assert.equal(f.doc.querySelector('[data-fx-nav="job-runs"]').getAttribute('aria-current'), 'page');
  const ext = f.doc.getElementById('external');
  const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  ext.addEventListener('click', (e) => e.preventDefault()); // keep jsdom from attempting navigation
  const meta = new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
  let seenDefault = null;
  w.addEventListener('click', (e) => (seenDefault = e.defaultPrevented), { once: true });
  f.doc.querySelector('[data-fx-nav="jobs"]').addEventListener('click', (e) => e.preventDefault(), { once: true });
  f.doc.querySelector('[data-fx-nav="jobs"]').dispatchEvent(meta);
  assert.equal(f.fx.info().route, 'job-runs', 'modified click not intercepted');
  ext.dispatchEvent(ev);
  assert.equal(f.fx.info().route, 'job-runs', 'external link not intercepted');
  assert.notEqual(seenDefault, null);
  w.history.back();
  await waitFor(() => f.fx.info().route === 'home');
});

test('Replace main swaps in a brand-new <main> with fresh content and no extension nodes', async () => {
  const f = await bootFixture({ at: '/jobs/101/runs' + O, fragments: { 'job-runs.html': JOB_RUNS } });
  const old = f.main();
  const ours = f.doc.createElement('div');
  ours.setAttribute('data-dcc', 'banner');
  old.prepend(ours);
  old.setAttribute('data-dcc-mark', '1');
  f.doc.querySelector('[data-fx-action="replace-main"]').click();
  const fresh = f.main();
  assert.notEqual(fresh, old);
  assert.equal(old.isConnected, false);
  assert.equal(fresh.getAttribute('data-testid'), 'main-content');
  assert.equal(fresh.className, old.className);
  assert.equal(fresh.hasAttribute('data-dcc-mark'), false);
  assert.equal(fresh.querySelector('[data-dcc]'), null);
  assert.ok(fresh.querySelector('[data-fx-page="job-runs"] table'));
  assert.equal(f.fx.info().mainReplacements, 1);
  assert.match(f.doc.querySelector('[data-fx-status]').textContent, /main replaced 1×/);
});

test('the mutation storm updates a clock inside main every 50 ms, survives main replacement and stops cleanly', async () => {
  const f = await bootFixture();
  const records = [];
  new f.w.MutationObserver((rs) => records.push(...rs)).observe(f.doc.body, { childList: true, subtree: true });
  f.doc.querySelector('[data-fx-action="storm"]').click();
  assert.equal(f.doc.querySelector('[data-fx-action="storm"]').getAttribute('aria-pressed'), 'true');
  await settle(400);
  const node = f.main().querySelector(':scope > [data-fx-storm]');
  assert.ok(node && /Synthetic clock/.test(node.textContent));
  assert.ok(f.fx.info().storm >= 4, 'ticks: ' + f.fx.info().storm);
  assert.ok(records.length >= 4);
  f.fx.replaceMain();
  await settle(150);
  assert.ok(f.main().querySelector(':scope > [data-fx-storm]'), 'the storm follows the new main');
  f.fx.setStorm(false);
  assert.equal(f.main().querySelector('[data-fx-storm]'), null);
  await settle(20);
  const n = records.length;
  await settle(250);
  assert.equal(records.length, n, 'no mutations after stopping');
});

test('virtual rows reuse row elements in place with new IDs; extension nodes inside rows are left for the extension to clean', async () => {
  const f = await bootFixture({ at: '/jobs/101/runs' + O, fragments: { 'job-runs.html': JOB_RUNS } });
  const rows = [...f.main().querySelectorAll('tbody tr')];
  assert.equal(rows.length, 3);
  const badge = f.doc.createElement('span');
  badge.setAttribute('data-dcc', 'badge');
  badge.textContent = '$1.23';
  rows[0].cells[1].appendChild(badge);
  rows[0].setAttribute('data-dcc-row', 'k');
  assert.equal(f.fx.setVirtual(true), true);
  assert.deepEqual(plain(f.fx.info().virtual), { offset: 0, total: 18, rows: 3 });
  assert.equal(f.fx.scrollRows(3), true);
  const now = [...f.main().querySelectorAll('tbody tr')];
  assert.ok(now.every((r, i) => r === rows[i]), 'same row elements');
  const link = rows[0].querySelector('a');
  assert.equal(link.getAttribute('href'), '/jobs/101/runs/105001' + O);
  assert.equal(link.textContent, 'Run 105001');
  assert.equal(rows[0].querySelectorAll('a')[1].getAttribute('href'), '/jobs/202/runs/107001' + O);
  assert.equal(rows[0].getAttribute('data-fx-virtual-index'), '3');
  assert.ok(badge.isConnected && rows[0].contains(badge), 'stale extension badge stays until removed');
  assert.equal(rows[0].getAttribute('data-dcc-row'), 'k');
  f.fx.scrollRows(-3);
  assert.equal(rows[0].querySelector('a').getAttribute('href'), '/jobs/101/runs/5001' + O);
  assert.equal(f.fx.scrollRows(-1), false, 'top of the list');
  for (let i = 0; i < 10; i++) f.fx.scrollRows(3);
  assert.equal(f.fx.info().virtual.offset, 15, 'clamped at the end');
  const table = f.main().querySelector('table');
  table.dispatchEvent(new f.w.WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
  assert.equal(f.fx.info().virtual.offset, 14, 'wheel recycles rows');
  // Grid rows with UUID identities: only the row's own (last) ID changes.
  await f.fx.navigate('/pipelines/' + PIPELINE + O);
  assert.equal(f.fx.info().virtual.rows, 0, 'no table on a placeholder page');
  f.fx.setVirtual(false);
  const g = await bootFixture({ at: '/pipelines/' + PIPELINE + O, fragments: { 'pipeline-updates.html': UPDATES } });
  g.fx.setVirtual(true);
  g.fx.scrollRows(2);
  const href = g.main().querySelector('[role="row"] a').getAttribute('href');
  assert.match(href, new RegExp('^/pipelines/' + PIPELINE + '/updates/0a0b0c0d-1e1f-4a2b-8c3d-4e5f6a7b0102\\?o=1234567890$'));
});

test('the shared topbar fragment replaces the built-in nav; Replace top nav yields a fresh unmarked element', async () => {
  const f = await bootFixture({ fragments: { 'shell-home.html': SHELL_HOME, 'topbar.html': TOPBAR } });
  const nav = f.doc.querySelector('nav[aria-label="Top Navigation"]');
  assert.ok(nav.classList.contains('fx-topnav'));
  assert.equal(f.doc.querySelectorAll('style[data-fixture="topbar"]').length, 1);
  assert.doesNotMatch(f.main().textContent, /topbar demo body/);
  nav.setAttribute('data-dcc-themed', '');
  f.doc.querySelector('[data-fx-action="replace-nav"]').click();
  const fresh = f.doc.querySelector('nav[aria-label="Top Navigation"]');
  assert.notEqual(fresh, nav);
  assert.equal(nav.isConnected, false);
  assert.ok(fresh.classList.contains('fx-topnav'));
  assert.equal(fresh.hasAttribute('data-dcc-themed'), false);
  assert.equal(f.doc.querySelectorAll('nav[aria-label="Top Navigation"]').length, 1);
});

test('the real fixture fragments on disk (when present) render without the placeholder', async () => {
  const names = ['jobs', 'job-runs', 'pipeline-updates', 'query-history', 'warehouses-list', 'warehouse-size', 'compute-create', 'apps', 'notebooks'];
  const fragments = { 'shell-home.html': SHELL_HOME };
  for (const n of names) {
    const file = path.join(HERE, 'fixture', n + '.html');
    if (existsSync(file)) fragments[n + '.html'] = readFileSync(file, 'utf8');
  }
  const f = await bootFixture({ fragments });
  // The canonical routes each shared fragment was written for (see its header comment).
  const routes = { jobs: '/jobs', 'job-runs': '/jobs/101/runs', 'pipeline-updates': '/pipelines/0a1b2c3d-1111-4a2b-8c3d-000000000001', 'query-history': '/sql/history', 'warehouses-list': '/sql/warehouses', 'warehouse-size': '/sql/warehouses/a1b2c3d4e5f60001/edit', 'compute-create': '/compute/clusters/create', apps: '/apps', notebooks: '/browse/folders/2001' };
  for (const n of names) {
    await f.fx.navigate(routes[n] + O);
    const present = Boolean(fragments[n + '.html']);
    assert.equal(Boolean(f.main().querySelector('[data-fx-placeholder]')), !present, n);
    assert.equal(f.doc.querySelectorAll('main').length, 1, n);
    assert.equal(f.main().querySelector('script'), null, n);
  }
});

test('banner inside the fixture: mounts first in main and stays single through navigation, main replacement, storms and recycling', async () => {
  const f = await bootFixture({ at: '/jobs' + O, fragments: { 'jobs.html': '<h1>Jobs</h1><table><tbody><tr><td><a href="/jobs/101' + O + '">Job 101</a></td></tr></tbody></table>', 'job-runs.html': JOB_RUNS }, withContent: true });
  const host = () => f.doc.querySelector('[data-dcc="banner"]');
  await waitFor(() => host() && /\$321\.50/.test(host().shadowRoot.textContent));
  assert.equal(f.main().firstElementChild, host());
  assert.match(host().shadowRoot.textContent, /DEMO/);
  const hellos = () => f.env.messages.filter((m) => m.type === 'dcc:hello').length;
  const summaries = () => f.env.messages.filter((m) => m.type === 'dcc:summary').length;
  f.doc.querySelector('[data-fx-nav="job-runs"]').click();
  await waitFor(() => f.fx.info().route === 'job-runs' && hellos() === 2);
  await settle(300);
  assert.equal(f.main().firstElementChild, host());
  assert.equal(summaries(), 1, 'same workspace: no reload on navigation');
  f.fx.replaceMain();
  await waitFor(() => f.main().firstElementChild === host());
  f.fx.setStorm(true);
  f.fx.setVirtual(true);
  for (let i = 0; i < 4; i++) {
    f.fx.scrollRows(1);
    await settle(250);
  }
  f.fx.setStorm(false);
  await settle(300);
  assert.equal(f.doc.querySelectorAll('[data-dcc="banner"]').length, 1);
  assert.equal(f.main().firstElementChild, host());
  assert.equal(summaries(), 1);
  assert.equal(f.w.__dccTest.state.workspaceId, '1234567890');
});
