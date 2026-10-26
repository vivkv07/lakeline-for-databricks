/*
 * Workspace colors (top bar, optionally the sidebar): pure helpers shared by the popup panel and
 * the content feature.
 *
 * - Strict `#RRGGBB` validation. Nothing else ever reaches injected CSS.
 * - WCAG 2.x relative luminance and contrast; the foreground is black or white, whichever
 *   contrasts more with the chosen background.
 * - Storage shape and key resolution for `chrome.storage.local['dcc.appearance']`:
 *     {version:1, entries:{'<origin>|<workspaceId>': {color, savedAt, sidebar?}, '<origin>|*': {...}}}
 *   An ID-specific entry wins; otherwise the host default (`origin|*`) applies. `sidebar: true`
 *   also tints the side navigation; it's stored only when on, so older entries read as off.
 *   This key is separate from billing connections and settings, and nothing in billing ever
 *   writes it.
 *
 * No DOM access here; safe in content scripts, extension pages and `node --test`.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const V = dep('validate', '../core/validate.js');
  const ids = dep('ids', '../core/ids.js');

  const STORAGE_KEY = 'dcc.appearance';
  const VERSION = 1;
  const HOST_DEFAULT = '*';
  const BLACK = '#000000';
  const WHITE = '#FFFFFF';
  const MAX_ENTRIES = 200;

  // Accessible starting points; each keeps at least 4.5:1 with its chosen foreground.
  const PRESETS = Object.freeze([
    Object.freeze({ name: 'Red', color: '#B42318' }),
    Object.freeze({ name: 'Orange', color: '#F79009' }),
    Object.freeze({ name: 'Green', color: '#067647' }),
    Object.freeze({ name: 'Blue', color: '#1D4ED8' }),
    Object.freeze({ name: 'Purple', color: '#6941C6' }),
    Object.freeze({ name: 'Slate', color: '#344054' }),
  ]);

  /** Canonical uppercase `#RRGGBB`, or null. No trimming, no shorthand, no names. */
  function normalizeColor(v) {
    return V.normalizeHexColor(v);
  }

  /** Text typed into the hex field: surrounding whitespace is ignored, everything else is strict. */
  function parseHexInput(text) {
    return typeof text === 'string' ? normalizeColor(text.trim()) : null;
  }

  function channel(c) {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }

  /** WCAG 2.x relative luminance (0 = black, 1 = white). Null for anything that isn't #RRGGBB. */
  function relativeLuminance(hex) {
    const c = normalizeColor(hex);
    if (!c) return null;
    const r = parseInt(c.slice(1, 3), 16);
    const g = parseInt(c.slice(3, 5), 16);
    const b = parseInt(c.slice(5, 7), 16);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    if (la === null || lb === null) return null;
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  /** Black or white, whichever contrasts more with `hex` (black on ties). */
  function chooseForeground(hex) {
    const toBlack = contrastRatio(hex, BLACK);
    if (toBlack === null) return null;
    return toBlack >= contrastRatio(hex, WHITE) ? BLACK : WHITE;
  }

  /** `a` moved toward `b` by `t` (0…1), per sRGB channel. Both must be valid; output is #RRGGBB. */
  function mix(a, b, t) {
    const x = normalizeColor(a);
    const y = normalizeColor(b);
    if (!x || !y || !(t >= 0 && t <= 1)) return null;
    let out = '#';
    for (let i = 1; i < 7; i += 2) {
      const p = parseInt(x.slice(i, i + 2), 16);
      const q = parseInt(y.slice(i, i + 2), 16);
      out += Math.round(p + (q - p) * t).toString(16).padStart(2, '0');
    }
    return out.toUpperCase();
  }

  // How far the surface tone moves away from the bar color: lighter on light bars, darker on
  // dark ones, so the foreground's contrast on it is never lower than on the bar itself.
  const SURFACE_TOWARD_WHITE = 0.42;
  const SURFACE_TOWARD_BLACK = 0.24;

  /** Secondary text (placeholders, shortcut hints): as soft as possible while keeping 4.5:1. */
  function mutedOn(fg, surface) {
    for (let t = 0.4; t > 0; t = Math.round((t - 0.05) * 100) / 100) {
      const m = mix(fg, surface, t);
      if (contrastRatio(m, surface) >= 4.5) return m;
    }
    return fg;
  }

  /**
   * Everything the CSS and preview need, derived only from a validated color: every tone is
   * computed numerically and formatted as #RRGGBB, and the translucent overlays are fixed
   * constants per foreground, so input text never reaches the stylesheet.
   *   surface  search field, pills and the selected sidebar item (same hue, one step away)
   *   muted    placeholders and shortcut hints on the surface (≥ 4.5:1)
   */
  function themeFor(hex) {
    const bg = normalizeColor(hex);
    if (!bg) return null;
    const fg = chooseForeground(bg);
    const dark = fg === WHITE;
    let surface = dark ? mix(bg, BLACK, SURFACE_TOWARD_BLACK) : mix(bg, WHITE, SURFACE_TOWARD_WHITE);
    // Pure white or black bars have no room in that direction: step toward the foreground.
    if (contrastRatio(bg, surface) < 1.1) surface = mix(bg, fg, 0.1);
    return Object.freeze({
      bg,
      fg,
      fgName: dark ? 'white' : 'black',
      contrast: Math.round(contrastRatio(bg, fg) * 100) / 100,
      surface,
      muted: mutedOn(fg, surface),
      line: dark ? 'rgba(255, 255, 255, 0.28)' : 'rgba(0, 0, 0, 0.18)',
      hover: dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.08)',
    });
  }

  /* ------------------------------------------------------------------ keys and targets */

  /** Exact origin of a supported workspace (or the local fixture), else null. */
  function cleanOrigin(origin) {
    if (typeof origin !== 'string') return null;
    const cls = ids.classifyOrigin(origin);
    return cls.ok && cls.origin === origin ? cls.origin : null;
  }

  /** `origin|workspaceId`, or `origin|*` (host default) when workspaceId is null. */
  function entryKey(origin, workspaceId) {
    const o = cleanOrigin(origin);
    if (!o) return null;
    if (workspaceId === null || workspaceId === undefined || workspaceId === HOST_DEFAULT) return o + '|' + HOST_DEFAULT;
    return V.isWorkspaceId(workspaceId) ? o + '|' + workspaceId : null;
  }

  /** @returns {{origin, workspaceId: string|null}|null} */
  function parseKey(key) {
    if (typeof key !== 'string') return null;
    const bar = key.lastIndexOf('|');
    if (bar <= 0) return null;
    const origin = key.slice(0, bar);
    const id = key.slice(bar + 1);
    const workspaceId = id === HOST_DEFAULT ? null : id;
    return entryKey(origin, workspaceId) === key ? { origin, workspaceId } : null;
  }

  /** Optional-host-permission pattern for exactly one workspace origin. */
  function sitePattern(origin) {
    const o = cleanOrigin(origin);
    return o ? o + '/*' : null;
  }

  const TARGET_MESSAGES = {
    empty: 'Enter a workspace URL.',
    'invalid-url': 'Enter a full workspace URL, like https://dbc-1234.cloud.databricks.com/?o=1234.',
    'credentials-in-url': 'Remove the user name or password from the URL.',
    'not-https': 'Workspace URLs must start with https://.',
    'non-default-port': 'Workspace URLs can’t use a custom port.',
    'unsupported-host': 'This isn’t a supported Databricks workspace host.',
    'account-console': 'This is an account console or sign-in host, not a workspace.',
    conflict: 'This URL contains conflicting workspace IDs. Use a URL with one ?o= value.',
  };

  /**
   * Interpret a workspace URL typed in the popup. Without an ID in the URL the target is the
   * host default for that origin; saved IDs from elsewhere are deliberately not applied here.
   * @returns {{ok:true, origin, host, workspaceId:string|null, key, scope:'workspace'|'host'} | {ok:false, reason, message}}
   */
  function targetFromUrl(text) {
    const raw = typeof text === 'string' ? text.trim() : '';
    if (!raw) return { ok: false, reason: 'empty', message: TARGET_MESSAGES.empty };
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
    const cls = ids.classifyOrigin(withScheme);
    if (!cls.ok) return { ok: false, reason: cls.reason, message: TARGET_MESSAGES[cls.reason] || TARGET_MESSAGES['invalid-url'] };
    const resolved = ids.resolveWorkspaceId(withScheme, {});
    if (resolved.conflict) return { ok: false, reason: 'conflict', message: TARGET_MESSAGES.conflict };
    const workspaceId = resolved.id || null;
    return { ok: true, origin: cls.origin, host: cls.host, workspaceId, key: entryKey(cls.origin, workspaceId), scope: workspaceId ? 'workspace' : 'host' };
  }

  /* ------------------------------------------------------------------ storage shape */

  function emptyAppearance() {
    return { version: VERSION, entries: {} };
  }

  /** Keep only well-formed keys with strictly valid colors. Never throws. */
  function sanitizeAppearance(raw) {
    const out = emptyAppearance();
    const entries = raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
    let n = 0;
    for (const key of Object.keys(entries)) {
      if (n >= MAX_ENTRIES) break;
      const e = entries[key];
      if (!parseKey(key) || !e || typeof e !== 'object') continue;
      const color = normalizeColor(e.color);
      if (!color) continue;
      out.entries[key] = { color, savedAt: Number.isFinite(e.savedAt) ? e.savedAt : 0 };
      if (e.sidebar === true) out.entries[key].sidebar = true;
      n++;
    }
    return out;
  }

  /** @param {{sidebar?: boolean}} [opts] */
  function withEntry(appearance, key, color, nowMs, opts) {
    const c = normalizeColor(color);
    if (!parseKey(key) || !c) throw new Error('Invalid appearance entry');
    const next = sanitizeAppearance(appearance);
    next.entries[key] = { color: c, savedAt: Number.isFinite(nowMs) ? nowMs : Date.now() };
    if (opts && opts.sidebar === true) next.entries[key].sidebar = true;
    return next;
  }

  function withoutEntry(appearance, key) {
    const next = sanitizeAppearance(appearance);
    delete next.entries[key];
    return next;
  }

  /**
   * Color for a workspace page. ID-specific entry first, then the host default. The sidebar
   * choice travels with the entry that supplies the color.
   * @returns {{color, sidebar: boolean, key, scope:'workspace'|'host'}|null}
   */
  function resolveColor(appearance, origin, workspaceId) {
    const app = sanitizeAppearance(appearance);
    const o = cleanOrigin(origin);
    if (!o) return null;
    const hit = (key, scope) => ({ color: app.entries[key].color, sidebar: app.entries[key].sidebar === true, key, scope });
    if (V.isWorkspaceId(workspaceId)) {
      const key = entryKey(o, workspaceId);
      if (app.entries[key]) return hit(key, 'workspace');
    }
    const hostKey = entryKey(o, null);
    if (app.entries[hostKey]) return hit(hostKey, 'host');
    return null;
  }

  /**
   * Workspace ID a page's colors should use: the URL's own ID; if the URL has none, the saved
   * cost connection's ID; then the ID the content script resolved for the tab. Conflicting IDs
   * in the URL resolve to no ID, so only a host default can apply.
   */
  function pageWorkspaceId({ href, connectionWorkspaceId, contextWorkspaceId } = {}) {
    const r = ids.resolveWorkspaceId(href, {});
    if (r.conflict) return { id: null, source: 'conflict' };
    if (r.id) return { id: r.id, source: 'url' };
    if (V.isWorkspaceId(connectionWorkspaceId)) return { id: connectionWorkspaceId, source: 'connection' };
    if (V.isWorkspaceId(contextWorkspaceId)) return { id: contextWorkspaceId, source: 'context' };
    return { id: null, source: null };
  }

  /** After removing `key`, what still applies to that target (for the Reset message). */
  function resetOutcome(appearance, key) {
    const parsed = parseKey(key);
    if (!parsed) return { removed: false, hostDefault: null, overridesLeft: 0 };
    const app = sanitizeAppearance(appearance);
    const removed = Boolean(app.entries[key]);
    const after = withoutEntry(app, key);
    const hostKey = entryKey(parsed.origin, null);
    const hostDefault = parsed.workspaceId && after.entries[hostKey] ? after.entries[hostKey].color : null;
    const overridesLeft = parsed.workspaceId ? 0 : Object.keys(after.entries).filter((k) => k !== hostKey && parseKey(k).origin === parsed.origin).length;
    return { removed, hostDefault, overridesLeft };
  }

  const api = Object.freeze({
    STORAGE_KEY,
    VERSION,
    HOST_DEFAULT,
    BLACK,
    WHITE,
    PRESETS,
    normalizeColor,
    parseHexInput,
    relativeLuminance,
    contrastRatio,
    chooseForeground,
    mix,
    themeFor,
    entryKey,
    parseKey,
    sitePattern,
    targetFromUrl,
    emptyAppearance,
    sanitizeAppearance,
    withEntry,
    withoutEntry,
    resolveColor,
    pageWorkspaceId,
    resetOutcome,
  });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).workspaceColor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
