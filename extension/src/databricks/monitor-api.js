/*
 * Run/compute monitor: pure normalization of read-only REST responses (Jobs 2.2 runs/list,
 * Pipelines list, SQL warehouses list, Clusters 2.1 list) into small, validated records for the
 * monitor widget. No network here.
 *
 * Rules:
 * - IDs are validated (DCC.validate); records with an invalid primary ID are dropped and counted.
 * - The only URL kept is a run's run_page_url, and only when it parses (DCC.ids.parseResourceLink)
 *   as that exact job run on the monitored workspace origin. Every other URL is dropped.
 * - Jobs: `status` (state + termination_details) is authoritative; the deprecated `state`
 *   (life_cycle_state + result_state) is read only when `status` is absent.
 * - Unknown or missing values are null, never 0. Free-text error messages are never kept
 *   (they can echo SQL text); only enum-like codes are.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const V = dep('validate', '../core/validate.js');
  const ids = dep('ids', '../core/ids.js');
  const warehouses = dep('warehouses', './warehouses.js');

  const PATHS = Object.freeze({
    runs: '/api/2.2/jobs/runs/list',
    pipelines: '/api/2.0/pipelines',
    warehouses: '/api/2.0/sql/warehouses',
    clusters: '/api/2.1/clusters/list',
  });
  /** The complete set of paths the monitor may GET. Never SQL statement endpoints. */
  const MONITOR_PATHS = Object.freeze(Object.values(PATHS));
  const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
  const RUNS_LIMIT = 25;
  const PIPELINES_MAX_RESULTS = 100;
  const CLUSTERS_PAGE_SIZE = 100;
  const PAGE_TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;
  const ENUM = /^[A-Z][A-Z0-9_]{0,63}$/;

  function isMonitorPath(path) {
    return MONITOR_PATHS.includes(path);
  }

  function enumOrNull(v) {
    return typeof v === 'string' && ENUM.test(v) ? v : null;
  }

  function textOrNull(v, max = 200) {
    if (typeof v !== 'string') return null;
    const t = V.safeText(v, max).trim();
    return t || null;
  }

  /** Epoch ms from a positive finite number (APIs use 0 for "not yet"), else null. */
  function msOrNull(v) {
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  }

  function isoMsOrNull(v) {
    if (typeof v === 'number') return msOrNull(v);
    if (typeof v !== 'string' || v.length > 40) return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }

  function intOrNull(v) {
    return Number.isInteger(v) && v >= 0 ? v : null;
  }

  function pageToken(v) {
    return typeof v === 'string' && PAGE_TOKEN.test(v) ? v : null;
  }

  /**
   * Numeric Databricks ID as a string. JSON numbers above 2^53 lose precision when parsed, so an
   * unsafe integer is accepted only when an already validated string form (from the run's own
   * page URL) rounds to the same number.
   */
  function numericId(raw, fromUrl) {
    if (typeof raw === 'string') return V.isNumericId(raw) ? raw : null;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return null;
    if (Number.isSafeInteger(raw)) return String(raw);
    return V.isNumericId(fromUrl) && Number(fromUrl) === raw ? fromUrl : null;
  }

  /* ------------------------------------------------------------------ job runs */

  const PENDING_STATES = new Set(['PENDING', 'QUEUED', 'BLOCKED', 'WAITING', 'WAITING_FOR_RETRY']);
  const RUNNING_STATES = new Set(['RUNNING', 'TERMINATING']);
  const TERM_SUCCESS = new Set(['SUCCESS']);
  const TERM_PARTIAL = new Set(['SUCCESS_WITH_FAILURES']);
  const TERM_CANCELED = new Set(['CANCELED', 'CANCELLED', 'USER_CANCELED']);
  const TERM_SKIPPED = new Set(['SKIPPED', 'DISABLED', 'EXCLUDED', 'MAX_CONCURRENT_RUNS_EXCEEDED', 'MAX_JOB_QUEUE_SIZE_EXCEEDED']);
  const RESULT_OUTCOME = Object.freeze({
    SUCCESS: 'succeeded',
    SUCCESS_WITH_FAILURES: 'partial',
    FAILED: 'failed',
    TIMEDOUT: 'failed',
    UPSTREAM_FAILED: 'failed',
    CANCELED: 'canceled',
    UPSTREAM_CANCELED: 'canceled',
    EXCLUDED: 'skipped',
    DISABLED: 'skipped',
    MAXIMUM_CONCURRENT_RUNS_REACHED: 'skipped',
  });
  const STATE_TEXT = Object.freeze({
    PENDING: 'Pending',
    QUEUED: 'Queued',
    BLOCKED: 'Blocked',
    WAITING: 'Waiting to retry',
    WAITING_FOR_RETRY: 'Waiting to retry',
    RUNNING: 'Running',
    TERMINATING: 'Finishing',
  });
  const OUTCOME_TEXT = Object.freeze({
    running: 'Running',
    pending: 'Pending',
    succeeded: 'Succeeded',
    failed: 'Failed',
    partial: 'Some tasks failed',
    canceled: 'Canceled',
    skipped: 'Skipped',
    unknown: 'Status unknown',
  });

  function outcomeText(outcome, state, code) {
    if (STATE_TEXT[state]) return STATE_TEXT[state];
    if (outcome === 'failed' && code && /TIMEDOUT|TIMED_OUT|TIMEOUT/.test(code)) return 'Timed out';
    return OUTCOME_TEXT[outcome] || OUTCOME_TEXT.unknown;
  }

  /**
   * Outcome of a run from `status` (preferred) or the deprecated `state`.
   * @returns {{outcome, state, code, codeType, source:'status'|'state'|null, text}}
   */
  function runOutcome(raw) {
    const status = raw && raw.status && typeof raw.status === 'object' ? raw.status : null;
    if (status) {
      const state = enumOrNull(status.state);
      const td = status.termination_details && typeof status.termination_details === 'object' ? status.termination_details : {};
      const code = enumOrNull(td.code);
      const codeType = enumOrNull(td.type);
      let outcome = 'unknown';
      if (PENDING_STATES.has(state)) outcome = 'pending';
      else if (RUNNING_STATES.has(state)) outcome = 'running';
      else if (state === 'TERMINATED') {
        if (TERM_SUCCESS.has(code)) outcome = 'succeeded';
        else if (TERM_PARTIAL.has(code)) outcome = 'partial';
        else if (TERM_CANCELED.has(code)) outcome = 'canceled';
        else if (TERM_SKIPPED.has(code)) outcome = 'skipped';
        else if (code) outcome = codeType === 'SUCCESS' ? 'succeeded' : 'failed';
        else if (codeType) outcome = codeType === 'SUCCESS' ? 'succeeded' : 'failed';
      }
      return { outcome, state, code, codeType, source: 'status', text: outcomeText(outcome, state, code) };
    }
    const legacy = raw && raw.state && typeof raw.state === 'object' ? raw.state : null;
    if (legacy) {
      const life = enumOrNull(legacy.life_cycle_state);
      const result = enumOrNull(legacy.result_state);
      let outcome = 'unknown';
      if (PENDING_STATES.has(life)) outcome = 'pending';
      else if (RUNNING_STATES.has(life)) outcome = 'running';
      else if (life === 'SKIPPED') outcome = 'skipped';
      else if (life === 'INTERNAL_ERROR') outcome = 'failed';
      else if (life === 'TERMINATED') outcome = RESULT_OUTCOME[result] || 'unknown';
      const code = result || (life === 'INTERNAL_ERROR' ? 'INTERNAL_ERROR' : null);
      return { outcome, state: life, code, codeType: null, source: 'state', text: outcomeText(outcome, life, code) };
    }
    return { outcome: 'unknown', state: null, code: null, codeType: null, source: null, text: OUTCOME_TEXT.unknown };
  }

  /**
   * Keep a run page URL only if it is this exact job run on the monitored workspace.
   * @returns {string|null} normalized absolute URL
   */
  function validRunUrl(href, origin, workspaceId, jobId, runIds) {
    if (typeof href !== 'string' || href.length > 2048) return null;
    const cls = ids.classifyOrigin(origin);
    if (!cls.ok || cls.origin !== origin) return null;
    const ref = ids.parseResourceLink(href, origin, V.isWorkspaceId(workspaceId) ? workspaceId : null);
    if (!ref || ref.type !== 'job_run') return null;
    if (!jobId || ref.jobId !== jobId) return null;
    const allowed = [].concat(runIds).filter(Boolean);
    if (!allowed.includes(ref.runId)) return null;
    try {
      const url = new URL(href, origin);
      return url.origin === origin ? url.href : null;
    } catch (_) {
      return null;
    }
  }

  /** IDs that a run page URL claims, before they are trusted (used only for >2^53 recovery). */
  function urlIds(href, origin, workspaceId) {
    if (typeof href !== 'string') return null;
    const ref = ids.parseResourceLink(href, origin, V.isWorkspaceId(workspaceId) ? workspaceId : null);
    return ref && ref.type === 'job_run' ? ref : null;
  }

  /**
   * @param raw one element of runs/list `runs`
   * @param {{origin, workspaceId}} ctx monitored workspace
   * @returns {object|null} null when the run ID is invalid
   */
  function normalizeRun(raw, ctx) {
    if (!raw || typeof raw !== 'object') return null;
    const claimed = urlIds(raw.run_page_url, ctx.origin, ctx.workspaceId);
    const runId = numericId(raw.run_id, claimed && claimed.runId);
    if (!runId) return null;
    const jobId = numericId(raw.job_id, claimed && claimed.jobId);
    const originalRunId = numericId(raw.original_attempt_run_id, claimed && claimed.runId);
    const o = runOutcome(raw);
    const startMs = msOrNull(raw.start_time);
    const endMs = msOrNull(raw.end_time);
    const active = o.outcome === 'running' || o.outcome === 'pending';
    let durationMs = null;
    if (!active) {
      if (msOrNull(raw.run_duration) !== null) durationMs = msOrNull(raw.run_duration);
      else if (startMs !== null && endMs !== null && endMs >= startMs) durationMs = endMs - startMs;
    }
    return {
      runId,
      jobId,
      originalRunId: originalRunId && originalRunId !== runId ? originalRunId : null,
      name: textOrNull(raw.run_name),
      outcome: o.outcome,
      statusText: o.text,
      state: o.state,
      code: o.code,
      statusSource: o.source,
      active,
      startMs,
      endMs: active ? null : endMs,
      durationMs,
      trigger: enumOrNull(raw.trigger),
      attempt: intOrNull(raw.attempt_number),
      url: validRunUrl(raw.run_page_url, ctx.origin, ctx.workspaceId, jobId, [runId, originalRunId]),
    };
  }

  /** @returns {{runs, dropped, nextPageToken, hasMore, truncated}} */
  function normalizeRunsResponse(json, ctx) {
    const list = json && Array.isArray(json.runs) ? json.runs : [];
    const runs = [];
    let dropped = 0;
    const seen = new Set();
    for (const raw of list) {
      const r = normalizeRun(raw, ctx);
      if (!r || seen.has(r.runId)) {
        dropped++;
        continue;
      }
      seen.add(r.runId);
      runs.push(r);
    }
    const token = pageToken(json && json.next_page_token);
    const hasMore = Boolean(token || (json && json.has_more === true));
    return { runs, dropped, nextPageToken: token, hasMore, truncated: hasMore && !token };
  }

  /* ------------------------------------------------------------------ pipelines */

  const PIPELINE_ACTIVE = new Set(['RUNNING', 'STARTING', 'RECOVERING', 'RESETTING', 'DEPLOYING', 'STOPPING']);
  const UPDATE_PENDING = new Set(['QUEUED', 'CREATED', 'WAITING_FOR_RESOURCES']);
  const UPDATE_RUNNING = new Set(['INITIALIZING', 'RESETTING', 'SETTING_UP_TABLES', 'RUNNING', 'STOPPING']);
  const UPDATE_DONE = Object.freeze({ COMPLETED: 'succeeded', FAILED: 'failed', CANCELED: 'canceled' });
  const UPDATE_TEXT = Object.freeze({
    QUEUED: 'Queued',
    CREATED: 'Created',
    WAITING_FOR_RESOURCES: 'Waiting for resources',
    INITIALIZING: 'Initializing',
    RESETTING: 'Resetting',
    SETTING_UP_TABLES: 'Setting up tables',
    RUNNING: 'Running',
    STOPPING: 'Stopping',
    COMPLETED: 'Completed',
    FAILED: 'Failed',
    CANCELED: 'Canceled',
  });

  function normalizeUpdate(raw) {
    if (!raw || typeof raw !== 'object' || !V.isUuid(raw.update_id)) return null;
    const state = enumOrNull(raw.state);
    let outcome = 'unknown';
    if (UPDATE_PENDING.has(state)) outcome = 'pending';
    else if (UPDATE_RUNNING.has(state)) outcome = 'running';
    else if (UPDATE_DONE[state]) outcome = UPDATE_DONE[state];
    return { updateId: raw.update_id, state, outcome, statusText: UPDATE_TEXT[state] || OUTCOME_TEXT.unknown, createdMs: isoMsOrNull(raw.creation_time) };
  }

  function normalizePipeline(raw, nowMs) {
    if (!raw || typeof raw !== 'object' || !V.isUuid(raw.pipeline_id)) return null;
    const state = enumOrNull(raw.state);
    const updates = Array.isArray(raw.latest_updates) ? raw.latest_updates : [];
    // latest_updates is newest first; pick the newest valid one.
    let update = null;
    for (const u of updates) {
      update = normalizeUpdate(u);
      if (update) break;
    }
    const updateActive = Boolean(update && (update.outcome === 'running' || update.outcome === 'pending'));
    const active = updateActive || PIPELINE_ACTIVE.has(state);
    const recentFailure = Boolean(
      state === 'FAILED' || (update && update.outcome === 'failed' && update.createdMs !== null && nowMs - update.createdMs <= RECENT_WINDOW_MS)
    );
    return {
      pipelineId: raw.pipeline_id,
      name: textOrNull(raw.name),
      state,
      health: enumOrNull(raw.health),
      update,
      active,
      recentFailure,
    };
  }

  /**
   * Keeps only pipelines that are active or failed recently (the widget is a run monitor, not
   * an inventory).
   * @returns {{pipelines, listed, dropped, hasMore, nextPageToken}}
   */
  function normalizePipelinesResponse(json, nowMs) {
    const list = json && Array.isArray(json.statuses) ? json.statuses : [];
    const out = [];
    let dropped = 0;
    let listed = 0;
    for (const raw of list) {
      const p = normalizePipeline(raw, nowMs);
      if (!p) {
        dropped++;
        continue;
      }
      listed++;
      if (p.active || p.recentFailure) out.push(p);
    }
    const token = pageToken(json && json.next_page_token);
    return { pipelines: out, listed, dropped, hasMore: Boolean(token || (json && json.next_page_token)), nextPageToken: token };
  }

  /* ------------------------------------------------------------------ SQL warehouses */

  function normalizeWarehouse(raw) {
    const w = warehouses.normalize(raw);
    if (!w) return null;
    return {
      id: w.id,
      name: w.name,
      state: enumOrNull(w.state),
      size: w.size,
      type: w.type,
      serverless: w.serverless,
      activeClusters: intOrNull(raw.num_clusters),
      minClusters: w.minClusters,
      maxClusters: w.maxClusters,
    };
  }

  function normalizeWarehousesResponse(json) {
    const list = json && Array.isArray(json.warehouses) ? json.warehouses : [];
    const out = [];
    let dropped = 0;
    for (const raw of list) {
      const w = normalizeWarehouse(raw);
      if (w) out.push(w);
      else dropped++;
    }
    const token = pageToken(json && json.next_page_token);
    return { warehouses: out, dropped, nextPageToken: token, hasMore: Boolean(token || (json && json.next_page_token)) };
  }

  /* ------------------------------------------------------------------ clusters */

  const CLUSTER_ACTIVE = new Set(['PENDING', 'RUNNING', 'RESTARTING', 'RESIZING']);
  const CLUSTER_TEXT = Object.freeze({ PENDING: 'Starting', RUNNING: 'Running', RESTARTING: 'Restarting', RESIZING: 'Resizing', TERMINATING: 'Terminating', TERMINATED: 'Terminated', ERROR: 'Error', UNKNOWN: 'Status unknown' });

  function normalizeCluster(raw) {
    if (!raw || typeof raw !== 'object' || !V.isClusterId(raw.cluster_id)) return null;
    const state = enumOrNull(raw.state);
    const auto = raw.autoscale && typeof raw.autoscale === 'object' ? raw.autoscale : null;
    const min = auto ? intOrNull(auto.min_workers) : null;
    const max = auto ? intOrNull(auto.max_workers) : null;
    return {
      clusterId: raw.cluster_id,
      name: textOrNull(raw.cluster_name),
      state,
      statusText: CLUSTER_TEXT[state] || OUTCOME_TEXT.unknown,
      source: enumOrNull(raw.cluster_source),
      workers: auto ? null : intOrNull(raw.num_workers),
      autoscale: min !== null && max !== null ? { min, max } : null,
      startMs: msOrNull(raw.start_time),
      active: CLUSTER_ACTIVE.has(state),
    };
  }

  /**
   * Keeps active clusters only. The API sorts by state first by default, so `lastActive` says
   * whether the next page may still hold active clusters.
   */
  function normalizeClustersResponse(json) {
    const list = json && Array.isArray(json.clusters) ? json.clusters : [];
    const out = [];
    let dropped = 0;
    let lastActive = false;
    for (const raw of list) {
      const c = normalizeCluster(raw);
      if (!c) {
        dropped++;
        continue;
      }
      lastActive = c.active;
      if (c.active) out.push(c);
    }
    const token = pageToken(json && json.next_page_token);
    return { clusters: out, listed: list.length - dropped, dropped, nextPageToken: token, hasMore: Boolean(token || (json && json.next_page_token)), lastActive };
  }

  /* ------------------------------------------------------------------ requests */

  const requests = Object.freeze({
    activeRuns: () => ({ path: PATHS.runs, query: { active_only: 'true', limit: String(RUNS_LIMIT), expand_tasks: 'false' } }),
    recentRuns: (nowMs, token) => ({
      path: PATHS.runs,
      query: { completed_only: 'true', start_time_from: String(Math.floor(nowMs - RECENT_WINDOW_MS)), limit: String(RUNS_LIMIT), expand_tasks: 'false', page_token: pageToken(token) || undefined },
    }),
    pipelines: () => ({ path: PATHS.pipelines, query: { max_results: String(PIPELINES_MAX_RESULTS) } }),
    warehouses: (token) => ({ path: PATHS.warehouses, query: { page_token: pageToken(token) || undefined } }),
    clusters: (token) => ({ path: PATHS.clusters, query: { page_size: String(CLUSTERS_PAGE_SIZE), page_token: pageToken(token) || undefined } }),
  });

  /* ------------------------------------------------------------------ counts */

  /** Display order: active runs (newest start first), then finished runs (newest end first). */
  function sortRuns(runs) {
    const t = (r) => (r.active ? r.startMs : r.endMs !== null ? r.endMs : r.startMs) || 0;
    return runs.slice().sort((a, b) => (a.active !== b.active ? (a.active ? -1 : 1) : t(b) - t(a)));
  }

  function inRecentWindow(run, nowMs) {
    const t = run.endMs !== null ? run.endMs : run.startMs;
    return t !== null && nowMs - t <= RECENT_WINDOW_MS;
  }

  /**
   * Counts for the widget and badge. A section that has never loaded gives null counts (unknown),
   * never zero.
   * @param {{runsActive?:object[]|null, runsRecent?:object[]|null, pipelines?, warehouses?, clusters?}} s
   */
  function summarize(s, nowMs) {
    const counts = {
      running: null,
      pending: null,
      failed: null,
      succeeded: null,
      partial: null,
      canceled: null,
      skipped: null,
      pipelinesActive: null,
      pipelinesFailed: null,
      warehousesRunning: null,
      warehousesStarting: null,
      warehousesStopped: null,
      warehousesTotal: null,
      clustersActive: null,
    };
    if (Array.isArray(s.runsActive)) {
      counts.running = s.runsActive.filter((r) => r.outcome === 'running').length;
      counts.pending = s.runsActive.filter((r) => r.outcome === 'pending').length;
    }
    if (Array.isArray(s.runsRecent)) {
      const recent = s.runsRecent.filter((r) => !r.active && inRecentWindow(r, nowMs));
      for (const k of ['failed', 'succeeded', 'partial', 'canceled', 'skipped']) counts[k] = recent.filter((r) => r.outcome === k).length;
    }
    if (Array.isArray(s.pipelines)) {
      counts.pipelinesActive = s.pipelines.filter((p) => p.active).length;
      counts.pipelinesFailed = s.pipelines.filter((p) => p.recentFailure).length;
    }
    if (Array.isArray(s.warehouses)) {
      counts.warehousesTotal = s.warehouses.length;
      counts.warehousesRunning = s.warehouses.filter((w) => w.state === 'RUNNING').length;
      counts.warehousesStarting = s.warehouses.filter((w) => w.state === 'STARTING').length;
      counts.warehousesStopped = s.warehouses.filter((w) => w.state === 'STOPPED' || w.state === 'STOPPING').length;
    }
    if (Array.isArray(s.clusters)) counts.clustersActive = s.clusters.filter((c) => c.active).length;
    return counts;
  }

  const api = Object.freeze({
    PATHS,
    MONITOR_PATHS,
    RECENT_WINDOW_MS,
    RUNS_LIMIT,
    OUTCOME_TEXT,
    isMonitorPath,
    pageToken,
    numericId,
    runOutcome,
    validRunUrl,
    normalizeRun,
    normalizeRunsResponse,
    normalizePipeline,
    normalizePipelinesResponse,
    normalizeWarehouse,
    normalizeWarehousesResponse,
    normalizeCluster,
    normalizeClustersResponse,
    requests,
    sortRuns,
    inRecentWindow,
    summarize,
  });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).monitorApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
