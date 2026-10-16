/*
 * Design tokens for every surface, in one place. Extension pages follow prefers-color-scheme
 * through ui/brand.css (same values). Surfaces injected into Databricks pages match the page:
 * pickForElement() reads the computed background of the element (walking up through
 * transparent ancestors and shadow hosts) and picks dark tokens when its relative luminance is
 * below 0.2. cssVars() turns a token set into custom-property declarations for a <style>.
 *
 * In-page surfaces can't load the bundled fonts (no web_accessible_resources), so they use the
 * FONT / MONO stacks, which pick the fonts up when they're installed locally.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;

  const LIGHT = Object.freeze({
    bg: '#FFFFFF',
    surface: '#F6F6F7',
    surface2: '#EFEFF1',
    line: '#E4E4E7',
    line2: '#D4D4D8',
    text: '#0A0A0A',
    body: '#52525B',
    muted: '#6B6B74',
    faint: '#A1A1AA',
    accent: '#2F5BEA',
    accentSoft: '#EEF2FF',
    accentLine: '#B9C8FA',
    accentFill: '#DCE5FF',
    accentText: '#1E3A8A',
    warm: '#B45309',
    warmSoft: '#FFF7E8',
    warmLine: '#F2CF8E',
    pillBg: '#0A0A0A',
    pillText: '#FFFFFF',
    panel: '#0B1A3A',
    panelText: '#F5F5F4',
    panelSub: '#C7D5FF',
    panelEyebrow: '#8FB0FF',
    danger: '#B42318',
    success: '#067647',
  });

  const DARK = Object.freeze({
    bg: '#000000',
    surface: '#0F0F10',
    surface2: '#141416',
    line: '#232326',
    line2: '#2A2A2E',
    text: '#F5F5F4',
    body: '#A1A1AA',
    muted: '#8A8A93',
    faint: '#52525B',
    accent: '#5B8CFF',
    accentSoft: '#0B1A3A',
    accentLine: '#2E4A85',
    accentFill: '#132447',
    accentText: '#C7D5FF',
    warm: '#F5B83D',
    warmSoft: '#1A1406',
    warmLine: '#5A4515',
    pillBg: '#F5F5F4',
    pillText: '#0A0A0A',
    panel: '#0B1A3A',
    panelText: '#F5F5F4',
    panelSub: '#C7D5FF',
    panelEyebrow: '#8FB0FF',
    danger: '#F97066',
    success: '#47CD89',
  });

  const FONT = 'Inter, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
  const DARK_BELOW = 0.2;
  const NAMES = Object.freeze(['light', 'dark']);

  function tokens(name) {
    return name === 'dark' ? DARK : LIGHT;
  }

  /** accentSoft → accent-soft; surface2 stays surface2. */
  function varName(key, prefix) {
    return '--' + (prefix || '') + key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  }

  /**
   * Custom-property declarations for a theme: "--bg:#FFFFFF;--surface:#F6F6F7;…;--font:…;--mono:…;".
   * @param {'light'|'dark'} name
   * @param {string} [prefix] e.g. 'dcc-' → "--dcc-bg:…" for surfaces in the page's own DOM
   */
  function cssVars(name, prefix) {
    const t = tokens(name);
    let out = '';
    for (const k of Object.keys(t)) out += varName(k, prefix) + ':' + t[k] + ';';
    out += varName('font', prefix) + ':' + FONT + ';' + varName('mono', prefix) + ':' + MONO + ';';
    return out;
  }

  /* ------------------------------------------------------------------ colors */

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const fromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

  /** Gray with the given relative luminance (used for color spaces we only read lightness from). */
  function grayOf(y, a) {
    const v = Math.round(clamp01(fromLinear(clamp01(y))) * 255);
    return { r: v, g: v, b: v, a };
  }

  function num(s, scale) {
    const t = String(s).trim();
    if (t === 'none') return 0;
    const v = parseFloat(t);
    if (!Number.isFinite(v)) return NaN;
    return t.endsWith('%') ? (v / 100) * scale : v;
  }

  /**
   * Parse a computed CSS color into {r, g, b (0–255), a (0–1)}, or null when unreadable.
   * Handles transparent, #hex, rgb()/rgba() (comma or space syntax), color(srgb …), and reads
   * lightness only from lab/lch/oklab/oklch (enough for a light/dark decision).
   */
  function parseColor(str) {
    const s = String(str || '').trim().toLowerCase();
    if (!s) return null;
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    let m = /^#([0-9a-f]{3,8})$/.exec(s);
    if (m) {
      let h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
      if (h.length !== 6 && h.length !== 8) return null;
      const n = (i) => parseInt(h.slice(i, i + 2), 16);
      return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
    }
    m = /^([a-z]+)\((.*)\)$/.exec(s);
    if (!m) return null;
    const fn = m[1];
    const [body, alphaPart] = m[2].split('/');
    const parts = body.split(/[\s,]+/).filter(Boolean);
    let a = alphaPart !== undefined ? num(alphaPart, 1) : 1;
    if (fn === 'rgb' || fn === 'rgba') {
      if (parts.length === 4 && alphaPart === undefined) a = num(parts[3], 1);
      const [r, g, b] = parts.slice(0, 3).map((p) => num(p, 255));
      if (![r, g, b, a].every(Number.isFinite)) return null;
      return { r: clamp01(r / 255) * 255, g: clamp01(g / 255) * 255, b: clamp01(b / 255) * 255, a: clamp01(a) };
    }
    if (!Number.isFinite(a)) return null;
    if (fn === 'color' && (parts[0] === 'srgb' || parts[0] === 'srgb-linear')) {
      const [r, g, b] = parts.slice(1, 4).map((p) => num(p, 1));
      if (![r, g, b].every(Number.isFinite)) return null;
      const enc = parts[0] === 'srgb-linear' ? (c) => fromLinear(clamp01(c)) : (c) => clamp01(c);
      return { r: enc(r) * 255, g: enc(g) * 255, b: enc(b) * 255, a: clamp01(a) };
    }
    if (fn === 'oklab' || fn === 'oklch') {
      const l = num(parts[0], 1);
      return Number.isFinite(l) ? grayOf(Math.pow(clamp01(l), 3), clamp01(a)) : null;
    }
    if (fn === 'lab' || fn === 'lch') {
      const l = num(parts[0], 100);
      if (!Number.isFinite(l)) return null;
      const f = (l + 16) / 116;
      return grayOf(l > 8 ? f * f * f : l / 903.3, clamp01(a));
    }
    return null;
  }

  /** WCAG relative luminance of {r, g, b} (0–255) or a CSS color string. */
  function luminance(color) {
    const c = typeof color === 'string' ? parseColor(color) : color;
    if (!c) return null;
    return 0.2126 * toLinear(c.r / 255) + 0.7152 * toLinear(c.g / 255) + 0.0722 * toLinear(c.b / 255);
  }

  /** Next element up, crossing from a shadow root to its host. */
  function parentOf(node) {
    if (node.parentElement) return node.parentElement;
    const p = node.parentNode;
    return p && p.host ? p.host : null;
  }

  /** What shows through a fully transparent page: the canvas follows the root's color-scheme. */
  function canvasColor(doc) {
    const win = doc && doc.defaultView;
    let scheme = '';
    try {
      scheme = String(win.getComputedStyle(doc.documentElement).colorScheme || '');
    } catch (_) {
      scheme = '';
    }
    const words = scheme.split(/\s+/);
    let dark = false;
    if (words.includes('dark')) {
      if (!words.includes('light')) dark = true;
      else {
        try {
          dark = Boolean(win.matchMedia && win.matchMedia('(prefers-color-scheme: dark)').matches);
        } catch (_) {
          dark = false;
        }
      }
    }
    return dark ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  }

  /**
   * Effective background behind `el`: walks up while backgrounds are transparent, composites
   * semi-transparent layers, and falls back to the canvas color. Returns {r, g, b, a:1} or null.
   */
  function backgroundOf(el) {
    if (!el || el.nodeType !== 1) return null;
    const doc = el.ownerDocument;
    const win = doc && doc.defaultView;
    if (!win || typeof win.getComputedStyle !== 'function') return null;
    const layers = [];
    let opaque = null;
    for (let node = el, guard = 0; node && guard < 80; node = parentOf(node), guard++) {
      if (node.nodeType !== 1) continue;
      let c = null;
      try {
        c = parseColor(win.getComputedStyle(node).backgroundColor);
      } catch (_) {
        c = null;
      }
      if (!c || c.a <= 0) continue;
      if (c.a >= 0.999) {
        opaque = c;
        break;
      }
      layers.push(c);
    }
    let out = opaque || canvasColor(doc);
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      out = { r: l.r * l.a + out.r * (1 - l.a), g: l.g * l.a + out.g * (1 - l.a), b: l.b * l.a + out.b * (1 - l.a), a: 1 };
    }
    return { r: out.r, g: out.g, b: out.b, a: 1 };
  }

  /** 'dark' when the background behind `el` has relative luminance below 0.2, else 'light'. */
  function pickForElement(el) {
    const bg = backgroundOf(el);
    const y = bg ? luminance(bg) : null;
    return y !== null && y < DARK_BELOW ? 'dark' : 'light';
  }

  /** The page's main container (or body): the reference element for in-page surfaces. */
  function mainOf(doc) {
    if (!doc) return null;
    return doc.querySelector('main, [role="main"]') || doc.body || doc.documentElement;
  }

  /** pickForElement on the page's main container or body. */
  function pickForPage(doc) {
    return pickForElement(mainOf(doc));
  }

  const api = Object.freeze({
    LIGHT,
    DARK,
    FONT,
    MONO,
    DARK_BELOW,
    NAMES,
    tokens,
    varName,
    cssVars,
    parseColor,
    luminance,
    backgroundOf,
    pickForElement,
    pickForPage,
    mainOf,
  });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).theme = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
