#!/usr/bin/env node
/*
 * DEV-ONLY synthetic fixture server (http://127.0.0.1:8765). Not part of the distributable.
 *
 *   node local/fixture-server.mjs [--port 8765]     (or: npm run fixture)
 *
 * - App routes (any GET path that is not a static file, /api/ or /fixture/) serve
 *   local/workspace.html, the routed fixture SPA that imitates the native workspace DOM.
 *   Static: /workspace*.{js,css,svg} from local/ and /fixture/<file>.{html,js,css,svg} from
 *   local/fixture/ (no directory traversal).
 * - A mock Databricks REST API for the fixture origin. It accepts only the FAKE fixture token
 *   `Authorization: Bearer dapi-fixture-0000000000000000000000000000`, which is not a real
 *   credential (paste it as the personal access token for the fixture workspace).
 *     GET  /api/2.0/sql/warehouses                (3 synthetic warehouses, one RUNNING; 2 per page)
 *     POST /api/2.0/sql/statements                (runs the extension's SQL on DuckDB, simulated)
 *     GET  /api/2.0/sql/statements/:id            (poll path; PENDING → SUCCEEDED)
 *     POST /api/2.0/sql/statements/:id/cancel
 *     GET  /api/2.2/jobs/runs/list | /api/2.0/pipelines | /api/2.1/clusters/list  (monitor data)
 *   SQL runs through local/support/sqlengine.mjs (DuckDB dialect shim). This is a SIMULATION
 *   that checks query logic; it is not proof of Databricks compatibility.
 * - Binds 127.0.0.1 only and rejects any Host header other than 127.0.0.1:<port>.
 */
import nodeHttp from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine, SENTINEL_SQL_TEXT } from './support/sqlengine.mjs';
import { buildDataset, toInsertSql, monitorSnapshot, WAREHOUSES } from './fixture-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PORT = 8765;
export const FIXTURE_ORIGIN = 'http://127.0.0.1:8765';
/** FAKE token for the synthetic fixture only. Not a credential. */
export const FIXTURE_TOKEN = 'dapi-fixture-0000000000000000000000000000';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const TOP_STATIC = /^\/(workspace(?:[-.][a-z0-9-]+)*\.(?:js|css|svg))$/;
const FIXTURE_STATIC = /^\/fixture\/([a-z0-9][a-z0-9_.-]{0,80}\.(?:html|js|css|svg))$/;
const STATEMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY = 1024 * 1024;
const MAX_STORED = 500;

function headers(extra) {
  return Object.assign({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }, extra || {});
}

function send(res, status, body, extra) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');
  res.writeHead(status, headers(Object.assign({ 'Content-Length': buf.length }, extra || {})));
  res.end(buf);
}

function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function apiError(res, status, code, message) {
  json(res, status, { error_code: code, message });
}

/** Resolve a static file strictly inside `dir`. */
function inside(dir, name) {
  if (name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  const full = path.resolve(dir, name);
  return full.startsWith(path.resolve(dir) + path.sep) ? full : null;
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Map DuckDB failures onto Databricks-style error codes so errors.classify() is exercised. */
export function mapEngineError(message) {
  const m = String(message || '');
  if (/Could not find key "?effective_list"?|effective_list/i.test(m) && /struct|key/i.test(m)) return { error_code: 'FIELD_NOT_FOUND', message: '[FIELD_NOT_FOUND] No such struct field `effective_list` (simulated).' };
  if (/Table with name .* does not exist|Catalog .* does not exist|Schema .* does not exist/i.test(m)) return { error_code: 'TABLE_OR_VIEW_NOT_FOUND', message: '[TABLE_OR_VIEW_NOT_FOUND] ' + m.slice(0, 300) };
  if (/Referenced column .* not found|Could not find key/i.test(m)) return { error_code: 'UNRESOLVED_COLUMN', message: '[UNRESOLVED_COLUMN] ' + m.slice(0, 300) };
  if (/Unbound parameter/i.test(m)) return { error_code: 'UNBOUND_SQL_PARAMETER', message: '[UNBOUND_SQL_PARAMETER] ' + m.slice(0, 300) };
  return { error_code: 'INTERNAL_ERROR', message: m.slice(0, 500) };
}

function readOnlySingleStatement(sql) {
  const s = String(sql || '')
    .replace(/--[^\n]*\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
  if (!/^(WITH|SELECT)\b/i.test(s)) return false;
  return !/;\s*\S/.test(s);
}

function containsSentinel(response) {
  const data = response && response.result && response.result.data_array;
  return Array.isArray(data) && data.some((row) => row.some((v) => typeof v === 'string' && v.includes(SENTINEL_SQL_TEXT)));
}

/**
 * @param {object} [o]
 * @param {number} [o.port=8765]       0 → ephemeral (tests)
 * @param {number} [o.nowMs]           anchor for the synthetic dataset and monitor data
 * @param {number} [o.pendingPolls=0]  GET polls that still report RUNNING before SUCCEEDED
 * @param {Function} [o.log]
 */
export async function startFixtureServer(o = {}) {
  const log = o.log || ((line) => process.stderr.write('[dcc-fixture] ' + line + '\n'));
  const anchor = o.nowMs;
  const now = () => (anchor === undefined ? Date.now() : anchor);
  const engine = await createEngine();
  const dataset = buildDataset({ nowMs: now() });
  for (const [table, rows] of Object.entries(dataset.tables)) {
    if (!rows.length) continue;
    for (const sql of toInsertSql(table, rows)) await engine.exec(sql);
  }
  const counts = Object.fromEntries(Object.entries(dataset.tables).map(([t, rows]) => [t, rows.length]));

  const state = {
    warehouses: WAREHOUSES.map((w) => Object.assign({}, w)),
    statements: new Map(), // id → {response, polls, canceled}
    executed: 0,
    warehouseStarts: 0,
    sentinelReads: 0,
    pendingPolls: Number.isInteger(o.pendingPolls) ? o.pendingPolls : 0,
  };
  let port = o.port === undefined ? FIXTURE_PORT : o.port;
  let expectedHost = null;
  let origin = null;
  let queue = Promise.resolve();

  function serialize(fn) {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  }

  function remember(id, entry) {
    state.statements.set(id, entry);
    while (state.statements.size > MAX_STORED) state.statements.delete(state.statements.keys().next().value);
  }

  async function executeStatement(body) {
    const id = crypto.randomUUID();
    const wh = state.warehouses.find((w) => w.id === body.warehouse_id);
    if (!wh) return { status: 404, error: { error_code: 'RESOURCE_DOES_NOT_EXIST', message: 'SQL warehouse ' + String(body.warehouse_id).slice(0, 40) + ' does not exist.' } };
    if (body.disposition !== undefined && body.disposition !== 'INLINE') return { status: 400, error: { error_code: 'INVALID_PARAMETER_VALUE', message: 'Fixture supports disposition INLINE only.' } };
    if (body.format !== undefined && body.format !== 'JSON_ARRAY') return { status: 400, error: { error_code: 'INVALID_PARAMETER_VALUE', message: 'Fixture supports format JSON_ARRAY only.' } };
    if (body.parameters !== undefined && !Array.isArray(body.parameters)) return { status: 400, error: { error_code: 'INVALID_PARAMETER_VALUE', message: 'parameters must be an array.' } };
    // A statement sent to a stopped warehouse starts it, as Databricks would (and bills).
    if (wh.state !== 'RUNNING') {
      wh.state = 'RUNNING';
      state.warehouseStarts += 1;
    }
    let response;
    if (!readOnlySingleStatement(body.statement)) {
      response = { statement_id: id, status: { state: 'FAILED', error: { error_code: 'INVALID_PARAMETER_VALUE', message: 'Fixture accepts a single read-only SELECT/WITH statement.' } } };
    } else {
      try {
        response = await serialize(() => engine.execute({ statement: body.statement, parameters: body.parameters || [], row_limit: body.row_limit }));
        response.statement_id = id;
        state.executed += 1;
        if (engine.statements.length > 50) engine.statements.splice(0, engine.statements.length - 50);
        if (containsSentinel(response)) {
          state.sentinelReads += 1;
          response = { statement_id: id, status: { state: 'FAILED', error: { error_code: 'FIXTURE_SENTINEL_READ', message: 'Fixture: statement_text must never be selected.' } } };
        }
      } catch (e) {
        const err = mapEngineError(e && e.message);
        response = { statement_id: id, status: { state: 'FAILED', error: err, sql_state: err.error_code === 'TABLE_OR_VIEW_NOT_FOUND' ? '42P01' : undefined } };
      }
    }
    const wantsPending = String(body.wait_timeout || '') === '0s' || state.pendingPolls > 0;
    const entry = { response, polls: wantsPending ? Math.max(1, state.pendingPolls) : 0, canceled: false };
    remember(id, entry);
    if (wantsPending) return { status: 200, body: { statement_id: id, status: { state: 'PENDING' } } };
    return { status: 200, body: response };
  }

  function pageOf(list, query, key, maxSize, defSize) {
    const size = Math.min(Number(query.get(key)) || defSize, maxSize);
    const offset = /^o\d{1,6}$/.test(query.get('page_token') || '') ? Number(query.get('page_token').slice(1)) : 0;
    const items = list.slice(offset, offset + size);
    const next = offset + size < list.length ? 'o' + (offset + size) : null;
    return { items, next };
  }

  async function handleApi(req, res, url) {
    if (req.headers.authorization !== 'Bearer ' + FIXTURE_TOKEN) return apiError(res, 401, 'UNAUTHENTICATED', 'Invalid access token. (fixture accepts only the documented fake token)');
    const p = url.pathname;
    const q = url.searchParams;
    if (req.method === 'GET' && p === '/api/2.0/sql/warehouses') {
      const { items, next } = pageOf(state.warehouses, q, 'page_size', 2, 2);
      return json(res, 200, Object.assign({ warehouses: items.map((w) => Object.assign({ creator_name: 'fixture.user@example.com', num_clusters: w.state === 'RUNNING' ? 1 : 0 }, w)) }, next ? { next_page_token: next } : {}));
    }
    if (req.method === 'POST' && p === '/api/2.0/sql/statements') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (e) {
        if (e && e.status === 413) return apiError(res, 413, 'INVALID_PARAMETER_VALUE', 'Request too large.');
        return apiError(res, 400, 'MALFORMED_REQUEST', 'Request body is not JSON.');
      }
      const out = await executeStatement(body || {});
      if (out.error) return json(res, out.status, out.error);
      return json(res, out.status, out.body);
    }
    const sm = /^\/api\/2\.0\/sql\/statements\/([^/]+)(\/cancel)?$/.exec(p);
    if (sm) {
      const id = sm[1];
      const entry = STATEMENT_ID.test(id) ? state.statements.get(id) : null;
      if (!entry) return apiError(res, 404, 'RESOURCE_DOES_NOT_EXIST', 'Statement not found.');
      if (sm[2] && req.method === 'POST') {
        entry.canceled = true;
        return json(res, 200, {});
      }
      if (!sm[2] && req.method === 'GET') {
        if (entry.canceled) return json(res, 200, { statement_id: id, status: { state: 'CANCELED' } });
        if (entry.polls > 0) {
          entry.polls -= 1;
          return json(res, 200, { statement_id: id, status: { state: 'RUNNING' } });
        }
        return json(res, 200, entry.response);
      }
      return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    }
    if (req.method === 'GET' && p === '/api/2.2/jobs/runs/list') {
      const limit = q.has('limit') ? Number(q.get('limit')) : 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 25) return apiError(res, 400, 'INVALID_PARAMETER_VALUE', 'limit must be between 1 and 25.');
      let runs = monitorSnapshot(now(), origin).runs;
      if (q.get('active_only') === 'true') runs = runs.filter((r) => r.status.state !== 'TERMINATED');
      if (q.get('completed_only') === 'true') runs = runs.filter((r) => r.status.state === 'TERMINATED');
      if (q.has('job_id')) runs = runs.filter((r) => String(r.job_id) === q.get('job_id'));
      const offset = /^o\d{1,6}$/.test(q.get('page_token') || '') ? Number(q.get('page_token').slice(1)) : Number(q.get('offset')) || 0;
      const items = runs.slice(offset, offset + limit);
      const more = offset + limit < runs.length;
      return json(res, 200, Object.assign({ runs: items, has_more: more }, more ? { next_page_token: 'o' + (offset + limit) } : {}));
    }
    if (req.method === 'GET' && p === '/api/2.0/pipelines') {
      const { items, next } = pageOf(monitorSnapshot(now(), origin).pipelines, q, 'max_results', 100, 25);
      return json(res, 200, Object.assign({ statuses: items }, next ? { next_page_token: next } : {}));
    }
    if (req.method === 'GET' && p === '/api/2.1/clusters/list') {
      const { items, next } = pageOf(monitorSnapshot(now(), origin).clusters, q, 'page_size', 100, 100);
      return json(res, 200, Object.assign({ clusters: items }, next ? { next_page_token: next } : {}));
    }
    return apiError(res, 404, 'ENDPOINT_NOT_FOUND', 'No API found for ' + req.method + ' ' + p.slice(0, 100));
  }

  async function serveFile(res, file, method) {
    let data;
    try {
      data = await fsp.readFile(file);
    } catch (_) {
      return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    if (method === 'HEAD') {
      res.writeHead(200, headers({ 'Content-Type': type, 'Content-Length': data.length }));
      return res.end();
    }
    return send(res, 200, data, { 'Content-Type': type });
  }

  const PLACEHOLDER = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture workspace (synthetic)</title></head><body><main><h1>Synthetic fixture workspace</h1><p>local/workspace.html has not been created yet.</p></main></body></html>';

  async function handle(req, res) {
    if (!expectedHost || req.headers.host !== expectedHost) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    if (typeof req.url !== 'string' || !req.url.startsWith('/')) return send(res, 400, '');
    let url;
    try {
      url = new URL(req.url, origin);
    } catch (_) {
      return send(res, 400, '');
    }
    const p = url.pathname;
    if (p.startsWith('/api/')) return handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '', { Allow: 'GET, HEAD' });
    if (/%2e|%2f|%5c|\.\.|\\|\0/i.test(req.url.split('?')[0])) return send(res, 400, 'Bad path', { 'Content-Type': 'text/plain; charset=utf-8' });
    if (p === '/favicon.ico') return send(res, 204, '');
    let m = TOP_STATIC.exec(p);
    if (m) {
      const file = inside(HERE, m[1]);
      return file ? serveFile(res, file, req.method) : send(res, 404, '');
    }
    if (p.startsWith('/fixture/')) {
      m = FIXTURE_STATIC.exec(p);
      const file = m && inside(path.join(HERE, 'fixture'), m[1]);
      return file ? serveFile(res, file, req.method) : send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    // Every other path is an app route of the routed fixture SPA.
    const html = path.join(HERE, 'workspace.html');
    if (!fs.existsSync(html)) return send(res, 200, PLACEHOLDER, { 'Content-Type': 'text/html; charset=utf-8' });
    return serveFile(res, html, req.method);
  }

  const server = nodeHttp.createServer({ requestTimeout: 60000, headersTimeout: 10000 }, (req, res) => {
    handle(req, res).catch((e) => {
      log('request failed: ' + String((e && e.message) || e).slice(0, 200));
      if (!res.headersSent) send(res, 500, '');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = server.address().port;
  expectedHost = '127.0.0.1:' + port;
  origin = 'http://' + expectedHost;

  return {
    server,
    port,
    origin,
    state,
    counts,
    dataset,
    engine,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections && server.closeAllConnections();
      }),
  };
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch (_) {
    return false;
  }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--port');
  const port = i >= 0 ? Number(argv[i + 1]) : FIXTURE_PORT;
  startFixtureServer({ port })
    .then((fx) => {
      const usage = fx.counts['billing.usage'];
      process.stdout.write('Synthetic fixture (dev only) on ' + fx.origin + ' — ' + usage + ' usage rows, DuckDB simulation. Ctrl+C to stop.\n');
      const stop = () => fx.close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((e) => {
      process.stderr.write('Fixture server failed to start: ' + (e && e.code === 'EADDRINUSE' ? 'port ' + port + ' is already in use.' : String((e && e.message) || e)) + '\n');
      process.exit(1);
    });
}
