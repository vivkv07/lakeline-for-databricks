/*
 * Service-worker sender validation. Three trust classes:
 *   content  — our content script in a top-level supported workspace tab
 *   page     — our own extension pages (popup, options, monitor, Genie side panel)
 *   admin    — only the options page (connection settings, secrets, pairing)
 *   external — the helper setup page on the exact loopback origin (externally_connectable)
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const ids = NODE ? require('../core/ids.js') : root.DCC.ids;
  const V = NODE ? require('../core/validate.js') : root.DCC.validate;

  const PAGE_PATHS = Object.freeze(['/ui/popup.html', '/ui/options.html', '/ui/monitor.html', '/ui/sidepanel.html']);
  const ADMIN_PATHS = Object.freeze(['/ui/options.html']);

  function deny(reason) {
    return { ok: false, reason };
  }

  function senderUrl(sender) {
    try {
      return new URL(sender.url);
    } catch (_) {
      return null;
    }
  }

  /**
   * @param sender chrome.runtime.MessageSender
   * @param msg message with {origin, workspaceId}
   * @param ctx {extensionId, connection?: saved connection for msg.origin}
   */
  function validateContentSender(sender, msg, ctx) {
    if (!sender || sender.id !== ctx.extensionId) return deny('foreign-extension');
    if (!sender.tab || sender.frameId !== 0) return deny('not-top-frame');
    const url = senderUrl(sender);
    if (!url) return deny('no-url');
    const cls = ids.classifyOrigin(url);
    if (!cls.ok) return deny('unsupported-origin');
    if (!msg || msg.origin !== cls.origin) return deny('origin-mismatch');
    if (!V.isWorkspaceId(msg.workspaceId)) return deny('invalid-workspace-id');
    const resolved = ids.resolveWorkspaceId(url, {});
    if (resolved.conflict) return deny('ambiguous-workspace-id');
    if (resolved.id && resolved.id !== msg.workspaceId) return deny('workspace-id-mismatch');
    const conn = ctx.connection;
    if (conn && conn.workspaceId && conn.workspaceId !== msg.workspaceId) return deny('workspace-id-mismatch');
    return { ok: true, origin: cls.origin, workspaceId: msg.workspaceId, tabId: sender.tab.id, kind: cls.kind };
  }

  function validatePageSender(sender, ctx, { admin = false } = {}) {
    if (!sender || sender.id !== ctx.extensionId) return deny('foreign-extension');
    const url = senderUrl(sender);
    // Compare protocol+host: some URL implementations report non-special schemes' origin as "null".
    if (!url || url.protocol + '//' + url.host !== ctx.extensionOrigin) return deny('not-extension-page');
    const allowed = admin ? ADMIN_PATHS : PAGE_PATHS;
    if (!allowed.includes(url.pathname)) return deny(admin ? 'not-admin-page' : 'not-extension-page');
    return { ok: true, page: url.pathname };
  }

  /** externally_connectable sender: only the helper's /setup page on the exact loopback origin. */
  function validateSetupSender(sender, ctx) {
    if (!sender || sender.id) return deny('extension-sender');
    const url = senderUrl(sender);
    if (!url) return deny('no-url');
    const expected = 'http://127.0.0.1:' + ctx.helperPort;
    if (url.origin !== expected || (sender.origin && sender.origin !== expected)) return deny('wrong-origin');
    if (url.pathname !== '/setup') return deny('wrong-path');
    return { ok: true };
  }

  const api = Object.freeze({ PAGE_PATHS, ADMIN_PATHS, validateContentSender, validatePageSender, validateSetupSender });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).sender = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
