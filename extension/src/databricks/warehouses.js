/*
 * SQL warehouse listing and Automatic selection. Listing a warehouse does not prove CAN USE or
 * billing-table access; the first SQL execution may still fail and is reported specifically.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const V = NODE ? require('../core/validate.js') : root.DCC.validate;

  const SIZE_ORDER = Object.freeze(['2X-Small', 'X-Small', 'Small', 'Medium', 'Large', 'X-Large', '2X-Large', '3X-Large', '4X-Large', '5X-Large']);
  const UNUSABLE = new Set(['DELETING', 'DELETED']);

  function normalize(raw) {
    if (!raw || !V.isWarehouseId(raw.id)) return null;
    return {
      id: raw.id,
      name: V.safeText(raw.name || raw.id, 200),
      state: V.safeText(raw.state || 'UNKNOWN', 20),
      size: SIZE_ORDER.includes(raw.cluster_size) ? raw.cluster_size : V.safeText(raw.cluster_size || '', 20) || null,
      type: V.safeText(raw.warehouse_type || '', 20) || null,
      serverless: raw.enable_serverless_compute === true,
      minClusters: Number.isInteger(raw.min_num_clusters) ? raw.min_num_clusters : null,
      maxClusters: Number.isInteger(raw.max_num_clusters) ? raw.max_num_clusters : null,
    };
  }

  async function list(http) {
    const out = [];
    let token = null;
    for (let page = 0; page < 10; page++) {
      const res = await http.get('/api/2.0/sql/warehouses', token ? { page_token: token } : undefined);
      for (const w of res.warehouses || []) {
        const n = normalize(w);
        if (n) out.push(n);
      }
      token = res.next_page_token;
      if (!token) break;
    }
    return sortForDisplay(out);
  }

  function sizeRank(size) {
    const i = SIZE_ORDER.indexOf(size);
    return i === -1 ? SIZE_ORDER.length : i;
  }

  function compareAuto(a, b) {
    const ar = a.state === 'RUNNING' ? 0 : 1;
    const br = b.state === 'RUNNING' ? 0 : 1;
    if (ar !== br) return ar - br;
    const s = sizeRank(a.size) - sizeRank(b.size);
    if (s !== 0) return s;
    const n = a.name.localeCompare(b.name, 'en');
    if (n !== 0) return n;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  function sortForDisplay(list) {
    return list.slice().sort(compareAuto);
  }

  /**
   * Automatic choice: a usable RUNNING warehouse first, then the smaller supported size, then
   * name and ID for deterministic ordering. Resolved at save/reconnect, never per query.
   */
  function autoSelect(list) {
    const usable = (list || []).filter((w) => !UNUSABLE.has(w.state));
    if (!usable.length) return null;
    return usable.slice().sort(compareAuto)[0];
  }

  /** Describe the saved selection against the current listing (explicitly shows unavailable). */
  function describeSaved(saved, list) {
    if (!saved) return { status: 'none' };
    const id = saved.mode === 'manual' ? saved.id : saved.resolvedId;
    if (!id) return { status: 'unresolved', mode: saved.mode };
    const found = (list || []).find((w) => w.id === id);
    if (!found) return { status: 'unavailable', mode: saved.mode, id, name: saved.name || saved.resolvedName || null };
    if (UNUSABLE.has(found.state)) return { status: 'unavailable', mode: saved.mode, id, name: found.name };
    return { status: 'ok', mode: saved.mode, id, name: found.name, state: found.state };
  }

  const api = Object.freeze({ SIZE_ORDER, normalize, list, autoSelect, describeSaved, sortForDisplay, sizeRank });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).warehouses = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
