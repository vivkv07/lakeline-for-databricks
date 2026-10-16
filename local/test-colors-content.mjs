// Workspace top-bar colors in the content script. SIMULATED: jsdom with a fake `chrome`
// (content-harness.mjs) and the synthetic fixture fragment local/fixture/topbar.html. This is
// not proof of behavior against the live Databricks DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContentEnv, BASE_CONTENT_FILES, settle } from './support/content-harness.mjs';

const ORIGIN = 'https://dbc-1.cloud.databricks.com';
const KEY = 'dcc.appearance';
const FILES = [...BASE_CONTENT_FILES, 'src/content/workspace-color.js', 'src/content/workspace-theme.js', 'src/content/content-main.js'];
const FIXTURE = readFileSync(new URL('./fixture/topbar.html', import.meta.url), 'utf8');
const page = (body = FIXTURE, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
// Two jsdom limitations affect computed-style checks (Chrome behaves correctly in both cases):
// a later `background` shorthand beats an earlier `background-color: … !important`, and the
// computed-style cache can go stale (banner shadow DOM re-renders; ancestors read through a
// descendant's inherited property). So the cascade test drives the feature directly (no banner),
// puts the fixture's native-like stylesheet in <head>, and reads ancestors first.
const FIXTURE_STYLE = /<style data-fixture="topbar">[\s\S]*?<\/style>/.exec(FIXTURE)[0];
const FIXTURE_BODY = FIXTURE.replace(FIXTURE_STYLE, '');
const FEATURE_FILES = ['src/core/validate.js', 'src/core/ids.js', 'src/content/dom.js', 'src/content/native-adapter.js', 'src/content/workspace-color.js', 'src/content/workspace-theme.js'];
const appearance = (entries) => ({ [KEY]: { version: 1, entries } });
const entry = (color) => ({ color, savedAt: 1 });

const summary = {
  kind: 'summary', pricingBasis: 'list', priceTable: 'system.billing.list_prices', currency: 'USD',
  period: { days: 30, start: '2026-09-15', endExclusive: '2026-10-15', prevStart: '2026-08-16', prevEndExclusive: '2026-09-15' },
  current: { coverage: 'complete', total: 10 }, previous: { coverage: 'complete', total: 8 },
  currentAmount: 10, previousAmount: 8, daily: [], freeQuantity: {}, latestUsageMs: Date.now() - 3600e3,
};

/** Service-worker stand-in. `sw.settings` / `sw.connection` can be changed between calls. */
function makeSw({ showCosts = true, mode = 'connected', connection = { workspaceId: '42' }, helloId } = {}) {
  const sw = {
    settings: { mode, periodDays: 30, showCosts, revision: 1 },
    connection,
    handle(msg) {
      if (msg.type === 'dcc:hello') {
        const urlId = new URL(msg.href).searchParams.get('o');
        const id = urlId || (helloId !== undefined ? helloId : sw.connection && sw.connection.workspaceId) || null;
        return { ok: true, data: { origin: ORIGIN, kind: 'workspace', workspaceId: id, idSource: urlId ? 'param:o' : 'saved-connection', idConflict: false, settings: sw.settings, connection: sw.connection, connectionMismatch: false } };
      }
      if (msg.type === 'dcc:summary') {
        if (!sw.settings.showCosts) return { ok: true, data: { paused: true } };
        if (!sw.connection) return { ok: false, error: { code: 'NOT_CONNECTED', title: 'Not connected', steps: [] } };
        return { ok: true, data: summary };
      }
      return { ok: true, data: null };
    },
  };
  return sw;
}

function start({ url = ORIGIN + '/jobs?o=42', html = page(), storage = {}, sw = makeSw() } = {}) {
  const env = createContentEnv({ url, html, files: FILES, onMessage: (m) => sw.handle(m), storage });
  return Object.assign(env, { sw });
}

const styles = (env) => env.document.querySelectorAll('style[data-dcc="theme"]');
const marked = (env) => [...env.document.querySelectorAll('[data-dcc-themed]')];
const nav = (env) => env.document.querySelector('nav[aria-label="Top Navigation"]');
const css = (env, el) => env.window.getComputedStyle(el);

test('with the content bootstrap: only the native top nav is marked; header and banner are not (simulated)', async () => {
  const env = start({ storage: appearance({ [ORIGIN + '|42']: entry('#B42318') }) });
  await settle(150);
  assert.equal(styles(env).length, 1);
  assert.equal(styles(env)[0].parentNode, env.document.head);
  assert.deepEqual(marked(env), [nav(env)]);
  const text = styles(env)[0].textContent;
  assert.match(text, /background-color: #B42318 !important/);
  assert.match(text, /color: #FFFFFF !important/);
  for (const rule of text.split('\n').filter((l) => !l.startsWith('/*'))) assert.ok(rule.startsWith('[data-dcc-themed]'), rule);
  assert.equal(env.document.querySelector('.fx-page-header').hasAttribute('data-dcc-themed'), false);
  const banner = env.document.querySelector('[data-dcc="banner"]');
  assert.ok(banner, 'banner mounted');
  assert.equal(banner.hasAttribute('data-dcc-themed'), false);
  assert.equal(banner.closest('[data-dcc-themed]'), null, 'banner is outside the themed bar');
  // Brand graphic keeps its explicit fills; the stylesheet never sets fill or stroke.
  const brand = env.document.querySelector('[data-fx="brand-graphic"]');
  assert.deepEqual([...brand.querySelectorAll('path')].map((p) => p.getAttribute('fill')), ['#E8590C', '#1F2933']);
  assert.doesNotMatch(text, /\bfill\s*:|\bstroke\s*:/);
  env.close();
});

test('computed cascade: bar tinted, controls follow the foreground, search stays light, others untouched (simulated)', async () => {
  const badge = '<span data-dcc="badge" style="color: rgb(1, 2, 3)">$1.00</span>';
  const body = FIXTURE_BODY.replace('</nav>', badge + '</nav>');
  const env = createContentEnv({ url: ORIGIN + '/jobs?o=42', html: page(body, FIXTURE_STYLE), files: FEATURE_FILES, storage: appearance({ [ORIGIN + '|42']: entry('#B42318') }) });
  const feature = env.window.DCC.features.find((f) => f.name === 'workspace-theme');
  feature.onStart({ doc: env.document, origin: ORIGIN, workspaceId: '42', connection: null, settings: { showCosts: true } });
  await settle(30);
  assert.deepEqual(marked(env), [nav(env)]);
  const q = (sel) => env.document.querySelector(sel);
  assert.equal(css(env, nav(env)).backgroundColor, 'rgb(180, 35, 24)');
  assert.equal(css(env, nav(env)).color, 'rgb(255, 255, 255)');
  assert.equal(css(env, q('[aria-label="Help"]')).color, 'rgb(255, 255, 255)');
  assert.equal(css(env, q('.fx-switcher')).color, 'rgb(255, 255, 255)');
  assert.equal(css(env, q('.fx-wordmark')).color, 'rgb(255, 255, 255)');
  // Ancestors before descendants: jsdom mis-caches an ancestor's !important declarations when a
  // descendant's inherited property is computed first.
  assert.equal(css(env, q('.fx-field')).backgroundColor, 'rgb(255, 255, 255)');
  const input = q('nav input[type="search"]');
  assert.equal(css(env, input).backgroundColor, 'rgb(255, 255, 255)');
  assert.equal(css(env, input).color, 'rgb(31, 41, 51)');
  assert.equal(css(env, q('.fx-kbd')).color, 'rgb(31, 41, 51)');
  // Extension elements inside the bar keep their own colors.
  assert.equal(css(env, q('[data-dcc="badge"]')).color, 'rgb(1, 2, 3)');
  // Other headers are not tinted.
  assert.equal(css(env, q('.fx-page-header')).backgroundColor, 'rgb(247, 247, 247)');

  env.close();
});

test('computed cascade, light tint: black foreground; the avatar keeps its own colors (simulated)', async () => {
  const env = createContentEnv({ url: ORIGIN + '/jobs?o=42', html: page(FIXTURE_BODY, FIXTURE_STYLE), files: FEATURE_FILES, storage: appearance({ [ORIGIN + '|42']: entry('#F79009') }) });
  const feature = env.window.DCC.features.find((f) => f.name === 'workspace-theme');
  feature.onStart({ doc: env.document, origin: ORIGIN, workspaceId: '42', connection: null, settings: { showCosts: true } });
  await settle(30);
  const q = (sel) => env.document.querySelector(sel);
  assert.equal(css(env, nav(env)).backgroundColor, 'rgb(247, 144, 9)');
  assert.equal(css(env, q('.fx-switcher')).color, 'rgb(0, 0, 0)');
  assert.equal(css(env, q('[aria-label="Help"]')).color, 'rgb(0, 0, 0)');
  assert.equal(css(env, q('.fx-avatar')).backgroundColor, 'rgb(34, 114, 180)');
  assert.equal(css(env, q('.fx-avatar')).color, 'rgb(255, 255, 255)');
  env.close();
});

test('nav replacement re-marks the new bar once; no duplicate style and no write loop (simulated)', async () => {
  const env = start({ storage: appearance({ [ORIGIN + '|42']: entry('#1D4ED8') }) });
  await settle(150);
  const style = styles(env)[0];
  assert.ok(style);
  const records = [];
  const mo = new env.window.MutationObserver((list) => records.push(...list));
  mo.observe(env.document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

  // The SPA swaps in a fresh top bar.
  const fresh = nav(env).cloneNode(true);
  fresh.removeAttribute('data-dcc-themed');
  nav(env).replaceWith(fresh);
  await settle(600);
  const themedWrites = records.filter((r) => r.type === 'attributes' && r.attributeName === 'data-dcc-themed');
  assert.equal(themedWrites.length, 1, 'marked exactly once');
  assert.equal(themedWrites[0].target, fresh);
  assert.deepEqual(marked(env), [fresh]);
  assert.equal(styles(env).length, 1);
  assert.equal(styles(env)[0], style, 'same style element, not re-created');
  assert.equal(records.filter((r) => r.target === style || [...r.addedNodes, ...r.removedNodes].includes(style)).length, 0, 'style text untouched');

  // Steady state: further ticks write nothing.
  records.length = 0;
  env.window.__dccTest.scheduler.request();
  env.document.body.appendChild(env.document.createElement('span')); // unrelated page mutation
  await settle(700);
  assert.deepEqual(records.filter((r) => r.type === 'attributes' || r.target === style), []);
  mo.disconnect();
  env.close();
});

test('a hidden old bar is unmarked when a new visible bar appears (simulated)', async () => {
  const env = start({ storage: appearance({ [ORIGIN + '|42']: entry('#067647') }) });
  await settle(150);
  const old = nav(env);
  assert.deepEqual(marked(env), [old]);
  const fresh = old.cloneNode(true);
  fresh.removeAttribute('data-dcc-themed');
  old.style.display = 'none';
  old.after(fresh);
  await settle(500);
  assert.deepEqual(marked(env), [fresh]);
  env.close();
});

test('leftover duplicate theme styles (e.g. from an orphaned instance) collapse to one (simulated)', async () => {
  const stale = '<style data-dcc="theme">[data-dcc-themed]{background:#000}</style><style data-dcc="theme">x{}</style>';
  const env = start({ html: page(FIXTURE, stale), storage: appearance({ [ORIGIN + '|42']: entry('#6941C6') }) });
  await settle(150);
  assert.equal(styles(env).length, 1);
  assert.match(styles(env)[0].textContent, /#6941C6/);
  env.close();
});

test('storage changes apply, recolor and reset without duplicates (simulated)', async () => {
  const env = start();
  await settle(150);
  assert.equal(styles(env).length, 0);
  assert.deepEqual(marked(env), []);

  await env.setStorage(appearance({ [ORIGIN + '|42']: entry('#067647') }));
  await settle(50);
  assert.equal(styles(env).length, 1);
  assert.deepEqual(marked(env), [nav(env)]);
  assert.match(styles(env)[0].textContent, /#067647/);

  await env.setStorage(appearance({ [ORIGIN + '|42']: entry('#F79009') }));
  await settle(50);
  assert.equal(styles(env).length, 1);
  assert.match(styles(env)[0].textContent, /background-color: #F79009 !important; background-image: none !important; color: #000000/);

  // Reset: the override is removed; nothing is left behind.
  await env.setStorage(appearance({}));
  await settle(50);
  assert.equal(styles(env).length, 0);
  assert.deepEqual(marked(env), []);
  assert.equal(css(env, nav(env)).backgroundColor, 'rgb(255, 255, 255)');
  env.close();
});

test('invalid stored colors never reach the page; a valid host default still applies (simulated)', async () => {
  const env = start({
    storage: appearance({ [ORIGIN + '|42']: entry('#123456;}body{background:red'), [ORIGIN + '|*']: entry('red') }),
  });
  await settle(150);
  assert.equal(styles(env).length, 0);
  assert.deepEqual(marked(env), []);
  await env.setStorage(appearance({ [ORIGIN + '|42']: entry('#123456;}body{background:red'), [ORIGIN + '|*']: entry('#344054') }));
  await settle(50);
  const text = styles(env)[0].textContent;
  assert.match(text, /#344054/);
  assert.doesNotMatch(text, /body\s*\{|#123456/);
  env.close();
});

test('colors stay active while cost display is paused and in demo mode (simulated)', async () => {
  const sw = makeSw({ showCosts: false, mode: 'demo' });
  const env = start({ sw, storage: appearance({ [ORIGIN + '|42']: entry('#B42318') }) });
  await settle(150);
  assert.match(env.document.querySelector('[data-dcc="banner"]').shadowRoot.textContent, /Cost display paused/);
  assert.deepEqual(marked(env), [nav(env)]);
  // Resume and pause again through settings changes: the color never flickers off.
  sw.settings = { mode: 'connected', periodDays: 30, showCosts: true, revision: 2 };
  await env.setStorage({ 'dcc.settings': sw.settings });
  await settle(80);
  assert.deepEqual(marked(env), [nav(env)]);
  sw.settings = { mode: 'connected', periodDays: 30, showCosts: false, revision: 3 };
  await env.setStorage({ 'dcc.settings': sw.settings });
  await settle(80);
  assert.deepEqual(marked(env), [nav(env)]);
  assert.equal(styles(env).length, 1);
  env.close();
});

test('no billing connection needed: colors apply with no connection and send no extra messages (simulated)', async () => {
  const env = start({ sw: makeSw({ connection: null }), storage: appearance({ [ORIGIN + '|42']: entry('#344054') }) });
  await settle(150);
  assert.deepEqual(marked(env), [nav(env)]);
  assert.match(styles(env)[0].textContent, /#344054/);
  assert.deepEqual([...new Set(env.messages.map((m) => m.type))].sort(), ['dcc:hello', 'dcc:summary']);
  env.close();
});

test('URL without an ID uses the saved connection ID; otherwise the host default (simulated)', async () => {
  const entries = { [ORIGIN + '|42']: entry('#6941C6'), [ORIGIN + '|*']: entry('#344054') };
  const withConn = start({ url: ORIGIN + '/jobs', storage: appearance(entries) });
  await settle(150);
  assert.match(styles(withConn)[0].textContent, /#6941C6/);
  withConn.close();

  const noConn = start({ url: ORIGIN + '/jobs', sw: makeSw({ connection: null, helloId: null }), storage: appearance(entries) });
  await settle(150);
  assert.match(styles(noConn)[0].textContent, /#344054/);
  noConn.close();
});

test('same host, different workspace IDs stay isolated across SPA navigation (simulated)', async () => {
  const env = start({ url: ORIGIN + '/jobs?o=43', sw: makeSw({ connection: null }), storage: appearance({ [ORIGIN + '|42']: entry('#B42318') }) });
  await settle(150);
  assert.equal(styles(env).length, 0);
  env.navigate(ORIGIN + '/jobs?o=42');
  env.document.body.appendChild(env.document.createElement('div'));
  await settle(500);
  assert.equal(styles(env).length, 1);
  assert.deepEqual(marked(env), [nav(env)]);
  env.navigate(ORIGIN + '/jobs?o=43');
  env.document.body.appendChild(env.document.createElement('div'));
  await settle(500);
  assert.equal(styles(env).length, 0);
  assert.deepEqual(marked(env), []);
  env.close();
});

test('supported top-bar test ID is used when there is no Top Navigation nav (simulated)', async () => {
  const html = page('<div data-testid="top-bar"><span>Workspace</span><input aria-label="Search"></div><header class="other">Other header</header><main><h1>Home</h1></main>');
  const env = start({ html, storage: appearance({ [ORIGIN + '|*']: entry('#1D4ED8') }) });
  await settle(150);
  assert.deepEqual(marked(env), [env.document.querySelector('[data-testid="top-bar"]')]);
  assert.equal(env.document.querySelector('header.other').hasAttribute('data-dcc-themed'), false);
  env.close();
});

test('refresh/restart: a fresh page load re-applies from storage (simulated)', async () => {
  const storage = appearance({ [ORIGIN + '|42']: entry('#B42318') });
  const first = start({ storage });
  await settle(150);
  assert.equal(styles(first).length, 1);
  first.close();
  const again = start({ storage });
  await settle(150);
  assert.equal(styles(again).length, 1);
  assert.deepEqual(marked(again), [nav(again)]);
  again.close();
});

test('re-running the content files in the same page registers the feature once (simulated)', async () => {
  const env = start({ storage: appearance({ [ORIGIN + '|42']: entry('#B42318') }) });
  await settle(150);
  const before = env.window.DCC.features.filter((f) => f.name === 'workspace-theme').length;
  env.window.eval(readFileSync(new URL('../extension/src/content/workspace-theme.js', import.meta.url), 'utf8'));
  assert.equal(before, 1);
  assert.equal(env.window.DCC.features.filter((f) => f.name === 'workspace-theme').length, 1);
  env.close();
});
