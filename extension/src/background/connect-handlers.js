/*
 * One-click connect. From the popup (or options) on a workspace tab:
 *   page grants site access in its click → this handler signs in (Databricks OAuth PKCE, or the
 *   user's existing browser login relayed through the open tab), resolves the workspace ID,
 *   picks a warehouse automatically, saves the connection with list prices, registers content
 *   scripts and injects into open tabs.
 * Progress is mirrored to chrome.storage.session so a popup that closed while the sign-in window
 * was open can show the outcome next time.
 */
(function (root) {
  'use strict';
  const DCC = root.DCC;
  const STATUS_KEY = 'dcc.connect.status';

  function create(deps) {
    const { store, data, chromeApi } = deps;
    const ids = DCC.ids;
    const V = DCC.validate;
    const errors = DCC.errors;
    const oauth = deps.oauth;

    async function setStatus(status) {
      await chromeApi.storage.session.set({ [STATUS_KEY]: Object.assign({ at: Date.now() }, status) });
    }

    async function hasAccess(origin) {
      return chromeApi.permissions.contains({ origins: [origin + '/*'] });
    }

    /** Workspace ID: URL/host/observed first; else the x-databricks-org-id response header. */
    function resolveId(fromUrl, observed, headerId) {
      const known = fromUrl || observed || null;
      if (known && headerId && known !== headerId) throw new errors.DccError({ code: 'WORKSPACE_MISMATCH', message: 'The page and the API report different workspace IDs' });
      const id = known || headerId;
      if (!V.isWorkspaceId(id)) throw new errors.DccError({ code: 'UNKNOWN', message: 'Could not determine the workspace ID; open any workspace page and try again' });
      return id;
    }

    /**
     * @param msg {url|origin, method?: 'oauth'|'session', clientId?}
     * Without a method: Sign in with Databricks when a client ID is configured; otherwise the
     * caller gets {needsChoice} so the user can pick their Databricks login, a client ID, or a token.
     */
    async function connect(msg) {
      const cls = ids.classifyOrigin(msg.url || msg.origin);
      if (!cls.ok || cls.kind !== 'workspace') throw new errors.DccError({ code: 'UNKNOWN', message: 'Open a Databricks workspace tab, then click Connect' });
      const origin = cls.origin;
      if (!(await hasAccess(origin))) throw new errors.DccError({ code: 'PERMISSION_NOT_GRANTED' });

      const settings = await store.getSettings();
      const clientId = msg.clientId !== undefined && msg.clientId !== '' ? String(msg.clientId).trim() : settings.oauth.clientId;
      const sessionAllowed = !(DCC.flags && DCC.flags.sessionLogin === false);
      if (msg.method === 'session' && !sessionAllowed) throw new errors.DccError({ code: 'UNKNOWN', message: 'This sign-in method is not available in this build' });
      let method = msg.method === 'session' || msg.method === 'oauth' ? msg.method : null;
      if (!method) method = DCC.oauth.isClientId(clientId) ? 'oauth' : null;
      if (!method || (method === 'oauth' && !DCC.oauth.isClientId(clientId))) {
        return { needsChoice: true, needsClientId: true, redirectUrl: chromeApi.identity.getRedirectURL() };
      }

      if (method === 'oauth') {
        if (clientId !== settings.oauth.clientId) await store.updateSettings({ oauth: { clientId } });
        await setStatus({ state: 'signing-in', origin });
        await oauth.signIn({ origin, clientId, purpose: 'cost', interactive: true });
      } else {
        // Browser login works through the tab: make sure our bridge is loaded there first.
        await setStatus({ state: 'checking-login', origin });
        await DCC.registration.sync(chromeApi);
        await DCC.registration.injectIntoOpenTabs(chromeApi, origin);
      }

      await setStatus({ state: 'configuring', origin });
      let headerId = null;
      const list = await data.listWarehouses({
        origin,
        authMode: method,
        onHeaders: (h) => {
          const v = h.get('x-databricks-org-id');
          if (V.isWorkspaceId(v)) headerId = v;
        },
      });
      const observed = await store.getObserved(origin);
      const workspaceId = resolveId(ids.resolveWorkspaceId(msg.url || origin, {}).id, observed && observed.workspaceId, headerId);
      const auto = DCC.warehouses.autoSelect(list);
      if (!auto) throw new errors.DccError({ code: 'WAREHOUSE_UNAVAILABLE', message: 'No SQL warehouse is visible to your account in this workspace' });

      const existing = await store.getConnection(origin);
      const saved = await store.saveConnection({
        origin,
        workspaceId,
        authMode: method,
        // Keep an explicit earlier choice; otherwise Automatic resolved now.
        warehouse: existing && existing.warehouse && existing.warehouse.mode === 'manual' ? existing.warehouse : { mode: 'auto', resolvedId: auto.id, resolvedName: auto.name },
        priceTable: existing ? existing.priceTable : DCC.pricing.DEFAULT_PRICE_TABLE,
        currency: existing ? existing.currency : 'USD',
      });
      if (!saved.ok) throw new errors.DccError({ code: 'UNKNOWN', message: saved.errors.join(' ') });
      if (settings.mode !== 'connected' || !settings.showCosts) await store.updateSettings({ mode: 'connected', showCosts: true });
      data.cache.clear();
      await DCC.registration.sync(chromeApi);
      const injected = await DCC.registration.injectIntoOpenTabs(chromeApi, origin);
      const result = { connected: true, method, origin, workspaceId, warehouseName: saved.value.warehouse.resolvedName || saved.value.warehouse.name || null, injected };
      await setStatus(Object.assign({ state: 'connected' }, result));
      return result;
    }

    return {
      'connect:oneClick': {
        trust: 'page',
        async handle(msg) {
          try {
            return await connect(msg || {});
          } catch (e) {
            await setStatus({ state: 'error', error: errors.toPayload(e) });
            throw e;
          }
        },
      },
      'connect:status': {
        trust: 'page',
        async handle() {
          const got = await chromeApi.storage.session.get(STATUS_KEY);
          return (got && got[STATUS_KEY]) || null;
        },
      },
      'connect:redirectUrl': {
        trust: 'page',
        async handle() {
          return { redirectUrl: chromeApi.identity.getRedirectURL() };
        },
      },
      // The broader all-apis consent is one sign-in shared by the run monitor and Genie
      // (oauth purpose 'apis'; 'monitor' and 'genie' are aliases). Genie's panel uses genie:signIn.
      'connect:signInMonitor': {
        trust: 'page',
        async handle(msg) {
          const cls = ids.classifyOrigin(msg.origin);
          const conn = cls.ok ? await store.getConnection(cls.origin) : null;
          if (!conn || conn.authMode !== 'oauth') throw new errors.DccError({ code: 'NOT_CONNECTED' });
          const settings = await store.getSettings();
          await oauth.signIn({ origin: conn.origin, clientId: conn.oauthClientId || settings.oauth.clientId, purpose: 'apis', interactive: true });
          return { signedIn: true };
        },
      },
      'connect:signOut': {
        trust: 'page',
        async handle(msg) {
          const cls = ids.classifyOrigin(msg.origin);
          if (!cls.ok) throw new errors.DccError({ code: 'UNKNOWN', message: 'Unsupported origin' });
          await oauth.signOut(cls.origin);
          data.cache.clear();
          return { signedOut: true };
        },
      },
    };
  }

  (DCC.handlerFactories || (DCC.handlerFactories = [])).push((deps) => create(deps));
  DCC.connectHandlers = Object.freeze({ create, STATUS_KEY });
})(typeof globalThis !== 'undefined' ? globalThis : this);
