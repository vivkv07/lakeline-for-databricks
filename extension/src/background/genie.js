/*
 * Genie side panel, background half.
 *
 * - The panel (ui/sidepanel.html) sends page-trust messages: pick a workspace and a Genie Agent,
 *   ask, read the state. The service worker sends the question to the user's own workspace,
 *   polls the message with backoff (1 s growing to 10 s; up to 60 s after errors) under a hard
 *   10-minute timeout, fetches the result table once, and keeps going while the panel is closed.
 * - Polling exists only while a question is in flight. A 30-second alarm is armed then, so a
 *   restarted service worker resumes in-flight questions; it is cleared when none are left.
 * - Conversations live only in chrome.storage.session ('dcc.genie.state'): memory-only, cleared
 *   when the browser closes, hidden from content scripts. Capped per conversation and in total.
 *   They are never written to local storage, diagnostics, logs or notification text.
 * - Panel presence: the panel holds a runtime port named 'dcc-genie-panel' (sender validated).
 *   When an answer lands with no panel open, the toolbar badge counts it (only while the run
 *   monitor, which owns the badge, is off) and, if the user opted in and granted the optional
 *   permission, a desktop notification says "Answer ready in <agent>" and nothing else.
 * - Auth: Connected mode only. Sign in with Databricks uses the shared all-apis consent (oauth
 *   purpose 'genie', an alias of 'apis'); PAT mode uses the session PAT; the local helper is not
 *   supported. Demo mode answers from src/core/genie-demo.js with no network.
 *
 * Registers through DCC.handlerFactories and DCC.backgroundInits (router.js is not edited).
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const errors = dep('errors', '../errors.js');
  // Looked up when used: oauth.js may load after this file in the service worker.
  const OAUTH_API = { effectiveClientId: (conn, settings) => (NODE ? require('./oauth.js') : root.DCC.oauth).effectiveClientId(conn, settings) };
  const V = dep('validate', '../core/validate.js');
  const ids = dep('ids', '../core/ids.js');
  const http = dep('http', '../databricks/http.js');
  const gapi = dep('genieApi', '../databricks/genie-api.js');
  const demoMod = dep('genieDemo', '../core/genie-demo.js');
  const senderMod = dep('sender', './sender.js');

  const STATE_KEY = 'dcc.genie.state';
  const ALARM = 'dcc-genie';
  const PORT_NAME = 'dcc-genie-panel';
  const PANEL_PATH = '/ui/sidepanel.html';
  const NOTIFY_PREFIX = 'dcc-genie-';
  const STATE_VERSION = 1;
  const LIMITS = Object.freeze({ threads: 8, turns: 20, stateChars: 1500000, inflight: 3, notified: 20, spacePages: 2 });
  const HARD_TIMEOUT_MS = 10 * 60 * 1000;
  const POLL = Object.freeze({ firstMs: 1000, factor: 1.5, maxMs: 10000, errorMinMs: 2000, rateLimitMinMs: 15000, errorMaxMs: 60000, maxErrors: 6, resultTries: 4 });
  const SPACES_TTL_MS = 2 * 60 * 1000;
  // White text on #2F5BEA ≈ 5.5:1. The badge counts answers; the title says what it is.
  const BADGE = Object.freeze({ color: '#2F5BEA', text: '#FFFFFF' });
  const DEFAULT_TITLE = 'Lakeline for Databricks';
  const IN_FLIGHT = new Set(['sending', 'working', 'query']);
  const TRANSIENT = new Set(['NETWORK', 'GENIE_RATE_LIMITED', 'UNKNOWN']);

  const isInFlight = (turn) => Boolean(turn && IN_FLIGHT.has(turn.phase));
  const spaceKey = (origin, spaceId) => origin + '|' + spaceId;

  function hostOf(origin) {
    if (origin === demoMod.ORIGIN) return 'Demo workspace';
    try {
      return new URL(origin).host;
    } catch (_) {
      return String(origin || '');
    }
  }

  function emptyState() {
    return { v: STATE_VERSION, rev: 0, threads: [], current: {}, unseen: 0, notified: [], badge: false };
  }

  /**
   * @param deps {store, secrets, oauth, chromeApi, fetch?, now?, sleep?, random?, log?}
   */
  function create(deps) {
    const chromeApi = deps.chromeApi;
    const store = deps.store;
    const now = deps.now || (() => Date.now());
    const doFetch = deps.fetch || ((...args) => root.fetch(...args));
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    // Logs carry error codes only, never questions, answers or messages from the API.
    const log = deps.log || ((...a) => console.warn(...a));
    const session = chromeApi.storage.session;
    const demoClient = demoMod.createClient({ now });
    const ports = new Set();
    const jobs = new Map(); // turnId → promise
    const spacesCache = new Map(); // origin → {at, value}
    let chain = Promise.resolve();
    let notificationListener = false;

    const warn = (where, e) => log('DCC genie', where, (e && e.dcc && e.dcc.code) || 'error');

    function newId(prefix) {
      const bytes = new Uint8Array(8);
      if (deps.random) for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(deps.random() * 256);
      else root.crypto.getRandomValues(bytes);
      return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    function fail(code, message, extra) {
      return new errors.DccError(Object.assign({ code, message }, extra || {}));
    }

    /* ---------------------------------------------------------------- session state */

    async function readState() {
      const got = await session.get(STATE_KEY);
      const st = got && got[STATE_KEY];
      return st && st.v === STATE_VERSION && Array.isArray(st.threads) ? st : emptyState();
    }

    /** Oldest threads and turns go first; tables of old turns are dropped before whole threads. */
    function enforceCaps(st) {
      st.threads.sort((a, b) => b.updatedAt - a.updatedAt);
      for (const t of st.threads) if (t.turns.length > LIMITS.turns) t.turns = t.turns.slice(-LIMITS.turns);
      const busy = (t) => t.turns.some(isInFlight);
      while (st.threads.length > LIMITS.threads) {
        const i = st.threads.map(busy).lastIndexOf(false);
        if (i < 0) break;
        st.threads.splice(i, 1);
      }
      let size = JSON.stringify(st).length;
      if (size > LIMITS.stateChars) {
        const turns = [];
        for (const t of st.threads) for (const u of t.turns) if (u.table) turns.push(u);
        turns.sort((a, b) => a.askedAt - b.askedAt);
        for (const u of turns) {
          if (size <= LIMITS.stateChars) break;
          const before = JSON.stringify(u.table).length;
          u.table = null;
          u.tableState = 'trimmed';
          size -= before;
        }
      }
      while (JSON.stringify(st).length > LIMITS.stateChars && st.threads.length > 1) {
        const i = st.threads.map(busy).lastIndexOf(false);
        if (i < 1) break;
        st.threads.splice(i, 1);
      }
      const live = new Set(st.threads.map((t) => t.id));
      for (const [k, v] of Object.entries(st.current)) if (v && !live.has(v)) delete st.current[k];
      return st;
    }

    function broadcast(rev) {
      for (const p of ports) {
        try {
          p.postMessage({ type: 'genie:changed', rev });
        } catch (_) {
          ports.delete(p);
        }
      }
    }

    /** Serialized read-modify-write; fn returns the next state or null for no change. */
    function mutate(fn) {
      const p = chain.then(async () => {
        const cur = await readState();
        const next = await fn(cur);
        if (!next) return cur;
        next.rev = (cur.rev || 0) + 1;
        enforceCaps(next);
        await session.set({ [STATE_KEY]: next });
        broadcast(next.rev);
        return next;
      });
      chain = p.catch(() => {});
      return p;
    }

    function findTurn(st, threadId, turnId) {
      const thread = st.threads.find((t) => t.id === threadId) || null;
      const turn = thread ? thread.turns.find((u) => u.id === turnId) || null : null;
      return { thread, turn };
    }

    /** Update one turn (and its thread's updatedAt); no-op when it is gone. */
    function patchTurn(threadId, turnId, fn) {
      return mutate((st) => {
        const { thread, turn } = findTurn(st, threadId, turnId);
        if (!thread || !turn) return null;
        if (fn(turn, thread, st) === false) return null;
        thread.updatedAt = now();
        return st;
      });
    }

    /* ---------------------------------------------------------------- clients and errors */

    async function settingsNow() {
      return store.getSettings();
    }

    /** The REST client for an origin, or a classified error explaining what's needed. */
    async function clientFor(origin) {
      const settings = await settingsNow();
      if (settings.mode === 'demo') {
        if (origin !== demoMod.ORIGIN) throw fail('UNKNOWN', 'Demo mode uses the demo workspace');
        return { client: demoClient, demo: true, authMode: 'demo' };
      }
      if (settings.mode !== 'connected') throw fail('GENIE_MODE');
      const cls = ids.classifyOrigin(origin);
      const conn = cls.ok && cls.origin === origin ? await store.getConnection(origin) : null;
      if (!conn) throw fail('NOT_CONNECTED');
      if (conn.authMode === 'helper') throw fail('GENIE_HELPER_MODE');
      if (!['oauth', 'pat'].includes(conn.authMode)) throw fail('GENIE_AUTH_UNSUPPORTED');
      if (chromeApi.permissions && chromeApi.permissions.contains) {
        const granted = await chromeApi.permissions.contains({ origins: [origin + '/*'] });
        if (!granted) throw fail('PERMISSION_NOT_GRANTED');
      }
      let token;
      if (conn.authMode === 'oauth') {
        if (!deps.oauth) throw fail('GENIE_SIGNIN');
        try {
          token = await deps.oauth.getAccessToken(origin, 'genie', { clientId: OAUTH_API.effectiveClientId(conn, settings) });
        } catch (e) {
          if (e && e.dcc && (e.dcc.code === 'AUTH_EXPIRED' || e.dcc.code === 'OAUTH_CLIENT_MISSING')) throw fail('GENIE_SIGNIN');
          throw e;
        }
      } else {
        token = await deps.secrets.getPat(origin);
        if (!token) throw fail('GENIE_PAT_MISSING');
      }
      return { client: http.create({ origin, token, fetch: doFetch, scope: 'genie' }), demo: false, authMode: conn.authMode };
    }

    /**
     * Map an HTTP or client failure onto the Genie catalog. `stage` is list | send | poll | result.
     * @returns classification payload {code, title, steps, details}
     */
    function genieError(e, stage, authMode) {
      if (e && e.dcc && /^GENIE_|^NOT_CONNECTED$|^PERMISSION_NOT_GRANTED$/.test(e.dcc.code)) return e.dcc;
      const d = e && e.dcc ? e.dcc : errors.classify({ message: e && e.message, httpStatus: e && e.httpStatus });
      const det = d.details || {};
      const status = det.httpStatus || (e && Number.isInteger(e.httpStatus) ? e.httpStatus : null);
      const ec = String(det.errorCode || '');
      let code = d.code;
      if (code === 'NETWORK') code = 'NETWORK';
      else if (status === 429 || /RATE_LIMIT|REQUEST_LIMIT_EXCEEDED|TOO_MANY_REQUESTS/i.test(ec)) code = 'GENIE_RATE_LIMITED';
      else if (status === 401 || code === 'AUTH_EXPIRED') code = authMode === 'oauth' ? 'GENIE_SIGNIN' : 'AUTH_EXPIRED';
      else if (status === 403 || /PERMISSION_DENIED|UNAUTHORIZED|FORBIDDEN/i.test(ec)) code = 'GENIE_ACCESS_DENIED';
      else if (status === 404 || /RESOURCE_DOES_NOT_EXIST|NOT_FOUND|FEATURE_DISABLED/i.test(ec)) code = stage === 'list' ? 'GENIE_UNAVAILABLE' : 'GENIE_NOT_FOUND';
      else if (stage === 'send' || stage === 'poll') code = status && status >= 500 ? 'UNKNOWN' : code === 'UNKNOWN' ? 'GENIE_FAILED' : code;
      return errors.classify({ code, message: det.message, errorCode: det.errorCode, httpStatus: status });
    }

    function turnError(payload, detail) {
      const p = payload || errors.classify({ code: 'GENIE_FAILED' });
      const extra = detail || (p.details && p.details.message) || null;
      return { code: p.code, title: p.title, steps: p.steps.slice(0, 3), detail: extra ? V.safeText(errors.redact(extra), 300) : null, httpStatus: (p.details && p.details.httpStatus) || null };
    }

    /* ---------------------------------------------------------------- badge + notifications */

    async function apiCall(obj, name, arg) {
      if (!obj || typeof obj[name] !== 'function') return;
      try {
        await obj[name](arg);
      } catch (e) {
        warn('chrome.' + name, e);
      }
    }

    async function notificationsGranted() {
      if (!chromeApi.permissions || !chromeApi.permissions.contains) return false;
      try {
        return (await chromeApi.permissions.contains({ permissions: ['notifications'] })) === true;
      } catch (_) {
        return false;
      }
    }

    async function setBadge(count, settings) {
      // The run monitor owns the badge while it is enabled; Genie then relies on notifications.
      if (settings.monitor && settings.monitor.enabled) return false;
      const a = chromeApi.action;
      if (!a) return false;
      const text = count > 0 ? (count > 9 ? '9+' : String(count)) : '';
      await apiCall(a, 'setBadgeText', { text });
      if (text) {
        await apiCall(a, 'setBadgeBackgroundColor', { color: BADGE.color });
        await apiCall(a, 'setBadgeTextColor', { color: BADGE.text });
      }
      await apiCall(a, 'setTitle', { title: text ? DEFAULT_TITLE + ' · ' + (count === 1 ? '1 Genie answer' : count + ' Genie answers') + ' ready' : DEFAULT_TITLE });
      return true;
    }

    /** A turn finished while no panel was open: badge and, if allowed, a data-free notification. */
    async function announce(thread, turn) {
      const settings = await settingsNow();
      const st = await mutate((s) => {
        s.unseen = (s.unseen || 0) + 1;
        return s;
      });
      const shown = await setBadge(st.unseen, settings);
      if (shown && !st.badge) await mutate((s) => Object.assign(s, { badge: true }));
      if (!settings.genie.notify || !chromeApi.notifications || !chromeApi.notifications.create) return;
      if (!(await notificationsGranted())) return;
      const id = NOTIFY_PREFIX + turn.id;
      const agent = V.safeText(thread.spaceTitle || 'Genie', 80);
      const ok = turn.phase === 'done';
      try {
        await chromeApi.notifications.create(id, {
          type: 'basic',
          iconUrl: chromeApi.runtime.getURL('icons/icon-128.png'),
          title: ok ? 'Genie answer ready' : "Genie couldn't answer",
          message: (ok ? 'Answer ready in ' : 'No answer from ') + agent,
          contextMessage: hostOf(thread.origin),
          priority: 0,
        });
        await mutate((s) => Object.assign(s, { notified: (s.notified || []).concat(id).slice(-LIMITS.notified) }));
      } catch (e) {
        warn('notify', e);
      }
    }

    /** The panel is visible: answers are seen, so clear the count, our badge and notifications. */
    async function markSeen() {
      const st = await readState();
      if (!st.unseen && !st.badge && !(st.notified || []).length) return;
      const settings = await settingsNow();
      if (st.badge) await setBadge(0, settings);
      for (const id of st.notified || []) await apiCall(chromeApi.notifications, 'clear', id);
      await mutate((s) => Object.assign(s, { unseen: 0, badge: false, notified: [] }));
    }

    async function openPanelFromNotification() {
      // sidePanel.open needs a user gesture; a notification click may not count. Fall back to a tab.
      try {
        const w = chromeApi.windows && chromeApi.windows.getLastFocused ? await chromeApi.windows.getLastFocused() : null;
        if (chromeApi.sidePanel && chromeApi.sidePanel.open && w && Number.isInteger(w.id)) {
          await chromeApi.sidePanel.open({ windowId: w.id });
          return 'sidePanel';
        }
      } catch (_) {
        /* fall through */
      }
      await chromeApi.tabs.create({ url: chromeApi.runtime.getURL('ui/sidepanel.html') });
      return 'tab';
    }

    async function onNotificationClicked(id) {
      if (typeof id !== 'string' || !id.startsWith(NOTIFY_PREFIX)) return null;
      try {
        return await openPanelFromNotification();
      } finally {
        await apiCall(chromeApi.notifications, 'clear', id);
      }
    }

    /* ---------------------------------------------------------------- alarm */

    async function syncAlarm() {
      const st = await readState();
      const pending = st.threads.some((t) => t.turns.some(isInFlight));
      if (!chromeApi.alarms) return pending;
      if (!pending) {
        await apiCall(chromeApi.alarms, 'clear', ALARM);
        return false;
      }
      const existing = await chromeApi.alarms.get(ALARM);
      if (!existing) await chromeApi.alarms.create(ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
      return true;
    }

    /* ---------------------------------------------------------------- the question pipeline */

    function applyMessage(turn, msg) {
      turn.status = msg.status;
      turn.step = gapi.STEP_TEXT[msg.status] || null;
      if (msg.texts.length) turn.texts = msg.texts;
      if (msg.query) turn.query = msg.query;
      if (msg.suggested.length) turn.suggested = msg.suggested;
      if (!gapi.isTerminal(msg.status)) turn.phase = msg.phase === 'query' ? 'query' : 'working';
    }

    async function finishFailed(threadId, turnId, payload, detail) {
      let done = null;
      const st = await patchTurn(threadId, turnId, (turn) => {
        if (!isInFlight(turn)) return false;
        turn.phase = 'failed';
        turn.error = turnError(payload, detail);
        turn.finishedAt = now();
        done = turn;
      });
      return done ? afterFinish(st, threadId, turnId) : null;
    }

    async function afterFinish(st, threadId, turnId) {
      await syncAlarm().catch((e) => warn('alarm', e));
      if (ports.size) return;
      const { thread, turn } = findTurn(st, threadId, turnId);
      if (thread && turn) await announce(thread, turn).catch((e) => warn('announce', e));
    }

    async function fetchTable(ctx, thread, msg) {
      const q = msg.query;
      if (!q || !q.attachmentId) return { table: null, tableState: q ? 'unavailable' : 'none' };
      const r = gapi.requests.queryResult(thread.spaceId, thread.conversationId, msg.messageId, q.attachmentId);
      let delay = POLL.firstMs;
      for (let i = 0; i < POLL.resultTries; i++) {
        try {
          const res = gapi.normalizeQueryResult(await ctx.client.get(r.path, r.query));
          if (res.ready) return { table: tableOf(res), tableState: 'ready' };
          if (res.failed) return { table: null, tableState: 'unavailable', tableError: res.error ? res.error.text : null };
        } catch (e) {
          const err = genieError(e, 'result', ctx.authMode);
          if (!TRANSIENT.has(err.code)) return { table: null, tableState: 'unavailable', tableError: err.title };
        }
        await sleep(delay);
        delay = Math.min(delay * 2, POLL.maxMs);
      }
      return { table: null, tableState: 'unavailable' };
    }

    function tableOf(res) {
      return { columns: res.columns, rows: res.rows, totalRows: res.totalRows, shown: res.shown, clipped: res.clipped, serverTruncated: res.serverTruncated, columnsHidden: res.columnsHidden };
    }

    async function finishMessage(ctx, threadId, turnId, msg) {
      const thread = findTurn(await readState(), threadId, turnId).thread;
      if (!thread) return null;
      if (msg.status === 'FAILED') {
        return finishFailed(threadId, turnId, errors.classify({ code: gapi.messageErrorCode(msg.error) }), msg.error && msg.error.text);
      }
      if (msg.status === 'CANCELLED') return finishFailed(threadId, turnId, errors.classify({ code: 'GENIE_CANCELLED' }));
      let tableOut = { table: null, tableState: msg.query ? 'unavailable' : 'none' };
      if (msg.status === 'QUERY_RESULT_EXPIRED') tableOut = { table: null, tableState: msg.query && msg.query.attachmentId ? 'expired' : 'unavailable' };
      else if (msg.query) {
        await patchTurn(threadId, turnId, (turn) => {
          applyMessage(turn, msg);
          turn.tableState = 'loading';
        });
        tableOut = await fetchTable(ctx, thread, msg);
      }
      let finished = false;
      const st = await patchTurn(threadId, turnId, (turn) => {
        if (!isInFlight(turn)) return false;
        finished = true;
        applyMessage(turn, msg);
        turn.phase = 'done';
        turn.step = null;
        turn.table = tableOut.table;
        turn.tableState = tableOut.tableState;
        turn.tableError = tableOut.tableError ? V.safeText(tableOut.tableError, 200) : null;
        turn.finishedAt = now();
      });
      return finished ? afterFinish(st, threadId, turnId) : null;
    }

    /** Send (if not sent yet), poll to a terminal status, fetch the table, finish. */
    async function runTurn(threadId, turnId) {
      let st = await readState();
      let { thread, turn } = findTurn(st, threadId, turnId);
      if (!thread || !isInFlight(turn)) return;
      let ctx;
      try {
        ctx = await clientFor(thread.origin);
      } catch (e) {
        return finishFailed(threadId, turnId, genieError(e, 'send'));
      }

      let msg = null;
      if (!turn.messageId) {
        if (turn.sentAt) {
          // A restarted service worker can't know whether the earlier send reached Genie.
          return finishFailed(threadId, turnId, errors.classify({ code: 'GENIE_SEND_UNCONFIRMED' }));
        }
        await patchTurn(threadId, turnId, (u) => {
          u.sentAt = now();
        });
        try {
          if (thread.conversationId) {
            const r = gapi.requests.createMessage(thread.spaceId, thread.conversationId, turn.question);
            msg = gapi.normalizeMessage(await ctx.client.post(r.path, r.body));
            msg.conversationId = msg.conversationId || thread.conversationId;
          } else {
            const r = gapi.requests.startConversation(thread.spaceId, turn.question);
            const out = gapi.normalizeStart(await ctx.client.post(r.path, r.body));
            msg = out.message;
            if (out.title) msg.title = out.title;
          }
        } catch (e) {
          // Never resend automatically: a POST that failed midway may still have reached Genie.
          return finishFailed(threadId, turnId, genieError(e, 'send', ctx.authMode));
        }
        if (!msg.messageId || !msg.conversationId) return finishFailed(threadId, turnId, errors.classify({ code: 'GENIE_FAILED', message: 'Unexpected response from Genie' }));
        st = await patchTurn(threadId, turnId, (u, t) => {
          if (!t.conversationId) {
            t.conversationId = msg.conversationId;
            if (msg.title) t.title = V.safeText(msg.title, 200);
          } else if (t.conversationId !== msg.conversationId) {
            return false;
          }
          u.messageId = msg.messageId;
          applyMessage(u, msg);
        });
        ({ thread, turn } = findTurn(st, threadId, turnId));
        if (!thread || !turn || turn.messageId !== msg.messageId) return finishFailed(threadId, turnId, errors.classify({ code: 'GENIE_FAILED', message: 'Conversation changed' }));
      }

      let delay = POLL.firstMs;
      let failures = 0;
      for (;;) {
        // Re-read every round: the turn may have been cleared, and the storage call keeps the
        // service worker active between polls.
        ({ thread, turn } = findTurn(await readState(), threadId, turnId));
        if (!thread || !isInFlight(turn)) return;
        if (msg && gapi.isTerminal(msg.status)) return finishMessage(ctx, threadId, turnId, msg);
        if (now() - turn.askedAt > HARD_TIMEOUT_MS) return finishFailed(threadId, turnId, errors.classify({ code: 'GENIE_TIMEOUT' }));
        await sleep(delay);
        try {
          const r = gapi.requests.getMessage(thread.spaceId, thread.conversationId, turn.messageId);
          msg = gapi.normalizeMessage(await ctx.client.get(r.path, r.query));
          msg.messageId = msg.messageId || turn.messageId;
          failures = 0;
          delay = Math.min(Math.round(delay * POLL.factor), POLL.maxMs);
          if (!gapi.isTerminal(msg.status)) {
            const m = msg;
            await patchTurn(threadId, turnId, (u) => {
              if (u.status === m.status && u.phase === (m.phase === 'query' ? 'query' : 'working') && !m.texts.length && !m.query) return false;
              applyMessage(u, m);
            });
          }
        } catch (e) {
          const err = genieError(e, 'poll', ctx.authMode);
          failures++;
          if (!TRANSIENT.has(err.code) || failures >= POLL.maxErrors) return finishFailed(threadId, turnId, err);
          const floor = err.code === 'GENIE_RATE_LIMITED' ? POLL.rateLimitMinMs : POLL.errorMinMs;
          delay = Math.min(Math.max(delay * 2, floor), POLL.errorMaxMs);
          msg = msg && !gapi.isTerminal(msg.status) ? msg : null;
        }
      }
    }

    function startJob(threadId, turnId) {
      if (jobs.has(turnId)) return jobs.get(turnId);
      const p = runTurn(threadId, turnId)
        .catch(async (e) => {
          warn('job', e);
          await finishFailed(threadId, turnId, errors.toPayload(e)).catch(() => {});
        })
        .finally(() => {
          jobs.delete(turnId);
        });
      jobs.set(turnId, p);
      return p;
    }

    /** Start jobs for in-flight turns that have none (service-worker restart, alarm). */
    async function resume() {
      const st = await readState();
      for (const t of st.threads) for (const u of t.turns) if (isInFlight(u) && !jobs.has(u.id)) startJob(t.id, u.id);
      await syncAlarm();
      return jobs.size;
    }

    /* ---------------------------------------------------------------- spaces */

    async function listSpaces(origin, { refresh = false } = {}) {
      const cached = spacesCache.get(origin);
      if (!refresh && cached && now() - cached.at < SPACES_TTL_MS) return cached.value;
      const ctx = await clientFor(origin);
      const spaces = [];
      let token = null;
      let more = false;
      try {
        for (let page = 0; page < LIMITS.spacePages; page++) {
          const r = gapi.requests.listSpaces(token);
          const out = gapi.normalizeSpaces(await ctx.client.get(r.path, r.query), gapi.LIMITS.spaces - spaces.length);
          for (const s of out.spaces) if (!spaces.some((x) => x.id === s.id)) spaces.push(s);
          more = out.more;
          if (!out.nextPageToken || spaces.length >= gapi.LIMITS.spaces) break;
          token = out.nextPageToken;
        }
      } catch (e) {
        throw new errors.DccError(Object.assign({}, { code: genieError(e, 'list', ctx.authMode).code, message: e && e.dcc ? e.dcc.details.message : null, httpStatus: e && e.dcc ? e.dcc.details.httpStatus : null }));
      }
      spaces.sort((a, b) => a.title.localeCompare(b.title, 'en'));
      const value = { spaces, more, demo: ctx.demo };
      spacesCache.set(origin, { at: now(), value });
      return value;
    }

    /* ---------------------------------------------------------------- page handlers */

    async function workspaces(settings) {
      if (settings.mode === 'demo') return [{ origin: demoMod.ORIGIN, host: 'Demo workspace', workspaceId: null, authMode: 'demo', status: 'ready' }];
      if (settings.mode !== 'connected') return [];
      const conns = await store.getConnections();
      const out = [];
      for (const origin of Object.keys(conns).sort()) {
        const c = conns[origin];
        let status = 'ready';
        if (c.authMode === 'helper') status = 'helper';
        else if (!['oauth', 'pat'].includes(c.authMode)) status = 'unsupported';
        else if (c.authMode === 'pat') status = (await deps.secrets.getPat(origin)) ? 'ready' : 'pat';
        else if (c.authMode === 'oauth') status = deps.oauth && (await deps.oauth.describe(origin)).genie ? 'ready' : 'signin';
        out.push({ origin, host: hostOf(origin), workspaceId: c.workspaceId, authMode: c.authMode, status });
      }
      return out;
    }

    async function init(msg) {
      const settings = await settingsNow();
      const list = await workspaces(settings);
      let preferred = null;
      if (msg && typeof msg.activeUrl === 'string' && msg.activeUrl.length <= 4096) {
        const cls = ids.classifyOrigin(msg.activeUrl);
        if (cls.ok && list.some((w) => w.origin === cls.origin)) preferred = cls.origin;
      }
      const remembered = list.find((w) => settings.genie.lastSpace[w.origin]);
      const defaultOrigin = preferred || (list.length === 1 ? list[0].origin : remembered ? remembered.origin : list.length ? list[0].origin : null);
      const st = await readState();
      return {
        mode: settings.mode,
        modeError: settings.mode === 'import' ? errors.classify({ code: 'GENIE_MODE' }) : null,
        workspaces: list,
        defaultOrigin,
        fromActiveTab: Boolean(preferred),
        lastSpace: Object.assign({}, settings.genie.lastSpace),
        notify: settings.genie.notify,
        notificationsGranted: await notificationsGranted(),
        monitorEnabled: settings.monitor.enabled === true,
        inflight: st.threads.reduce((n, t) => n + t.turns.filter(isInFlight).length, 0),
      };
    }

    function validOrigin(origin, settings) {
      if (settings.mode === 'demo') {
        if (origin !== demoMod.ORIGIN) throw fail('UNKNOWN', 'Demo mode uses the demo workspace');
        return origin;
      }
      const cls = ids.classifyOrigin(origin);
      if (!cls.ok || cls.origin !== origin) throw fail('UNKNOWN', 'Unsupported workspace');
      return origin;
    }

    function validSpace(spaceId) {
      if (!gapi.isId(spaceId)) throw fail('UNKNOWN', 'Invalid Genie Agent');
      return spaceId;
    }

    async function remember(origin, spaceId) {
      const settings = await settingsNow();
      if (settings.genie.lastSpace[origin] === spaceId) return;
      await store.updateSettings({ genie: { lastSpace: { [origin]: spaceId } } });
    }

    function publicThread(t) {
      if (!t) return null;
      return {
        id: t.id,
        origin: t.origin,
        spaceId: t.spaceId,
        spaceTitle: t.spaceTitle,
        title: t.title || null,
        hasConversation: Boolean(t.conversationId),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        turns: t.turns.map((u) => ({
          id: u.id,
          question: u.question,
          askedAt: u.askedAt,
          finishedAt: u.finishedAt || null,
          phase: u.phase,
          status: u.status || null,
          step: u.step || null,
          texts: u.texts || [],
          query: u.query ? { title: u.query.title, description: u.query.description, sql: u.query.sql, rowCount: u.query.rowCount, truncated: u.query.truncated, canRerun: Boolean(u.query.attachmentId) } : null,
          table: u.table || null,
          tableState: u.tableState || 'none',
          tableError: u.tableError || null,
          suggested: u.suggested || [],
          error: u.error || null,
        })),
      };
    }

    async function getState(msg) {
      const settings = await settingsNow();
      resume().catch((e) => warn('resume', e));
      const st = await readState();
      let thread = null;
      if (msg && typeof msg.origin === 'string' && typeof msg.spaceId === 'string') {
        const origin = validOrigin(msg.origin, settings);
        const spaceId = validSpace(msg.spaceId);
        const key = spaceKey(origin, spaceId);
        const id = Object.prototype.hasOwnProperty.call(st.current, key) ? st.current[key] : undefined;
        thread = id ? st.threads.find((t) => t.id === id) || null : null;
      }
      return {
        rev: st.rev,
        thread: publicThread(thread),
        inflight: st.threads.reduce((n, t) => n + t.turns.filter(isInFlight).length, 0),
        unseen: st.unseen || 0,
      };
    }

    async function ask(msg) {
      const settings = await settingsNow();
      const origin = validOrigin(msg && msg.origin, settings);
      const spaceId = validSpace(msg && msg.spaceId);
      const question = gapi.cleanQuestion(msg && msg.question);
      if (!question) throw fail('UNKNOWN', 'Write a question of up to ' + gapi.LIMITS.question + ' characters');
      await clientFor(origin); // surfaces sign-in, PAT, helper and mode problems before anything is stored
      const cachedSpaces = spacesCache.get(origin);
      const known = cachedSpaces && cachedSpaces.value.spaces.find((s) => s.id === spaceId);
      const spaceTitle = known ? known.title : V.safeText(typeof msg.spaceTitle === 'string' ? msg.spaceTitle : '', 200).replace(/\s+/g, ' ').trim() || 'Genie Agent';
      let created = null;
      await mutate((st) => {
        const inflight = st.threads.reduce((n, t) => n + t.turns.filter(isInFlight).length, 0);
        if (inflight >= LIMITS.inflight) throw fail('GENIE_BUSY');
        const key = spaceKey(origin, spaceId);
        let thread = msg.newConversation === true ? null : st.threads.find((t) => t.id === st.current[key]) || null;
        if (thread && thread.turns.some(isInFlight)) throw fail('GENIE_BUSY');
        const t = now();
        if (!thread) {
          thread = { id: newId('c'), origin, workspaceId: null, spaceId, spaceTitle, conversationId: null, title: null, createdAt: t, updatedAt: t, turns: [] };
          st.threads.unshift(thread);
          st.current[key] = thread.id;
        }
        const turn = { id: newId('q'), question, askedAt: t, phase: 'sending', status: null, step: null, messageId: null, sentAt: null, texts: [], query: null, table: null, tableState: 'none', suggested: [], error: null, finishedAt: null };
        thread.turns.push(turn);
        thread.updatedAt = t;
        created = { threadId: thread.id, turnId: turn.id };
        return st;
      });
      await remember(origin, spaceId).catch((e) => warn('remember', e));
      startJob(created.threadId, created.turnId);
      await syncAlarm().catch((e) => warn('alarm', e));
      return created;
    }

    async function newConversation(msg) {
      const settings = await settingsNow();
      const origin = validOrigin(msg && msg.origin, settings);
      const spaceId = validSpace(msg && msg.spaceId);
      await mutate((st) => {
        st.current[spaceKey(origin, spaceId)] = null;
        return st;
      });
      return getState({ origin, spaceId });
    }

    async function rerunQuery(msg) {
      const st = await readState();
      const { thread, turn } = findTurn(st, msg && msg.threadId, msg && msg.turnId);
      if (!thread || !turn || turn.tableState !== 'expired' || !turn.query || !turn.query.attachmentId) throw fail('UNKNOWN', 'Nothing to run again');
      const ctx = await clientFor(thread.origin);
      await patchTurn(thread.id, turn.id, (u) => {
        u.tableState = 'loading';
      });
      try {
        const r = gapi.requests.executeQuery(thread.spaceId, thread.conversationId, turn.messageId, turn.query.attachmentId);
        let res = gapi.normalizeQueryResult(await ctx.client.post(r.path, r.body));
        if (!res.ready && !res.failed) {
          const out = await fetchTable(ctx, thread, { messageId: turn.messageId, query: turn.query });
          await patchTurn(thread.id, turn.id, (u) => Object.assign(u, { table: out.table, tableState: out.tableState === 'ready' ? 'ready' : 'expired', tableError: out.tableError || null }));
        } else {
          await patchTurn(thread.id, turn.id, (u) => Object.assign(u, { table: res.ready ? tableOf(res) : null, tableState: res.ready ? 'ready' : 'expired', tableError: res.failed && res.error ? res.error.text : null }));
        }
      } catch (e) {
        await patchTurn(thread.id, turn.id, (u) => Object.assign(u, { tableState: 'expired' }));
        throw new errors.DccError({ code: genieError(e, 'result', ctx.authMode).code });
      }
      return getState({ origin: thread.origin, spaceId: thread.spaceId });
    }

    async function signIn(msg) {
      const cls = ids.classifyOrigin(msg && msg.origin);
      const conn = cls.ok ? await store.getConnection(cls.origin) : null;
      if (!conn) throw fail('NOT_CONNECTED');
      if (conn.authMode !== 'oauth') throw fail(conn.authMode === 'helper' ? 'GENIE_HELPER_MODE' : 'UNKNOWN', 'Only Sign in with Databricks connections sign in here');
      const settings = await settingsNow();
      await deps.oauth.signIn({ origin: conn.origin, clientId: OAUTH_API.effectiveClientId(conn, settings), purpose: 'genie', interactive: true });
      spacesCache.delete(conn.origin);
      return { signedIn: true };
    }

    async function clearAll() {
      await mutate(() => emptyState());
      await markSeen().catch(() => {});
      await syncAlarm().catch(() => {});
      return { cleared: true };
    }

    const handlers = {
      'genie:init': { trust: 'page', handle: (msg) => init(msg) },
      'genie:spaces': {
        trust: 'page',
        async handle(msg) {
          const settings = await settingsNow();
          const origin = validOrigin(msg && msg.origin, settings);
          const out = await listSpaces(origin, { refresh: msg && msg.refresh === true });
          return Object.assign({}, out, { lastSpace: settings.genie.lastSpace[origin] || null });
        },
      },
      'genie:remember': {
        trust: 'page',
        async handle(msg) {
          const settings = await settingsNow();
          await remember(validOrigin(msg && msg.origin, settings), validSpace(msg && msg.spaceId));
          return { remembered: true };
        },
      },
      'genie:ask': { trust: 'page', handle: (msg) => ask(msg) },
      'genie:state': { trust: 'page', handle: (msg) => getState(msg) },
      'genie:new': { trust: 'page', handle: (msg) => newConversation(msg) },
      'genie:rerunQuery': { trust: 'page', handle: (msg) => rerunQuery(msg) },
      'genie:signIn': { trust: 'page', handle: (msg) => signIn(msg) },
      'genie:clear': { trust: 'page', handle: () => clearAll() },
      'genie:settings': {
        trust: 'page',
        async handle(msg) {
          const s = await store.updateSettings({ genie: { notify: Boolean(msg && msg.notify === true) } });
          return { notify: s.genie.notify };
        },
      },
    };

    /* ---------------------------------------------------------------- panel port */

    function onConnect(port) {
      if (!port || port.name !== PORT_NAME) return false;
      const v = senderMod.validatePageSender(port.sender, { extensionId: chromeApi.runtime.id, extensionOrigin: 'chrome-extension://' + chromeApi.runtime.id });
      if (!v.ok || v.page !== PANEL_PATH) {
        try {
          port.disconnect();
        } catch (_) {
          /* already gone */
        }
        return false;
      }
      ports.add(port);
      if (port.onDisconnect) port.onDisconnect.addListener(() => ports.delete(port));
      markSeen().catch((e) => warn('seen', e));
      return true;
    }

    function registerNotificationListener() {
      const n = chromeApi.notifications;
      if (notificationListener || !n || !n.onClicked) return;
      n.onClicked.addListener((id) => {
        onNotificationClicked(id).catch((e) => warn('click', e));
      });
      notificationListener = true;
    }

    /** Synchronous listener registration at service-worker evaluation. */
    function initListeners() {
      if (chromeApi.alarms && chromeApi.alarms.onAlarm) {
        chromeApi.alarms.onAlarm.addListener((alarm) => {
          if (alarm && alarm.name === ALARM) resume().catch((e) => warn('alarm', e));
        });
      }
      if (chromeApi.runtime.onConnect) chromeApi.runtime.onConnect.addListener(onConnect);
      registerNotificationListener();
      if (chromeApi.permissions && chromeApi.permissions.onAdded) chromeApi.permissions.onAdded.addListener(() => registerNotificationListener());
      // A restarted service worker picks up questions that were still in flight.
      resume().catch((e) => warn('resume', e));
    }

    return { handlers, init: initListeners, resume, runTurn, listSpaces, getState, ask, onConnect, onNotificationClicked, markSeen, readState, syncAlarm, ports, jobs, genieError, clientFor };
  }

  const api = Object.freeze({ STATE_KEY, ALARM, PORT_NAME, LIMITS, HARD_TIMEOUT_MS, POLL, NOTIFY_PREFIX, create });
  if (NODE) {
    module.exports = api;
  } else {
    const DCC = root.DCC || (root.DCC = {});
    DCC.genie = api;
    let instance = null;
    const ensure = (deps) => instance || (instance = create(deps));
    (DCC.handlerFactories || (DCC.handlerFactories = [])).push((deps) => ensure(deps).handlers);
    (DCC.backgroundInits || (DCC.backgroundInits = [])).push((deps) => ensure(deps).init());
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
