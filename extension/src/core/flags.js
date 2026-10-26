/*
 * Build-time feature flags. The development build enables everything; `node scripts/package.mjs
 * --store` rewrites this file for the store build (see STORE_FLAGS there).
 *
 *   devTools      Developer-only links, such as the local test workspace (127.0.0.1:8765).
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const api = Object.freeze({ devTools: true });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).flags = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
