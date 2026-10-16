/*
 * Service-worker side of "Use my Databricks login": a fetch()-compatible function for one
 * workspace origin that relays allowlisted requests through an open tab of that workspace
 * (session-bridge.js). The browser's own login is used; no credential is ever handled here.
 *
 * Failures are specific: no open tab, the tab can't be reached, the login expired (redirect to
 * sign-in), or the workspace refused session access (non-API 401/403). Real Databricks API errors
 * (JSON with error_code) pass through unchanged so permission problems keep their own messages.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const errors = NODE ? require('../errors.js') : root.DCC.errors;
  const ids = NODE ? require('../core/ids.js') : root.DCC.ids;

  function looksLikeApiError(text) {
    try {
      const j = JSON.parse(text);
      return Boolean(j && typeof j === 'object' && (j.error_code || j.message));
    } catch (_) {
      return false;
    }
  }

  function create({ chromeApi }) {
    /** Prefer the active, fully loaded tab of this origin. */
    async function tabFor(origin) {
      const tabs = await chromeApi.tabs.query({ url: origin + '/*' });
      const usable = tabs.filter((t) => !t.discarded);
      usable.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || Number(b.status === 'complete') - Number(a.status === 'complete'));
      return usable[0] || null;
    }

    function fetchFor(origin, { scope = null } = {}) {
      const cls = ids.classifyOrigin(origin);
      if (!cls.ok || cls.origin !== origin) throw new errors.DccError({ code: 'UNKNOWN', message: 'Unsupported origin for browser login' });
      return async function sessionFetch(url, init = {}) {
        const u = new URL(url);
        if (u.origin !== origin) throw new errors.DccError({ code: 'UNKNOWN', message: 'Cross-origin request refused' });
        const tab = await tabFor(origin);
        if (!tab) throw new errors.DccError({ code: 'SESSION_TAB_REQUIRED', message: 'No open tab for ' + cls.host });
        let reply;
        try {
          const relay = { type: 'dcc:sessionFetch', method: init.method || 'GET', path: u.pathname + u.search, body: init.body };
          if (scope === 'genie') relay.scope = 'genie';
          reply = await chromeApi.tabs.sendMessage(tab.id, relay);
        } catch (e) {
          throw new errors.DccError({ code: 'SESSION_TAB_REQUIRED', message: 'The Databricks tab could not be reached; reload it' });
        }
        if (!reply || reply.ok !== true) {
          if (reply && reply.network) throw new errors.DccError({ code: 'SESSION_EXPIRED', message: reply.message || 'Request redirected or failed in the tab' });
          throw new errors.DccError({ code: 'UNKNOWN', message: 'Browser login request refused' + (reply && reply.blocked ? ' (' + reply.blocked + ')' : '') });
        }
        // The browser login is the only credential here, so any 401 means Databricks refused it
        // (its public API answers "Credential was not sent or was of an unsupported type").
        // A 403 with a real API error (e.g. PERMISSION_DENIED on a warehouse) passes through.
        if (reply.status === 401 || (reply.status === 403 && !looksLikeApiError(reply.text))) {
          throw new errors.DccError({ code: 'SESSION_REJECTED', httpStatus: reply.status, message: 'The workspace did not accept browser-login API requests' });
        }
        const headers = { get: (k) => (String(k).toLowerCase() === 'x-databricks-org-id' ? reply.orgId || null : String(k).toLowerCase() === 'content-type' ? reply.contentType || null : null) };
        return {
          ok: reply.status >= 200 && reply.status < 300,
          status: reply.status,
          headers,
          text: async () => reply.text,
          json: async () => JSON.parse(reply.text),
        };
      };
    }

    return { fetchFor, tabFor };
  }

  const api = Object.freeze({ create, looksLikeApiError });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).sessionTransport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
