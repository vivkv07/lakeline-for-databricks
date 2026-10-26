/*
 * Workspace colors (content feature). Tints the native top navigation bar with the color saved
 * for this workspace and, when that entry has the sidebar option on, the side navigation and the
 * shell around the page card too. Everything lives in one removable <style data-dcc="theme">
 * whose rules are scoped to marker attributes on those native containers. Independent of
 * billing: it runs in every mode, with or without a cost connection, and stays active while cost
 * display is paused.
 *
 * Blending. Native controls paint their own backgrounds (the search field, pills, the New button,
 * the selected sidebar item), so recoloring text alone leaves dark or blue patches on the tint. A
 * DOM-agnostic scan reads each container's native computed backgrounds and tags every painted
 * descendant with a tone (data-dcc-tone):
 *   field    the painted box around a text entry → surface shade in a subtle frame, soft text,
 *            full-color input
 *   surface  smaller painted controls → surface shade (a lighter or darker step of the bar color)
 *   layer    tall inner panels → the bar color itself
 *   keep     circles (account initials, status dots) → left exactly as they are
 * Tones are painted with an inset box-shadow rather than background-color, so the native
 * background stays readable and the next scan sees the same page the last one did.
 *
 * Idempotent on every tick: scans run only when a container's signature changes (or a while has
 * passed), and attributes and style text are written only when they differ from the live DOM,
 * so it can't feed the mutation observer.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const V = dep('validate', '../core/validate.js');
  const colors = dep('workspaceColor', './workspace-color.js');
  const native = dep('native', './native-adapter.js');

  const FEATURE_NAME = 'workspace-theme';
  const MARK_ATTR = 'data-dcc-themed'; // 'top' | 'side' | 'shell' | 'card'
  const TONE_ATTR = 'data-dcc-tone'; // 'field' | 'surface' | 'layer' | 'keep'
  const STYLE_SELECTOR = 'style[data-dcc="theme"]';
  const TONES = Object.freeze(['field', 'surface', 'layer', 'keep']);

  const MARKED = '[' + MARK_ATTR + ']';
  const marked = (kind) => '[' + MARK_ATTR + '="' + kind + '"]';
  const tone = (t) => '[' + TONE_ATTR + '="' + t + '"]';
  // Design systems put class-level !important on some field properties: on a real workspace the
  // native search box kept its dark background and placeholder color against an !important
  // override. So every rule inside a themed container carries one ID's worth of specificity:
  // `:not(#…)` with an ID that no element has matches everything, outranks any class-based
  // selector, and matches nothing new.
  const LIFT = ':not(#dcc-theme-lift)';
  // Containers whose descendants follow the theme. The shell and card only get one property each.
  const BAR = ':is(' + marked('top') + ', ' + marked('side') + ')' + LIFT;

  // Menus and popovers rendered inside a container keep their own native colors.
  const POPOVER = '[role="menu"], [role="listbox"], [role="dialog"], [role="tooltip"]';
  // Brand graphics and images are never recolored: no fill/stroke rules, and no `color` on SVG.
  // The extension's own elements (banner, badges) are excluded too.
  const GRAPHIC = 'svg, img, canvas, video, [class*="avatar"], [data-dcc]';
  const within = (sel) => sel + ', :is(' + sel + ') *';
  const SKIP_SCAN = [within(POPOVER), within(GRAPHIC)].join(', ');
  const SKIP = [SKIP_SCAN, within(tone('keep'))].join(', ');
  const TEXT_ENTRY = [
    'input:not([type="checkbox"], [type="radio"], [type="hidden"], [type="color"], [type="range"], [type="file"], [type="button"], [type="submit"], [type="reset"], [type="image"])',
    'textarea',
    'select',
    '[role="searchbox"]',
    '[contenteditable="true"]',
  ].join(', ');
  const INTERACTIVE = 'a, button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="treeitem"]';
  const SELECTED = '[aria-current="page"], [aria-current="true"], [aria-selected="true"]';

  const MIN_ALPHA = 0.02; // below this a background is invisible on any tint
  const OPAQUE = 0.95;
  const FIELD_SLACK = 20; // px a field box may exceed its input's height (padding, border)
  const TOP_LAYER = 0.8; // top bar: painted children at least this share of its height are layers
  const SIDE_LAYER = 56; // sidebar: painted children taller than this are layers, not items
  const MAX_SCAN = 1500;
  const MAX_AGE = 4000; // ms; rescan at least this often on ticks (late native styles)
  const RECHECK = 1000; // ms; revisit hovered elements whose tone was carried over

  /**
   * CSS for one validated theme (from workspaceColor.themeFor). Returns null for anything that
   * isn't a strict #RRGGBB background with a black or white foreground, so arbitrary input can
   * never reach the stylesheet; every other value is recomputed here from that background.
   */
  function buildCss(theme) {
    if (!theme || !V.isHexColor(theme.bg) || theme.bg !== theme.bg.toUpperCase()) return null;
    const fixed = colors.themeFor(theme.bg);
    if (!fixed || fixed.fg !== theme.fg) return null;
    const { bg, fg, surface, muted, line, hover } = fixed; // tones: #RRGGBB; line/hover: constants
    if (![surface, muted].every(V.isHexColor)) return null;
    const fill = (...layers) => 'box-shadow: ' + layers.map((c) => 'inset 0 0 0 100vmax ' + c).join(', ') + ' !important;';
    // Shadows fill the padding box; clipping the native background there keeps it from showing
    // through the border as a dark or tinted ring. Surfaces drop their border; fields keep a
    // subtle frame: the translucent line over the bar color.
    const unframe = 'background-clip: padding-box !important; border-color: transparent !important;';
    const frame = 'background-clip: padding-box !important; border-color: ' + line + ' !important;';
    return [
      '/* Lakeline for Databricks: workspace colors (removable; scoped to the native top bar, sidebar and shell). */',
      `${BAR} { background-color: ${bg} !important; background-image: none !important; color: ${fg} !important; border-color: ${line} !important; }`,
      `${marked('shell')} { background-color: ${bg} !important; background-image: none !important; }`,
      `${marked('card')} { border-color: ${bg} !important; }`,
      // Text and icon controls follow the chosen foreground; icons drawn with currentColor
      // follow it through inheritance. Explicit SVG fills (logos) are untouched.
      `${BAR} *:not(${SKIP}) { color: ${fg} !important; }`,
      `${BAR} :is(${INTERACTIVE}):not(${SKIP}, [${TONE_ATTR}]):hover { background-color: ${hover} !important; }`,
      `${BAR} ${tone('layer')} { ${fill(bg)} }`,
      `${BAR} :is(${tone('surface')}, :is(${SELECTED}):not(${SKIP}, [${TONE_ATTR}])) { ${fill(surface)} ${unframe} }`,
      `${BAR} :is(${INTERACTIVE})${tone('surface')}:hover { ${fill(hover, surface)} }`,
      // Search and other fields: one shade of the bar color inside a subtle frame, soft secondary
      // text, full-strength typed text, and a foreground ring while focused.
      `${BAR} ${tone('field')} { ${fill(surface)} ${frame} color: ${muted} !important; }`,
      `${BAR} ${tone('field')}:focus-within { box-shadow: inset 0 0 0 1px ${fg}, inset 0 0 0 100vmax ${surface} !important; }`,
      `${BAR} ${tone('field')} *:not(${SKIP}) { background-color: transparent !important; box-shadow: none !important; color: ${muted} !important; }`,
      `${BAR} ${tone('field')} :is(input, textarea, select, [contenteditable="true"]), ${BAR} :is(input, textarea, select)${tone('field')} { color: ${fg} !important; caret-color: ${fg} !important; }`,
      `${BAR} ${tone('field')} ::placeholder, ${BAR} ${tone('field')}::placeholder { color: ${muted} !important; opacity: 1 !important; }`,
      `${BAR} :focus-visible { outline-color: ${fg} !important; }`,
    ].join('\n');
  }

  /* ------------------------------------------------------------------ native paint */

  /** Alpha of a computed `rgb()`/`rgba()` color; 0 for `transparent` and anything unrecognized. */
  function alphaOf(c) {
    const m = typeof c === 'string' ? /^rgba?\(([^)]*)\)$/.exec(c.trim()) : null;
    if (!m) return 0;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return 0;
    if (parts.length === 3) return 1;
    const a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    return Number.isFinite(a) ? a : 0;
  }

  const SIDES = ['Top', 'Right', 'Bottom', 'Left'];

  function paintOf(view, el) {
    const cs = view.getComputedStyle(el);
    const visibleBorder = (s) => parseFloat(cs['border' + s + 'Width']) > 0 && !/^(none|hidden)$/.test(cs['border' + s + 'Style']) && alphaOf(cs['border' + s + 'Color']) >= MIN_ALPHA;
    return {
      bg: cs.backgroundColor,
      filled: alphaOf(cs.backgroundColor) >= MIN_ALPHA,
      bordered: SIDES.some(visibleBorder),
      // The shorthand covers engines that leave the longhand at 0 when only the shorthand is set.
      radius: [cs.borderTopLeftRadius, cs.borderRadius].find((v) => parseFloat(v) > 0) || '',
    };
  }

  function rectOf(el) {
    try {
      const r = el.getBoundingClientRect();
      return r && r.width > 0 && r.height > 0 ? r : null;
    } catch (_) {
      return null;
    }
  }

  /** Round and (with layout) square: account initials, status dots. */
  function isCircle(paint, r) {
    const rad = paint.radius;
    if (r && Math.abs(r.width - r.height) > 2) return false;
    if (rad.endsWith('%')) return parseFloat(rad) >= 50;
    return Boolean(r) && parseFloat(rad) >= r.height / 2 - 1;
  }

  /**
   * Tones for one container from the page's native styles (pure reads; no writes).
   * Without layout (no geometry) sizes are unknown: fields are the outermost painted box around
   * an entry, and painted elements are surfaces unless round.
   * @returns {{tones: Map<Element, string>, carried: boolean}}
   */
  function scanTones(view, container, kind) {
    const tones = new Map();
    const cr = rectOf(container);
    const fields = [];
    for (const entry of container.querySelectorAll(TEXT_ENTRY)) {
      if (entry.matches(SKIP_SCAN)) continue;
      const er = cr ? rectOf(entry) : null;
      if (cr && !er) continue; // hidden entry
      let box = null;
      for (let el = entry; el && el !== container; el = el.parentElement) {
        if (el !== entry) {
          if (cr) {
            const r = rectOf(el);
            if (!r || r.height > er.height + FIELD_SLACK) break;
          }
          if (el.querySelectorAll(TEXT_ENTRY).length > 1) break; // a group of fields, not one
        }
        const p = paintOf(view, el);
        if (p.filled || p.bordered) box = el;
      }
      if (box && !tones.has(box)) {
        tones.set(box, 'field');
        fields.push(box);
      }
    }

    let carried = false;
    const all = container.getElementsByTagName('*');
    const n = Math.min(all.length, MAX_SCAN);
    for (let i = 0; i < n; i++) {
      const el = all[i];
      if (tones.has(el) || el.matches(SKIP_SCAN) || fields.some((f) => f.contains(el))) continue;
      const p = paintOf(view, el);
      if (el.matches(':hover')) {
        // Hover paints native (and our own) backgrounds for a moment; keep whatever it was.
        const prev = el.getAttribute(TONE_ATTR);
        if (TONES.includes(prev)) tones.set(el, prev);
        if (Boolean(prev) !== p.filled) carried = true;
        continue;
      }
      if (!p.filled) continue;
      const r = cr ? rectOf(el) : null;
      if (cr && !r) continue;
      if (isCircle(p, r)) tones.set(el, 'keep');
      else if (r && (kind === 'top' ? r.height >= cr.height * TOP_LAYER : r.height > SIDE_LAYER)) tones.set(el, 'layer');
      else tones.set(el, 'surface');
    }
    return { tones, carried };
  }

  /**
   * The shell that frames the page beside the sidebar (their nearest common ancestor) and the
   * opaque card that holds the page inside it. Without such a card the page would show through,
   * so nothing is returned and the shell keeps its native color.
   */
  function findFrame(doc, view, side) {
    const main = native.findBannerContainer(doc);
    if (!side || !main || side.contains(main) || main.contains(side)) return null;
    let shell = side.parentElement;
    while (shell && !shell.contains(main)) shell = shell.parentElement;
    if (!shell || shell === doc.body || shell === doc.documentElement) return null;
    let card = null;
    for (let el = main; el && el !== shell; el = el.parentElement) {
      if (alphaOf(view.getComputedStyle(el).backgroundColor) >= OPAQUE) card = el;
    }
    return card ? { shell, card } : null;
  }

  /* ------------------------------------------------------------------ feature */

  function createFeature(win) {
    let appearance = null; // sanitized storage value; null until the first read finishes
    let loadSeq = 0;
    let lastCtx = null;
    let force = false;
    let recheckTimer = null;
    const scanned = new WeakMap(); // container → {sig, at}

    function area() {
      const c = win.chrome;
      return c && c.storage && c.storage.local ? c.storage.local : null;
    }

    function load() {
      const seq = ++loadSeq;
      const a = area();
      if (!a) {
        appearance = colors.emptyAppearance();
        return Promise.resolve();
      }
      return Promise.resolve()
        .then(() => a.get(colors.STORAGE_KEY))
        .then(
          (got) => {
            if (seq !== loadSeq) return;
            appearance = colors.sanitizeAppearance(got && got[colors.STORAGE_KEY]);
            if (lastCtx) apply(lastCtx);
          },
          () => {
            if (seq === loadSeq && !appearance) appearance = colors.emptyAppearance();
          }
        );
    }

    function wanted(ctx) {
      const doc = ctx.doc || win.document;
      const href = (doc.defaultView || win).location.href;
      const id = colors.pageWorkspaceId({
        href,
        connectionWorkspaceId: ctx.connection && ctx.connection.workspaceId,
        contextWorkspaceId: ctx.workspaceId,
      });
      return colors.resolveColor(appearance, ctx.origin, id.id);
    }

    function ensureStyle(doc, css) {
      const parent = doc.head || doc.documentElement;
      const found = doc.querySelectorAll(STYLE_SELECTOR);
      for (let i = 1; i < found.length; i++) found[i].remove();
      let style = found[0] || null;
      if (!style) {
        style = doc.createElement('style');
        style.setAttribute('data-dcc', 'theme');
        style.textContent = css;
        parent.appendChild(style);
        return;
      }
      if (style.textContent !== css) style.textContent = css;
      if (!style.isConnected || !parent.contains(style)) parent.appendChild(style);
    }

    /** @param {Array<[Element|null, string]>} wantedMarks */
    function mark(doc, wantedMarks) {
      const want = new Map(wantedMarks.filter(([el]) => el));
      for (const el of doc.querySelectorAll(MARKED)) if (!want.has(el)) el.removeAttribute(MARK_ATTR);
      for (const [el, kind] of want) {
        if (el.getAttribute(MARK_ATTR) === kind) continue;
        el.setAttribute(MARK_ATTR, kind);
        scanned.delete(el); // newly themed: scan it now
      }
    }

    function writeTones(container, tones) {
      for (const el of container.querySelectorAll('[' + TONE_ATTR + ']')) if (!tones.has(el)) el.removeAttribute(TONE_ATTR);
      for (const [el, t] of tones) if (el.getAttribute(TONE_ATTR) !== t) el.setAttribute(TONE_ATTR, t);
    }

    /** Revisit hovered elements later; only this feature re-runs, not a whole page tick. */
    function scheduleRecheck() {
      if (recheckTimer !== null) return;
      recheckTimer = win.setTimeout(() => {
        recheckTimer = null;
        force = true;
        if (lastCtx) apply(lastCtx);
      }, RECHECK);
    }

    function toneContainer(doc, container, kind) {
      const view = doc.defaultView || win;
      const html = doc.documentElement;
      const sig = [container.getElementsByTagName('*').length, view.location.href, html.getAttribute('class') || '', (doc.body && doc.body.getAttribute('class')) || ''].join('|');
      const last = scanned.get(container);
      const now = Date.now();
      if (!force && last && last.sig === sig && now - last.at < MAX_AGE) return;
      const { tones, carried } = scanTones(view, container, kind);
      scanned.set(container, { sig, at: now });
      writeTones(container, tones);
      if (carried) scheduleRecheck();
    }

    function clear(doc) {
      for (const el of doc.querySelectorAll(MARKED)) el.removeAttribute(MARK_ATTR);
      for (const el of doc.querySelectorAll('[' + TONE_ATTR + ']')) el.removeAttribute(TONE_ATTR);
      for (const s of doc.querySelectorAll(STYLE_SELECTOR)) s.remove();
    }

    /** Bring the DOM in line with the saved color. No writes when it already matches. */
    function apply(ctx) {
      lastCtx = ctx;
      if (!appearance) return null; // first storage read still pending: leave the page as is
      const doc = ctx.doc || win.document;
      const hit = wanted(ctx);
      const css = hit ? buildCss(colors.themeFor(hit.color)) : null;
      if (!css) {
        clear(doc);
        return null;
      }
      ensureStyle(doc, css);
      const view = doc.defaultView || win;
      const top = native.findTopNav(doc);
      const side = hit.sidebar ? native.findSideNav(doc, top) : null;
      const frame = side ? findFrame(doc, view, side) : null;
      mark(doc, [
        [top, 'top'],
        [side, 'side'],
        [frame && frame.shell, 'shell'],
        [frame && frame.card, 'card'],
      ]);
      if (top) toneContainer(doc, top, 'top');
      if (side) toneContainer(doc, side, 'side');
      force = false;
      // Tones left behind by a container that is no longer themed (sidebar turned off, bar swapped).
      for (const el of doc.querySelectorAll('[' + TONE_ATTR + ']')) if (!el.closest(BAR)) el.removeAttribute(TONE_ATTR);
      return hit;
    }

    // Start reading storage right away so the first apply doesn't wait on the service worker.
    load();

    return {
      name: FEATURE_NAME,
      onStart: apply,
      onTick: apply,
      onRoute: apply,
      onSettings: apply,
      onAppearance(ctx) {
        lastCtx = ctx;
        load();
      },
    };
  }

  const api = Object.freeze({ FEATURE_NAME, MARK_ATTR, TONE_ATTR, STYLE_SELECTOR, buildCss, alphaOf, scanTones, createFeature });
  if (NODE) module.exports = api;
  else {
    const DCC = root.DCC || (root.DCC = {});
    DCC.workspaceTheme = api;
    const list = DCC.features || (DCC.features = []);
    // Re-injection into an open tab re-runs this file in the same world; register only once.
    if (!list.some((f) => f && f.name === FEATURE_NAME)) list.push(createFeature(root));
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
