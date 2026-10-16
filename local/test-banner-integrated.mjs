// Banner core with EVERY registered content script (registration.CONTENT_JS, all features and the
// Explorer) on each synthetic fixture page, in a SIMULATED jsdom window with a demo-mode
// service-worker stand-in. Guards the cross-feature invariants the core owns: one banner, first
// in main, no observer loops when idle, bounded ticks under mutation storms, single re-mount.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createContentEnv, settle } from './support/content-harness.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../extension');
const { CONTENT_JS } = require('../extension/src/background/registration.js');
const ids = require('../extension/src/core/ids.js');
const demo = require('../extension/src/core/demo-data.js');

const MAIN_FILE = 'src/content/content-main.js';
const BEFORE_MAIN = CONTENT_JS.filter((f) => f !== MAIN_FILE);
const CONTENT_MAIN = readFileSync(path.join(EXT, MAIN_FILE), 'utf8') + '\n//# sourceURL=' + MAIN_FILE;
const WORKSPACE_HTML = readFileSync(path.join(HERE, 'workspace.html'), 'utf8');
const WORKSPACE_JS = readFileSync(path.join(HERE, 'workspace.js'), 'utf8') + '\n//# sourceURL=workspace.js';
const FIXTURE = 'http://127.0.0.1:8765';
const O = '?o=1234567890';
const IDLE_MS = 1300;

// Canonical route for each shared fragment (see each fragment's header comment).
const PAGES = {
  'jobs.html': '/jobs',
  'job-runs.html': '/jobs/1001/runs',
  'pipeline-updates.html': '/pipelines/0a1b2c3d-1111-4a2b-8c3d-000000000001',
  'query-history.html': '/sql/history',
  'warehouses-list.html': '/sql/warehouses',
  'warehouse-size.html': '/sql/warehouses/a1b2c3d4e5f60001/edit',
  'compute-create.html': '/compute/clusters/create',
  'apps.html': '/apps',
  'notebooks.html': '/browse/folders/2001',
};

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

function fragment(name) {
  try {
    return readFileSync(path.join(HERE, 'fixture', name), 'utf8');
  } catch (_) {
    return undefined;
  }
}

/** Demo-mode router stand-in: real demo-data module, refs sanitized and keyed like the router does. */
function demoSw() {
  return async (msg) => {
    switch (msg.type) {
      case 'dcc:hello': {
        const id = new URL(msg.href).searchParams.get('o');
        return { ok: true, data: { origin: FIXTURE, kind: 'fixture', workspaceId: id, idSource: 'param:o', idConflict: false, settings: { mode: 'demo', periodDays: 30, showCosts: true, revision: 1 }, connection: null, connectionMismatch: false } };
      }
      case 'dcc:summary':
        return { ok: true, data: demo.summary(msg.origin, msg.workspaceId, msg.periodDays) };
      case 'dcc:rows': {
        const refs = [];
        for (const r of Array.isArray(msg.refs) ? msg.refs.slice(0, 40) : []) {
          const clean = ids.sanitizeRef(r);
          if (clean) refs.push(Object.assign(clean, { key: ids.refKey(clean) }));
        }
        return { ok: true, data: demo.rowAmounts(refs, msg.periodDays) };
      }
      case 'dcc:query':
        return { ok: true, data: { unavailableInMode: 'demo' } };
      default:
        return { ok: true, data: null };
    }
  };
}

async function bootIntegrated(route) {
  const env = createContentEnv({ url: FIXTURE + route + O, html: WORKSPACE_HTML, files: BEFORE_MAIN, onMessage: demoSw() });
  openEnvs.push(env);
  const w = env.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  w.fetch = async (url) => {
    const m = /^\/fixture\/([a-z0-9-]+\.html)$/.exec(new URL(url, w.location.href).pathname);
    const body = m ? fragment(m[1]) : undefined;
    return { ok: typeof body === 'string', status: body ? 200 : 404, text: async () => body || '' };
  };
  w.eval(WORKSPACE_JS); // defer script: runs before content scripts (document_idle)
  await w.__fixture.ready;
  w.eval(CONTENT_MAIN);
  const host = () => w.document.querySelector('[data-dcc="banner"]');
  return { env, w, doc: w.document, fx: w.__fixture, host, errors, main: () => w.document.querySelector('main'), ticks: () => w.__dccTest.state.ticks };
}

async function waitFor(fn, timeout = 4000) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out: ' + fn.toString());
    await settle(20);
  }
}

/** Ticks stop once the page and features settle: no feature write feeds the observer. */
async function assertIdle(t, label) {
  await settle(900);
  const before = t.ticks();
  await settle(IDLE_MS);
  assert.equal(t.ticks(), before, label + ': ticks kept running on an idle page (observer loop?)');
}

test('all registered content scripts load in order and register their features once', async () => {
  const t = await bootIntegrated('/jobs');
  await waitFor(() => t.host() && /DEMO/.test(t.host().shadowRoot.textContent));
  const names = t.w.__dccTest.features().map((f) => f.name);
  assert.equal(new Set(names).size, names.length, 'feature names unique: ' + names.join(', '));
  assert.ok(t.w.DCC.explorer && typeof t.w.DCC.explorer.mount === 'function', 'Explorer loaded');
  assert.deepEqual(t.errors, []);
});

for (const [file, route] of Object.entries(PAGES)) {
  test('integrated on ' + file + ': one banner first in main, page settles to idle', { skip: fragment(file) === undefined && 'fragment not present' }, async () => {
    const t = await bootIntegrated(route);
    await waitFor(() => t.host() && /DEMO/.test(t.host().shadowRoot.textContent));
    assert.equal(t.main().firstElementChild, t.host());
    await assertIdle(t, file);
    assert.equal(t.doc.querySelectorAll('[data-dcc="banner"]').length, 1);
    assert.equal(t.main().firstElementChild, t.host());
    assert.match(t.host().shadowRoot.textContent, /Estimated costs\. Billing can be delayed; final invoices may differ\./);
    assert.deepEqual(t.errors, []);
  });
}

test('integrated: SPA navigation across every page, main replacement, storm and row recycling keep one banner and stay bounded', async () => {
  const t = await bootIntegrated('/jobs');
  await waitFor(() => t.host() && /DEMO/.test(t.host().shadowRoot.textContent));
  for (const route of Object.values(PAGES)) {
    await t.fx.navigate(route + O);
    await settle(150);
  }
  await t.fx.navigate(PAGES['job-runs.html'] + O);
  await waitFor(() => t.main().firstElementChild === t.host());
  const summaries = () => t.env.messages.filter((m) => m.type === 'dcc:summary').length;
  assert.equal(summaries(), 1, 'navigation within one workspace never reloads the summary');

  t.fx.replaceMain();
  await waitFor(() => t.main().firstElementChild === t.host());
  const ticksBefore = t.ticks();
  const t0 = Date.now();
  t.fx.setStorm(true);
  t.fx.setVirtual(true);
  for (let i = 0; i < 6; i++) {
    t.fx.scrollRows(1);
    await settle(400);
  }
  t.fx.setStorm(false);
  const elapsed = Date.now() - t0;
  const stormTicks = t.ticks() - ticksBefore;
  assert.ok(stormTicks >= 2, 'ticks during storm: ' + stormTicks);
  assert.ok(stormTicks <= Math.ceil(elapsed / 250) + 2, 'ticks bounded by minInterval: ' + stormTicks + ' in ' + elapsed + ' ms');
  t.fx.setVirtual(false);
  await assertIdle(t, 'after storm');
  assert.equal(t.doc.querySelectorAll('[data-dcc="banner"]').length, 1);
  assert.equal(t.main().firstElementChild, t.host());
  assert.deepEqual(t.errors, []);
});

test('integrated: the Explorer mounts inside the banner panel and survives a re-render', async () => {
  const t = await bootIntegrated('/jobs');
  await waitFor(() => t.host() && t.host().shadowRoot.querySelector('[data-k="toggle"]'));
  t.host().shadowRoot.querySelector('[data-k="toggle"]').click();
  const panel = await waitFor(() => t.host().shadowRoot.querySelector('#dcc-panel'));
  await settle(300);
  assert.ok(panel.childNodes.length > 0, 'explorer rendered something');
  t.w.__dccTest.sync(); // unrelated re-render keeps the same mounted panel
  assert.equal(t.host().shadowRoot.querySelector('#dcc-panel'), panel);
  await assertIdle(t, 'explorer open');
  assert.deepEqual(t.errors, []);
});
