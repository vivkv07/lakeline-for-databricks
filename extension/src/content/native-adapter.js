/*
 * Native Databricks DOM adapter. All selectors for native structure live here so changes to
 * the workspace UI need one edit. Uses semantic roles and visible geometry; never reads
 * application-private React state.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dom = NODE ? require('./dom.js') : root.DCC.dom;

  const TOP_NAV = ['nav[aria-label="Top Navigation"]', '[data-testid="top-bar"]', '[data-testid="topbar"]', '[data-testid="app-topbar"]'];
  const MAIN = ['[data-testid="main-content"]', 'main', '[role="main"]', '#content'];
  // A main-like region inside a modal is never the banner's home.
  const MODAL = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const OWN = '[data-dcc]';

  function firstVisible(doc, selectors, filter) {
    for (const sel of selectors) {
      for (const el of doc.querySelectorAll(sel)) {
        if (el.closest(OWN)) continue;
        if (filter && !filter(el)) continue;
        if (dom.isVisible(el)) return el;
      }
    }
    return null;
  }

  function findTopNav(doc) {
    return firstVisible(doc, TOP_NAV);
  }

  function rectOf(el) {
    try {
      return el.getBoundingClientRect();
    } catch (_) {
      return null;
    }
  }

  /**
   * Drop candidates that are laid out with no size or entirely outside the viewport (off-canvas
   * route transitions, collapsed panes), so the banner never drifts offscreen. Only applied when
   * the page has real layout; without it (or if everything would be dropped) keep the list.
   */
  function onscreen(doc, candidates) {
    const win = doc.defaultView;
    const rects = candidates.map(rectOf);
    if (!rects.some((r) => r && (r.width > 0 || r.height > 0))) return candidates;
    const vw = (win && win.innerWidth) || Infinity;
    const vh = (win && win.innerHeight) || Infinity;
    const kept = candidates.filter((c, i) => {
      const r = rects[i];
      return r && r.width > 0 && r.height > 0 && r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh;
    });
    return kept.length ? kept : candidates;
  }

  /**
   * Main container that should host the banner as its first child: the innermost visible,
   * on-screen main region outside our own nodes and outside modals.
   * @param {Document} doc
   * @param {{prefer?: Element|null}} [opts] keep this container when it is still a valid
   *   choice, so two equally valid regions (e.g. during a route transition) can't flip-flop.
   */
  function findBannerContainer(doc, opts) {
    const seen = new Set();
    let candidates = [];
    for (const sel of MAIN) {
      for (const el of doc.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.closest(OWN) || el.closest(MODAL)) continue;
        if (dom.isVisible(el)) candidates.push(el);
      }
    }
    if (!candidates.length) return null;
    // Prefer the innermost region (Databricks nests app shells).
    const innermost = candidates.filter((c) => !candidates.some((o) => o !== c && c.contains(o)));
    candidates = onscreen(doc, innermost.length ? innermost : candidates);
    const prefer = opts && opts.prefer;
    if (prefer && candidates.includes(prefer)) return prefer;
    return candidates[0];
  }

  /** Native page title element for detail-page totals (job/pipeline name heading). */
  function findPageTitle(doc) {
    const main = findBannerContainer(doc) || doc.body;
    for (const heading of main.querySelectorAll('[data-testid="page-title"], h1, [role="heading"][aria-level="1"]')) {
      if (!heading.closest(OWN) && dom.isVisible(heading)) return heading;
    }
    return null;
  }

  const api = Object.freeze({ TOP_NAV, MAIN, firstVisible, findTopNav, findBannerContainer, findPageTitle });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).native = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
