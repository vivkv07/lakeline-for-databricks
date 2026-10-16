/*
 * Trusted message routing. Every handler declares its trust class; the sender is validated
 * before the handler runs. Responses are {ok:true, data} or {ok:false, error} where error is a
 * sanitized classification. Secrets are never included in any response.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const errors = dep('errors', '../errors.js');
  const V = dep('validate', '../core/validate.js');
  const ids = dep('ids', '../core/ids.js');
  const senderMod = dep('sender', './sender.js');
  const importData = dep('importData', '../core/import-data.js');
  const warehouses = dep('warehouses', '../databricks/warehouses.js');
  const config = dep('config', '../databricks/config.js');

  const MAX_REFS = 40;
  const CONNECTED_KINDS = new Set(['queryEstimates', 'computeRates', 'exploreSummary', 'exploreEntities', 'exploreRuns']);

  /**
   * @param deps {store, secrets, data, helper, chromeApi, extensionId, extensionOrigin, helperPort,
   *              registration, openPage(path), extra?: {[type]: {trust, handle}}}
   */
  function create(deps) {
    const ctx = { extensionId: deps.extensionId, extensionOrigin: deps.extensionOrigin, helperPort: deps.helperPort };

    async function contentCheck(msg, sender) {
      const conn = await deps.store.getConnection(msg && msg.origin);
      const v = senderMod.validateContentSender(sender, msg, Object.assign({}, ctx, { connection: conn }));
      if (!v.ok) throw new errors.DccError({ code: v.reason === 'workspace-id-mismatch' ? 'WORKSPACE_MISMATCH' : 'UNKNOWN', message: 'Rejected sender: ' + v.reason });
      return v;
    }

    /** Our top-frame script on a supported origin; used where the workspace may be unidentified. */
    function contentOriginCheck(msg, sender) {
      if (!sender || sender.id !== deps.extensionId || !sender.tab || sender.frameId !== 0) throw new errors.DccError({ code: 'UNKNOWN', message: 'Rejected sender' });
      const cls = ids.classifyOrigin(sender.url);
      if (!cls.ok || !msg || cls.origin !== msg.origin) throw new errors.DccError({ code: 'UNKNOWN', message: 'Rejected sender origin' });
      return cls;
    }

    function pageCheck(sender, admin) {
      const v = senderMod.validatePageSender(sender, ctx, { admin });
      if (!v.ok) throw new errors.DccError({ code: 'UNKNOWN', message: 'Rejected sender: ' + v.reason });
      return v;
    }

    function publicConnection(c) {
      if (!c) return null;
      return {
        origin: c.origin,
        cloud: c.cloud,
        workspaceId: c.workspaceId,
        authMode: c.authMode,
        priceTable: c.priceTable,
        usageSource: c.usageSource,
        historySource: c.historySource,
        currency: c.currency,
        warehouse: c.warehouse,
        revision: c.revision,
        savedAt: c.savedAt,
      };
    }

    const handlers = {
      /* ---------------------------------------------------------------- content scripts */
      'dcc:hello': {
        trust: 'content-hello',
        async handle(msg, sender) {
          if (!sender || sender.id !== deps.extensionId || !sender.tab || sender.frameId !== 0) throw new errors.DccError({ code: 'UNKNOWN', message: 'Rejected sender' });
          const cls = ids.classifyOrigin(sender.url);
          if (!cls.ok || cls.origin !== msg.origin) throw new errors.DccError({ code: 'UNKNOWN', message: 'Rejected sender origin' });
          const conn = await deps.store.getConnection(cls.origin);
          const observed = await deps.store.getObserved(cls.origin);
          const resolved = ids.resolveWorkspaceId(sender.url, { observedId: observed && observed.workspaceId, savedId: conn && conn.workspaceId });
          if (resolved.id && (String(resolved.source).startsWith('param') || resolved.source === 'host')) {
            await deps.store.recordObserved(cls.origin, resolved.id);
          }
          const settings = await deps.store.getSettings();
          return {
            origin: cls.origin,
            kind: cls.kind,
            workspaceId: resolved.id,
            idSource: resolved.source,
            idConflict: Boolean(resolved.conflict),
            settings: { mode: settings.mode, periodDays: settings.periodDays, showCosts: settings.showCosts, revision: settings.revision },
            connection: conn ? { workspaceId: conn.workspaceId, authMode: conn.authMode, priceTable: conn.priceTable, currency: conn.currency } : null,
            connectionMismatch: Boolean(conn && resolved.id && conn.workspaceId !== resolved.id),
          };
        },
      },
      'dcc:summary': {
        trust: 'content',
        async handle(msg) {
          const settings = await deps.store.getSettings();
          if (!settings.showCosts) return { paused: true };
          return deps.data.summary({ origin: msg.origin, workspaceId: msg.workspaceId, periodDays: msg.periodDays, force: msg.force === true });
        },
      },
      'dcc:rows': {
        trust: 'content',
        async handle(msg) {
          const settings = await deps.store.getSettings();
          if (!settings.showCosts) return { paused: true };
          const refs = sanitizeRefs(msg.refs);
          return deps.data.rows({ origin: msg.origin, workspaceId: msg.workspaceId, periodDays: msg.periodDays, refs, force: msg.force === true });
        },
      },
      'dcc:query': {
        trust: 'content',
        async handle(msg) {
          const settings = await deps.store.getSettings();
          if (!settings.showCosts) return { paused: true };
          if (!CONNECTED_KINDS.has(msg.kind)) throw new errors.DccError({ code: 'UNKNOWN', message: 'Unknown query kind' });
          const args = msg.args && typeof msg.args === 'object' ? msg.args : {};
          return deps.data.connectedOnly({
            origin: msg.origin,
            workspaceId: msg.workspaceId,
            kind: msg.kind,
            periodDays: V.isPeriodDays(args.periodDays) ? args.periodDays : null,
            scope: V.safeText(msg.scope || '', 2000),
            args,
            force: msg.force === true,
          });
        },
      },
      'dcc:setPeriod': {
        trust: 'content',
        async handle(msg) {
          if (!V.isPeriodDays(msg.periodDays)) throw new errors.DccError({ code: 'UNKNOWN', message: 'Invalid period' });
          const s = await deps.store.updateSettings({ periodDays: msg.periodDays });
          return { periodDays: s.periodDays };
        },
      },
      'dcc:resume': {
        // Must work in unidentified/mismatch states, so it checks origin only (it changes no data scope).
        trust: 'content-origin',
        async handle() {
          await deps.store.updateSettings({ showCosts: true });
          return { showCosts: true };
        },
      },
      'dcc:open': {
        trust: 'content-origin',
        async handle(msg) {
          return openNamedPage(msg.page, msg.anchor, msg.origin);
        },
      },

      /* ---------------------------------------------------------------- extension pages */
      'page:state': {
        trust: 'page',
        async handle() {
          const [settings, connections, diagnostics, observed] = await Promise.all([
            deps.store.getSettings(),
            deps.store.getConnections(),
            deps.store.getDiagnostics(),
            deps.store.getAllObserved(),
          ]);
          const conns = {};
          for (const [o, c] of Object.entries(connections)) conns[o] = Object.assign(publicConnection(c), { secrets: await deps.secrets.describe(o) });
          const imp = await deps.store.getImport();
          return {
            settings,
            connections: conns,
            observed,
            diagnostics,
            importSummary: imp ? { entries: imp.entries.length, importedAt: imp.importedAt } : null,
            bridge: await deps.secrets.describe(null),
            extensionId: deps.extensionId,
          };
        },
      },
      'page:updateSettings': {
        trust: 'page',
        async handle(msg) {
          const p = msg.patch || {};
          const patch = {};
          if (p.mode !== undefined) patch.mode = p.mode;
          if (p.periodDays !== undefined) patch.periodDays = p.periodDays;
          if (p.showCosts !== undefined) patch.showCosts = p.showCosts === true;
          if (p.monitor && typeof p.monitor === 'object') {
            patch.monitor = {};
            for (const k of ['enabled', 'autoOpen', 'notifyFailures']) if (p.monitor[k] !== undefined) patch.monitor[k] = p.monitor[k] === true;
            if (p.monitor.intervalSec !== undefined) patch.monitor.intervalSec = p.monitor.intervalSec;
            if (p.monitor.origin !== undefined) patch.monitor.origin = ids.classifyOrigin(p.monitor.origin).ok ? ids.classifyOrigin(p.monitor.origin).origin : null;
          }
          return deps.store.updateSettings(patch);
        },
      },
      'page:clearDiagnostics': { trust: 'page', handle: () => deps.store.clearDiagnostics() },
      'page:open': { trust: 'page', handle: (msg) => openNamedPage(msg.page, msg.anchor, msg.origin) },

      /* ---------------------------------------------------------------- options (admin) */
      'admin:prepare': {
        trust: 'admin',
        async handle(msg) {
          const cls = ids.classifyOrigin(msg.url || msg.origin);
          if (!cls.ok) throw new errors.DccError({ code: 'UNKNOWN', message: 'Not a supported Databricks workspace URL' });
          const observed = await deps.store.getObserved(cls.origin);
          const fromUrl = ids.resolveWorkspaceId(msg.url || cls.origin, {});
          const conn = await deps.store.getConnection(cls.origin);
          const candidates = [...new Set([fromUrl.id, observed && observed.workspaceId, conn && conn.workspaceId].filter(Boolean))];
          return { origin: cls.origin, cloud: cls.cloud, candidates, conflict: Boolean(fromUrl.conflict), connection: publicConnection(conn) };
        },
      },
      'admin:setPat': {
        trust: 'admin',
        async handle(msg) {
          const cls = ids.classifyOrigin(msg.origin);
          if (!cls.ok) throw new errors.DccError({ code: 'UNKNOWN', message: 'Unsupported origin' });
          await deps.secrets.setPat(cls.origin, String(msg.token || '').trim(), { remember: msg.remember === true });
          deps.data.cache.clear();
          return { saved: true };
        },
      },
      'admin:clearPat': {
        trust: 'admin',
        async handle(msg) {
          await deps.secrets.clearPat(msg.origin);
          deps.data.cache.clear();
          return { cleared: true };
        },
      },
      'admin:listWarehouses': {
        trust: 'admin',
        async handle(msg) {
          const cls = ids.classifyOrigin(msg.origin);
          if (!cls.ok || !config.AUTH_MODES.includes(msg.authMode)) throw new errors.DccError({ code: 'UNKNOWN', message: 'Invalid request' });
          if (msg.authMode === 'helper') await deps.helper.assertCapable('summary', { priceTable: 'system.billing.list_prices' }, {});
          const list = await deps.data.listWarehouses({ origin: cls.origin, authMode: msg.authMode });
          const auto = warehouses.autoSelect(list);
          return { origin: cls.origin, requestId: V.safeText(msg.requestId || '', 40), warehouses: list, automatic: auto ? { id: auto.id, name: auto.name } : null };
        },
      },
      'admin:saveConnection': {
        trust: 'admin',
        async handle(msg) {
          const input = Object.assign({}, msg.connection || {});
          const cls = ids.classifyOrigin(input.origin);
          if (!cls.ok) throw new errors.DccError({ code: 'UNKNOWN', message: 'Unsupported origin' });
          input.origin = cls.origin;
          // Resolve Automatic at save time from a fresh listing; never per query.
          if (input.warehouse && input.warehouse.mode === 'auto') {
            const list = await deps.data.listWarehouses({ origin: cls.origin, authMode: input.authMode });
            const auto = warehouses.autoSelect(list);
            if (!auto) throw new errors.DccError({ code: 'WAREHOUSE_UNAVAILABLE', message: 'No usable SQL warehouse is visible to this identity' });
            input.warehouse = { mode: 'auto', resolvedId: auto.id, resolvedName: auto.name };
          }
          if (input.authMode === 'helper') await deps.helper.assertCapable('summary', input, {});
          const res = await deps.store.saveConnection(input);
          if (!res.ok) throw new errors.DccError({ code: 'UNKNOWN', message: res.errors.join(' ') });
          deps.data.cache.clear();
          return publicConnection(res.value);
        },
      },
      'admin:removeConnection': {
        trust: 'admin',
        async handle(msg) {
          await deps.store.removeConnection(msg.origin);
          await deps.secrets.clearPat(msg.origin);
          deps.data.cache.clear();
          return { removed: true };
        },
      },
      'admin:syncScripts': {
        trust: 'admin',
        async handle(msg) {
          const matches = await deps.registration.sync(deps.chromeApi);
          const injected = msg.origin ? await deps.registration.injectIntoOpenTabs(deps.chromeApi, msg.origin) : 0;
          return { matches, injected };
        },
      },
      'admin:importCosts': {
        trust: 'admin',
        async handle(msg) {
          const parsed = importData.parseImport(msg.text);
          if (!parsed.ok) return { ok: false, errors: parsed.errors };
          await deps.store.setImport(parsed.value);
          return { ok: true, entries: parsed.value.entries.length };
        },
      },
      'admin:clearImport': { trust: 'admin', handle: () => deps.store.clearImport() },
      'admin:helperHello': {
        trust: 'admin',
        async handle() {
          const hello = await deps.helper.hello();
          return { version: V.safeText(hello.version, 40), capabilities: hello.capabilities, cli: hello.cli || null };
        },
      },
      'admin:helperLogin': {
        trust: 'admin',
        async handle(msg) {
          const cls = ids.classifyOrigin(msg.origin);
          if (!cls.ok || cls.kind !== 'workspace') throw new errors.DccError({ code: 'UNKNOWN', message: 'Choose a Databricks workspace first' });
          const purpose = msg.purpose === 'monitor' ? 'monitor' : 'cost';
          const out = await deps.helper.call('/bridge/login', { origin: cls.origin, purpose });
          return { signedIn: out.signedIn === true, reused: out.reused === true, profile: V.safeText(out.profile, 80) };
        },
      },
      'admin:pairManual': {
        trust: 'admin',
        async handle(msg) {
          return pairWithHelper(String(msg.key || '').trim().toLowerCase(), deps.helperPort);
        },
      },
      'admin:unpair': {
        trust: 'admin',
        async handle() {
          await deps.secrets.clearBridge();
          deps.data.cache.clear();
          return { unpaired: true };
        },
      },

      /* ---------------------------------------------------------------- helper setup page */
      'setup:pair': {
        trust: 'external',
        async handle(msg) {
          const out = await pairWithHelper(String(msg.key || '').toLowerCase(), deps.helperPort);
          await deps.openPage('ui/options.html#paired');
          return out;
        },
      },
    };
    Object.assign(handlers, deps.extra || {});

    function sanitizeRefs(refs) {
      if (!Array.isArray(refs)) return [];
      const out = [];
      const seen = new Set();
      for (const r of refs) {
        const clean = ids.sanitizeRef(r);
        if (!clean) continue;
        const key = ids.refKey(clean);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(Object.assign(clean, { key }));
        if (out.length >= MAX_REFS) break;
      }
      return out;
    }

    async function pairWithHelper(key, port) {
      if (!V.isPairingKey(key)) throw new errors.DccError({ code: 'HELPER_UNREACHABLE', message: 'Pairing key format not accepted' });
      // Verify before storing: a temporary bridge that is only kept if hello succeeds.
      const probe = deps.helperFactory({ getBridge: async () => ({ key, port, capabilities: {} }) });
      const hello = await probe.hello();
      const { rotated } = await deps.secrets.setBridge({ key, port, helperVersion: hello.version, capabilities: hello.capabilities });
      deps.data.cache.clear();
      return { paired: true, rotated, helperVersion: V.safeText(hello.version, 40) };
    }

    const PAGES = { options: 'ui/options.html', guide: 'docs/calculation-guide.html', monitor: 'ui/monitor.html' };
    async function openNamedPage(page, anchor) {
      const path = PAGES[page];
      if (!path) throw new errors.DccError({ code: 'UNKNOWN', message: 'Unknown page' });
      const a = typeof anchor === 'string' && /^[a-z0-9-]{1,40}$/.test(anchor) ? '#' + anchor : '';
      await deps.openPage(path + a);
      return { opened: page };
    }

    /** Dispatch with sender validation. */
    async function dispatch(msg, sender, { external = false } = {}) {
      try {
        if (!msg || typeof msg.type !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, msg.type)) throw new errors.DccError({ code: 'UNKNOWN', message: 'Unknown message' });
        const h = handlers[msg.type];
        if (external !== (h.trust === 'external')) throw new errors.DccError({ code: 'UNKNOWN', message: 'Message not allowed on this channel' });
        if (h.trust === 'content') await contentCheck(msg, sender);
        else if (h.trust === 'content-origin') contentOriginCheck(msg, sender);
        else if (h.trust === 'page') pageCheck(sender, false);
        else if (h.trust === 'admin') pageCheck(sender, true);
        else if (h.trust === 'external') {
          const v = senderMod.validateSetupSender(sender, ctx);
          if (!v.ok) throw new errors.DccError({ code: 'UNKNOWN', message: 'Rejected setup sender: ' + v.reason });
        }
        const data = await h.handle(msg, sender);
        return { ok: true, data: data === undefined ? null : data };
      } catch (e) {
        const error = errors.toPayload(e);
        if (deps.store && error.code !== 'NOT_CONNECTED') {
          await deps.store.recordDiagnostic({ type: msg && V.safeText(msg.type, 40), code: error.code, details: error.details }).catch(() => {});
        }
        return { ok: false, error };
      }
    }

    return { dispatch, handlers, sanitizeRefs };
  }

  const api = Object.freeze({ create, MAX_REFS });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).router = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
