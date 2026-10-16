/*
 * Build-time feature flags. The development build enables everything; `node scripts/package.mjs
 * --store` rewrites this file for the Chrome Web Store build (see STORE_FLAGS there).
 *
 *   sessionLogin  "Use my Databricks login" (experimental browser-login sign-in). Databricks'
 *                 public API rejected browser-session calls on a tested workspace, so the store
 *                 build hides it in the UI and the background refuses the method.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const api = Object.freeze({ sessionLogin: true });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).flags = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
