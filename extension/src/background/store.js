/*
 * Non-secret persistent state in chrome.storage.local, with schema migration.
 *   dcc.settings     — mode, period, cost visibility, monitor and Genie prefs (revisioned)
 *   dcc.connections  — one cost connection per workspace origin (revisioned)
 *   dcc.observed     — workspace IDs observed in tab URLs, per origin
 *   dcc.import       — validated local import
 *   dcc.diagnostics  — last sanitized errors
 * Appearance prefs live in their own key (dcc.appearance, see workspace-appearance) and are
 * never touched by billing connection changes.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const V = NODE ? require('../core/validate.js') : root.DCC.validate;
  const config = NODE ? require('../databricks/config.js') : root.DCC.config;

  const KEYS = Object.freeze({
    settings: 'dcc.settings',
    connections: 'dcc.connections',
    observed: 'dcc.observed',
    importData: 'dcc.import',
    diagnostics: 'dcc.diagnostics',
  });
  const SCHEMA_VERSION = 3;
  const MODES = Object.freeze(['demo', 'import', 'connected']);
  // Genie: a remembered agent per workspace origin ('demo' is the Demo-mode workspace). Agent IDs
  // are 32 hex or a hyphenated UUID (notes/GENIE.md). Never any question or answer text here.
  const GENIE_ORIGIN = /^(?:demo|https:\/\/[a-z0-9.-]{1,253}|http:\/\/127\.0\.0\.1:8765)$/;
  const GENIE_SPACE = /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
  const GENIE_LAST_SPACE_CAP = 20;

  function migrateGenie(raw) {
    const g = raw && typeof raw === 'object' ? raw : {};
    const last = {};
    const src = g.lastSpace && typeof g.lastSpace === 'object' && !Array.isArray(g.lastSpace) ? g.lastSpace : {};
    for (const [origin, space] of Object.entries(src)) {
      if (Object.keys(last).length >= GENIE_LAST_SPACE_CAP) break;
      if (GENIE_ORIGIN.test(origin) && typeof space === 'string' && GENIE_SPACE.test(space)) last[origin] = space;
    }
    return { notify: g.notify === true, lastSpace: last };
  }

  function defaultSettings() {
    return {
      schemaVersion: SCHEMA_VERSION,
      mode: 'connected',
      periodDays: 30,
      showCosts: true,
      monitor: { enabled: false, autoOpen: false, notifyFailures: false, intervalSec: 60, origin: null },
      genie: { notify: false, lastSpace: {} },
      oauth: { clientId: null },
      revision: 1,
    };
  }

  /**
   * Migrate any earlier shape to the current schema. v1 stored `paused` instead of `showCosts`
   * and `period` instead of `periodDays`; v2 had no `genie` prefs (defaults: notify off, no
   * remembered agents). Unknown fields are dropped; invalid values fall back.
   */
  function migrateSettings(raw) {
    const d = defaultSettings();
    if (!raw || typeof raw !== 'object') return d;
    const out = Object.assign({}, d);
    const period = raw.periodDays !== undefined ? raw.periodDays : raw.period;
    out.periodDays = V.isPeriodDays(period) ? period : d.periodDays;
    out.mode = MODES.includes(raw.mode) ? raw.mode : d.mode;
    if (typeof raw.showCosts === 'boolean') out.showCosts = raw.showCosts;
    else if (typeof raw.paused === 'boolean') out.showCosts = !raw.paused;
    const m = raw.monitor && typeof raw.monitor === 'object' ? raw.monitor : {};
    out.monitor = {
      enabled: m.enabled === true,
      autoOpen: m.autoOpen === true,
      notifyFailures: m.notifyFailures === true,
      intervalSec: [60, 120, 300].includes(m.intervalSec) ? m.intervalSec : 60,
      origin: typeof m.origin === 'string' ? m.origin : null,
    };
    out.genie = migrateGenie(raw.genie);
    const oa = raw.oauth && typeof raw.oauth === 'object' ? raw.oauth : {};
    out.oauth = { clientId: typeof oa.clientId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/.test(oa.clientId) ? oa.clientId : null };
    out.revision = Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1;
    out.schemaVersion = SCHEMA_VERSION;
    return out;
  }

  /** Keep only connections that still validate; preserve their revision and warehouse choice. */
  function migrateConnections(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [origin, c] of Object.entries(raw)) {
      const v = config.validateConnection(Object.assign({}, c, { origin }));
      if (!v.ok) continue;
      out[v.value.origin] = Object.assign(v.value, {
        revision: Number.isInteger(c.revision) ? c.revision : 1,
        savedAt: Number.isFinite(c.savedAt) ? c.savedAt : Date.now(),
      });
    }
    return out;
  }

  function create(area) {
    async function read(key, fallback) {
      const got = await area.get(key);
      return got && got[key] !== undefined ? got[key] : fallback;
    }

    const store = {
      KEYS,
      async migrate() {
        const settings = migrateSettings(await read(KEYS.settings, null));
        const connections = migrateConnections(await read(KEYS.connections, {}));
        await area.set({ [KEYS.settings]: settings, [KEYS.connections]: connections });
        return { settings, connections };
      },
      async getSettings() {
        return migrateSettings(await read(KEYS.settings, null));
      },
      /** Patch validated fields only; bumps revision so in-flight results from old settings are discarded. */
      async updateSettings(patch) {
        const cur = await store.getSettings();
        const g = patch && patch.genie && typeof patch.genie === 'object' ? patch.genie : {};
        const genie = Object.assign({}, cur.genie, g, { lastSpace: Object.assign({}, cur.genie.lastSpace, g.lastSpace && typeof g.lastSpace === 'object' ? g.lastSpace : {}) });
        const next = migrateSettings(Object.assign({}, cur, patch, { monitor: Object.assign({}, cur.monitor, patch && patch.monitor), genie, oauth: Object.assign({}, cur.oauth, patch && patch.oauth) }));
        next.revision = cur.revision + 1;
        await area.set({ [KEYS.settings]: next });
        return next;
      },
      async getConnections() {
        return migrateConnections(await read(KEYS.connections, {}));
      },
      async getConnection(origin) {
        const all = await store.getConnections();
        return all[origin] || null;
      },
      /**
       * Save a connection. Preserves a saved Automatic/manual choice unless the caller sends a
       * new one. Returns {ok, value} or {ok:false, errors}.
       */
      async saveConnection(input) {
        const all = await store.getConnections();
        const prev = all[input && input.origin] || null;
        const merged = Object.assign({}, prev || {}, input);
        if (!input.warehouse && prev) merged.warehouse = prev.warehouse;
        const v = config.validateConnection(merged);
        if (!v.ok) return v;
        const value = Object.assign(v.value, { revision: prev ? prev.revision + 1 : 1, savedAt: Date.now() });
        all[value.origin] = value;
        await area.set({ [KEYS.connections]: all });
        return { ok: true, value };
      },
      async removeConnection(origin) {
        const all = await store.getConnections();
        delete all[origin];
        await area.set({ [KEYS.connections]: all });
      },
      async recordObserved(origin, workspaceId) {
        if (!V.isWorkspaceId(workspaceId)) return;
        const all = await read(KEYS.observed, {});
        all[origin] = { workspaceId, seenAt: Date.now() };
        await area.set({ [KEYS.observed]: all });
      },
      async getObserved(origin) {
        const all = await read(KEYS.observed, {});
        return all[origin] || null;
      },
      async getAllObserved() {
        return read(KEYS.observed, {});
      },
      async setImport(value) {
        await area.set({ [KEYS.importData]: value });
      },
      async getImport() {
        return read(KEYS.importData, null);
      },
      async clearImport() {
        await area.remove(KEYS.importData);
      },
      async recordDiagnostic(entry) {
        const list = await read(KEYS.diagnostics, []);
        list.unshift(Object.assign({ at: Date.now() }, entry));
        await area.set({ [KEYS.diagnostics]: list.slice(0, 20) });
      },
      async getDiagnostics() {
        return read(KEYS.diagnostics, []);
      },
      async clearDiagnostics() {
        await area.set({ [KEYS.diagnostics]: [] });
      },
    };
    return store;
  }

  const api = Object.freeze({ KEYS, SCHEMA_VERSION, MODES, create, defaultSettings, migrateSettings, migrateConnections, migrateGenie });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).store = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
