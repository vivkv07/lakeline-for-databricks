// Workspace colors in the content script (top bar, optional sidebar and shell). SIMULATED: jsdom
// with a fake `chrome` (content-harness.mjs) and the synthetic fixture fragment
// local/fixture/topbar.html. jsdom has no layout, so the tone scan runs without geometry here.
// This is not proof of behavior against the live Databricks DOM.
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
const entry = (color, extra) => ({ color, savedAt: 1, ...extra });
const BAR = ':is([data-dcc-themed="top"], [data-dcc-themed="side"]):not(#dcc-theme-lift)';

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

test('with the content bootstrap: only the native top nav is marked; sidebar, header and banner are not (simulated)', async () => {
  const env = start({ storage: appearance({ [ORIGIN + '|42']: entry('#B42318') }) });
  await settle(150);
  assert.equal(styles(env).length, 1);
  assert.equal(styles(env)[0].parentNode, env.document.head);
  assert.deepEqual(marked(env), [nav(env)]);
  assert.equal(nav(env).getAttribute('data-dcc-themed'), 'top');
  const text = styles(env)[0].textContent;
  assert.match(text, /background-color: #B42318 !important/);
  assert.match(text, /color: #FFFFFF !important/);
  for (const rule of text.split('\n').filter((l) => !l.startsWith('/*'))) assert.ok(rule.startsWith(BAR) || /^\[data-dcc-themed="(shell|card)"\] \{/.test(rule), rule);
  // Tones only inside the themed bar; the sidebar option is off, so the side nav is untouched.
  const toned = [...env.document.querySelectorAll('[data-dcc-tone]')];
  assert.ok(toned.length > 0);
  for (const el of toned) assert.ok(nav(env).contains(el), el.className);
  assert.equal(env.document.querySelector('nav[aria-label="Side Navigation"]').hasAttribute('data-dcc-themed'), false);
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

/** Drives the feature directly against the fixture with its native-like styles in <head>. */
function direct(entries, body = FIXTURE_BODY, style = FIXTURE_STYLE) {
  const env = createContentEnv({ url: ORIGIN + '/jobs?o=42', html: page(body, style), files: FEATURE_FILES, storage: appearance(entries) });
  const feature = env.window.DCC.features.find((f) => f.name === 'workspace-theme');
  const ctx = { doc: env.document, origin: ORIGIN, workspaceId: '42', connection: null, settings: { showCosts: true } };
  feature.onStart(ctx);
  return Object.assign(env, { feature, ctx });
}
const tones = (env) => [...env.document.querySelectorAll('[data-dcc-tone]')].map((el) => [el.getAttribute('data-dcc-tone'), el.className.split(' ')[0]]);

test('tone scan: the search box is a field, the pill a surface, the account circle is kept (simulated)', async () => {
  const env = direct({ [ORIGIN + '|42']: entry('#B42318') });
  await settle(30);
  assert.deepEqual(tones(env), [
    ['field', 'fx-field'],
    ['surface', 'fx-pill'],
    ['keep', 'fx-initials'],
  ]);
  // The combobox around the field and the empty results listbox are left alone.
  assert.equal(env.document.querySelector('[role="combobox"]').hasAttribute('data-dcc-tone'), false);
  assert.equal(env.document.querySelector('[role="listbox"]').hasAttribute('data-dcc-tone'), false);
  env.close();
});

test('computed cascade: bar tinted, search blends as a darker shade, others untouched (simulated)', async () => {
  const badge = '<span data-dcc="badge" style="color: rgb(1, 2, 3)">$1.00</span>';
  const env = direct({ [ORIGIN + '|42']: entry('#B42318') }, FIXTURE_BODY.replace('</nav>', badge + '</nav>'));
  await settle(30);
  const t = env.window.DCC.workspaceColor.themeFor('#B42318');
  const q = (sel) => env.document.querySelector(sel);
  const rgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
  assert.deepEqual(marked(env), [nav(env)]);
  assert.equal(css(env, nav(env)).backgroundColor, 'rgb(180, 35, 24)');
  assert.equal(css(env, nav(env)).color, 'rgb(255, 255, 255)');
  assert.equal(css(env, q('[aria-label="Help"]')).color, 'rgb(255, 255, 255)');
  assert.equal(css(env, q('.fx-switcher')).color, 'rgb(255, 255, 255)');
  assert.equal(css(env, q('.fx-wordmark')).color, 'rgb(255, 255, 255)');
  // Ancestors before descendants: jsdom mis-caches an ancestor's !important declarations when a
  // descendant's inherited property is computed first.
  const field = css(env, q('.fx-field'));
  assert.equal(field.boxShadow.toUpperCase(), ('inset 0 0 0 100vmax ' + t.surface).toUpperCase());
  assert.equal(field.borderTopColor, 'rgba(255, 255, 255, 0.28)', 'a subtle frame: the translucent line');
  assert.equal(field.backgroundClip, 'padding-box');
  assert.equal(field.color, rgb(t.muted));
  const input = q('nav input');
  assert.equal(css(env, input).backgroundColor, 'rgba(0, 0, 0, 0)', 'no white box inside the field');
  assert.equal(css(env, input).color, 'rgb(255, 255, 255)', 'typed text in the foreground');
  assert.equal(css(env, q('.fx-kbd')).color, rgb(t.muted), 'shortcut hint in the soft tone');
  assert.equal(css(env, q('.fx-pill')).boxShadow.toUpperCase(), ('inset 0 0 0 100vmax ' + t.surface).toUpperCase());
  assert.equal(css(env, q('.fx-pill')).color, 'rgb(255, 255, 255)');
  // Extension elements inside the bar keep their own colors.
  assert.equal(css(env, q('[data-dcc="badge"]')).color, 'rgb(1, 2, 3)');
  // Other headers are not tinted.
  assert.equal(css(env, q('.fx-page-header')).backgroundColor, 'rgb(247, 247, 247)');
  env.close();
});

test('computed cascade, light tint: black foreground, lighter search; the account circle keeps its colors (simulated)', async () => {
  const env = direct({ [ORIGIN + '|42']: entry('#F79009') });
  await settle(30);
  const q = (sel) => env.document.querySelector(sel);
  assert.equal(css(env, nav(env)).backgroundColor, 'rgb(247, 144, 9)');
  assert.equal(css(env, q('.fx-switcher')).color, 'rgb(0, 0, 0)');
  assert.equal(css(env, q('[aria-label="Help"]')).color, 'rgb(0, 0, 0)');
  assert.equal(css(env, q('.fx-field')).boxShadow.toUpperCase(), 'INSET 0 0 0 100VMAX #FABF70');
  assert.equal(css(env, q('.fx-initials')).backgroundColor, 'rgb(166, 99, 12)');
  assert.equal(css(env, q('.fx-initials')).color, 'rgb(255, 255, 255)');
  assert.equal(css(env, q('.fx-initials abbr')).color, 'rgb(255, 255, 255)');
  env.close();
});

test('sidebar option: side nav, shell and page card follow the color; the page itself does not (simulated)', async () => {
  const env = direct({ [ORIGIN + '|42']: entry('#1D4ED8', { sidebar: true }) });
  await settle(30);
  const q = (sel) => env.document.querySelector(sel);
  const side = q('nav[aria-label="Side Navigation"]');
  assert.deepEqual(
    marked(env).map((el) => [el.getAttribute('data-dcc-themed'), el.className]),
    [['top', 'fx-topnav'], ['shell', 'fx-shell'], ['side', 'fx-sidenav'], ['card', 'fx-card']]
  );
  // The New button and the selected item become surface shades; plain links stay on the tint.
  assert.equal(q('[data-testid="NewDropdown"]').getAttribute('data-dcc-tone'), 'surface');
  assert.equal(q('[data-fx="side-home"]').getAttribute('data-dcc-tone'), 'surface');
  assert.equal(q('[data-fx="side-jobs"]').hasAttribute('data-dcc-tone'), false);
  assert.equal(css(env, q('.fx-shell')).backgroundColor, 'rgb(29, 78, 216)');
  assert.equal(css(env, side).backgroundColor, 'rgb(29, 78, 216)');
  assert.equal(css(env, side).color, 'rgb(255, 255, 255)');
  assert.equal(css(env, q('.fx-side-section')).color, 'rgb(255, 255, 255)');
  assert.equal(css(env, q('[data-fx="side-jobs"]')).color, 'rgb(255, 255, 255)');
  assert.equal(css(env, q('.fx-card')).borderTopColor, 'rgb(29, 78, 216)');
  assert.equal(css(env, q('.fx-card')).backgroundColor, 'rgb(255, 255, 255)', 'the page card keeps its own background');
  assert.equal(css(env, q('.fx-page-header')).backgroundColor, 'rgb(247, 247, 247)');
  assert.notEqual(css(env, q('.fx-page-header h1')).color, 'rgb(255, 255, 255)', 'page text never follows the bar foreground');

  // Turning the option off returns the sidebar, shell and card to native, tones included.
  await env.setStorage(appearance({ [ORIGIN + '|42']: entry('#1D4ED8') }));
  env.feature.onAppearance(env.ctx); // what the content bootstrap does on a storage change
  await settle(50);
  assert.deepEqual(marked(env), [nav(env)]);
  assert.equal(side.querySelectorAll('[data-dcc-tone]').length, 0);
  assert.equal(css(env, q('.fx-shell')).backgroundColor, 'rgb(246, 247, 249)');
  env.close();
});

test('sidebar option without an opaque page card: the shell keeps its native color (simulated)', async () => {
  const body = FIXTURE_BODY.replace('class="fx-card"', 'class="fx-card" style="background: transparent"');
  const env = direct({ [ORIGIN + '|42']: entry('#1D4ED8', { sidebar: true }) }, body);
  await settle(30);
  assert.deepEqual(marked(env).map((el) => el.getAttribute('data-dcc-themed')), ['top', 'side']);
  env.close();
});

test('a host default with the sidebar option applies to workspaces without their own color (simulated)', async () => {
  const env = direct({ [ORIGIN + '|*']: entry('#067647', { sidebar: true }), [ORIGIN + '|43']: entry('#B42318') });
  await settle(30);
  assert.deepEqual(marked(env).map((el) => el.getAttribute('data-dcc-themed')), ['top', 'shell', 'side', 'card']);
  env.close();
});

/* Dark top bar (local/fixture/topbar-dark.html): the structure captured on a real workspace, with
 * the search inside a 0x0 dark-token wrapper. jsdom resolves the cascade by order, not
 * specificity, and has no layout or ::placeholder styles; local/browser/test-colors-dark-topbar.mjs
 * checks the real cascade, geometry and pixels. */
const DARK = readFileSync(new URL('./fixture/topbar-dark.html', import.meta.url), 'utf8');
const DARK_STYLE = /<style data-fixture="topbar-dark">[\s\S]*?<\/style>/.exec(DARK)[0];
const DARK_BODY = DARK.replace(DARK_STYLE, '');
const DARK_COLORS = ['#194AD2', '#F5D90A', '#1B1F2A', '#D92D20', '#12B76A']; // vivid, light, near-black, red, green
const rgbOf = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;

test('dark top bar: the affix wrapper is the field, found through the 0x0 dark-token wrapper; only the initials circle is kept (simulated)', async () => {
  const env = direct({ [ORIGIN + '|42']: entry('#194AD2') }, DARK_BODY, DARK_STYLE);
  await settle(30);
  const q = (sel) => env.document.querySelector(sel);
  assert.deepEqual(marked(env), [nav(env)]);
  assert.deepEqual(tones(env), [
    ['field', 'du-bois-dark-input-affix-wrapper'],
    ['keep', 'fxd-initials'],
  ]);
  for (const sel of ['[data-testid="ds-override-tokens-wrapper"]', 'form', '[role="combobox"]', 'input', '[data-fx="verify"]', '[data-fx="switcher"]']) {
    assert.equal(q(sel).hasAttribute('data-dcc-tone'), false, sel);
  }
  env.close();
});

test('dark top bar, five colors: the field is a shade of the bar in a subtle frame, no input box, readable text; the circle is untouched (simulated)', async () => {
  for (const color of DARK_COLORS) {
    const env = direct({ [ORIGIN + '|42']: entry(color) }, DARK_BODY, DARK_STYLE);
    await settle(30);
    const C = env.window.DCC.workspaceColor;
    const t = C.themeFor(color);
    const q = (sel) => env.document.querySelector(sel);
    assert.equal(css(env, nav(env)).backgroundColor, rgbOf(color), color);
    // Ancestors before descendants (jsdom computed-style cache).
    const wrap = css(env, q('.du-bois-dark-input-affix-wrapper'));
    assert.equal(wrap.boxShadow.toUpperCase(), ('inset 0 0 0 100vmax ' + t.surface).toUpperCase(), color + ' field paint');
    assert.equal(wrap.backgroundClip, 'padding-box', color);
    assert.equal(wrap.borderTopColor, t.fg === '#FFFFFF' ? 'rgba(255, 255, 255, 0.28)' : 'rgba(0, 0, 0, 0.18)', color + ' frame');
    assert.equal(wrap.color, rgbOf(t.muted), color);
    const input = css(env, q('input'));
    assert.equal(input.backgroundColor, 'rgba(0, 0, 0, 0)', color + ' no input box');
    assert.equal(input.color, rgbOf(t.fg), color + ' typed text');
    assert.equal(css(env, q('.fxd-kbd')).color, rgbOf(t.muted), color + ' hint');
    assert.ok(styles(env)[0].textContent.includes('::placeholder { color: ' + t.muted + ' !important; opacity: 1 !important; }'), color + ' placeholder rule');
    // The shade: not the native near-black, not black or white, apart from the bar; text AA on it.
    assert.ok(!['#11171C', '#000000', '#FFFFFF'].includes(t.surface), color + ' ' + t.surface);
    assert.ok(C.contrastRatio(t.surface, color) >= 1.1, color);
    assert.ok(C.contrastRatio(t.fg, t.surface) >= 4.5, color);
    assert.ok(C.contrastRatio(t.muted, t.surface) >= 4.5, color);
    const circle = css(env, q('.fxd-initials'));
    assert.equal(circle.backgroundColor, 'rgb(127, 86, 217)', color);
    assert.doesNotMatch(circle.boxShadow, /inset/, color);
    assert.equal(circle.color, 'rgb(255, 255, 255)', color);
    env.close();
  }
});

test('dark top bar: removing the color restores every native computed style (simulated)', async () => {
  const env = direct({}, DARK_BODY, DARK_STYLE);
  await settle(30);
  const props = ['backgroundColor', 'backgroundClip', 'color', 'caretColor', 'boxShadow', 'borderTopColor'];
  const snap = () => [nav(env), ...nav(env).querySelectorAll('*')].map((el) => el.tagName + ' ' + props.map((p) => css(env, el)[p]).join(' | '));
  const native = snap();
  assert.equal(css(env, env.document.querySelector('.du-bois-dark-input-affix-wrapper')).backgroundColor, 'rgb(17, 23, 28)');
  await env.setStorage(appearance({ [ORIGIN + '|42']: entry('#194AD2') }));
  env.feature.onAppearance(env.ctx);
  await settle(50);
  assert.equal(css(env, nav(env)).backgroundColor, 'rgb(25, 74, 210)');
  assert.notDeepEqual(snap(), native);
  await env.setStorage(appearance({}));
  env.feature.onAppearance(env.ctx);
  await settle(50);
  assert.equal(env.document.querySelectorAll('style[data-dcc="theme"], [data-dcc-themed], [data-dcc-tone]').length, 0);
  assert.deepEqual(snap(), native);
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

test('sidebar on: a re-rendered side nav is toned once and steady ticks write nothing (simulated)', async () => {
  const env = start({ storage: appearance({ [ORIGIN + '|42']: entry('#6941C6', { sidebar: true }) }) });
  await settle(150);
  const sideNav = () => env.document.querySelector('nav[aria-label="Side Navigation"]');
  assert.deepEqual(marked(env).map((el) => el.getAttribute('data-dcc-themed')), ['top', 'shell', 'side', 'card']);
  const records = [];
  const mo = new env.window.MutationObserver((list) => records.push(...list));
  mo.observe(env.document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

  // The SPA re-renders the sidebar without our attributes.
  const fresh = sideNav().cloneNode(true);
  fresh.removeAttribute('data-dcc-themed');
  for (const el of fresh.querySelectorAll('[data-dcc-tone]')) el.removeAttribute('data-dcc-tone');
  sideNav().replaceWith(fresh);
  await settle(600);
  assert.equal(fresh.getAttribute('data-dcc-themed'), 'side');
  assert.deepEqual([...fresh.querySelectorAll('[data-dcc-tone]')].map((el) => el.getAttribute('data-dcc-tone')), ['surface', 'surface']);
  const toneWrites = records.filter((r) => r.type === 'attributes' && r.attributeName === 'data-dcc-tone');
  assert.equal(toneWrites.length, 2, 'each tone written once');

  records.length = 0;
  env.window.__dccTest.scheduler.request();
  env.document.body.appendChild(env.document.createElement('span'));
  await settle(700);
  assert.deepEqual(records.filter((r) => r.type === 'attributes'), []);
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
  assert.equal(css(env, nav(env)).backgroundColor, 'rgb(246, 247, 249)');
  assert.equal(env.document.querySelectorAll('[data-dcc-tone]').length, 0, 'tones removed too');
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
