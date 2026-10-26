// Workspace colors on the DARK native top bar (local/fixture/topbar-dark.html) in REAL headless
// Chromium: real layout (the tone scan's geometry path through the 0x0 dark-token wrapper), the
// real cascade (the design system's class-level !important field rules, inserted after the theme
// stylesheet), real ::placeholder styles and real pixels. The feature's content scripts run in the
// page with a stand-in chrome.storage; no extension install and no fixture server (test-e2e.mjs
// covers the installed extension). The fragment imitates a captured workspace top bar; it is not
// the live Databricks UI.
//
//   npm run test:browser
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from '../support/load.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const EXT = path.join(ROOT, 'extension');
const C = load('content/workspace-color.js');

const FILES = ['src/core/validate.js', 'src/core/ids.js', 'src/content/dom.js', 'src/content/native-adapter.js', 'src/content/workspace-color.js', 'src/content/workspace-theme.js'];
const FRAGMENT = fs.readFileSync(path.join(ROOT, 'local/fixture/topbar-dark.html'), 'utf8');
const NATIVE_STYLE = /<style data-fixture="topbar-dark">[\s\S]*?<\/style>/.exec(FRAGMENT)[0];
const BODY = FRAGMENT.replace(NATIVE_STYLE, '');
const ORIGIN = 'https://dbc-1.cloud.databricks.com';
const KEY = 'dcc.appearance';
const NATIVE_FIELD = '#11171C'; // rgb(17, 23, 28)
const NATIVE_PLACEHOLDER = 'rgb(131, 150, 165)';
const NATIVE_INITIALS = 'rgb(127, 86, 217)';

// Vivid (white text), light (black text), near-black (the shade steps lighter), red, green.
const COLORS = [
  ['vivid blue', '#194AD2'],
  ['light yellow', '#F5D90A'],
  ['near-black', '#1B1F2A'],
  ['red', '#D92D20'],
  ['green', '#12B76A'],
];

let chromium = null;
let skip = false;
try {
  ({ chromium } = await import('playwright'));
  const exe = chromium.executablePath();
  if (!process.env.E2E_CHANNEL && (!exe || !fs.existsSync(exe))) skip = 'Playwright Chromium is not installed (' + exe + '); this suite never downloads browsers';
} catch (e) {
  skip = 'playwright is not installed: ' + String((e && e.message) || e).slice(0, 120);
}

/* ------------------------------------------------------------------ color math */

/** 'rgb(…)' / 'rgba(…)' / '#RRGGBB' / [r, g, b(, a)] pixel / {r, g, b, a} → {r, g, b, a} (0–255, alpha 0–1). */
function parse(c) {
  if (c && typeof c === 'object' && !Array.isArray(c)) return c;
  if (Array.isArray(c)) return { r: c[0], g: c[1], b: c[2], a: c.length > 3 ? c[3] / 255 : 1 };
  if (/^#[0-9a-f]{6}$/i.test(c)) return { r: parseInt(c.slice(1, 3), 16), g: parseInt(c.slice(3, 5), 16), b: parseInt(c.slice(5, 7), 16), a: 1 };
  const m = /^rgba?\(([^)]*)\)$/.exec(String(c).trim());
  assert.ok(m, 'unparsed color ' + c);
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}
const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
/** `top` (possibly translucent) composited over an opaque `under`. */
const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
const contrast = (a, b) => C.contrastRatio(hex(parse(a)), hex(parse(b)));
const near = (a, b, tol = 4) => {
  const x = parse(a);
  const y = parse(b);
  return Math.abs(x.r - y.r) <= tol && Math.abs(x.g - y.g) <= tol && Math.abs(x.b - y.b) <= tol;
};
const r2 = (n) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ page helpers */

describe('workspace colors on the dark-token top bar: real Chromium, real cascade and pixels', { skip }, () => {
  let browser;
  let page;
  let scratch; // decodes screenshots into pixels
  let native; // computed snapshot + screenshot before any tint

  // caret: 'initial' keeps the page untouched (hiding the caret writes a style attribute on inputs).
  const shoot = () => page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 48 }, caret: 'initial' });

  /** Every element of the bar: the painted/text properties the theme can touch. */
  const snapshot = () =>
    page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Top Navigation"]');
      const props = ['backgroundColor', 'backgroundClip', 'backgroundImage', 'color', 'caretColor', 'boxShadow', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outlineColor'];
      return [nav, ...nav.querySelectorAll('*')].map((el) => {
        const cs = getComputedStyle(el);
        const out = { el: el.tagName + '.' + (el.getAttribute('class') || '') + '|' + [...el.attributes].map((a) => a.name).join(',') };
        for (const p of props) out[p] = cs[p];
        if (el.matches('input')) out.placeholder = getComputedStyle(el, '::placeholder').color;
        return out;
      });
    });

  const measure = () =>
    page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      };
      const nav = q('nav[aria-label="Top Navigation"]');
      const wrap = q('.du-bois-dark-input-affix-wrapper');
      const input = q('input.du-bois-dark-input');
      const initials = q('[data-testid="user-menu-trigger"] > span');
      const cs = (el) => getComputedStyle(el);
      return {
        toned: [...nav.querySelectorAll('[data-dcc-tone]')].map((el) => ({
          tone: el.getAttribute('data-dcc-tone'),
          wrap: el === wrap,
          initials: el === initials,
          tag: el.tagName.toLowerCase(),
        })),
        navBg: cs(nav).backgroundColor,
        wrap: { bg: cs(wrap).backgroundColor, shadow: cs(wrap).boxShadow, clip: cs(wrap).backgroundClip, border: cs(wrap).borderTopColor, borderWidth: cs(wrap).borderTopWidth, color: cs(wrap).color, box: box(wrap) },
        input: { bg: cs(input).backgroundColor, color: cs(input).color, placeholder: getComputedStyle(input, '::placeholder').color, box: box(input) },
        kbd: cs(q('.fxd-kbd')).color,
        tokens: box(q('[data-testid="ds-override-tokens-wrapper"]')),
        form: box(q('form')),
        initials: { bg: cs(initials).backgroundColor, color: cs(initials).color, shadow: cs(initials).boxShadow, radius: cs(initials).borderTopLeftRadius, box: box(initials) },
      };
    });

  /** RGBA pixels at viewport points, read from a real screenshot of the bar. */
  async function pixels(points) {
    const png = await shoot();
    return scratch.evaluate(
      async ({ b64, points }) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        return points.map(([x, y]) => [...g.getImageData(Math.floor(x), Math.floor(y), 1, 1).data]);
      },
      { b64: png.toString('base64'), points }
    );
  }

  /** Points: the field's padding, the empty part of the input, the bar beside the search, the circle. */
  async function samples(m) {
    const [field, input, bar, circle] = await pixels([
      [m.wrap.box.x + 4, m.wrap.box.y + m.wrap.box.h / 2],
      [m.input.box.x + m.input.box.w * 0.85, m.input.box.y + m.input.box.h / 2],
      [m.form.x + m.form.w + 24, 24],
      [m.initials.box.x + m.initials.box.w / 2, m.initials.box.y + 3],
    ]);
    return { field, input, bar, circle };
  }

  /** Save an appearance and let the feature apply it, as the content bootstrap does on a storage change. */
  async function setAppearance(entries) {
    await page.evaluate(
      async ({ key, entries, origin }) => {
        await window.chrome.storage.local.set({ [key]: { version: 1, entries } });
        window.__ctx = window.__ctx || { doc: document, origin, workspaceId: '42', connection: null, settings: { showCosts: true } };
        window.DCC.features.find((f) => f.name === 'workspace-theme').onAppearance(window.__ctx);
      },
      { key: KEY, entries, origin: ORIGIN }
    );
  }

  before(async () => {
    const opts = { headless: true };
    if (process.env.E2E_CHANNEL) opts.channel = process.env.E2E_CHANNEL;
    browser = await chromium.launch(opts);
    const context = await browser.newContext({ viewport: { width: 1280, height: 240 }, deviceScaleFactor: 1, colorScheme: 'light' });
    page = await context.newPage();
    scratch = await context.newPage();
    await page.setContent('<!doctype html><html><head><meta charset="utf-8">' + NATIVE_STYLE + '</head><body style="margin: 0">' + BODY + '</body></html>');
    await page.evaluate(() => {
      const data = {};
      window.chrome = {
        storage: {
          local: {
            async get(k) {
              return k in data ? { [k]: structuredClone(data[k]) } : {};
            },
            async set(obj) {
              for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v);
            },
          },
        },
      };
    });
    for (const f of FILES) await page.addScriptTag({ content: fs.readFileSync(path.join(EXT, f), 'utf8') + '\n//# sourceURL=' + f });
    native = { styles: await snapshot(), png: await shoot() };
  });

  after(async () => {
    if (browser) await browser.close().catch(() => {});
  });

  it('native look first: dark field box, transparent input, 0x0 token wrapper, nothing tagged', async () => {
    const m = await measure();
    assert.deepEqual(m.toned, []);
    assert.equal(m.tokens.w, 0);
    assert.equal(m.tokens.h, 0);
    assert.equal(m.wrap.bg, 'rgb(17, 23, 28)');
    assert.equal(m.wrap.box.h, 32);
    assert.equal(m.input.bg, 'rgba(0, 0, 0, 0)');
    assert.equal(m.input.placeholder, NATIVE_PLACEHOLDER);
    const px = await samples(m);
    assert.ok(near(px.field, NATIVE_FIELD), 'field padding ' + px.field);
    assert.ok(near(px.input, NATIVE_FIELD), 'input area ' + px.input);
    assert.ok(near(px.circle, NATIVE_INITIALS), 'circle ' + px.circle);
    assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-dcc="theme"]').length), 0);
  });

  for (const [name, color] of COLORS) {
    it(`${color} (${name}): the search field takes a shade of the bar with readable text; the circle keeps its own color`, async (t) => {
      const theme = C.themeFor(color);
      await setAppearance({ [ORIGIN + '|42']: { color, savedAt: 1 } });
      const want = 'rgb(' + [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)).join(', ') + ')';
      for (let i = 0; i < 100 && (await measure()).navBg !== want; i++) await new Promise((r) => setTimeout(r, 20));
      // Worst case for the cascade: the design system's styles come after the theme stylesheet.
      await page.evaluate(() => document.head.appendChild(document.querySelector('style[data-fixture="topbar-dark"]')));
      assert.equal(await page.evaluate(() => document.head.lastElementChild.getAttribute('data-fixture')), 'topbar-dark');
      const m = await measure();
      const px = await samples(m);
      const fieldPaint = parse(px.field);
      const frame = over(parse(m.wrap.border), parse(m.navBg));
      const values = {
        bar: m.navBg,
        surface: theme.surface,
        fieldPixel: hex(fieldPaint),
        inputPixel: hex(parse(px.input)),
        wrapperBackgroundColor: m.wrap.bg,
        wrapperBoxShadow: m.wrap.shadow,
        inputBackgroundColor: m.input.bg,
        text: m.input.color + ' ' + r2(contrast(m.input.color, px.field)) + ':1',
        placeholder: m.input.placeholder + ' ' + r2(contrast(m.input.placeholder, px.field)) + ':1',
        hint: m.kbd + ' ' + r2(contrast(m.kbd, px.field)) + ':1',
        frame: m.wrap.border + ' → ' + hex(frame) + ' (' + r2(contrast(frame, m.navBg)) + ':1 to the bar, ' + r2(contrast(frame, px.field)) + ':1 to the field)',
        tones: m.toned.map((x) => x.tone + ':' + (x.wrap ? 'affix-wrapper' : x.initials ? 'initials' : x.tag)).join(' '),
      };
      t.diagnostic(color + ' ' + JSON.stringify(values));

      assert.equal(m.navBg, want);
      // Tones: the affix wrapper is the field (found through the 0x0 token wrapper) and the
      // initials circle is kept; the combobox, the input and the wrappers are not tagged.
      assert.deepEqual(m.toned.map((x) => [x.tone, x.wrap || x.initials]), [['field', true], ['keep', true]]);
      assert.ok(m.toned[1].initials);

      // The visible box is one shade of the bar color: not the native near-black, not white,
      // and the input inside it has no box of its own.
      assert.ok(near(px.field, theme.surface), 'field paint ' + hex(fieldPaint) + ' vs surface ' + theme.surface);
      assert.ok(near(px.input, px.field, 2), 'input area ' + hex(parse(px.input)) + ' vs field ' + hex(fieldPaint));
      assert.ok(near(px.bar, color, 2), 'bar ' + hex(parse(px.bar)));
      assert.ok(!near(px.field, NATIVE_FIELD, 6) && !near(px.field, '#FFFFFF', 6) && !near(px.field, '#000000', 6), 'field is a shade, not black or white');
      assert.ok(contrast(fieldPaint, color) >= 1.1, 'field stands apart from the bar');
      assert.equal(parse(m.input.bg).a, 0, 'no separate input background');

      // Readable text: typed text AA (4.5:1), placeholder at least 3:1, shortcut hint AA.
      assert.ok(contrast(m.input.color, px.field) >= 4.5, 'text ' + values.text);
      assert.ok(contrast(m.input.placeholder, px.field) >= 3, 'placeholder ' + values.placeholder);
      assert.notEqual(m.input.placeholder, NATIVE_PLACEHOLDER, 'the native placeholder color does not survive');
      assert.ok(contrast(m.kbd, px.field) >= 4.5, 'hint ' + values.hint);

      // The frame stays visible but subtle: a translucent 1px line over the bar color.
      assert.equal(m.wrap.borderWidth, '1px');
      assert.ok(parse(m.wrap.border).a > 0 && parse(m.wrap.border).a <= 0.35, 'translucent frame ' + m.wrap.border);
      assert.ok(Math.max(contrast(frame, m.navBg), contrast(frame, px.field)) >= 1.3, 'visible frame ' + values.frame);
      assert.ok(contrast(frame, m.navBg) <= 3, 'subtle frame ' + values.frame);
      assert.equal(m.wrap.clip, 'padding-box', 'the native dark background never shows through the frame');

      // The initials circle keeps its own color and shape.
      assert.equal(m.initials.bg, NATIVE_INITIALS);
      assert.equal(m.initials.shadow, 'none');
      assert.equal(m.initials.radius, '50%');
      assert.ok(near(px.circle, NATIVE_INITIALS), 'circle ' + px.circle);
    });
  }

  it('reset restores the native look exactly: computed styles and pixels', async () => {
    await setAppearance({});
    for (let i = 0; i < 100 && (await page.evaluate(() => document.querySelectorAll('style[data-dcc="theme"]').length)); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-dcc="theme"], [data-dcc-themed], [data-dcc-tone]').length), 0);
    assert.deepEqual(await snapshot(), native.styles);
    const png = await shoot();
    assert.ok(png.equals(native.png), 'the bar renders pixel-identical to the native bar');
  });
});
