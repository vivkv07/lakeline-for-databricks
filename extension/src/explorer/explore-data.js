/*
 * Explorer data client (content side). Only explicit user actions call load(); nothing here
 * runs SQL automatically. Adds a client-side 5-minute cache and in-flight request dedupe on top
 * of workspace-data's dcc:query channel. Non-connected modes:
 *   demo   → synthetic Explorer data (explore-demo.js), labeled DEMO, no request sent
 *   import → 'unavailable' (imported summaries contain no resource or run detail)
 * Cache keys isolate origin, workspace, mode, price source, kind, period and scope.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const V = dep('validate', '../core/validate.js');
  const model = dep('exploreModel', './explore-model.js');
  const demo = dep('exploreDemo', './explore-demo.js');

  const TTL_MS = 5 * 60 * 1000;
  const KINDS = Object.freeze(['exploreSummary', 'exploreEntities', 'exploreRuns']);

  /**
   * @param {{now?:()=>number}} [o]
   */
  function create(o = {}) {
    const now = o.now || (() => Date.now());
    const cache = new Map();
    const inflight = new Map();

    function modeFor(ctx, summary) {
      return model.modeOf(summary, ctx && ctx.settings && ctx.settings.mode);
    }

    function keyOf(ctx, mode, kind, args, scope) {
      const c = (ctx && ctx.connection) || {};
      return [ctx.origin, ctx.workspaceId, mode, c.priceTable || '', c.currency || '', kind, args.periodDays, scope || ''].join('|');
    }

    function fresh(entry) {
      return entry && now() - entry.at < TTL_MS;
    }

    function demoValue(ctx, kind, args, summary) {
      const t = summary && summary.latestUsageMs ? summary.latestUsageMs + 3 * 3600 * 1000 : now();
      if (kind === 'exploreEntities') return demo.entities(ctx.origin, ctx.workspaceId, args.periodDays, t);
      if (kind === 'exploreRuns') return demo.runs(ctx.origin, ctx.workspaceId, args.periodDays, t, args.jobId || null);
      return demo.ownerSummary(summary);
    }

    function validate(kind, args) {
      if (!KINDS.includes(kind)) throw new Error('Unknown Explorer kind');
      if (!V.isPeriodDays(args && args.periodDays)) throw new Error('Unsupported period');
      if (args.jobId !== undefined && args.jobId !== null && !V.isNumericId(args.jobId)) throw new Error('Invalid job ID');
    }

    /** Cached result without sending anything (used when the panel re-mounts). */
    function peek(ctx, kind, args, scope, summary) {
      validate(kind, args);
      const mode = modeFor(ctx, summary);
      const hit = cache.get(keyOf(ctx, mode, kind, args, scope));
      return fresh(hit) ? { status: 'ok', value: hit.value, cached: true } : null;
    }

    /**
     * @returns {Promise<{status:'ok', value, cached?, synthetic?} | {status:'unavailable', mode} |
     *   {status:'error', error} | {status:'paused'} | {status:'stale'}>}
     */
    function load(ctx, kind, args, scope, opts = {}) {
      validate(kind, args);
      const summary = opts.summary || null;
      const mode = modeFor(ctx, summary);
      if (mode === 'import') return Promise.resolve({ status: 'unavailable', mode });
      const key = keyOf(ctx, mode, kind, args, scope);
      const hit = cache.get(key);
      if (!opts.force && fresh(hit)) return Promise.resolve({ status: 'ok', value: hit.value, cached: true, synthetic: Boolean(hit.value && hit.value.synthetic) });
      if (mode === 'demo') {
        const value = demoValue(ctx, kind, args, summary);
        cache.set(key, { at: now(), value });
        return Promise.resolve({ status: 'ok', value, synthetic: true });
      }
      if (inflight.has(key)) return inflight.get(key);
      const p = Promise.resolve()
        // The 5th argument asks the service worker to bypass its cache too (ignored by clients that don't support it).
        .then(() => ctx.data.query('explore:' + kind + ':' + (scope || ''), kind, Object.assign({}, args), scope || '', Boolean(opts.force)))
        .then((res) => interpret(res, ctx, kind, args, summary, key))
        .catch(() => ({ status: 'error', error: { code: 'UNKNOWN', title: 'Something went wrong', steps: ['Try Load again.'], details: {} } }))
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    }

    function interpret(res, ctx, kind, args, summary, key) {
      if (!res || res.stale) return { status: 'stale' };
      if (!res.ok) return { status: 'error', error: res.error || { code: 'UNKNOWN', title: 'Something went wrong', steps: [] } };
      const data = res.data;
      if (!data) return { status: 'error', error: { code: 'UNKNOWN', title: 'No data returned', steps: ['Try Load again.'] } };
      if (data.paused) return { status: 'paused' };
      if (data.unavailableInMode) {
        if (data.unavailableInMode === 'demo') {
          const value = demoValue(ctx, kind, args, summary);
          return { status: 'ok', value, synthetic: true };
        }
        return { status: 'unavailable', mode: data.unavailableInMode };
      }
      cache.set(key, { at: now(), value: data });
      return { status: 'ok', value: data };
    }

    function clear() {
      cache.clear();
      inflight.clear();
    }

    return { load, peek, clear, keyOf, TTL_MS };
  }

  const shared = create();
  const api = Object.freeze({ create, TTL_MS, KINDS, shared });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).exploreData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
