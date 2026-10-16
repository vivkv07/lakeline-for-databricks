/*
 * Result cache with in-flight request deduplication. Keys isolate by origin, connection
 * revision, settings revision, kind, period, resource/run, view/filter and source. Entries
 * expire after ~5 minutes. Meaningful zero is a value; missing is the absence of an entry.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;

  const DEFAULT_TTL = 5 * 60 * 1000;

  function key(parts) {
    const order = ['origin', 'workspaceId', 'source', 'connRev', 'kind', 'periodDays', 'scope'];
    return order.map((k) => k + '=' + (parts[k] === undefined || parts[k] === null ? '' : String(parts[k]))).join('|');
  }

  function create({ ttlMs = DEFAULT_TTL, now = () => Date.now(), maxEntries = 2000 } = {}) {
    const entries = new Map();
    const inflight = new Map();

    function get(k) {
      const e = entries.get(k);
      if (!e) return undefined;
      if (now() - e.at > ttlMs) {
        entries.delete(k);
        return undefined;
      }
      return e.value;
    }

    function set(k, value) {
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entries.set(k, { value, at: now() });
    }

    /**
     * Return a cached value, join an in-flight request, or start one. `isCurrent()` is checked
     * when the work finishes; results from outdated settings are returned to nobody's cache.
     */
    async function dedupe(k, work, { force = false, isCurrent = () => true } = {}) {
      if (!force) {
        const hit = get(k);
        if (hit !== undefined) return { value: hit, cached: true };
      }
      if (inflight.has(k)) return { value: await inflight.get(k), cached: false, joined: true };
      const p = (async () => work())();
      inflight.set(k, p);
      try {
        const value = await p;
        if (isCurrent()) set(k, value);
        return { value, cached: false, stale: !isCurrent() };
      } finally {
        inflight.delete(k);
      }
    }

    function clear(prefix) {
      for (const k of [...entries.keys()]) if (!prefix || k.startsWith(prefix)) entries.delete(k);
    }

    return { get, set, dedupe, clear, size: () => entries.size, inflightCount: () => inflight.size };
  }

  const api = Object.freeze({ DEFAULT_TTL, key, create });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).cache = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
