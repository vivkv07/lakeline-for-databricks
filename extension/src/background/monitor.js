/*
 * Run/compute monitor (stage 9, added at the user's request; not in the base spec).
 *
 * - Polls read-only REST inventory (job runs, pipelines, SQL warehouses, clusters) on the
 *   chrome.alarms schedule 'dcc-monitor', only while settings.monitor.enabled. It never sends
 *   SQL: a stopped warehouse is never woken by background polling.
 * - Auth: PAT mode uses the session token for the monitored origin through the allowlisted HTTP
 *   client; helper mode forwards allowlisted GETs through the helper's separate monitor sign-in.
 * - State lives in chrome.storage.session 'dcc.monitor.state'. Errors back off exponentially
 *   (alarm ticks are skipped); concurrent polls are deduplicated.
 * - Toolbar badge: active run count; a distinct color plus "!" for failures in the last 24 h
 *   that the monitor window has not shown yet.
 * - Opt-in desktop notifications for newly failed runs (needs the optional `notifications`
 *   permission), deduplicated by run ID, never for runs that failed before monitoring started.
 * - Opens or focuses the compact monitor window (ui/monitor.html).
 *
 * Registers itself through DCC.handlerFactories and DCC.backgroundInits; listeners are added
 * synchronously when the service worker evaluates, so alarms and notification clicks wake it.
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
  const config = dep('config', '../databricks/config.js');
  const cacheMod = dep('cache', './cache.js');
  const mapi = dep('monitorApi', '../databricks/monitor-api.js');

  const ALARM = 'dcc-monitor';
  const STATE_KEY = 'dcc.monitor.state';
  const WINDOW_KEY = 'dcc.monitor.window';
  const SETTINGS_KEY = 'dcc.settings';
  const STATE_VERSION = 1;
  const INTERVALS = Object.freeze([60, 120, 300]);
  const MAX_BACKOFF_MS = 30 * 60 * 1000;
  const MANUAL_MIN_GAP_MS = 5000;
  const SEEN_CAP = 500;
  const LINK_CAP = 50;
  const NOTIFY_PER_POLL = 5;
  const RECENT_PAGES = 2;
  const WAREHOUSE_PAGES = 2;
  const CLUSTER_PAGES = 2;
  const MAX_RECENT_RUNS = 50;
  const WINDOW_SIZE = Object.freeze({ width: 380, height: 600 });
  // White text on both: #2F5BEA ≈ 5.5:1, #B42318 ≈ 6.6:1. Failures also add "!" (not color only).
  const BADGE = Object.freeze({ normal: '#2F5BEA', failure: '#B42318', text: '#FFFFFF' });
  const DEFAULT_TITLE = 'Lakeline for Databricks';
  const SECTIONS = Object.freeze(['runsActive', 'runsRecent', 'pipelines', 'warehouses', 'clusters']);
  const CLEARED_STATUSES = new Set(['signin', 'choose-workspace', 'no-connection', 'demo-mode']);

  const NEXT = Object.freeze({
    signinPat: (host) => ({
      code: 'MONITOR_SIGNIN',
      title: 'Sign in for monitor',
      steps: ['Open Connection preferences and save a personal access token for ' + host + '. Tokens are kept only for this browser session.'],
    }),
    signinHelper: () => ({
      code: 'MONITOR_SIGNIN',
      title: 'Sign in for monitor',
      steps: ['Start the local helper, then open Connection preferences and select "Sign in for monitor". The monitor uses its own read-only sign-in, separate from cost queries.'],
    }),
    signinOauth: () => ({
      code: 'MONITOR_SIGNIN',
      title: 'Sign in for monitor',
      steps: ['Click Sign in for monitor. Databricks asks once for read access to jobs, pipelines and compute status, separate from cost queries.'],
    }),
    choose: () => ({ code: 'MONITOR_CHOOSE', title: 'Choose a workspace to monitor', steps: ['Pick one of your saved workspaces in the selector above.'] }),
    none: () => ({ code: 'NOT_CONNECTED', title: 'No saved workspace', steps: ['Connect a workspace first from the extension popup or Connection preferences.'] }),
    demo: () => ({ code: 'MONITOR_DEMO', title: 'Monitor is off in Demo mode', steps: ['Demo mode makes no Databricks requests. Switch to Connected mode in the extension popup to monitor runs.'] }),
  });

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function intervalMs(monitorSettings) {
    const s = monitorSettings && INTERVALS.includes(monitorSettings.intervalSec) ? monitorSettings.intervalSec : 60;
    return s * 1000;
  }

  function recentFailedRuns(st, nowMs) {
    if (!st || !Array.isArray(st.runs)) return [];
    return st.runs.filter((r) => r.outcome === 'failed' && !r.active && mapi.inRecentWindow(r, nowMs));
  }

  /** Failed runs in the last 24 h that the visible monitor window has not shown yet. */
  function unseenFailures(st, nowMs) {
    const acked = new Set((st && st.ackedFailed) || []);
    return recentFailedRuns(st, nowMs).filter((r) => !acked.has(r.runId)).length;
  }

  /**
   * @param deps {store, secrets, data, helper, chromeApi, fetch?, now?, log?}
   */
  function create(deps) {
    const chromeApi = deps.chromeApi;
    const store = deps.store;
    const now = deps.now || (() => Date.now());
    const doFetch = deps.fetch || ((...args) => root.fetch(...args));
    const log = deps.log || ((...a) => console.warn(...a));
    const session = chromeApi.storage.session;
    const settingsKey = (store.KEYS && store.KEYS.settings) || SETTINGS_KEY;
    const stats = { polls: 0, skipped: 0 };
    let inflight = null;
    let chain = Promise.resolve();
    let windowOpening = null;
    let notificationListener = false;

    const warn = (e) => log('DCC monitor', errors.redact(e && e.message));

    /* ---------------------------------------------------------------- session state */

    async function readKey(key) {
      const got = await session.get(key);
      return got && got[key] !== undefined ? got[key] : null;
    }

    async function readState() {
      const st = await readKey(STATE_KEY);
      return st && st.v === STATE_VERSION ? st : null;
    }

    /** Serialized read-modify-write of the session state (poll results vs. acknowledgements). */
    function mutate(fn) {
      const p = chain.then(async () => {
        const cur = await readState();
        const next = await fn(cur);
        if (next) await session.set({ [STATE_KEY]: next });
        return next || cur;
      });
      chain = p.catch(() => {});
      return p;
    }

    function emptyState(target, nowMs) {
      return {
        v: STATE_VERSION,
        status: 'ok',
        origin: target.origin || null,
        workspaceId: (target.conn && target.conn.workspaceId) || null,
        authMode: (target.conn && target.conn.authMode) || null,
        at: null,
        attemptAt: nowMs,
        sections: {},
        runs: [],
        pipelines: [],
        warehouses: [],
        clusters: [],
        counts: mapi.summarize({}, nowMs),
        errors: {},
        next: null,
        backoff: { failures: 0, nextAt: 0 },
        baselineAt: null,
        ackedFailed: [],
        failedSeen: [],
        links: {},
      };
    }

    /** Public view for the monitor page: no dedupe sets, no notification bookkeeping. */
    function publicView(st, nowMs) {
      if (!st) return null;
      const truncated = {};
      const sectionAt = {};
      for (const s of SECTIONS) {
        const sec = st.sections && st.sections[s];
        truncated[s] = Boolean(sec && sec.truncated);
        sectionAt[s] = sec ? sec.at : null;
      }
      return {
        status: st.status,
        origin: st.origin,
        workspaceId: st.workspaceId,
        authMode: st.authMode,
        at: st.at,
        attemptAt: st.attemptAt,
        runs: st.runs,
        pipelines: st.pipelines,
        warehouses: st.warehouses,
        clusters: st.clusters,
        counts: st.counts,
        truncated,
        sectionAt,
        errors: st.errors,
        next: st.next,
        failures: st.backoff ? st.backoff.failures : 0,
        retryAt: st.backoff && st.backoff.failures ? st.backoff.nextAt : null,
        unseenFailures: unseenFailures(st, nowMs),
      };
    }

    /* ---------------------------------------------------------------- target + auth */

    function effectiveOrigin(settings, conns) {
      const origins = Object.keys(conns).sort();
      const m = settings.monitor;
      if (m.origin && conns[m.origin]) return m.origin;
      return origins.length === 1 ? origins[0] : null;
    }

    async function resolveTarget(settings) {
      if (!settings.monitor.enabled) return { status: 'disabled' };
      if (settings.mode === 'demo') return { status: 'demo-mode', next: NEXT.demo() };
      const conns = await store.getConnections();
      const origin = effectiveOrigin(settings, conns);
      if (!origin) return Object.keys(conns).length ? { status: 'choose-workspace', next: NEXT.choose() } : { status: 'no-connection', next: NEXT.none() };
      return { status: 'ready', origin, conn: conns[origin] };
    }

    function assertPath(path) {
      if (!mapi.isMonitorPath(path) || !http.isAllowed('GET', path)) throw new errors.DccError({ code: 'UNKNOWN', message: 'Blocked non-monitor API call' });
    }

    function cleanQuery(query) {
      const out = {};
      for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) out[k] = String(v);
      return out;
    }

    /** Helper bridge responses: the API JSON under `data` (preferred) or at the top level. */
    function unwrap(out) {
      if (out && out.data && typeof out.data === 'object') return out.data;
      const copy = Object.assign({}, out);
      delete copy.ok;
      return copy;
    }

    /** @returns {{get(path, query)} | {signin: next}} */
    async function clientFor(conn) {
      const host = new URL(conn.origin).host;
      if (conn.authMode === 'session') {
        // Browser login: relayed through an open tab of this workspace (errors say when none is open).
        const client = await deps.data.clientFor(conn.origin, 'session');
        return {
          get(path, query) {
            assertPath(path);
            return client.get(path, cleanQuery(query));
          },
        };
      }
      if (conn.authMode === 'oauth') {
        if (!deps.oauth) return { signin: NEXT.signinOauth() };
        let token;
        try {
          const settings = await deps.store.getSettings();
          token = await deps.oauth.getAccessToken(conn.origin, 'monitor', { clientId: OAUTH_API.effectiveClientId(conn, settings) });
        } catch (e) {
          if (e && e.dcc && e.dcc.code === 'AUTH_EXPIRED') return { signin: NEXT.signinOauth() };
          throw e;
        }
        const client = http.create({ origin: conn.origin, token, fetch: doFetch });
        return {
          get(path, query) {
            assertPath(path);
            return client.get(path, cleanQuery(query));
          },
        };
      }
      if (conn.authMode === 'pat') {
        const token = await deps.secrets.getPat(conn.origin);
        if (!token) return { signin: NEXT.signinPat(host) };
        if (chromeApi.permissions && chromeApi.permissions.contains) {
          const granted = await chromeApi.permissions.contains({ origins: [conn.origin + '/*'] });
          if (!granted) throw new errors.DccError({ code: 'PERMISSION_NOT_GRANTED' });
        }
        const client = http.create({ origin: conn.origin, token, fetch: doFetch });
        return {
          get(path, query) {
            assertPath(path);
            return client.get(path, cleanQuery(query));
          },
        };
      }
      const bridge = await deps.secrets.getBridge();
      if (!bridge) return { signin: NEXT.signinHelper() };
      await deps.helper.assertCapable('monitor', null, {});
      return {
        async get(path, query) {
          assertPath(path);
          return unwrap(await deps.helper.call('/bridge/api', { origin: conn.origin, path, query: cleanQuery(query) }));
        },
      };
    }

    /* ---------------------------------------------------------------- fetchers */

    async function fetchActiveRuns(client, ctx) {
      const r = mapi.requests.activeRuns();
      const out = mapi.normalizeRunsResponse(await client.get(r.path, r.query), ctx);
      return { items: out.runs, dropped: out.dropped, truncated: out.hasMore };
    }

    async function fetchRecentRuns(client, ctx, nowMs) {
      const items = [];
      const seen = new Set();
      let dropped = 0;
      let truncated = false;
      let token = null;
      for (let page = 0; page < RECENT_PAGES; page++) {
        const r = mapi.requests.recentRuns(nowMs, token);
        const out = mapi.normalizeRunsResponse(await client.get(r.path, r.query), ctx);
        for (const run of out.runs) if (!seen.has(run.runId)) (seen.add(run.runId), items.push(run));
        dropped += out.dropped;
        if (!out.hasMore) break;
        if (!out.nextPageToken || page === RECENT_PAGES - 1) {
          truncated = true;
          break;
        }
        token = out.nextPageToken;
      }
      return { items, dropped, truncated };
    }

    async function fetchPipelines(client, nowMs) {
      const r = mapi.requests.pipelines();
      const out = mapi.normalizePipelinesResponse(await client.get(r.path, r.query), nowMs);
      return { items: out.pipelines, dropped: out.dropped, truncated: out.hasMore };
    }

    async function fetchWarehouses(client) {
      const items = [];
      let dropped = 0;
      let truncated = false;
      let token = null;
      for (let page = 0; page < WAREHOUSE_PAGES; page++) {
        const r = mapi.requests.warehouses(token);
        const out = mapi.normalizeWarehousesResponse(await client.get(r.path, r.query));
        items.push(...out.warehouses);
        dropped += out.dropped;
        if (!out.hasMore) break;
        if (!out.nextPageToken || page === WAREHOUSE_PAGES - 1) {
          truncated = true;
          break;
        }
        token = out.nextPageToken;
      }
      const order = (w) => (w.state === 'RUNNING' ? 0 : w.state === 'STARTING' ? 1 : 2);
      items.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name, 'en'));
      return { items, dropped, truncated };
    }

    async function fetchClusters(client) {
      const items = [];
      let dropped = 0;
      let truncated = false;
      let token = null;
      for (let page = 0; page < CLUSTER_PAGES; page++) {
        const r = mapi.requests.clusters(token);
        const out = mapi.normalizeClustersResponse(await client.get(r.path, r.query));
        items.push(...out.clusters);
        dropped += out.dropped;
        // Active clusters sort first; only follow the next page while the page ended active.
        if (!out.hasMore || !out.lastActive) break;
        if (!out.nextPageToken || page === CLUSTER_PAGES - 1) {
          truncated = true;
          break;
        }
        token = out.nextPageToken;
      }
      return { items, dropped, truncated };
    }

    /* ---------------------------------------------------------------- merge */

    function merge(cur, target, results, nowMs, { notifyAllowed, monitorSettings }) {
      const same = cur && cur.origin === target.origin;
      const base = same ? cur : emptyState(target, nowMs);
      const st = Object.assign({}, base, {
        status: 'ok',
        origin: target.origin,
        workspaceId: target.conn.workspaceId,
        authMode: target.conn.authMode,
        attemptAt: nowMs,
        sections: Object.assign({}, base.sections),
        errors: {},
        next: null,
      });

      let active = base.runs.filter((r) => r.active);
      let recent = base.runs.filter((r) => !r.active);
      const fresh = [];
      for (const s of SECTIONS) {
        const res = results[s];
        if (!res.ok) {
          st.errors[s] = res.error;
          continue;
        }
        st.sections[s] = { at: nowMs, truncated: Boolean(res.value.truncated), dropped: res.value.dropped || 0 };
        if (s === 'runsActive') (active = res.value.items), fresh.push(...res.value.items);
        else if (s === 'runsRecent') (recent = res.value.items), fresh.push(...res.value.items);
        else st[s] = res.value.items;
      }

      // A run seen in both lists: the completed record is the newer information.
      recent = mapi.sortRuns(recent.filter((r) => mapi.inRecentWindow(r, nowMs))).slice(0, MAX_RECENT_RUNS);
      const recentIds = new Set(recent.map((r) => r.runId));
      st.runs = mapi.sortRuns(active.filter((r) => !recentIds.has(r.runId)).concat(recent));
      st.counts = mapi.summarize(
        {
          runsActive: st.sections.runsActive ? active : null,
          runsRecent: st.sections.runsRecent ? recent : null,
          pipelines: st.sections.pipelines ? st.pipelines : null,
          warehouses: st.sections.warehouses ? st.warehouses : null,
          clusters: st.sections.clusters ? st.clusters : null,
        },
        nowMs
      );

      const okCount = SECTIONS.filter((s) => results[s].ok).length;
      let toNotify = [];
      if (okCount > 0) {
        st.at = nowMs;
        st.backoff = { failures: 0, nextAt: 0 };
        const firstPoll = !base.baselineAt;
        if (firstPoll) st.baselineAt = nowMs;
        const seen = new Set(base.failedSeen || []);
        for (const r of fresh) {
          if (r.outcome !== 'failed' || seen.has(r.runId)) continue;
          seen.add(r.runId);
          const t = r.endMs !== null ? r.endMs : r.startMs;
          // Never notify on the first poll, or for runs that ended before monitoring started.
          if (!firstPoll && notifyAllowed && t !== null && t >= st.baselineAt) toNotify.push(r);
        }
        st.failedSeen = [...seen].slice(-SEEN_CAP);
        toNotify = toNotify.slice(0, NOTIFY_PER_POLL).concat(toNotify.length > NOTIFY_PER_POLL ? [{ more: toNotify.length - NOTIFY_PER_POLL }] : []);
        const links = Object.assign({}, base.links);
        for (const r of toNotify) if (r.runId && r.url) links['dcc-run-' + r.runId] = { url: r.url, jobId: r.jobId, runIds: [r.runId, r.originalRunId].filter(Boolean) };
        st.links = Object.fromEntries(Object.entries(links).slice(-LINK_CAP));
      } else {
        const failures = ((base.backoff && base.backoff.failures) || 0) + 1;
        st.backoff = { failures, nextAt: nowMs + Math.min(intervalMs(monitorSettings) * Math.pow(2, failures), MAX_BACKOFF_MS) };
        const codes = SECTIONS.map((s) => results[s].error && results[s].error.code);
        if (codes.includes('AUTH_EXPIRED')) {
          return { state: clearedState(st, target, 'signin', target.conn.authMode === 'oauth' ? NEXT.signinOauth() : target.conn.authMode === 'pat' ? NEXT.signinPat(new URL(target.origin).host) : NEXT.signinHelper(), nowMs), toNotify: [] };
        }
        st.status = 'error';
        st.next = new Set(codes).size === 1 ? results[SECTIONS[0]].error : null;
      }
      return { state: st, toNotify };
    }

    /** States without data (sign-in needed, no workspace, demo mode): data cleared, next step set. */
    function clearedState(cur, target, status, next, nowMs) {
      const same = cur && cur.origin === (target.origin || null);
      const st = emptyState(target, nowMs);
      return Object.assign(st, {
        status,
        next,
        backoff: same && cur.backoff ? cur.backoff : st.backoff,
        baselineAt: same ? cur.baselineAt : null,
        ackedFailed: same ? cur.ackedFailed || [] : [],
        failedSeen: same ? cur.failedSeen || [] : [],
        links: same ? cur.links || {} : {},
      });
    }

    /* ---------------------------------------------------------------- poll */

    async function canNotify(settings) {
      if (!settings.monitor.notifyFailures) return false;
      if (!chromeApi.notifications || !chromeApi.notifications.create || !chromeApi.permissions) return false;
      try {
        return (await chromeApi.permissions.contains({ permissions: ['notifications'] })) === true;
      } catch (_) {
        return false;
      }
    }

    async function runPoll({ manual = false, minGapMs = 0 } = {}) {
      const settings = await store.getSettings();
      const target = await resolveTarget(settings);
      const nowMs = now();
      if (target.status === 'disabled') return null;
      if (target.status !== 'ready') {
        const st = await mutate((cur) => clearedState(cur, target, target.status, target.next, nowMs));
        await updateBadge(st, settings);
        return st;
      }
      const prev = await readState();
      const sameOrigin = prev && prev.origin === target.origin;
      if (minGapMs && sameOrigin && prev.attemptAt && nowMs - prev.attemptAt < minGapMs) return prev;
      if (!manual && sameOrigin && prev.backoff && prev.backoff.nextAt > nowMs) {
        stats.skipped++;
        return prev;
      }
      stats.polls++;

      const results = {};
      let client = null;
      try {
        client = await clientFor(target.conn);
      } catch (e) {
        const error = errors.toPayload(e);
        for (const s of SECTIONS) results[s] = { ok: false, error };
      }
      if (client && client.signin) {
        const st = await mutate((cur) => clearedState(cur, target, 'signin', client.signin, nowMs));
        await updateBadge(st, settings);
        return st;
      }
      if (client) {
        const ctx = { origin: target.origin, workspaceId: target.conn.workspaceId };
        const settled = await Promise.allSettled([fetchActiveRuns(client, ctx), fetchRecentRuns(client, ctx, nowMs), fetchPipelines(client, nowMs), fetchWarehouses(client), fetchClusters(client)]);
        SECTIONS.forEach((s, i) => {
          results[s] = settled[i].status === 'fulfilled' ? { ok: true, value: settled[i].value } : { ok: false, error: errors.toPayload(settled[i].reason) };
        });
      }
      const notifyAllowed = await canNotify(settings);
      let toNotify = [];
      const st = await mutate((cur) => {
        const m = merge(cur, target, results, nowMs, { notifyAllowed, monitorSettings: settings.monitor });
        toNotify = m.toNotify;
        return m.state;
      });
      await updateBadge(st, settings);
      if (toNotify.length) await sendNotifications(toNotify, st, nowMs);
      return st;
    }

    /** Deduplicated: a poll already in flight is joined, never doubled. */
    function poll(opts) {
      if (inflight) return inflight;
      inflight = runPoll(opts).finally(() => {
        inflight = null;
      });
      return inflight;
    }

    /** After a settings change: let a poll for the old target finish, then poll (still deduplicated). */
    async function pollFresh(opts) {
      if (inflight) await inflight.catch(() => {});
      return poll(opts);
    }

    /* ---------------------------------------------------------------- badge + notifications */

    async function apiCall(obj, name, arg) {
      if (!obj || typeof obj[name] !== 'function') return;
      try {
        await obj[name](arg);
      } catch (e) {
        warn(e);
      }
    }

    async function setBadge(text, color, title) {
      const a = chromeApi.action;
      if (!a) return;
      await apiCall(a, 'setBadgeText', { text });
      await apiCall(a, 'setBadgeBackgroundColor', { color });
      await apiCall(a, 'setBadgeTextColor', { color: BADGE.text });
      await apiCall(a, 'setTitle', { title });
    }

    async function updateBadge(st, settings) {
      if (!settings.monitor.enabled || !st) return setBadge('', BADGE.normal, DEFAULT_TITLE);
      if (st.status === 'signin') return setBadge('', BADGE.normal, DEFAULT_TITLE + ' · run monitor needs sign-in');
      if (st.status !== 'ok' && st.status !== 'error') return setBadge('', BADGE.normal, DEFAULT_TITLE);
      const c = st.counts || {};
      const known = c.running !== null && c.running !== undefined;
      const active = (c.running || 0) + (c.pending || 0);
      const unseen = unseenFailures(st, now());
      let text = active > 99 ? '99+' : active > 0 ? String(active) : '';
      if (unseen) text = (active > 9 ? '9+' : text) + '!';
      const parts = [known ? plural(active, 'active run') : 'active runs unknown'];
      if (unseen) parts.push(plural(unseen, 'new failed run') + ' in the last 24 h');
      if (st.status === 'error') parts.push('last refresh failed');
      return setBadge(text, unseen ? BADGE.failure : BADGE.normal, DEFAULT_TITLE + ' · ' + parts.join(', '));
    }

    async function sendNotifications(list, st, nowMs) {
      const n = chromeApi.notifications;
      if (!n || !n.create) return;
      const iconUrl = chromeApi.runtime.getURL('icons/icon-128.png');
      const host = new URL(st.origin).host;
      for (const r of list) {
        try {
          if (r.more) {
            await n.create('dcc-more-' + nowMs, { type: 'basic', iconUrl, title: plural(r.more, 'more job run') + ' failed', message: 'Open the run monitor for details.', contextMessage: host, priority: 0 });
          } else {
            await n.create('dcc-run-' + r.runId, { type: 'basic', iconUrl, title: 'Databricks job run failed', message: (r.name || 'Run ' + r.runId) + ' · ' + r.statusText, contextMessage: host, priority: 0 });
          }
        } catch (e) {
          warn(e);
        }
      }
    }

    async function onNotificationClicked(id) {
      if (typeof id !== 'string' || !id.startsWith('dcc-')) return;
      try {
        if (id.startsWith('dcc-run-')) {
          const st = await readState();
          const link = st && st.links && st.links[id];
          const url = link ? mapi.validRunUrl(link.url, st.origin, st.workspaceId, link.jobId, link.runIds) : null;
          if (url) await chromeApi.tabs.create({ url });
          else await openWindow();
        } else if (id.startsWith('dcc-more-')) {
          await openWindow();
        }
      } finally {
        try {
          await chromeApi.notifications.clear(id);
        } catch (_) {
          /* already gone */
        }
      }
    }

    function registerNotificationListener() {
      const n = chromeApi.notifications;
      if (notificationListener || !n || !n.onClicked) return;
      n.onClicked.addListener((id) => {
        onNotificationClicked(id).catch(warn);
      });
      notificationListener = true;
    }

    /* ---------------------------------------------------------------- alarm + lifecycle */

    async function clearMonitorState() {
      await session.remove(STATE_KEY);
      await setBadge('', BADGE.normal, DEFAULT_TITLE);
    }

    /** Create the alarm only while enabled; never reset an existing matching schedule. */
    async function syncAlarm(settings) {
      const s = settings || (await store.getSettings());
      if (!s.monitor.enabled) {
        await chromeApi.alarms.clear(ALARM);
        await clearMonitorState();
        return false;
      }
      const period = Math.max(1, intervalMs(s.monitor) / 60000);
      const existing = await chromeApi.alarms.get(ALARM);
      if (!existing || existing.periodInMinutes !== period) await chromeApi.alarms.create(ALARM, { delayInMinutes: period, periodInMinutes: period });
      return true;
    }

    function monitorSnapshot(raw) {
      const m = raw && raw.monitor && typeof raw.monitor === 'object' ? raw.monitor : {};
      return { enabled: m.enabled === true, intervalSec: m.intervalSec, origin: m.origin || null, mode: raw ? raw.mode : null };
    }

    async function onSettingsChanged(oldRaw, newRaw) {
      const o = monitorSnapshot(oldRaw);
      const n = monitorSnapshot(newRaw);
      if (JSON.stringify(o) === JSON.stringify(n)) return;
      const settings = await store.getSettings();
      const enabled = await syncAlarm(settings);
      if (enabled && (o.enabled !== n.enabled || o.origin !== n.origin || o.mode !== n.mode)) await pollFresh({ manual: true, minGapMs: MANUAL_MIN_GAP_MS });
    }

    async function onStartup() {
      const settings = await store.getSettings();
      const enabled = await syncAlarm(settings);
      if (!enabled) return;
      poll({}).catch(warn);
      if (settings.monitor.autoOpen) await openWindow();
    }

    /* ---------------------------------------------------------------- window */

    async function openWindow() {
      if (windowOpening) return windowOpening;
      windowOpening = (async () => {
        const saved = await readKey(WINDOW_KEY);
        if (saved && Number.isInteger(saved.windowId)) {
          try {
            const w = await chromeApi.windows.get(saved.windowId);
            if (w && w.type === 'popup') {
              await chromeApi.windows.update(saved.windowId, w.state === 'minimized' ? { focused: true, state: 'normal' } : { focused: true });
              return { focused: true, windowId: saved.windowId };
            }
          } catch (_) {
            /* closed: open a new one */
          }
        }
        const w = await chromeApi.windows.create({ url: chromeApi.runtime.getURL('ui/monitor.html'), type: 'popup', width: WINDOW_SIZE.width, height: WINDOW_SIZE.height, focused: true });
        await session.set({ [WINDOW_KEY]: { windowId: w.id, openedAt: now() } });
        return { opened: true, windowId: w.id };
      })();
      try {
        return await windowOpening;
      } finally {
        windowOpening = null;
      }
    }

    async function onWindowRemoved(windowId) {
      const saved = await readKey(WINDOW_KEY);
      if (saved && saved.windowId === windowId) await session.remove(WINDOW_KEY);
    }

    /* ---------------------------------------------------------------- cost line */

    /** Same key data-service uses for the cached summary (peek only; never runs SQL). */
    function peekSummary(conn, periodDays) {
      const cache = deps.data && deps.data.cache;
      if (!cache || typeof cache.get !== 'function') return null;
      const k = cacheMod.key({ origin: conn.origin, workspaceId: conn.workspaceId, source: conn.authMode + ':' + conn.priceTable + ':' + conn.currency, connRev: conn.revision, kind: 'summary', periodDays });
      return cache.get(k) || null;
    }

    function costView(s, periodDays, cached) {
      const period = s.period && typeof s.period === 'object' ? { days: s.period.days, start: s.period.start, endExclusive: s.period.endExclusive } : { days: periodDays, start: null, endExclusive: null };
      const amount = typeof s.currentAmount === 'number' && Number.isFinite(s.currentAmount) ? s.currentAmount : null;
      return {
        amount,
        coverage: (s.current && s.current.coverage) || null,
        basis: s.synthetic ? 'demo' : s.pricingBasis || null,
        priceTable: s.priceTable || null,
        currency: V.isCurrency(s.currency) ? s.currency : 'USD',
        period,
        latestUsageMs: Number.isFinite(s.latestUsageMs) ? s.latestUsageMs : null,
        cached: Boolean(cached || s.cached),
        noImport: s.noImport === true,
      };
    }

    async function loadCost(msg) {
      const settings = await store.getSettings();
      if (!settings.showCosts) return { paused: true };
      const conns = await store.getConnections();
      const origin = effectiveOrigin(settings, conns);
      if (!origin) return { notConnected: true };
      const conn = conns[origin];
      const periodDays = settings.periodDays;
      // Demo and import answer locally with no network and no warehouse.
      if (settings.mode !== 'connected') return costView(await deps.data.summary({ origin, workspaceId: conn.workspaceId, periodDays, force: false }), periodDays, false);
      const hit = peekSummary(conn, periodDays);
      if (hit) return costView(hit, periodDays, true);
      if (msg && msg.cachedOnly === true) return { notCached: true, periodDays };
      const warehouseId = config.effectiveWarehouseId(conn);
      if (!warehouseId) throw new errors.DccError({ code: 'WAREHOUSE_UNAVAILABLE', message: 'No warehouse resolved' });
      const list = await deps.data.listWarehouses({ origin, authMode: conn.authMode });
      const wh = (list || []).find((w) => w.id === warehouseId);
      if (!wh) throw new errors.DccError({ code: 'WAREHOUSE_UNAVAILABLE', message: 'The saved warehouse is not visible' });
      if (wh.state !== 'RUNNING' && !(msg && msg.confirmStart === true)) {
        return { needsConfirm: true, warehouseId: wh.id, warehouseName: wh.name, state: wh.state, periodDays };
      }
      const s = await deps.data.summary({ origin, workspaceId: conn.workspaceId, periodDays, force: false });
      if (s && s.stale) return { stale: true };
      return costView(s, periodDays, false);
    }

    /* ---------------------------------------------------------------- page handlers */

    async function notificationsGranted() {
      if (!chromeApi.permissions || !chromeApi.permissions.contains) return false;
      try {
        return (await chromeApi.permissions.contains({ permissions: ['notifications'] })) === true;
      } catch (_) {
        return false;
      }
    }

    async function getState({ ack = false } = {}) {
      const settings = await store.getSettings();
      const conns = await store.getConnections();
      const origin = effectiveOrigin(settings, conns);
      let st = await readState();
      // The visible window has shown these failures: they no longer count as new on the badge.
      if (ack && st && settings.monitor.enabled && unseenFailures(st, now()) > 0) {
        st = await mutate((cur) => {
          if (!cur) return null;
          const shown = recentFailedRuns(cur, now()).map((r) => r.runId);
          return Object.assign({}, cur, { ackedFailed: [...new Set((cur.ackedFailed || []).concat(shown))].slice(-SEEN_CAP) });
        });
        await updateBadge(st, settings);
      }
      const matches = st && (st.origin === origin || CLEARED_STATUSES.has(st.status));
      return {
        settings: Object.assign({}, settings.monitor),
        mode: settings.mode,
        showCosts: settings.showCosts,
        periodDays: settings.periodDays,
        connections: Object.keys(conns).sort(),
        monitorOrigin: origin,
        notificationsGranted: await notificationsGranted(),
        state: settings.monitor.enabled && matches ? publicView(st, now()) : null,
      };
    }

    async function refresh(msg) {
      const settings = await store.getSettings();
      if (msg && msg.ifStale === true) {
        const st = await readState();
        const fresh = st && st.attemptAt && now() - st.attemptAt < intervalMs(settings.monitor);
        if (!fresh) await poll({});
      } else {
        await poll({ manual: true, minGapMs: MANUAL_MIN_GAP_MS });
      }
      return getState({});
    }

    async function setOrigin(msg) {
      const cls = ids.classifyOrigin(msg && msg.origin);
      if (!cls.ok || cls.origin !== msg.origin) throw new errors.DccError({ code: 'UNKNOWN', message: 'Unsupported origin' });
      const conns = await store.getConnections();
      if (!conns[cls.origin]) throw new errors.DccError({ code: 'NOT_CONNECTED', message: 'Not a saved workspace' });
      const settings = await store.updateSettings({ monitor: { origin: cls.origin } });
      if (settings.monitor.enabled) await pollFresh({ manual: true });
      return getState({});
    }

    const handlers = {
      'monitor:open': { trust: 'page', handle: () => openWindow() },
      'monitor:state': { trust: 'page', handle: (msg) => getState({ ack: Boolean(msg && msg.ack === true) }) },
      'monitor:refresh': { trust: 'page', handle: (msg) => refresh(msg) },
      'monitor:setOrigin': { trust: 'page', handle: (msg) => setOrigin(msg) },
      'monitor:loadCost': { trust: 'page', handle: (msg) => loadCost(msg) },
    };

    /** Synchronous listener registration; safe to call once at service-worker evaluation. */
    function init() {
      chromeApi.alarms.onAlarm.addListener((alarm) => {
        if (alarm && alarm.name === ALARM) poll({}).catch(warn);
      });
      chromeApi.runtime.onStartup.addListener(() => {
        onStartup().catch(warn);
      });
      if (chromeApi.runtime.onInstalled) {
        // Extension updates clear alarms; recreate it and refresh the badge right away.
        chromeApi.runtime.onInstalled.addListener(() => {
          syncAlarm()
            .then((enabled) => (enabled ? poll({}) : null))
            .catch(warn);
        });
      }
      chromeApi.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes || !changes[settingsKey]) return;
        onSettingsChanged(changes[settingsKey].oldValue, changes[settingsKey].newValue).catch(warn);
      });
      if (chromeApi.windows && chromeApi.windows.onRemoved) {
        chromeApi.windows.onRemoved.addListener((windowId) => {
          onWindowRemoved(windowId).catch(warn);
        });
      }
      registerNotificationListener();
      // The notifications API appears only after the optional permission is granted.
      if (chromeApi.permissions && chromeApi.permissions.onAdded) chromeApi.permissions.onAdded.addListener(() => registerNotificationListener());
      // Service worker restarted: make sure the alarm matches settings (does not reset a schedule).
      syncAlarm().catch(warn);
    }

    return { handlers, init, poll, syncAlarm, openWindow, loadCost, getState, readState, onNotificationClicked, onStartup, updateBadge, stats };
  }

  const api = Object.freeze({ ALARM, STATE_KEY, WINDOW_KEY, BADGE, WINDOW_SIZE, SEEN_CAP, NOTIFY_PER_POLL, MAX_BACKOFF_MS, create, unseenFailures });
  if (NODE) {
    module.exports = api;
  } else {
    const DCC = root.DCC || (root.DCC = {});
    DCC.monitor = api;
    let instance = null;
    const ensure = (deps) => instance || (instance = create(deps));
    (DCC.handlerFactories || (DCC.handlerFactories = [])).push((deps) => ensure(deps).handlers);
    (DCC.backgroundInits || (DCC.backgroundInits = [])).push((deps) => ensure(deps).init());
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
