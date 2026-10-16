/*
 * Content-side data client. Sends validated requests to the service worker and ignores late
 * responses: each request carries a generation, and a response is delivered only if no newer
 * request of the same channel (e.g. after a period or route change) has been issued.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;

  function create({ sendMessage, getContext }) {
    const generations = new Map();

    async function request(channel, msg) {
      const gen = (generations.get(channel) || 0) + 1;
      generations.set(channel, gen);
      const ctx = getContext();
      if (!ctx || !ctx.workspaceId) return { ok: false, stale: false, error: { code: 'NOT_CONNECTED', title: 'Workspace not identified', steps: [] } };
      const full = Object.assign({ origin: ctx.origin, workspaceId: ctx.workspaceId }, msg);
      let res;
      try {
        res = await sendMessage(full);
      } catch (e) {
        res = { ok: false, error: { code: 'UNKNOWN', title: 'Extension was reloaded', steps: ['Refresh this page.'], details: {} } };
      }
      if (generations.get(channel) !== gen) return { stale: true };
      const ctxNow = getContext();
      if (!ctxNow || ctxNow.workspaceId !== ctx.workspaceId || ctxNow.origin !== ctx.origin) return { stale: true };
      if (res && res.ok && res.data && res.data.stale) return { stale: true };
      return res || { ok: false, error: { code: 'UNKNOWN', title: 'No response', steps: [] } };
    }

    /** Invalidate a channel so any in-flight response is dropped. */
    function invalidate(channel) {
      generations.set(channel, (generations.get(channel) || 0) + 1);
    }

    // One-off requests get a unique channel that is dropped when they settle, so the
    // generation map can't grow without bound on long-lived tabs.
    let miscSeq = 0;
    function send(msg) {
      const channel = 'misc:' + ++miscSeq;
      return request(channel, msg).finally(() => generations.delete(channel));
    }

    return {
      summary: (periodDays, force) => request('summary', { type: 'dcc:summary', periodDays, force: force === true }),
      rows: (channel, periodDays, refs) => request('rows:' + channel, { type: 'dcc:rows', periodDays, refs }),
      query: (channel, kind, args, scope, force) => request('q:' + channel, { type: 'dcc:query', kind, args, scope, force: force === true }),
      send,
      invalidate,
    };
  }

  const api = Object.freeze({ create });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).workspaceData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
