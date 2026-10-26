/*
 * One-click connect. From the popup (or options) on a workspace tab:
 *   page grants site access in its click → this handler signs in (Databricks OAuth PKCE through a
 *   registered app or the built-in databricks-cli client, or a personal access token the user
 *   pasted), resolves the workspace ID,
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
     * @param msg {url|origin, method?: 'oauth'|'pat', clientId?, token?, remember?}
     * Without a method: Sign in with Databricks, through the account's registered app when one is
     * configured, otherwise through the built-in client (no setup). 'pat' saves the pasted token
     * only after Databricks accepted it.
     */
    async function connect(msg) {
      const cls = ids.classifyOrigin(msg.url || msg.origin);
      if (!cls.ok || cls.kind !== 'workspace') throw new errors.DccError({ code: 'UNKNOWN', message: 'Open a Databricks workspace tab, then click Connect' });
      const origin = cls.origin;
      if (!(await hasAccess(origin))) throw new errors.DccError({ code: 'PERMISSION_NOT_GRANTED' });

      const settings = await store.getSettings();
      const typed = msg.clientId !== undefined && msg.clientId !== '' ? String(msg.clientId).trim() : null;
      if (msg.method !== undefined && msg.method !== 'oauth' && msg.method !== 'pat') throw new errors.DccError({ code: 'UNKNOWN', message: 'Unknown sign-in method' });
      const method = msg.method === 'pat' ? 'pat' : 'oauth';
      if (typed !== null && !DCC.oauth.isClientId(typed)) {
        return { needsChoice: true, needsClientId: true, redirectUrl: chromeApi.identity.getRedirectURL() };
      }

      if (method === 'oauth') {
        const clientId = typed || DCC.oauth.effectiveClientId(null, settings);
        if (typed && typed !== settings.oauth.clientId) await store.updateSettings({ oauth: { clientId: typed } });
        await setStatus({ state: 'signing-in', origin, builtin: DCC.oauth.isBuiltin(clientId) });
        await oauth.signIn({ origin, clientId, purpose: 'cost', interactive: true });
      } else {
        const token = String(msg.token || '').trim();
        if (!V.isPlausiblePat(token)) throw new errors.DccError({ code: 'PAT_FORMAT', message: 'Token format not accepted' });
        await setStatus({ state: 'checking-token', origin });
        await deps.secrets.setPat(origin, token, { remember: msg.remember === true });
      }

      await setStatus({ state: 'configuring', origin });
      let headerId = null;
      let list;
      try {
        list = await data.listWarehouses({
          origin,
          authMode: method,
          onHeaders: (h) => {
            const v = h.get('x-databricks-org-id');
            if (V.isWorkspaceId(v)) headerId = v;
          },
        });
      } catch (e) {
        // A token Databricks refused is not kept, remembered or not.
        if (method === 'pat') {
          await deps.secrets.clearPat(origin);
          if (e && e.dcc && e.dcc.code === 'AUTH_EXPIRED') throw new errors.DccError({ code: 'PAT_REJECTED', httpStatus: e.dcc.httpStatus, message: 'Databricks did not accept the token' });
        }
        throw e;
      }
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
            // Scoped to its workspace: the popup shows it only on a tab of that workspace, and not
            // once that workspace is connected (a later save supersedes it).
            const cls = ids.classifyOrigin((msg && (msg.url || msg.origin)) || '');
            await setStatus({ state: 'error', origin: cls.ok ? cls.origin : null, error: errors.toPayload(e) });
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
    };
  }

  (DCC.handlerFactories || (DCC.handlerFactories = [])).push((deps) => create(deps));
  DCC.connectHandlers = Object.freeze({ create, STATUS_KEY });
})(typeof globalThis !== 'undefined' ? globalThis : this);
