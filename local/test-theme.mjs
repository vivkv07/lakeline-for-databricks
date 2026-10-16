// Theme tokens and in-page light/dark selection. pickForElement runs in jsdom (SIMULATED: its
// getComputedStyle resolves background colors but does no layout or painting).
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { load } from './support/load.mjs';

const theme = load('core/theme.js');
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension');

const KEYS = ['bg', 'surface', 'surface2', 'line', 'line2', 'text', 'body', 'muted', 'faint', 'accent', 'accentSoft', 'accentLine', 'accentFill', 'accentText', 'warm', 'warmSoft', 'warmLine', 'pillBg', 'pillText', 'panel', 'panelText', 'panelSub', 'panelEyebrow', 'danger', 'success'];

function contrast(a, b) {
  const [hi, lo] = [theme.luminance(a), theme.luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('token maps carry the exact style values in both themes', () => {
  assert.deepEqual(Object.keys(theme.LIGHT), KEYS);
  assert.deepEqual(Object.keys(theme.DARK), KEYS);
  assert.equal(theme.LIGHT.bg, '#FFFFFF');
  assert.equal(theme.DARK.bg, '#000000');
  assert.equal(theme.LIGHT.accent, '#2F5BEA');
  assert.equal(theme.DARK.accent, '#5B8CFF');
  assert.equal(theme.LIGHT.warm, '#B45309');
  assert.equal(theme.DARK.warm, '#F5B83D');
  assert.equal(theme.LIGHT.panel, theme.DARK.panel);
  for (const t of [theme.LIGHT, theme.DARK]) for (const v of Object.values(t)) assert.match(v, /^#[0-9A-F]{6}$/);
  assert.ok(Object.isFrozen(theme.LIGHT) && Object.isFrozen(theme.DARK));
  assert.equal(theme.tokens('dark'), theme.DARK);
  assert.equal(theme.tokens('light'), theme.LIGHT);
  assert.equal(theme.tokens('anything else'), theme.LIGHT);
});

test('text and accent tokens meet WCAG AA on their own surfaces', () => {
  for (const t of [theme.LIGHT, theme.DARK]) {
    for (const k of ['text', 'body', 'muted', 'accent', 'warm', 'danger', 'success']) assert.ok(contrast(t[k], t.bg) >= 4.5, k + ' on bg ' + contrast(t[k], t.bg).toFixed(2));
    for (const k of ['text', 'body', 'accentText']) assert.ok(contrast(t[k], t.surface2) >= 4.5, k + ' on surface2');
    assert.ok(contrast(t.accentText, t.accentSoft) >= 4.5, 'accentText on accentSoft');
    assert.ok(contrast(t.pillText, t.pillBg) >= 4.5, 'pill text');
    for (const k of ['panelText', 'panelSub', 'panelEyebrow']) assert.ok(contrast(t[k], t.panel) >= 4.5, k + ' on panel');
  }
});

test('cssVars renders custom properties, kebab-cased, with an optional prefix and the font stacks', () => {
  const light = theme.cssVars('light');
  assert.ok(light.startsWith('--bg:#FFFFFF;--surface:#F6F6F7;--surface2:#EFEFF1;'));
  assert.match(light, /--accent-soft:#EEF2FF;/);
  assert.match(light, /--pill-bg:#0A0A0A;--pill-text:#FFFFFF;/);
  assert.match(light, /--font:Inter, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;/);
  assert.match(light, /--mono:"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;$/);
  assert.equal(light.split(';').filter(Boolean).length, KEYS.length + 2);
  const dark = theme.cssVars('dark', 'dcc-');
  assert.ok(dark.startsWith('--dcc-bg:#000000;'));
  assert.match(dark, /--dcc-accent:#5B8CFF;/);
  assert.ok(!/(^|;)--bg:/.test(dark));
  assert.equal(theme.varName('panelEyebrow', 'x-'), '--x-panel-eyebrow');
});

test('parseColor reads the formats getComputedStyle returns', () => {
  assert.deepEqual(theme.parseColor('rgb(17, 34, 51)'), { r: 17, g: 34, b: 51, a: 1 });
  assert.deepEqual(theme.parseColor('rgba(0, 0, 0, 0)'), { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(theme.parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(theme.parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(theme.parseColor('#0B1A3A'), { r: 11, g: 26, b: 58, a: 1 });
  assert.deepEqual(theme.parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(theme.parseColor('color(srgb 1 1 1 / 0.25)'), { r: 255, g: 255, b: 255, a: 0.25 });
  assert.ok(theme.luminance(theme.parseColor('oklch(0.2 0.02 260)')) < 0.2);
  assert.ok(theme.luminance(theme.parseColor('oklch(95% 0.01 90)')) > 0.2);
  assert.ok(theme.luminance(theme.parseColor('lab(15 2 -3)')) < 0.2);
  for (const bad of ['', 'nonsense', 'rgb(a, b, c)', 'hsl(0 0% 0%)', '#12']) assert.equal(theme.parseColor(bad), null, bad);
  assert.equal(theme.luminance('#FFFFFF'), 1);
  assert.equal(theme.luminance('#000000'), 0);
});

function page(html) {
  const dom = new JSDOM('<!doctype html><html><head></head><body>' + html + '</body></html>');
  return dom.window.document;
}

test('pickForElement: dark below 0.2 relative luminance, walking up transparent ancestors', () => {
  const doc = page('<style>body{background:#1b1b1d}</style><main><section><span id="t">x</span></section></main>');
  assert.equal(theme.pickForElement(doc.getElementById('t')), 'dark');
  assert.equal(theme.pickForPage(doc), 'dark');

  const light = page('<style>body{background:#f7f7f8}</style><main><span id="t">x</span></main>');
  assert.equal(theme.pickForElement(light.getElementById('t')), 'light');

  // The nearest opaque background wins over the body.
  const mixed = page('<style>body{background:#ffffff} .side{background:rgb(20, 22, 30)}</style><div class="side"><b id="t">x</b></div>');
  assert.equal(theme.pickForElement(mixed.getElementById('t')), 'dark');
  assert.equal(theme.pickForElement(mixed.body), 'light');

  // Threshold: luminance 0.2 is light, just below is dark.
  const at = (hex) => theme.pickForElement(page('<style>body{background:' + hex + '}</style><i id="t"></i>').getElementById('t'));
  assert.equal(at('#7C7C7C'), 'light'); // ≈ 0.202
  assert.equal(at('#7A7A7A'), 'dark'); // ≈ 0.195
});

test('pickForElement composites translucent layers and falls back to the canvas', () => {
  const doc = page('<style>body{background:#000} .veil{background:rgba(255,255,255,0.9)}</style><div class="veil"><i id="t"></i></div>');
  assert.equal(theme.pickForElement(doc.getElementById('t')), 'light', 'a 90% white veil over black reads light');
  const thin = page('<style>body{background:#000} .veil{background:rgba(255,255,255,0.1)}</style><div class="veil"><i id="t"></i></div>');
  assert.equal(theme.pickForElement(thin.getElementById('t')), 'dark');
  // Nothing opaque anywhere: the default canvas is white.
  const bare = page('<i id="t"></i>');
  assert.equal(theme.pickForElement(bare.getElementById('t')), 'light');
  // A root that declares only a dark color scheme has a dark canvas.
  const darkScheme = page('<style>html{color-scheme: dark}</style><i id="t"></i>');
  assert.equal(theme.pickForElement(darkScheme.getElementById('t')), 'dark');
  assert.equal(theme.pickForElement(null), 'light');
});

test('pickForElement crosses shadow roots to the host', () => {
  const doc = page('<style>body{background:#0d0d0f}</style><div id="host"></div>');
  const shadow = doc.getElementById('host').attachShadow({ mode: 'open' });
  const inner = doc.createElement('div');
  shadow.appendChild(inner);
  assert.equal(theme.pickForElement(inner), 'dark');
  const bg = theme.backgroundOf(inner);
  assert.deepEqual([bg.r, bg.g, bg.b], [13, 13, 15]);
});

test('extension pages use the same token values as the module', () => {
  const css = readFileSync(path.join(EXT, 'ui/brand.css'), 'utf8');
  for (const [k, v] of Object.entries(theme.LIGHT)) assert.ok(css.includes(theme.varName(k, 'dcc-') + ': ' + v + ';'), 'light ' + k);
  for (const [k, v] of Object.entries(theme.DARK)) assert.ok(css.includes(theme.varName(k, 'dcc-') + ': ' + v + ';'), 'dark ' + k);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  for (const f of ['inter-latin-400-normal', 'inter-latin-500-normal', 'inter-latin-600-normal', 'inter-latin-700-normal', 'ibm-plex-mono-latin-400-normal', 'ibm-plex-mono-latin-500-normal', 'ibm-plex-mono-latin-600-normal']) {
    assert.ok(css.includes('url("../fonts/' + f + '.woff2")'), f);
  }
});
