/*
 * Content-side badge data client. Keeps one item map per (period, connection settings) context,
 * deduplicates references and in-flight requests, and sends batches of at most 40 references
 * through the workspace-data client. A context change (period, route, settings, pause) resets
 * the map and drops in-flight responses, so a late answer for the old period never renders.
 *
 * Entry states: pending → ready | error | paused. Ready entries are refreshed after `ttlMs`
 * (the old value stays visible meanwhile); errors are retried after `errorRetryMs`.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const ids = NODE ? require('../core/ids.js') : root.DCC.ids;

  const MAX_BATCH = 40;

  /**
   * @param {object} o
   * @param {object} o.data        workspace-data client ({rows, invalidate})
   * @param {Function} [o.onUpdate] called after any response changes entries
   */
  function create({ data, onUpdate = () => {}, maxBatch = MAX_BATCH, maxInFlight = 3, ttlMs = 5 * 60 * 1000, errorRetryMs = 60 * 1000, staleRetryMs = 2000, maxEntries = 3000, now = () => Date.now(), channel = 'inline' }) {
    const batchSize = Math.max(1, Math.min(MAX_BATCH, maxBatch));
    let gen = 0;
    let contextSig = null;
    let periodDays = null;
    let entries = new Map();
    let queue = [];
    const queued = new Set();
    const inFlight = new Set();
    const slots = new Array(Math.max(1, maxInFlight)).fill(null);
    const stats = { requests: 0, refsSent: 0 };

    const slotChannel = (i) => channel + ':' + i;

    /** Drop everything; in-flight responses for the old generation are ignored. */
    function reset() {
      gen += 1;
      entries = new Map();
      queue = [];
      queued.clear();
      inFlight.clear();
      for (let i = 0; i < slots.length; i++) {
        if (slots[i]) data.invalidate(slotChannel(i));
        slots[i] = null;
      }
    }

    /** Bind the map to a (period, settings) signature; any change resets it. */
    function setContext(sig, days) {
      if (sig === contextSig && days === periodDays) return false;
      reset();
      contextSig = sig;
      periodDays = days;
      return true;
    }

    function get(key) {
      return entries.get(key) || null;
    }

    function wants(key) {
      if (queued.has(key) || inFlight.has(key)) return false;
      const e = entries.get(key);
      if (!e) return true;
      const age = now() - e.at;
      if (e.state === 'ready') return age >= ttlMs;
      if (e.state === 'error') return age >= errorRetryMs;
      if (e.state === 'retry') return age >= staleRetryMs;
      return false; // pending, paused
    }

    /** Request any references not cached, queued or in flight. */
    function ensure(refs) {
      if (periodDays === null) return 0;
      let added = 0;
      for (const r of refs || []) {
        const clean = ids.sanitizeRef(r);
        const key = clean && ids.refKey(clean);
        if (!key || !wants(key)) continue;
        const e = entries.get(key);
        if (!e || e.state !== 'ready') entries.set(key, { state: 'pending', at: now() });
        queued.add(key);
        queue.push({ key, ref: clean });
        added += 1;
      }
      if (added) pump();
      return added;
    }

    function pump() {
      for (let i = 0; i < slots.length && queue.length; i++) {
        if (slots[i]) continue;
        const batch = queue.splice(0, batchSize);
        const token = { gen, keys: batch.map((b) => b.key) };
        for (const k of token.keys) {
          queued.delete(k);
          inFlight.add(k);
        }
        slots[i] = token;
        stats.requests += 1;
        stats.refsSent += batch.length;
        let pending;
        try {
          pending = Promise.resolve(data.rows(slotChannel(i), periodDays, batch.map((b) => b.ref)));
        } catch (e) {
          pending = Promise.reject(e);
        }
        pending.then(
            (res) => settle(i, token, res),
            () => settle(i, token, { ok: false, error: { code: 'UNKNOWN', title: 'Cost request failed', steps: [] } })
          );
      }
    }

    function settle(i, token, res) {
      if (token.gen !== gen) return; // superseded by a reset; that slot was already released
      slots[i] = null;
      const at = now();
      for (const k of token.keys) inFlight.delete(k);
      if (res && res.stale) {
        for (const k of token.keys) {
          const e = entries.get(k);
          if (!e || e.state !== 'ready') entries.set(k, { state: 'retry', at });
        }
      } else if (res && res.ok && res.data && res.data.paused) {
        for (const k of token.keys) entries.set(k, { state: 'paused', at });
      } else if (res && res.ok && res.data && res.data.items && typeof res.data.items === 'object') {
        const d = res.data;
        const env = { pricingBasis: d.pricingBasis, priceTable: d.priceTable || null, priceField: d.priceField || null, currency: d.currency, synthetic: Boolean(d.synthetic), periodDays };
        for (const k of token.keys) {
          const item = Object.prototype.hasOwnProperty.call(d.items, k) ? d.items[k] : null;
          entries.set(k, { state: 'ready', at, env, item: item || { key: k, status: 'unavailable', reason: 'missing-from-response', amount: null, warnings: [] } });
        }
      } else {
        const error = (res && res.error) || { code: 'UNKNOWN', title: 'No response', steps: [] };
        for (const k of token.keys) entries.set(k, { state: 'error', at, error });
      }
      trim();
      pump();
      onUpdate();
    }

    /** Bound memory on endless lists: drop the oldest settled entries. */
    function trim() {
      if (entries.size <= maxEntries) return;
      for (const [k, e] of entries) {
        if (entries.size <= Math.floor(maxEntries * 0.75)) break;
        if (e.state !== 'pending' && !inFlight.has(k) && !queued.has(k)) entries.delete(k);
      }
    }

    return {
      setContext,
      reset,
      ensure,
      get,
      stats,
      get periodDays() {
        return periodDays;
      },
      get size() {
        return entries.size;
      },
      get inFlight() {
        return inFlight.size;
      },
    };
  }

  const api = Object.freeze({ MAX_BATCH, create });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).rowData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
