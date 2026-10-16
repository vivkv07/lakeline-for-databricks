/*
 * Workspace and resource identity.
 *
 * - classifyOrigin: is this URL a supported Databricks workspace (or the local fixture)?
 * - resolveWorkspaceId: numeric workspace ID from URL params, hash routes, host, observed tab
 *   metadata, or the saved connection — in that order, refusing conflicting sources.
 * - parseResourceLink / parsePageRoute: native job, run, pipeline, update, warehouse, notebook,
 *   app and query-history identity from real hrefs. Never from names or React state.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const V = NODE ? require('./validate.js') : root.DCC.validate;

  const FIXTURE_ORIGIN = 'http://127.0.0.1:8765';
  const HOST_SUFFIXES = Object.freeze([
    { suffix: '.cloud.databricks.com', cloud: 'aws' },
    { suffix: '.azuredatabricks.net', cloud: 'azure' },
    { suffix: '.gcp.databricks.com', cloud: 'gcp' },
  ]);
  const HOST_PATTERNS = Object.freeze(HOST_SUFFIXES.map((h) => 'https://*' + h.suffix + '/*'));
  const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  // Account console and identity hosts are never workspaces.
  const NON_WORKSPACE_FIRST_LABEL = /^(accounts|accounts-[a-z0-9-]+|login|signin|auth|docs|www|community-docs)$/;

  function safeUrl(input, base) {
    try {
      return new URL(input, base);
    } catch (_) {
      return null;
    }
  }

  /**
   * @returns {{ok:true, origin, host, cloud, kind:'workspace'|'fixture'} | {ok:false, reason}}
   */
  function classifyOrigin(input) {
    const url = input instanceof URL ? input : safeUrl(String(input || ''));
    if (!url) return { ok: false, reason: 'invalid-url' };
    if (url.username || url.password) return { ok: false, reason: 'credentials-in-url' };
    if (url.origin === FIXTURE_ORIGIN) {
      return { ok: true, origin: FIXTURE_ORIGIN, host: url.host, cloud: 'fixture', kind: 'fixture' };
    }
    if (url.protocol !== 'https:') return { ok: false, reason: 'not-https' };
    if (url.port && url.port !== '443') return { ok: false, reason: 'non-default-port' };
    const host = url.hostname.toLowerCase();
    const match = HOST_SUFFIXES.find((h) => host.endsWith(h.suffix));
    if (!match) return { ok: false, reason: 'unsupported-host' };
    const prefix = host.slice(0, -match.suffix.length);
    const labels = prefix.split('.');
    if (!prefix || !labels.every((l) => LABEL.test(l))) return { ok: false, reason: 'unsupported-host' };
    if (NON_WORKSPACE_FIRST_LABEL.test(labels[0])) return { ok: false, reason: 'account-console' };
    return { ok: true, origin: 'https://' + host, host, cloud: match.cloud, kind: 'workspace' };
  }

  /** Workspace ID encoded in documented per-workspace hostnames (Azure adb-<id>.<n>, GCP <id>.<n>). */
  function workspaceIdFromHost(host) {
    const azure = /^adb-([0-9]{1,19})\.[0-9]+\.azuredatabricks\.net$/.exec(host);
    if (azure && V.isWorkspaceId(azure[1])) return azure[1];
    const gcp = /^([0-9]{1,19})\.[0-9]+\.gcp\.databricks\.com$/.exec(host);
    if (gcp && V.isWorkspaceId(gcp[1])) return gcp[1];
    return null;
  }

  const ID_PARAMS = ['o', 'w', 'workspace_id'];

  function idsFromParams(params) {
    const found = [];
    for (const name of ID_PARAMS) {
      for (const value of params.getAll(name)) found.push({ value, source: 'param:' + name });
    }
    return found;
  }

  /** Query string embedded in a hash route, e.g. `#job/1?o=123`. */
  function hashParams(hash) {
    const q = (hash || '').indexOf('?');
    return q === -1 ? new URLSearchParams() : new URLSearchParams(hash.slice(q + 1));
  }

  /**
   * Resolve the numeric workspace ID for a page.
   * @param {string|URL} input page URL
   * @param {{observedId?:string, savedId?:string}} context
   * @returns {{id:string|null, source:string|null, conflict?:boolean, candidates?:string[]}}
   */
  function resolveWorkspaceId(input, context = {}) {
    const url = input instanceof URL ? input : safeUrl(String(input || ''));
    if (!url) return { id: null, source: null };
    const candidates = [...idsFromParams(url.searchParams), ...idsFromParams(hashParams(url.hash))];
    const hostId = workspaceIdFromHost(url.hostname.toLowerCase());
    if (hostId) candidates.push({ value: hostId, source: 'host' });

    const invalid = candidates.filter((c) => !V.isWorkspaceId(c.value));
    if (invalid.length) return { id: null, source: null, conflict: true, candidates: candidates.map((c) => c.value) };
    const distinct = [...new Set(candidates.map((c) => c.value))];
    if (distinct.length > 1) return { id: null, source: null, conflict: true, candidates: distinct };
    if (distinct.length === 1) return { id: distinct[0], source: candidates[0].source };
    if (V.isWorkspaceId(context.observedId)) return { id: context.observedId, source: 'observed-tab' };
    if (V.isWorkspaceId(context.savedId)) return { id: context.savedId, source: 'saved-connection' };
    return { id: null, source: null };
  }

  /* ------------------------------------------------------------------ resource routes */

  const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  // Ordered: more specific routes first. `kind` drives which billing key is used.
  const PATH_ROUTES = [
    { re: new RegExp('^/jobs/([0-9]{1,20})/runs/([0-9]{1,20})/?$'), build: (m) => ({ type: 'job_run', jobId: m[1], runId: m[2] }) },
    { re: new RegExp('^/jobs/([0-9]{1,20})/?$'), build: (m) => ({ type: 'job', jobId: m[1] }) },
    { re: new RegExp('^/pipelines/(' + UUID_RE + ')/updates/(' + UUID_RE + ')/?$'), build: (m) => ({ type: 'pipeline_update', pipelineId: m[1], updateId: m[2] }) },
    { re: new RegExp('^/pipelines/(' + UUID_RE + ')/?$'), build: (m) => ({ type: 'pipeline', pipelineId: m[1] }) },
    { re: /^\/sql\/warehouses\/([0-9a-f]{16})\/?$/, build: (m) => ({ type: 'warehouse', warehouseId: m[1] }) },
    { re: /^\/editor\/notebooks\/([0-9]{1,20})\/?$/, build: (m) => ({ type: 'notebook', notebookId: m[1] }) },
    { re: /^\/apps\/([a-z0-9-]{2,30})\/?$/, build: (m) => (RESERVED_APP_SEGMENTS.has(m[1]) ? null : { type: 'app', appName: m[1] }) },
  ];
  // Legacy hash routes (`/#job/1/run/2`, `/#joblist/pipelines/<uuid>`, `/#notebook/<id>`).
  const HASH_ROUTES = [
    { re: /^#job\/([0-9]{1,20})\/run\/([0-9]{1,20})(?:[/?]|$)/, build: (m) => ({ type: 'job_run', jobId: m[1], runId: m[2] }) },
    { re: /^#job\/([0-9]{1,20})(?:\?|$)/, build: (m) => ({ type: 'job', jobId: m[1] }) },
    { re: new RegExp('^#joblist/pipelines/(' + UUID_RE + ')/updates/(' + UUID_RE + ')(?:[/?]|$)'), build: (m) => ({ type: 'pipeline_update', pipelineId: m[1], updateId: m[2] }) },
    { re: new RegExp('^#joblist/pipelines/(' + UUID_RE + ')(?:\\?|$)'), build: (m) => ({ type: 'pipeline', pipelineId: m[1] }) },
    { re: /^#notebook\/([0-9]{1,20})(?:[/?]|$)/, build: (m) => ({ type: 'notebook', notebookId: m[1] }) },
  ];
  const RESERVED_APP_SEGMENTS = new Set(['create', 'new', 'install', 'templates', 'settings']);
  const NAV_ONLY_SUFFIX = /\/(edit|create|new|settings|permissions|clone)\/?$/;

  function matchRoutes(routes, text) {
    for (const r of routes) {
      const m = r.re.exec(text);
      if (m) return r.build(m);
    }
    return null;
  }

  /** Statement ID for Query History execution-detail links (`queryId=` / `statementId=` params). */
  function statementIdFromUrl(url) {
    if (!/^\/sql\/history\/?$|^\/sql\/history\//.test(url.pathname)) return null;
    for (const name of ['queryId', 'statementId', 'statement_id']) {
      const v = url.searchParams.get(name);
      if (v && V.isStatementId(v.toLowerCase())) return v.toLowerCase();
    }
    const tail = /^\/sql\/history\/(?:queries\/)?([0-9a-f-]{36})\/?$/i.exec(url.pathname);
    return tail && V.isStatementId(tail[1].toLowerCase()) ? tail[1].toLowerCase() : null;
  }

  /**
   * Parse a native link into a resource reference bound to the page's origin and workspace.
   * Rejects external links, links to another workspace ID, and edit/create/navigation-only routes.
   * @returns {object|null} e.g. {type:'job_run', jobId, runId, origin, workspaceId}
   */
  function parseResourceLink(href, pageOrigin, pageWorkspaceId) {
    const url = safeUrl(href, pageOrigin);
    if (!url || url.origin !== pageOrigin) return null;
    if (NAV_ONLY_SUFFIX.test(url.pathname)) return null;
    const linkWs = resolveWorkspaceId(url, {});
    if (linkWs.conflict) return null;
    if (linkWs.id && pageWorkspaceId && linkWs.id !== pageWorkspaceId) return null;
    const statementId = statementIdFromUrl(url);
    let ref = statementId ? { type: 'statement', statementId } : null;
    if (!ref) ref = matchRoutes(PATH_ROUTES, url.pathname);
    if (!ref && url.hash) ref = matchRoutes(HASH_ROUTES, url.hash);
    if (!ref) return null;
    return Object.assign(ref, { origin: pageOrigin, workspaceId: pageWorkspaceId || linkWs.id || null });
  }

  /** The resource a detail page is about (title totals), from the page URL itself. */
  function parsePageRoute(href) {
    const url = safeUrl(href);
    if (!url) return null;
    const pathOnly = url.pathname.replace(/\/(runs|tasks|updates|settings|monitoring|lineage)\/?$/, '');
    let ref = matchRoutes(PATH_ROUTES, url.pathname) || matchRoutes(PATH_ROUTES, pathOnly);
    if (!ref && url.hash) ref = matchRoutes(HASH_ROUTES, url.hash);
    if (!ref && /^\/sql\/history\/?$/.test(url.pathname)) ref = { type: 'query_history' };
    if (!ref && /^\/compute\/(sql-)?warehouses\/?$|^\/sql\/warehouses\/?$/.test(url.pathname)) ref = { type: 'warehouse_list' };
    return ref;
  }

  /** Stable key for a resource reference, used for dedupe and caching. */
  function refKey(ref) {
    switch (ref && ref.type) {
      case 'job': return 'job:' + ref.jobId;
      case 'job_run': return 'job_run:' + ref.jobId + ':' + ref.runId;
      case 'pipeline': return 'pipeline:' + ref.pipelineId;
      case 'pipeline_update': return 'pipeline_update:' + ref.pipelineId + ':' + ref.updateId;
      case 'warehouse': return 'warehouse:' + ref.warehouseId;
      case 'notebook': return 'notebook:' + ref.notebookId;
      case 'app': return 'app:' + ref.appName;
      case 'statement': return 'statement:' + ref.statementId;
      default: return null;
    }
  }

  /** Re-validate a reference received over messaging; returns a clean copy or null. */
  function sanitizeRef(ref) {
    if (!ref || typeof ref !== 'object') return null;
    switch (ref.type) {
      case 'job': return V.isNumericId(ref.jobId) ? { type: 'job', jobId: ref.jobId } : null;
      case 'job_run': return V.isNumericId(ref.jobId) && V.isNumericId(ref.runId) ? { type: 'job_run', jobId: ref.jobId, runId: ref.runId } : null;
      case 'pipeline': return V.isUuid(ref.pipelineId) ? { type: 'pipeline', pipelineId: ref.pipelineId } : null;
      case 'pipeline_update': return V.isUuid(ref.pipelineId) && V.isUuid(ref.updateId) ? { type: 'pipeline_update', pipelineId: ref.pipelineId, updateId: ref.updateId } : null;
      case 'warehouse': return V.isWarehouseId(ref.warehouseId) ? { type: 'warehouse', warehouseId: ref.warehouseId } : null;
      case 'notebook': return V.isNumericId(ref.notebookId) ? { type: 'notebook', notebookId: ref.notebookId } : null;
      case 'app': return V.isAppName(ref.appName) && !RESERVED_APP_SEGMENTS.has(ref.appName) ? { type: 'app', appName: ref.appName } : null;
      case 'statement': return V.isStatementId(ref.statementId) ? { type: 'statement', statementId: ref.statementId } : null;
      default: return null;
    }
  }

  const api = Object.freeze({
    FIXTURE_ORIGIN,
    HOST_SUFFIXES,
    HOST_PATTERNS,
    classifyOrigin,
    workspaceIdFromHost,
    resolveWorkspaceId,
    parseResourceLink,
    parsePageRoute,
    refKey,
    sanitizeRef,
  });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).ids = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
