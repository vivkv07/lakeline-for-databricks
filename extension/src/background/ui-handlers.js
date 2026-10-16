/*
 * Background handlers for the popup → options hand-off.
 *
 * The popup can read the active tab's URL only while it is open (activeTab). When the user
 * selects "Connect this workspace", the popup passes that URL here and the options page takes
 * it exactly once. Only the validated origin and a numeric workspace ID resolved from the URL
 * are kept — never the path, other query parameters, or anything secret — and they live in
 * chrome.storage.session (memory only, extension contexts only) for a few minutes at most.
 *
 * Registered through DCC.handlerFactories; router.js is not edited.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const V = dep('validate', '../core/validate.js');
  const ids = dep('ids', '../core/ids.js');
  const errors = dep('errors', '../errors.js');

  const PENDING_KEY = 'dcc.ui.pendingConnect';
  const PENDING_TTL_MS = 10 * 60 * 1000;
  const MAX_URL_LENGTH = 4096;

  /**
   * Re-validate a stored hand-off. Expired, future-dated, or malformed entries are dropped.
   * @returns {{origin, cloud, kind, workspaceId:string|null, conflict:boolean} | null}
   */
  function sanitizePending(raw, nowMs) {
    if (!raw || typeof raw !== 'object') return null;
    if (!Number.isFinite(raw.at) || nowMs - raw.at > PENDING_TTL_MS || raw.at - nowMs > 60 * 1000) return null;
    const cls = ids.classifyOrigin(raw.origin);
    if (!cls.ok || cls.origin !== raw.origin) return null;
    return {
      origin: cls.origin,
      cloud: cls.cloud,
      kind: cls.kind,
      workspaceId: V.isWorkspaceId(raw.workspaceId) ? raw.workspaceId : null,
      conflict: raw.conflict === true,
    };
  }

  /**
   * @param deps {secrets, chromeApi} (the standard handler-factory deps)
   * @param [opts] {now(): number} — injectable clock for tests
   */
  function create(deps, opts = {}) {
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

    function session() {
      const area = deps && deps.chromeApi && deps.chromeApi.storage && deps.chromeApi.storage.session;
      if (!area) throw new errors.DccError({ code: 'UNKNOWN', message: 'Session storage is unavailable' });
      return area;
    }

    return {
      /** Popup → background: remember which workspace tab the user asked to connect. */
      'page:setPendingConnect': {
        trust: 'page',
        async handle(msg) {
          const url = msg && typeof msg.url === 'string' && msg.url.length <= MAX_URL_LENGTH ? msg.url : '';
          const cls = ids.classifyOrigin(url);
          if (!cls.ok) throw new errors.DccError({ code: 'UNKNOWN', message: 'Not a supported Databricks workspace URL' });
          const resolved = ids.resolveWorkspaceId(url, {});
          const pending = {
            origin: cls.origin,
            workspaceId: V.isWorkspaceId(resolved.id) ? resolved.id : null,
            conflict: resolved.conflict === true,
            at: now(),
          };
          await session().set({ [PENDING_KEY]: pending });
          return { origin: pending.origin, workspaceId: pending.workspaceId, conflict: pending.conflict };
        },
      },

      /** Options → background: take the hand-off once (read and clear). */
      'admin:takePendingConnect': {
        trust: 'admin',
        async handle() {
          const area = session();
          const got = await area.get(PENDING_KEY);
          await area.remove(PENDING_KEY);
          return sanitizePending(got && got[PENDING_KEY], now());
        },
      },

      /** Options → background: whether a session token exists for an origin. Never the value. */
      'admin:secretStatus': {
        trust: 'admin',
        async handle(msg) {
          const cls = ids.classifyOrigin(msg && msg.origin);
          if (!cls.ok) throw new errors.DccError({ code: 'UNKNOWN', message: 'Unsupported origin' });
          const d = deps && deps.secrets ? await deps.secrets.describe(cls.origin) : null;
          return { origin: cls.origin, hasPat: Boolean(d && d.hasPat === true) };
        },
      },
    };
  }

  const api = Object.freeze({ PENDING_KEY, PENDING_TTL_MS, create, sanitizePending });
  if (NODE) module.exports = api;
  else {
    const DCC = root.DCC || (root.DCC = {});
    DCC.uiHandlers = api;
    (DCC.handlerFactories || (DCC.handlerFactories = [])).push((deps) => create(deps));
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
