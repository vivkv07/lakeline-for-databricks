/*
 * Workspace top-bar color (content feature). Tints only the native top navigation bar with the
 * color saved for this workspace, through one removable <style data-dcc="theme"> whose rules
 * are scoped to a marker attribute on that bar. Independent of billing: it runs in every mode,
 * with or without a cost connection, and stays active while cost display is paused.
 *
 * Idempotent on every tick: it compares against the live DOM and writes nothing when the bar is
 * already marked and the style text is current, so it can't feed the mutation observer.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const V = dep('validate', '../core/validate.js');
  const colors = dep('workspaceColor', './workspace-color.js');
  const native = dep('native', './native-adapter.js');

  const FEATURE_NAME = 'workspace-theme';
  const MARK_ATTR = 'data-dcc-themed';
  const STYLE_SELECTOR = 'style[data-dcc="theme"]';

  const BAR = '[' + MARK_ATTR + ']';
  // Field-like controls keep a light surface with dark text on any tint. The class hint covers
  // design-system inputs whose border and background sit on a wrapper around the <input>.
  const FIELD = 'input, textarea, select, [role="searchbox"], [role="combobox"], [contenteditable="true"], [class*="input-affix-wrapper"]';
  // Menus and popovers rendered inside the bar keep their own native colors.
  const POPOVER = '[role="menu"], [role="listbox"], [role="dialog"], [role="tooltip"]';
  // Brand graphics, images and avatars (initials on their own colored circle) are never
  // recolored: no fill/stroke rules, and no `color` on SVG. The extension's own elements
  // (banner, badges) are excluded too.
  const GRAPHIC = 'svg, img, [class*="avatar"], [data-dcc]';
  const KEEP = [FIELD, ':is(' + FIELD + ') *', POPOVER, ':is(' + POPOVER + ') *', GRAPHIC, ':is(' + GRAPHIC + ') *'].join(', ');

  /**
   * CSS for one validated theme (from workspaceColor.themeFor). Returns null for anything that
   * isn't a strict #RRGGBB background with a black or white foreground, so arbitrary input can
   * never reach the stylesheet.
   */
  function buildCss(theme) {
    if (!theme || !V.isHexColor(theme.bg) || theme.bg !== theme.bg.toUpperCase()) return null;
    const fixed = colors.themeFor(theme.bg);
    if (!fixed || fixed.fg !== theme.fg) return null;
    const { bg, fg, line, hover } = fixed; // line/hover are constants chosen per foreground
    return [
      '/* Lakeline for Databricks: workspace top-bar color (removable; scoped to the native top bar). */',
      `${BAR} { background-color: ${bg} !important; background-image: none !important; color: ${fg} !important; border-color: ${line} !important; }`,
      // Text and icon controls follow the chosen foreground; icons drawn with currentColor
      // follow it through inheritance. Explicit SVG fills (logos) are untouched.
      `${BAR} *:not(${KEEP}) { color: ${fg} !important; }`,
      `${BAR} :is(button, [role="button"], a):not(${KEEP}):hover { background-color: ${hover} !important; }`,
      // Search and other fields stay light with dark text so they remain readable.
      `${BAR} :is(${FIELD}) { background-color: #FFFFFF !important; color: #1F2933 !important; border-color: rgba(31, 41, 51, 0.32) !important; }`,
      `${BAR} :is(${FIELD}) * { color: #1F2933 !important; }`,
      `${BAR} :is(input, textarea)::placeholder { color: #52606D !important; opacity: 1 !important; }`,
      `${BAR} :focus-visible { outline-color: ${fg} !important; }`,
    ].join('\n');
  }

  function createFeature(win) {
    let appearance = null; // sanitized storage value; null until the first read finishes
    let loadSeq = 0;
    let lastCtx = null;

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

    function mark(doc, nav) {
      for (const el of doc.querySelectorAll(BAR)) if (el !== nav) el.removeAttribute(MARK_ATTR);
      if (nav && !nav.hasAttribute(MARK_ATTR)) nav.setAttribute(MARK_ATTR, '');
    }

    function clear(doc) {
      for (const el of doc.querySelectorAll(BAR)) el.removeAttribute(MARK_ATTR);
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
      mark(doc, native.findTopNav(doc));
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

  const api = Object.freeze({ FEATURE_NAME, MARK_ATTR, STYLE_SELECTOR, buildCss, createFeature });
  if (NODE) module.exports = api;
  else {
    const DCC = root.DCC || (root.DCC = {});
    DCC.workspaceTheme = api;
    const list = DCC.features || (DCC.features = []);
    // Re-injection into an open tab re-runs this file in the same world; register only once.
    if (!list.some((f) => f && f.name === FEATURE_NAME)) list.push(createFeature(root));
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
