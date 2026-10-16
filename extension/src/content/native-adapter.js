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

  /** Main container that should host the banner as its first child. */
  function findBannerContainer(doc) {
    // Prefer the innermost visible main region (Databricks nests app shells).
    const candidates = [];
    for (const sel of MAIN) for (const el of doc.querySelectorAll(sel)) if (!el.closest(OWN) && dom.isVisible(el)) candidates.push(el);
    if (!candidates.length) return null;
    const innermost = candidates.filter((c) => !candidates.some((o) => o !== c && c.contains(o)));
    return innermost[0] || candidates[0];
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
