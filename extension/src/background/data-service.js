/*
 * Data service: answers cost requests for one workspace in the selected mode.
 *   demo      — synthetic data, no network
 *   import    — validated local import only
 *   connected — read-only SQL via PAT (service worker) or the local helper (CLI OAuth)
 * Caches ~5 minutes, deduplicates in-flight work, and discards results that finished after the
 * connection or settings changed.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const errors = dep('errors', '../errors.js');
  // Looked up when used: oauth.js may load after this file in the service worker.
  const DCC_OAUTH = () => (NODE ? require('./oauth.js') : root.DCC.oauth);
  const V = dep('validate', '../core/validate.js');
  const config = dep('config', '../databricks/config.js');
  const http = dep('http', '../databricks/http.js');
  const result = dep('result', '../databricks/result.js');
  const warehouses = dep('warehouses', '../databricks/warehouses.js');
  const demo = dep('demo', '../core/demo-data.js');
  const importData = dep('importData', '../core/import-data.js');
  const cacheMod = dep('cache', './cache.js');
  const registry = NODE ? require('../databricks/queries/index.js') : root.DCC.queries.registry;

  const DIRECT_MODES = Object.freeze(['oauth', 'pat', 'session']);

  function create({ store, secrets, helper, oauth, sessionTransport, fetch: doFetch, now = () => Date.now(), cache = cacheMod.create({ now }) }) {
    /**
     * HTTP client for direct (non-helper) modes. Browser login relays through an open workspace
     * tab and carries no token; OAuth and PAT send a bearer token from session storage.
     */
    async function clientFor(origin, authMode, { onHeaders, purpose = 'cost', scope = null } = {}) {
      const s = scope === 'genie' ? 'genie' : null; // a Genie client reaches only Genie paths
      if (authMode === 'session') {
        const flags = NODE ? null : root.DCC.flags;
        if (!sessionTransport || (flags && flags.sessionLogin === false)) throw new errors.DccError({ code: 'SESSION_REJECTED', message: 'Browser login is not available in this build' });
        return http.create({ origin, token: null, fetch: sessionTransport.fetchFor(origin, { scope: s }), onHeaders, scope: s });
      }
      return http.create({ origin, token: await directToken(origin, authMode, purpose), fetch: doFetch, onHeaders, scope: s });
    }

    /** Bearer token for direct (non-helper) modes: a session PAT or a Sign in with Databricks token. */
    async function directToken(origin, authMode, purpose = 'cost') {
      if (authMode === 'oauth') {
        if (!oauth) throw new errors.DccError({ code: 'AUTH_EXPIRED', message: 'Sign-in unavailable' });
        const settings = await store.getSettings();
        const conn = await store.getConnection(origin);
        return oauth.getAccessToken(origin, purpose, { clientId: DCC_OAUTH().effectiveClientId(conn, settings) });
      }
      const token = await secrets.getPat(origin);
      if (!token) throw new errors.DccError({ code: 'AUTH_EXPIRED', message: 'No access token in this browser session' });
      return token;
    }

    /** Executor for PAT mode: one statement → parsed rows. */
    async function patExec(conn) {
      const client = await clientFor(conn.origin, conn.authMode);
      const warehouseId = config.effectiveWarehouseId(conn);
      return async (query) => {
        const res = await http.executeStatement(client, { warehouseId, statement: query.statement, parameters: query.parameters, rowLimit: query.rowLimit });
        return result.parseResult(res, { maxRows: query.maxRows }).rows;
      };
    }

    async function runConnected(conn, kind, args) {
      if (DIRECT_MODES.includes(conn.authMode)) {
        return registry.run(kind, { conn, args, nowMs: now(), exec: await patExec(conn) });
      }
      await helper.assertCapable(kind, conn, args);
      const out = await helper.call('/bridge/query', {
        origin: conn.origin,
        workspaceId: conn.workspaceId,
        kind,
        args,
        conn: { priceTable: conn.priceTable, usageSource: conn.usageSource, historySource: conn.historySource, currency: conn.currency, warehouseId: config.effectiveWarehouseId(conn), cloud: conn.cloud },
      });
      return out.result;
    }

    /** Resolve the live connection for a validated (origin, workspaceId) pair. */
    async function connectionFor(origin, workspaceId) {
      const conn = await store.getConnection(origin);
      if (!conn) throw new errors.DccError({ code: 'NOT_CONNECTED' });
      if (conn.workspaceId !== workspaceId) throw new errors.DccError({ code: 'WORKSPACE_MISMATCH' });
      if (!config.effectiveWarehouseId(conn)) throw new errors.DccError({ code: 'WAREHOUSE_UNAVAILABLE', message: 'No warehouse resolved' });
      return conn;
    }

    /**
     * Generic cached query for the connected mode.
     * @param {{origin, workspaceId, kind, periodDays?, scope?, args, force?}} req
     */
    async function connectedQuery(req) {
      const conn = await connectionFor(req.origin, req.workspaceId);
      const settings = await store.getSettings();
      const k = cacheMod.key({ origin: conn.origin, workspaceId: conn.workspaceId, source: conn.authMode + ':' + conn.priceTable + ':' + conn.currency, connRev: conn.revision, kind: req.kind, periodDays: req.periodDays, scope: req.scope });
      const out = await cache.dedupe(k, () => runConnected(conn, req.kind, req.args), { force: req.force });
      // Discard results that completed after the connection or settings changed; the caller
      // re-requests with the new settings (content scripts watch storage changes).
      const latest = await store.getConnection(conn.origin);
      const latestSettings = await store.getSettings();
      if (!latest || latest.revision !== conn.revision || latestSettings.mode !== settings.mode) {
        cache.clear(k);
        return { stale: true };
      }
      return Object.assign({}, out.value, { cached: out.cached });
    }

    async function summary({ origin, workspaceId, periodDays, force }) {
      if (!V.isPeriodDays(periodDays)) throw new errors.DccError({ code: 'UNKNOWN', message: 'Invalid period' });
      const settings = await store.getSettings();
      if (settings.mode === 'demo') return demo.summary(origin, workspaceId, periodDays, now());
      if (settings.mode === 'import') {
        const data = await store.getImport();
        const s = importData.workspaceSummary(data, origin, workspaceId, periodDays);
        return s || { kind: 'summary', imported: true, pricingBasis: 'import', current: { coverage: 'empty' }, currentAmount: null, previousAmount: null, noImport: true };
      }
      return connectedQuery({ origin, workspaceId, kind: 'summary', periodDays, args: { periodDays }, force });
    }

    /** Batched badge data; refs already sanitized and ≤ 40. */
    async function rows({ origin, workspaceId, periodDays, refs, force }) {
      const settings = await store.getSettings();
      const keyed = refs.map((r) => Object.assign({}, r));
      if (settings.mode === 'demo') return demo.rowAmounts(keyed, periodDays);
      if (settings.mode === 'import') {
        const data = await store.getImport();
        const items = {};
        for (const r of keyed) {
          const hit = /run|update|statement/.test(r.type) ? null : importData.resourceAmount(data, origin, workspaceId, periodDays, r);
          items[r.key] = hit ? { key: r.key, status: 'ok', amount: hit.amount, scope: 'period', attribution: 'import', importBasis: hit.basis, warnings: [] } : { key: r.key, status: 'unavailable', reason: 'not-imported', warnings: [] };
        }
        return { pricingBasis: 'import', currency: (data && data.entries[0] && data.entries[0].currency) || 'USD', items };
      }
      const scope = keyed.map((r) => r.key).sort().join(',');
      return connectedQuery({ origin, workspaceId, kind: 'rows', periodDays, scope, args: { periodDays, refs: keyed }, force });
    }

    /** Any other connected-only kind (query estimates, compute rates, explorer). */
    async function connectedOnly({ origin, workspaceId, kind, periodDays, scope, args, force }) {
      const settings = await store.getSettings();
      if (settings.mode !== 'connected') return { unavailableInMode: settings.mode };
      return connectedQuery({ origin, workspaceId, kind, periodDays, scope, args, force });
    }

    /** Lists warehouses; `onHeaders` sees response headers (x-databricks-org-id = workspace ID). */
    async function listWarehouses({ origin, authMode, onHeaders }) {
      if (DIRECT_MODES.includes(authMode)) return warehouses.list(await clientFor(origin, authMode, { onHeaders }));
      const out = await helper.call('/bridge/warehouses', { origin });
      return (out.warehouses || []).map(warehouses.normalize).filter(Boolean);
    }

    return { summary, rows, connectedOnly, listWarehouses, directToken, clientFor, cache, runConnected, connectionFor };
  }

  const api = Object.freeze({ create });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).dataService = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
