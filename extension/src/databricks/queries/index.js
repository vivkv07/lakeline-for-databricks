/*
 * Registry of named, read-only query kinds. The local helper accepts only these kinds — it
 * never executes caller-supplied SQL text. Each kind exposes build(conn, args, nowMs) and
 * parse(rows, query).
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const KINDS = ['summary', 'rows', 'queryEstimates', 'computeRates', 'exploreSummary', 'exploreEntities', 'exploreRuns'];
  const FILES = {
    summary: './summary.js',
    rows: './row-data.js',
    queryEstimates: './query-history.js',
    computeRates: './compute-rates.js',
    exploreSummary: './explore.js',
    exploreEntities: './explore.js',
    exploreRuns: './explore.js',
  };

  function get(kind) {
    if (!KINDS.includes(kind)) return null;
    let mod = null;
    if (NODE) {
      try {
        mod = require(FILES[kind]);
      } catch (e) {
        if (e && e.code === 'MODULE_NOT_FOUND') return null;
        throw e;
      }
    } else {
      mod = root.DCC.queries && root.DCC.queries[kind.startsWith('explore') ? 'explore' : kind];
    }
    if (!mod) return null;
    // explore.js exposes several kinds; others expose build/parse directly.
    return mod.kinds ? mod.kinds[kind] || null : mod;
  }

  /**
   * Run a kind with an injected executor. `ctx.exec(query)` executes one statement and resolves
   * to parsed rows. Kinds with multiple statements implement run(); others build → exec → parse.
   * @param {string} kind
   * @param {{conn, args, nowMs, exec}} ctx
   */
  async function run(kind, ctx) {
    const mod = get(kind);
    if (!mod) throw new Error('Unknown query kind');
    if (typeof mod.run === 'function') return mod.run(ctx);
    const query = mod.build(ctx.conn, ctx.args || {}, ctx.nowMs);
    const rows = await ctx.exec(query);
    return mod.parse(rows, query);
  }

  const api = Object.freeze({ KINDS, get, run });
  if (NODE) module.exports = api;
  else ((root.DCC || (root.DCC = {})).queries || (root.DCC.queries = {})).registry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
