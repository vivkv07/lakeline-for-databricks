// Workspace top-bar colors: pure validation, contrast, key resolution, CSS safety, and the
// background 'appearance:applyAccess' handler (with fake chrome APIs; no browser involved).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { load, fakeArea } from './support/load.mjs';

const C = load('content/workspace-color.js');
const theme = load('content/workspace-theme.js');
const storeMod = load('background/store.js');
const routerMod = load('background/router.js');
const handlersMod = load('background/appearance-handlers.js');
const registration = load('background/registration.js');
const errors = load('errors.js');
const ids = load('core/ids.js');

const AWS = 'https://dbc-1.cloud.databricks.com';
const AZURE = 'https://adb-5555.12.azuredatabricks.net';

test('colors: strict #RRGGBB validation rejects shorthand, names and CSS-injection attempts', () => {
  assert.equal(C.normalizeColor('#1d4ed8'), '#1D4ED8');
  assert.equal(C.normalizeColor('#B42318'), '#B42318');
  const bad = [
    '#123', '123456', '#12345', '#1234567', '#12345g', ' #123456', '#123456 ', '#123456\n',
    '#123456;}body{background:red}', '#123456;}body{', '#123456!important', 'red', 'rgb(0,0,0)',
    'url(x)', 'var(--x)', '#12345٠', '', null, undefined, 123456, {}, ['#123456'],
  ];
  for (const v of bad) assert.equal(C.normalizeColor(v), null, JSON.stringify(v));
  // The hex text field only ignores surrounding whitespace; everything else stays strict.
  assert.equal(C.parseHexInput('  #b42318 '), '#B42318');
  assert.equal(C.parseHexInput('b42318'), null);
  assert.equal(C.parseHexInput('#b42318;}'), null);
  assert.equal(C.themeFor('#123456;}body{'), null);
});

test('colors: WCAG luminance and black/white foreground by contrast', () => {
  assert.equal(C.relativeLuminance('#000000'), 0);
  assert.equal(C.relativeLuminance('#FFFFFF'), 1);
  assert.ok(Math.abs(C.relativeLuminance('#808080') - 0.2159) < 1e-3);
  assert.ok(Math.abs(C.contrastRatio('#000000', '#FFFFFF') - 21) < 1e-9);
  assert.ok(Math.abs(C.contrastRatio('#767676', '#FFFFFF') - 4.54) < 0.01);
  assert.equal(C.relativeLuminance('nope'), null);
  assert.equal(C.chooseForeground('#FFFFFF'), '#000000');
  assert.equal(C.chooseForeground('#000000'), '#FFFFFF');
  assert.equal(C.chooseForeground('#F79009'), '#000000');
  assert.equal(C.chooseForeground('#B42318'), '#FFFFFF');
  // Crossover near L ≈ 0.179: #777777 reads better in black, #757575 in white.
  assert.equal(C.chooseForeground('#777777'), '#000000');
  assert.equal(C.chooseForeground('#757575'), '#FFFFFF');
  // Property check: the chosen foreground never loses to the other and always clears 4.5:1.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 2000; i++) {
    const hex = '#' + Math.floor(rnd() * 0x1000000).toString(16).padStart(6, '0').toUpperCase();
    const fg = C.chooseForeground(hex);
    const other = fg === '#000000' ? '#FFFFFF' : '#000000';
    assert.ok(C.contrastRatio(hex, fg) >= C.contrastRatio(hex, other), hex);
    assert.ok(C.contrastRatio(hex, fg) >= 4.5, hex);
  }
  for (const p of C.PRESETS) {
    const t = C.themeFor(p.color);
    assert.ok(t.contrast >= 4.5, p.name);
    assert.equal(C.normalizeColor(p.color), p.color);
  }
});

test('colors: surface and muted tones keep the foreground readable and never echo input text', () => {
  assert.equal(C.mix('#000000', '#FFFFFF', 0.5), '#808080');
  assert.equal(C.mix('#B42318', '#B42318', 0.3), '#B42318');
  assert.equal(C.mix('#1d4ed8', '#000000', 0), '#1D4ED8');
  for (const bad of [['#12345', '#000000', 0.5], ['#000000', 'red', 0.5], ['#000000', '#FFFFFF', 2], ['#000000', '#FFFFFF', NaN]]) assert.equal(C.mix(...bad), null, JSON.stringify(bad));
  // Light bars get a lighter surface, dark bars a darker one; pure white/black step inward.
  const light = C.themeFor('#F79009');
  assert.ok(C.relativeLuminance(light.surface) > C.relativeLuminance(light.bg));
  const dark = C.themeFor('#1D4ED8');
  assert.ok(C.relativeLuminance(dark.surface) < C.relativeLuminance(dark.bg));
  assert.notEqual(C.themeFor('#FFFFFF').surface, '#FFFFFF');
  assert.notEqual(C.themeFor('#000000').surface, '#000000');
  // Property check: text stays at least as readable on the surface as on the bar, and muted text
  // keeps 4.5:1 on the surface.
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 2000; i++) {
    const hex = '#' + Math.floor(rnd() * 0x1000000).toString(16).padStart(6, '0').toUpperCase();
    const t = C.themeFor(hex);
    assert.match(t.surface, /^#[0-9A-F]{6}$/, hex);
    assert.match(t.muted, /^#[0-9A-F]{6}$/, hex);
    assert.ok(C.contrastRatio(t.surface, t.fg) >= 4.5, hex + ' surface');
    assert.ok(C.contrastRatio(t.muted, t.surface) >= 4.5, hex + ' muted');
  }
});

test('colors: CSS is built only from validated values and scoped to the marked containers', () => {
  const css = theme.buildCss(C.themeFor('#1d4ed8'));
  const t = C.themeFor('#1D4ED8');
  // Every rule inside a themed container carries an ID-level lift (an ID no element has), so
  // class-level !important rules of the native design system can't outrank it.
  const BAR = ':is([data-dcc-themed="top"], [data-dcc-themed="side"]):not(#dcc-theme-lift)';
  assert.ok(css.includes(BAR + ' { background-color: #1D4ED8 !important;'));
  for (const sel of css.split('\n').filter((l) => !l.startsWith('/*')).flatMap((r) => r.slice(0, r.lastIndexOf(' {')).split(/,\s(?=:is\(\[data-dcc-themed)/))) {
    assert.ok(sel.startsWith(BAR) || /^\[data-dcc-themed="(shell|card)"\]$/.test(sel), sel);
  }
  assert.match(css, /color: #FFFFFF !important/);
  const rules = css.split('\n').filter((l) => !l.startsWith('/*'));
  for (const r of rules) assert.ok(r.startsWith(BAR) || r.startsWith('[data-dcc-themed="shell"] {') || r.startsWith('[data-dcc-themed="card"] {'), r);
  // The shell and the page card get exactly one kind of change each; nothing reaches inside them.
  assert.equal(rules.find((r) => r.startsWith('[data-dcc-themed="shell"]')), '[data-dcc-themed="shell"] { background-color: #1D4ED8 !important; background-image: none !important; }');
  assert.equal(rules.find((r) => r.startsWith('[data-dcc-themed="card"]')), '[data-dcc-themed="card"] { border-color: #1D4ED8 !important; }');
  // Tones are painted with inset shadows from the derived shades; fields are no longer forced white.
  assert.ok(css.includes('[data-dcc-tone="field"] { box-shadow: inset 0 0 0 100vmax ' + t.surface + ' !important;'));
  // Fields keep a subtle frame (the translucent line over the bar); surfaces drop theirs.
  assert.ok(css.includes('[data-dcc-tone="field"] { box-shadow: inset 0 0 0 100vmax ' + t.surface + ' !important; background-clip: padding-box !important; border-color: rgba(255, 255, 255, 0.28) !important;'));
  assert.match(css, /\[data-dcc-tone="surface"\][^\n]*border-color: transparent !important;/);
  assert.ok(css.includes('[data-dcc-tone="layer"] { box-shadow: inset 0 0 0 100vmax #1D4ED8 !important; }'));
  assert.ok(css.includes('color: ' + t.muted + ' !important'));
  assert.doesNotMatch(css, /#FFFFFF !important; color: #1F2933/);
  // Brand graphics: no fill/stroke rules, SVG, images and kept circles excluded from the color rule.
  assert.doesNotMatch(css, /\bfill\s*:|\bstroke\s*:/);
  assert.ok(css.includes('*:not([role="menu"], [role="listbox"], [role="dialog"], [role="tooltip"], :is([role="menu"], [role="listbox"], [role="dialog"], [role="tooltip"]) *, svg, img, canvas, video, [class*="avatar"], [data-dcc], :is(svg, img, canvas, video, [class*="avatar"], [data-dcc]) *, [data-dcc-tone="keep"], :is([data-dcc-tone="keep"]) *) { color: #FFFFFF'));
  // Every color literal in the stylesheet is a canonical #RRGGBB or one of the fixed overlays
  // (the lift's ID selector is the only other `#`).
  for (const c of css.split(':not(#dcc-theme-lift)').join('').match(/#[0-9A-Za-z]+|rgba?\([^)]*\)/g)) assert.match(c, /^#[0-9A-F]{6}$|^rgba\((0, 0, 0|255, 255, 255), 0\.\d+\)$/, c);
  // Forged theme objects never produce CSS.
  assert.equal(theme.buildCss({ bg: '#123456;}body{background:red', fg: '#FFFFFF' }), null);
  assert.equal(theme.buildCss({ bg: '#1D4ED8', fg: '#000000' }), null); // wrong foreground for this bg
  assert.equal(theme.buildCss({ bg: '#1D4ED8', fg: 'red;}' }), null);
  assert.equal(theme.buildCss({ bg: '#1d4ed8', fg: '#FFFFFF' }), null); // non-canonical
  assert.equal(theme.buildCss({ bg: '#1D4ED8', fg: '#FFFFFF', surface: 'red;}body{' }).includes('red;}'), false); // extra fields ignored
  assert.equal(theme.buildCss(null), null);
  // Light background → black foreground and light-theme constants.
  const light = theme.buildCss(C.themeFor('#F79009'));
  assert.match(light, /color: #000000 !important/);
  assert.match(light, /rgba\(0, 0, 0, 0\.18\)/);
});

test('colors: computed color alpha parsing for the tone scan', () => {
  assert.equal(theme.alphaOf('rgba(66, 153, 224, 0.08)'), 0.08);
  assert.equal(theme.alphaOf('rgb(17, 23, 28)'), 1);
  assert.equal(theme.alphaOf('rgba(0, 0, 0, 0)'), 0);
  assert.equal(theme.alphaOf('rgb(1 2 3 / 50%)'), 0.5);
  for (const v of ['transparent', '', 'red', 'color(srgb 1 0 0)', null, undefined]) assert.equal(theme.alphaOf(v), 0, String(v));
});

test('colors: storage keys are origin|workspaceId or origin|* and reject anything else', () => {
  assert.equal(C.entryKey(AWS, '42'), AWS + '|42');
  assert.equal(C.entryKey(AWS, null), AWS + '|*');
  assert.equal(C.entryKey('http://127.0.0.1:8765', '7'), 'http://127.0.0.1:8765|7');
  for (const [o, id] of [
    ['https://evil.example.com', '1'],
    ['https://accounts.cloud.databricks.com', '1'],
    [AWS + '/', '1'],
    [AWS + '/path', '1'],
    ['http://dbc-1.cloud.databricks.com', '1'],
    [AWS, '0'],
    [AWS, 'abc'],
    [AWS, '42;'],
    [AWS, 42],
  ]) assert.equal(C.entryKey(o, id), null, o + ' ' + id);
  assert.deepEqual(C.parseKey(AWS + '|42'), { origin: AWS, workspaceId: '42' });
  assert.deepEqual(C.parseKey(AWS + '|*'), { origin: AWS, workspaceId: null });
  for (const k of ['https://evil.com|1', 'x|1', AWS + '|01', AWS, '|42', AWS + '|42|1', 42]) assert.equal(C.parseKey(k), null, String(k));
  assert.equal(C.sitePattern(AWS), AWS + '/*');
  assert.equal(C.sitePattern('https://evil.com'), null);
});

test('colors: popup URL input → origin + workspace ID, or host default when the URL has no ID', () => {
  const t = C.targetFromUrl(AWS + '/jobs/123?o=42');
  assert.deepEqual(t, { ok: true, origin: AWS, host: 'dbc-1.cloud.databricks.com', workspaceId: '42', key: AWS + '|42', scope: 'workspace' });
  assert.equal(C.targetFromUrl(AWS + '/#job/1?o=43').workspaceId, '43');
  assert.equal(C.targetFromUrl(AZURE + '/compute').workspaceId, '5555');
  const host = C.targetFromUrl('dbc-1.cloud.databricks.com');
  assert.equal(host.ok, true);
  assert.equal(host.scope, 'host');
  assert.equal(host.key, AWS + '|*');
  assert.equal(C.targetFromUrl('http://127.0.0.1:8765/?o=5').key, 'http://127.0.0.1:8765|5');
  assert.equal(C.targetFromUrl(AWS + '/?o=1&o=2').reason, 'conflict');
  assert.equal(C.targetFromUrl('https://accounts.cloud.databricks.com/').reason, 'account-console');
  assert.equal(C.targetFromUrl('https://example.com/').reason, 'unsupported-host');
  assert.equal(C.targetFromUrl('http://dbc-1.cloud.databricks.com/').reason, 'not-https');
  assert.equal(C.targetFromUrl('').reason, 'empty');
  assert.equal(C.targetFromUrl('javascript:alert(1)').ok, false);
  for (const url of ['', AWS + '/?o=1&o=2', 'https://accounts.cloud.databricks.com', 'https://example.com']) {
    assert.match(C.targetFromUrl(url).message, /\w/, 'plain-language message for ' + url);
  }
});

test('colors: ID override wins, host default applies otherwise, hosts and IDs stay isolated', () => {
  const app = {
    version: 1,
    entries: {
      [AWS + '|42']: { color: '#B42318', savedAt: 1 },
      [AWS + '|*']: { color: '#344054', savedAt: 2 },
      ['https://dbc-2.cloud.databricks.com|42']: { color: '#067647', savedAt: 3 },
    },
  };
  assert.deepEqual(C.resolveColor(app, AWS, '42'), { color: '#B42318', sidebar: false, key: AWS + '|42', scope: 'workspace' });
  assert.deepEqual(C.resolveColor(app, AWS, '43'), { color: '#344054', sidebar: false, key: AWS + '|*', scope: 'host' });
  assert.deepEqual(C.resolveColor(app, AWS, null), { color: '#344054', sidebar: false, key: AWS + '|*', scope: 'host' });
  // Same ID on a different host has its own color; no host default leaks across hosts.
  assert.equal(C.resolveColor(app, 'https://dbc-2.cloud.databricks.com', '42').color, '#067647');
  assert.equal(C.resolveColor(app, 'https://dbc-2.cloud.databricks.com', '43'), null);
  assert.equal(C.resolveColor(app, 'https://dbc-3.cloud.databricks.com', '42'), null);
  // Same host, different IDs without a host default: isolated.
  const noDefault = { version: 1, entries: { [AWS + '|42']: { color: '#B42318' } } };
  assert.equal(C.resolveColor(noDefault, AWS, '43'), null);
  assert.equal(C.resolveColor(noDefault, AWS, '42').color, '#B42318');
  assert.equal(C.resolveColor(noDefault, 'https://evil.example.com', '42'), null);
});

test('colors: page workspace ID comes from the URL, then the saved connection, then the tab context', () => {
  assert.deepEqual(C.pageWorkspaceId({ href: AWS + '/jobs?o=43', connectionWorkspaceId: '42' }), { id: '43', source: 'url' });
  assert.deepEqual(C.pageWorkspaceId({ href: AWS + '/jobs', connectionWorkspaceId: '42', contextWorkspaceId: '44' }), { id: '42', source: 'connection' });
  assert.deepEqual(C.pageWorkspaceId({ href: AWS + '/jobs', contextWorkspaceId: '44' }), { id: '44', source: 'context' });
  assert.deepEqual(C.pageWorkspaceId({ href: AWS + '/jobs?o=1&o=2', connectionWorkspaceId: '42' }), { id: null, source: 'conflict' });
  assert.deepEqual(C.pageWorkspaceId({ href: AWS + '/jobs', connectionWorkspaceId: 'x' }), { id: null, source: null });
  assert.deepEqual(C.pageWorkspaceId({ href: AZURE + '/jobs', connectionWorkspaceId: '42' }), { id: '5555', source: 'url' });
});

test('colors: stored value is sanitized; entries add, remove and report what remains after reset', () => {
  const raw = {
    version: 1,
    entries: {
      [AWS + '|42']: { color: '#b42318', savedAt: 5 },
      [AWS + '|43']: { color: '#123456;}body{', savedAt: 5 },
      [AWS + '|*']: { color: 'red' },
      ['https://evil.example.com|1']: { color: '#000000' },
      [AWS + '|44']: null,
      ['https://dbc-2.cloud.databricks.com|*']: { color: '#067647', savedAt: 'x' },
    },
  };
  assert.deepEqual(C.sanitizeAppearance(raw), {
    version: 1,
    entries: { [AWS + '|42']: { color: '#B42318', savedAt: 5 }, ['https://dbc-2.cloud.databricks.com|*']: { color: '#067647', savedAt: 0 } },
  });
  for (const junk of [null, undefined, 'x', [], { entries: 'x' }, { entries: [] }]) assert.deepEqual(C.sanitizeAppearance(junk), { version: 1, entries: {} });

  let app = C.withEntry(null, AWS + '|*', '#344054', 10);
  app = C.withEntry(app, AWS + '|42', '#b42318', 11);
  assert.deepEqual(app.entries[AWS + '|42'], { color: '#B42318', savedAt: 11 });
  assert.throws(() => C.withEntry(app, AWS + '|42', '#123456;}'));
  assert.throws(() => C.withEntry(app, 'https://evil.com|1', '#123456'));

  assert.deepEqual(C.resetOutcome(app, AWS + '|42'), { removed: true, hostDefault: '#344054', overridesLeft: 0 });
  assert.deepEqual(C.resetOutcome(app, AWS + '|*'), { removed: true, hostDefault: null, overridesLeft: 1 });
  assert.deepEqual(C.resetOutcome(app, AWS + '|99'), { removed: false, hostDefault: '#344054', overridesLeft: 0 });
  const after = C.withoutEntry(app, AWS + '|42');
  assert.equal(after.entries[AWS + '|42'], undefined);
  assert.equal(C.resolveColor(after, AWS, '42').scope, 'host');
});

test('colors: the sidebar option is stored only when on and travels with the entry that supplies the color', () => {
  const raw = {
    version: 1,
    entries: {
      [AWS + '|42']: { color: '#B42318', savedAt: 1, sidebar: true },
      [AWS + '|43']: { color: '#067647', savedAt: 1, sidebar: 'yes' },
      [AWS + '|*']: { color: '#344054', savedAt: 1, sidebar: true },
    },
  };
  const clean = C.sanitizeAppearance(raw);
  assert.deepEqual(clean.entries[AWS + '|42'], { color: '#B42318', savedAt: 1, sidebar: true });
  assert.deepEqual(clean.entries[AWS + '|43'], { color: '#067647', savedAt: 1 }, 'only strict true is kept');
  assert.equal(C.resolveColor(raw, AWS, '42').sidebar, true);
  assert.equal(C.resolveColor(raw, AWS, '43').sidebar, false, 'the ID entry supplies the color, so its own choice applies');
  assert.deepEqual(C.resolveColor(raw, AWS, '44'), { color: '#344054', sidebar: true, key: AWS + '|*', scope: 'host' });

  let app = C.withEntry(null, AWS + '|42', '#1D4ED8', 5, { sidebar: true });
  assert.deepEqual(app.entries[AWS + '|42'], { color: '#1D4ED8', savedAt: 5, sidebar: true });
  app = C.withEntry(app, AWS + '|42', '#1D4ED8', 6, { sidebar: false });
  assert.deepEqual(app.entries[AWS + '|42'], { color: '#1D4ED8', savedAt: 6 });
  app = C.withEntry(app, AWS + '|42', '#1D4ED8', 7, { sidebar: 1 });
  assert.equal('sidebar' in app.entries[AWS + '|42'], false);
});

test('colors: billing store never reads or writes dcc.appearance', async () => {
  assert.ok(!Object.values(storeMod.KEYS).includes(C.STORAGE_KEY));
  const appearance = { version: 1, entries: { [AWS + '|42']: { color: '#B42318', savedAt: 1 } } };
  const area = fakeArea({ [C.STORAGE_KEY]: appearance });
  const store = storeMod.create(area);
  await store.migrate();
  assert.equal((await store.saveConnection({ origin: AWS, workspaceId: '42', authMode: 'pat' })).ok, true);
  await store.updateSettings({ showCosts: false, mode: 'demo' });
  await store.removeConnection(AWS);
  await store.recordObserved(AWS, '43');
  assert.deepEqual(area.data[C.STORAGE_KEY], appearance);
});

/* ------------------------------------------------------------------ background handler */

function fakeChrome({ granted = [], tabs = [] } = {}) {
  const calls = { register: [], update: [], unregister: [], execute: [], contains: [] };
  let registered = [];
  const covers = (pattern) =>
    granted.some((g) => g === pattern || (g.startsWith('https://*.') && pattern.startsWith('https://') && pattern.slice(8).split('/')[0].endsWith(g.slice(9).split('/')[0])));
  return {
    calls,
    api: {
      permissions: {
        async getAll() {
          return { origins: granted.slice() };
        },
        async contains({ origins }) {
          calls.contains.push(origins.slice());
          return origins.every(covers);
        },
      },
      scripting: {
        async getRegisteredContentScripts() {
          return registered.slice();
        },
        async registerContentScripts(defs) {
          calls.register.push(defs);
          registered = defs.map((d) => ({ id: d.id }));
        },
        async updateContentScripts(defs) {
          calls.update.push(defs);
        },
        async unregisterContentScripts(o) {
          calls.unregister.push(o);
          registered = [];
        },
        async executeScript(o) {
          calls.execute.push(o);
        },
      },
      tabs: {
        async query({ url }) {
          const prefix = url.replace(/\*$/, '');
          return tabs.filter((t) => t.url.startsWith(prefix));
        },
      },
    },
  };
}

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const POPUP = { id: EXT_ID, url: 'chrome-extension://' + EXT_ID + '/ui/popup.html' };

function routerWith(chromeApi) {
  return routerMod.create({
    extensionId: EXT_ID,
    extensionOrigin: 'chrome-extension://' + EXT_ID,
    store: { recordDiagnostic: async () => {}, getConnection: async () => null },
    extra: handlersMod.createHandlers({ chromeApi }),
  });
}

test('applyAccess: granted origin → registers content scripts and injects into open tabs of that origin only', async () => {
  const fc = fakeChrome({
    granted: [AWS + '/*'],
    tabs: [
      { id: 1, url: AWS + '/jobs?o=42' },
      { id: 2, url: AWS + '/?o=42' },
      { id: 3, url: 'https://dbc-2.cloud.databricks.com/?o=9' },
    ],
  });
  const res = await routerWith(fc.api).dispatch({ type: 'appearance:applyAccess', origin: AWS }, POPUP);
  assert.deepEqual(res, { ok: true, data: { origin: AWS, granted: true, registered: true, injected: 2 } });
  assert.deepEqual(fc.calls.contains, [[AWS + '/*']]);
  assert.equal(fc.calls.register.length, 1);
  assert.deepEqual(fc.calls.register[0][0].matches, [AWS + '/*']);
  assert.deepEqual(fc.calls.execute.map((e) => e.target.tabId), [1, 2]);
  assert.deepEqual(fc.calls.execute[0].files, registration.CONTENT_JS.slice());
});

test('applyAccess: survives a concurrent sync from permissions.onAdded (duplicate registration)', async () => {
  const fc = fakeChrome({ granted: [AWS + '/*'], tabs: [{ id: 1, url: AWS + '/?o=42' }] });
  let first = true;
  const register = fc.api.scripting.registerContentScripts;
  fc.api.scripting.registerContentScripts = async (defs) => {
    if (first) {
      first = false;
      await register(defs); // the other sync won the race…
      throw new Error("Duplicate script ID 'dcc-main'"); // …so ours is rejected
    }
    return register(defs);
  };
  const res = await routerWith(fc.api).dispatch({ type: 'appearance:applyAccess', origin: AWS }, POPUP);
  assert.deepEqual(res, { ok: true, data: { origin: AWS, granted: true, registered: true, injected: 1 } });
  assert.equal(fc.calls.update.length, 1, 'second pass updates the existing registration');
});

test('applyAccess: wildcard grant counts; no grant → no registration or injection', async () => {
  const wild = fakeChrome({ granted: ['https://*.cloud.databricks.com/*'], tabs: [{ id: 1, url: AWS + '/' }] });
  const ok = await routerWith(wild.api).dispatch({ type: 'appearance:applyAccess', origin: AWS }, POPUP);
  assert.equal(ok.data.granted, true);
  assert.equal(ok.data.injected, 1);

  const none = fakeChrome({ granted: [], tabs: [{ id: 1, url: AWS + '/' }] });
  const res = await routerWith(none.api).dispatch({ type: 'appearance:applyAccess', origin: AWS }, POPUP);
  assert.deepEqual(res, { ok: true, data: { origin: AWS, granted: false, registered: false, injected: 0 } });
  assert.equal(none.calls.register.length + none.calls.update.length + none.calls.execute.length, 0);
});

test('applyAccess: rejects invalid origins and non-page senders', async () => {
  const fc = fakeChrome({ granted: [AWS + '/*'], tabs: [{ id: 1, url: AWS + '/' }] });
  const r = routerWith(fc.api);
  for (const origin of ['https://evil.example.com', 'https://accounts.cloud.databricks.com', AWS + '/', AWS + '/*', 'https://*.cloud.databricks.com', '', null, 42]) {
    const res = await r.dispatch({ type: 'appearance:applyAccess', origin }, POPUP);
    assert.equal(res.ok, false, String(origin));
  }
  // A content script (or any non-extension page) can't trigger registration or injection.
  const content = { id: EXT_ID, url: AWS + '/?o=42', tab: { id: 1 }, frameId: 0 };
  assert.equal((await r.dispatch({ type: 'appearance:applyAccess', origin: AWS, workspaceId: '42' }, content)).ok, false);
  const otherExt = { id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', url: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/ui/popup.html' };
  assert.equal((await r.dispatch({ type: 'appearance:applyAccess', origin: AWS }, otherExt)).ok, false);
  assert.equal(fc.calls.execute.length, 0);
});

test('applyAccess: as a classic script it registers through DCC.handlerFactories', () => {
  const sandbox = { DCC: { errors, ids, registration } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(new URL('../extension/src/background/appearance-handlers.js', import.meta.url), 'utf8'), sandbox);
  assert.equal(sandbox.DCC.handlerFactories.length, 1);
  const made = sandbox.DCC.handlerFactories[0]({ chromeApi: fakeChrome().api });
  assert.deepEqual(Object.keys(made), ['appearance:applyAccess']);
  assert.equal(made['appearance:applyAccess'].trust, 'page');
});
