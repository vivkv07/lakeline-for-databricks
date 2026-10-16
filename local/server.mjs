#!/usr/bin/env node
/*
 * Databricks Cost Companion local helper (Node 20+, no runtime dependencies).
 *
 *   node local/server.mjs --open          start on 127.0.0.1:8766 and open setup in the browser
 *   node local/server.mjs --fixture       also start the dev-only synthetic fixture (port 8765)
 *   node local/server.mjs --fixture-only  start only the fixture server
 *   node local/server.mjs --version       print the helper version
 *
 * Security model (spec §3, §13):
 *   - Binds 127.0.0.1 only and rejects any request whose Host header is not exactly
 *     127.0.0.1:<port> (DNS rebinding).
 *   - A random 24-hex pairing key is generated per process. It is only ever placed in the URL
 *     fragment handed to the browser opener; it is never printed, logged, put in a query string,
 *     served in HTML, or returned by any endpoint.
 *   - /bridge/* requires the key (X-DCC-Key, constant-time compare) AND the extension's Origin.
 *     CORS preflights are answered only for that origin.
 *   - /launcher/open-setup refuses browsers (Origin, Sec-Fetch-*, Referer, preflight) and
 *     requires its own header; it re-opens setup and returns {opened:true} only.
 *   - SQL is built here from the extension's named query kinds; request bodies never carry SQL.
 *     Monitor calls are limited to the read-only GET allowlist in databricks/http.js.
 *   - CLI OAuth tokens stay in this process (see oauth-bridge.mjs); nothing is stored on disk.
 */
import nodeHttp from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOAuthBridge } from './oauth-bridge.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXT = path.join(ROOT, 'extension');

const V = require('../extension/src/core/validate.js');
const ids = require('../extension/src/core/ids.js');
const errors = require('../extension/src/errors.js');
const pricing = require('../extension/src/databricks/pricing.js');
const config = require('../extension/src/databricks/config.js');
const dbxHttp = require('../extension/src/databricks/http.js');
const result = require('../extension/src/databricks/result.js');
const registry = require('../extension/src/databricks/queries/index.js');

export const PROTOCOL = 1;
export const DEFAULT_PORT = 8766;
export const FIXTURE_PORT = 8765;
export const MAX_BODY = 256 * 1024;
/** Fake bearer token accepted only by the dev fixture server (not a credential). */
export const FIXTURE_TOKEN = 'dapi-fixture-0000000000000000000000000000';
export const VERSION = readVersion();

const STATIC = {
  '/setup': { file: 'setup.html', type: 'text/html; charset=utf-8' },
  '/setup.js': { file: 'setup.js', type: 'text/javascript; charset=utf-8' },
  '/setup.css': { file: 'setup.css', type: 'text/css; charset=utf-8' },
};
const SETUP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const STATEMENTS_PATH = /^\/api\/2\.0\/sql\/statements(\/|$)/;
const QUERY_BODY_KEYS = new Set(['origin', 'workspaceId', 'kind', 'args', 'conn']);
const CONN_KEYS = ['priceTable', 'usageSource', 'historySource', 'currency', 'warehouseId', 'cloud'];
// Same shape rules as databricks/http.js buildUrl, checked up front so bad input is a 400.
const API_QUERY_KEY = /^[a-z_.]{1,40}$/;
const API_QUERY_VALUE = /^[A-Za-z0-9_.:-]{0,128}$/;

function readVersion() {
  for (const f of [path.join(EXT, 'manifest.json'), path.join(ROOT, 'package.json')]) {
    try {
      const v = JSON.parse(fs.readFileSync(f, 'utf8')).version;
      if (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)) return v;
    } catch (_) {
      /* try next */
    }
  }
  return '0.0.0';
}

/** The extension ID from extension/EXTENSION_ID (stable thanks to the manifest `key`). */
export function readExtensionId(file = path.join(EXT, 'EXTENSION_ID')) {
  const id = fs.readFileSync(file, 'utf8').trim();
  if (!/^[a-p]{32}$/.test(id)) throw new Error('extension/EXTENSION_ID is not a valid extension ID');
  return id;
}

function defaultLog(line) {
  process.stderr.write('[dcc-helper] ' + errors.redact(line) + '\n');
}

class HttpError extends Error {
  constructor(status, payload) {
    super('http ' + status);
    this.status = status;
    this.payload = payload;
  }
}

function badRequest(message, code = 'UNKNOWN') {
  return new HttpError(400, errors.classify({ code, message }));
}

/* ------------------------------------------------------------------ browser opener */

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

function onPath(bin) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir && exists(path.join(dir, bin))) return true;
  }
  return false;
}

/**
 * Plan how to open a URL: Microsoft Edge if installed, else the default browser.
 * DCC_SETUP_BROWSER=edge|chrome|default overrides the choice. Always argument arrays.
 */
export function openerPlan(url, { platform = process.platform, env = process.env } = {}) {
  if (env.DCC_BROWSER_OPENER) {
    const o = env.DCC_BROWSER_OPENER;
    return /\.(mjs|cjs|js)$/i.test(o) ? { cmd: process.execPath, args: [o, url], label: 'test opener' } : { cmd: o, args: [url], label: 'custom opener' };
  }
  const pref = String(env.DCC_SETUP_BROWSER || 'edge').toLowerCase();
  if (platform === 'darwin') {
    const home = env.HOME || '';
    const edge = exists('/Applications/Microsoft Edge.app') || (home && exists(path.join(home, 'Applications/Microsoft Edge.app')));
    const chrome = exists('/Applications/Google Chrome.app') || (home && exists(path.join(home, 'Applications/Google Chrome.app')));
    if (pref === 'edge' && edge) return { cmd: 'open', args: ['-a', 'Microsoft Edge', url], label: 'Microsoft Edge' };
    if (pref === 'chrome' && chrome) return { cmd: 'open', args: ['-a', 'Google Chrome', url], label: 'Google Chrome' };
    return { cmd: 'open', args: [url], label: 'your default browser' };
  }
  if (platform === 'win32') {
    // `start` is a cmd builtin. The URL holds only [A-Za-z0-9:/.#=] so cmd metacharacters cannot occur.
    if (!/^http:\/\/127\.0\.0\.1:\d+\/setup(#k=[0-9a-f]{24})?$/.test(url)) throw new Error('Refusing to open an unexpected URL');
    if (pref === 'edge') return { cmd: 'cmd', args: ['/c', 'start', '""', 'msedge', url], label: 'Microsoft Edge', fallback: { cmd: 'cmd', args: ['/c', 'start', '""', url] } };
    if (pref === 'chrome') return { cmd: 'cmd', args: ['/c', 'start', '""', 'chrome', url], label: 'Google Chrome', fallback: { cmd: 'cmd', args: ['/c', 'start', '""', url] } };
    return { cmd: 'cmd', args: ['/c', 'start', '""', url], label: 'your default browser' };
  }
  if (pref === 'edge' && onPath('microsoft-edge')) return { cmd: 'microsoft-edge', args: [url], label: 'Microsoft Edge' };
  if (pref === 'chrome' && onPath('google-chrome')) return { cmd: 'google-chrome', args: [url], label: 'Google Chrome' };
  return { cmd: 'xdg-open', args: [url], label: 'your default browser' };
}

function runOpener(step) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(step.cmd, step.args, { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true, shell: false, windowsVerbatimArguments: step.cmd === 'cmd' });
    } catch (_) {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
    child.unref();
  });
}

async function openInBrowser(url) {
  const plan = openerPlan(url);
  let ok = await runOpener(plan);
  if (!ok && plan.fallback) ok = await runOpener(plan.fallback);
  return { ok, label: plan.label };
}

/* ------------------------------------------------------------------ request helpers */

function baseHeaders(extra) {
  return Object.assign(
    {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
    extra || {}
  );
}

function send(res, status, body, headers) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');
  res.writeHead(status, baseHeaders(Object.assign({ 'Content-Length': buf.length }, headers || {})));
  res.end(buf);
}

function sendJson(res, status, obj, headers) {
  send(res, status, JSON.stringify(obj), Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}));
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, errors.classify({ code: 'UNKNOWN', message: 'Request body too large' })));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, errors.classify({ code: 'UNKNOWN', message: 'Request body too large' })));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        const v = JSON.parse(text);
        if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(badRequest('Request body must be a JSON object'));
        resolve(v);
      } catch (_) {
        reject(badRequest('Request body is not valid JSON'));
      }
    });
    req.on('error', () => {
      if (!failed) reject(new HttpError(400, errors.classify({ code: 'UNKNOWN', message: 'Request aborted' })));
    });
  });
}

function keyMatches(provided, key) {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(key, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ helper */

/**
 * Start the helper.
 * @param {object} [o]
 * @param {number} [o.port=8766]        0 picks an ephemeral port (tests)
 * @param {string} [o.extensionId]      default: extension/EXTENSION_ID
 * @param {object} [o.oauth]            injected OAuth bridge (tests); default createOAuthBridge()
 * @param {string} [o.cliPath]          Databricks CLI path for the default bridge
 * @param {Function} [o.fetch]          fetch used for Databricks calls (default global fetch)
 * @param {Function} [o.log]            log sink (lines are redacted before reaching it)
 * @param {boolean} [o.open]            open setup in the browser once listening
 * @param {Function} [o.opener]         async (url) => {ok, label}; default spawns the browser
 * @param {boolean} [o.devFixture]      accept the fixture origin with the fake fixture token
 * @returns {Promise<{server, port, key, origin, openSetup, close}>}
 */
export async function startHelper(o = {}) {
  const extensionId = o.extensionId || readExtensionId();
  const allowedOrigins = new Set(['chrome-extension://' + extensionId, 'extension://' + extensionId]);
  const key = crypto.randomBytes(12).toString('hex');
  const logSink = o.log || defaultLog;
  const log = (line) => logSink(errors.redact(String(line)));
  const oauth = o.oauth || createOAuthBridge({ cliPath: o.cliPath, log });
  const doFetch = o.fetch || ((...a) => globalThis.fetch(...a));
  const opener = o.opener || openInBrowser;
  const devFixture = o.devFixture === true;
  let port = o.port === undefined ? DEFAULT_PORT : o.port;
  let expectedHost = null;
  let lastLaunch = 0;

  const setupUrl = () => 'http://127.0.0.1:' + port + '/setup#k=' + key;

  async function openSetup() {
    try {
      return await opener(setupUrl());
    } catch (_) {
      return { ok: false, label: 'browser' };
    }
  }

  /* -------------------------------------------------------------- bridge handlers */

  function apiOrigin(origin) {
    const cls = ids.classifyOrigin(origin);
    if (!cls.ok || cls.origin !== origin) throw badRequest('Unsupported workspace origin');
    if (cls.kind === 'workspace') return cls;
    if (cls.kind === 'fixture' && devFixture) return cls;
    throw badRequest('Unsupported workspace origin');
  }

  async function tokenFor(cls, purpose) {
    if (cls.kind === 'fixture') return FIXTURE_TOKEN;
    return oauth.getToken(cls.origin, purpose);
  }

  function clientFor(cls, token) {
    return dbxHttp.create({ origin: cls.origin, token, fetch: doFetch });
  }

  /** Re-throw with a dropped token cache when Databricks rejected the credentials. */
  function onUpstreamError(cls, purpose, e) {
    const code = e && e.dcc && e.dcc.code;
    if (code === 'AUTH_EXPIRED' || code === 'AUTH_INVALID') oauth.forget(cls.origin, purpose);
    throw e;
  }

  const handlers = {
    async '/bridge/hello'() {
      const cli = await oauth.cliInfo();
      return {
        ok: true,
        version: VERSION,
        protocol: PROTOCOL,
        capabilities: { accountPrices: true, priceAdapterVersion: pricing.ADAPTER_VERSION, jobPipelineAttribution: true, monitor: true, protocol: PROTOCOL },
        cli: { found: cli.found === true, version: cli.version || null, supported: cli.supported === true },
      };
    },

    async '/bridge/login'(body) {
      const cls = ids.classifyOrigin(body.origin);
      if (!cls.ok || cls.kind !== 'workspace' || cls.origin !== body.origin) throw badRequest('Choose a Databricks workspace first');
      const purpose = body.purpose === 'monitor' ? 'monitor' : body.purpose === 'cost' || body.purpose === undefined ? 'cost' : null;
      if (!purpose) throw badRequest('Unknown sign-in purpose');
      const out = await oauth.login(cls.origin, purpose);
      return { ok: true, signedIn: out.signedIn === true, reused: out.reused === true, profile: V.safeText(out.profile, 80) };
    },

    async '/bridge/warehouses'(body) {
      const cls = apiOrigin(body.origin);
      const client = clientFor(cls, await tokenFor(cls, 'cost'));
      const list = [];
      let pageToken = null;
      try {
        for (let page = 0; page < 10; page++) {
          const res = await client.get('/api/2.0/sql/warehouses', pageToken ? { page_token: pageToken } : undefined);
          for (const w of (res && res.warehouses) || []) {
            if (!w || !V.isWarehouseId(w.id)) continue;
            list.push({
              id: w.id,
              name: V.safeText(w.name || w.id, 200),
              state: V.safeText(w.state || 'UNKNOWN', 20),
              cluster_size: w.cluster_size ? V.safeText(w.cluster_size, 20) : null,
              warehouse_type: w.warehouse_type ? V.safeText(w.warehouse_type, 20) : null,
              enable_serverless_compute: w.enable_serverless_compute === true,
              min_num_clusters: Number.isInteger(w.min_num_clusters) ? w.min_num_clusters : null,
              max_num_clusters: Number.isInteger(w.max_num_clusters) ? w.max_num_clusters : null,
            });
          }
          pageToken = res && res.next_page_token;
          if (!pageToken) break;
        }
      } catch (e) {
        onUpstreamError(cls, 'cost', e);
      }
      return { ok: true, warehouses: list };
    },

    async '/bridge/query'(body) {
      for (const k of Object.keys(body)) if (!QUERY_BODY_KEYS.has(k)) throw badRequest('Unexpected field in query request');
      const kind = body.kind;
      if (typeof kind !== 'string' || !registry.KINDS.includes(kind)) throw badRequest('Unknown query kind');
      if (!registry.get(kind)) throw badRequest('This helper does not include the "' + kind + '" query; update and restart the helper', 'HELPER_OUTDATED');
      const cls = apiOrigin(body.origin);
      const c = body.conn && typeof body.conn === 'object' && !Array.isArray(body.conn) ? body.conn : {};
      const picked = {};
      for (const k of CONN_KEYS) if (c[k] !== undefined) picked[k] = c[k];
      const v = config.validateConnection(Object.assign({}, picked, {
        origin: cls.origin,
        workspaceId: body.workspaceId,
        authMode: 'helper',
        warehouse: { mode: 'manual', id: picked.warehouseId },
      }));
      if (!v.ok) throw badRequest(v.errors.join(' '));
      const conn = v.value;
      const warehouseId = config.effectiveWarehouseId(conn);
      const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
      const client = clientFor(cls, await tokenFor(cls, 'cost'));
      const exec = async (query) => {
        const res = await dbxHttp.executeStatement(client, { warehouseId, statement: query.statement, parameters: query.parameters, rowLimit: query.rowLimit });
        return result.parseResult(res, { maxRows: query.maxRows }).rows;
      };
      let out;
      try {
        out = await registry.run(kind, { conn, args, nowMs: Date.now(), exec });
      } catch (e) {
        onUpstreamError(cls, 'cost', e);
      }
      return { ok: true, result: out };
    },

    async '/bridge/api'(body) {
      const p = body.path;
      if (typeof p !== 'string' || p.length > 200 || STATEMENTS_PATH.test(p) || !dbxHttp.isAllowed('GET', p)) throw badRequest('API path not allowed');
      const q = body.query === undefined || body.query === null ? {} : body.query;
      if (typeof q !== 'object' || Array.isArray(q) || Object.keys(q).length > 12) throw badRequest('Unsupported query parameters');
      for (const [k, val] of Object.entries(q)) {
        if (!API_QUERY_KEY.test(k)) throw badRequest('Unsupported query parameters');
        if (val === null || val === undefined) continue;
        if (!['string', 'number', 'boolean'].includes(typeof val) || !API_QUERY_VALUE.test(String(val))) throw badRequest('Unsupported query parameters');
      }
      const cls = apiOrigin(body.origin);
      const client = clientFor(cls, await tokenFor(cls, 'monitor'));
      let data;
      try {
        data = await client.get(p, q);
      } catch (e) {
        onUpstreamError(cls, 'monitor', e);
      }
      return { ok: true, data };
    },
  };

  /* -------------------------------------------------------------- routing */

  async function handleBridge(req, res, pathname) {
    const origin = req.headers.origin;
    const allowed = typeof origin === 'string' && allowedOrigins.has(origin);
    const cors = allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
    if (req.method === 'OPTIONS') {
      if (!allowed || String(req.headers['access-control-request-method'] || '').toUpperCase() !== 'POST') return send(res, 403, '', { Vary: 'Origin' });
      return send(res, 204, '', Object.assign({}, cors, {
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type, X-DCC-Key, X-DCC-Protocol',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
      }));
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false }, Object.assign({ Allow: 'POST, OPTIONS' }, cors));
    if (!allowed) return sendJson(res, 403, { ok: false }, { Vary: 'Origin' });
    if (!keyMatches(req.headers['x-dcc-key'], key)) return sendJson(res, 401, { ok: false }, cors);
    if (String(req.headers['x-dcc-protocol'] || '') !== String(PROTOCOL)) {
      return sendJson(res, 409, { ok: false, error: errors.classify({ code: 'HELPER_OUTDATED', message: 'Bridge protocol mismatch (helper speaks ' + PROTOCOL + ')' }) }, cors);
    }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      return sendJson(res, 415, { ok: false, error: errors.classify({ code: 'UNKNOWN', message: 'Expected application/json' }) }, cors);
    }
    const h = Object.prototype.hasOwnProperty.call(handlers, pathname) ? handlers[pathname] : null;
    const started = Date.now();
    try {
      const body = await readJson(req);
      if (!h) throw new HttpError(404, errors.classify({ code: 'UNKNOWN', message: 'Unknown bridge endpoint' }));
      const out = await h(body);
      if (pathname === '/bridge/login') log('Sign-in ' + (out.reused ? 'reused' : 'completed') + ' for profile ' + out.profile + '.');
      return sendJson(res, 200, out, cors);
    } catch (e) {
      // Never answer 401/403 for upstream failures: the extension reserves those for pairing.
      const status = e instanceof HttpError ? e.status : 502;
      const error = e instanceof HttpError ? e.payload : errors.toPayload(e);
      log('bridge ' + pathname + ' failed: ' + error.code + (error.details && error.details.message ? ' — ' + error.details.message : '') + ' (' + (Date.now() - started) + ' ms)');
      if (!res.headersSent) sendJson(res, status, { ok: false, error }, status === 413 ? Object.assign({ Connection: 'close' }, cors) : cors);
    }
  }

  async function handleLauncher(req, res, pathname) {
    if (req.method === 'OPTIONS') return send(res, 403, '');
    if (pathname !== '/launcher/open-setup') return send(res, 404, '');
    if (req.method !== 'POST') return send(res, 405, '', { Allow: 'POST' });
    // Browsers always send Origin on POST and Sec-Fetch-* metadata; a local launcher (curl) sends neither.
    if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined || req.headers['sec-fetch-mode'] !== undefined || req.headers.referer !== undefined) {
      return send(res, 403, '');
    }
    if (req.headers['x-dcc-launcher'] !== '1') return send(res, 403, '');
    req.resume();
    const t = Date.now();
    if (t - lastLaunch < 2000) return sendJson(res, 429, { opened: false });
    lastLaunch = t;
    const r = await openSetup();
    if (r.ok) log('Setup page reopened in ' + r.label + '.');
    else log('Could not open a browser automatically.');
    return sendJson(res, r.ok ? 200 : 500, { opened: r.ok === true });
  }

  async function handleStatic(req, res, pathname) {
    const s = STATIC[pathname];
    const data = await fsp.readFile(path.join(HERE, s.file));
    const headers = { 'Content-Type': s.type };
    if (pathname === '/setup') headers['Content-Security-Policy'] = SETUP_CSP;
    if (req.method === 'HEAD') {
      res.writeHead(200, baseHeaders(Object.assign({ 'Content-Length': data.length }, headers)));
      return res.end();
    }
    return send(res, 200, data, headers);
  }

  async function handle(req, res) {
    if (!expectedHost || req.headers.host !== expectedHost) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    if (typeof req.url !== 'string' || !req.url.startsWith('/')) return send(res, 400, '');
    const pathname = req.url.split(/[?#]/, 1)[0];
    try {
      if (pathname.startsWith('/bridge/')) return await handleBridge(req, res, pathname);
      if (pathname.startsWith('/launcher/')) return await handleLauncher(req, res, pathname);
      if (req.method === 'OPTIONS') return send(res, 403, '');
      if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        return sendJson(res, 200, { name: 'dcc-helper', version: VERSION, protocol: PROTOCOL });
      }
      if (STATIC[pathname] && (req.method === 'GET' || req.method === 'HEAD')) return await handleStatic(req, res, pathname);
      if (pathname === '/favicon.ico') return send(res, 204, '');
      return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    } catch (e) {
      log('request failed: ' + (e && e.message));
      if (!res.headersSent) send(res, 500, '');
    }
  }

  const server = nodeHttp.createServer({ requestTimeout: 30000, headersTimeout: 10000 }, (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, '');
    });
  });
  server.keepAliveTimeout = 5000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = server.address().port;
  expectedHost = '127.0.0.1:' + port;

  let opened = null;
  if (o.open) opened = await openSetup();

  return {
    server,
    port,
    key,
    origin: 'http://' + expectedHost,
    opened,
    openSetup,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections && server.closeAllConnections();
      }),
  };
}

/* ------------------------------------------------------------------ fixture launcher */

function duckdbAvailable() {
  try {
    require.resolve('@duckdb/node-api');
    return true;
  } catch (_) {
    try {
      import.meta.resolve('@duckdb/node-api');
      return exists(path.join(ROOT, 'node_modules', '@duckdb', 'node-api'));
    } catch (__) {
      return false;
    }
  }
}

function fixtureStatus() {
  if (!exists(path.join(HERE, 'fixture-server.mjs'))) return 'The synthetic fixture is a development tool and is not included in this package.';
  if (!duckdbAvailable()) return 'The synthetic fixture needs its dev dependencies: run `npm install` in the project folder, then try again.';
  return null;
}

/* ------------------------------------------------------------------ CLI entry */

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, open: false, fixture: false, fixtureOnly: false, version: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--open') out.open = true;
    else if (a === '--fixture') out.fixture = true;
    else if (a === '--fixture-only') out.fixtureOnly = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--port' || a.startsWith('--port=')) {
      const v = a.includes('=') ? a.split('=')[1] : argv[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('Invalid --port');
      out.port = n;
    } else throw new Error('Unknown option ' + a);
  }
  return out;
}

const USAGE = `Databricks Cost Companion local helper ${VERSION}
Usage: node local/server.mjs [--open] [--fixture] [--port N]
       node local/server.mjs --fixture-only
       node local/server.mjs --version
  --open          open the setup page (Microsoft Edge if installed, else the default browser)
  --fixture       also start the dev-only synthetic fixture on http://127.0.0.1:${FIXTURE_PORT}
  --fixture-only  start only the fixture server
  --port N        helper port (default ${DEFAULT_PORT}; the extension pairs with ${DEFAULT_PORT})`;

async function main(argv) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    process.stderr.write('Node.js 20 or newer is required (found ' + process.versions.node + ').\n');
    process.exit(1);
  }
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(e.message + '\n\n' + USAGE + '\n');
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return;
  }
  if (args.version) {
    process.stdout.write(VERSION + '\n');
    return;
  }

  if (args.fixtureOnly) {
    const problem = fixtureStatus();
    if (problem) {
      process.stderr.write(problem + '\n');
      process.exit(1);
    }
    const mod = await import(pathToFileURL(path.join(HERE, 'fixture-server.mjs')).href);
    const fx = await mod.startFixtureServer({ port: FIXTURE_PORT });
    process.stdout.write('Synthetic fixture (dev only) on ' + fx.origin + ' — Ctrl+C to stop.\n');
    const stop = () => fx.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  let helper;
  try {
    helper = await startHelper({ port: args.port, devFixture: args.fixture });
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      process.stderr.write(
        'Port ' + args.port + ' is already in use. A helper may already be running: run the start script again (it reuses a running helper of the same version), or stop the other one (Ctrl+C in its window) and retry.\n'
      );
      process.exit(1);
    }
    throw e;
  }
  process.stdout.write('Databricks Cost Companion helper ' + VERSION + ' listening on ' + helper.origin + ' (this computer only).\n');

  let fixtureChild = null;
  if (args.fixture) {
    const problem = fixtureStatus();
    if (problem) process.stdout.write(problem + '\n');
    else {
      fixtureChild = spawn(process.execPath, [path.join(HERE, 'fixture-server.mjs'), '--port', String(FIXTURE_PORT)], { stdio: 'inherit' });
      fixtureChild.on('exit', (code) => {
        if (code) process.stdout.write('Fixture server exited (' + code + ').\n');
        fixtureChild = null;
      });
    }
  }

  if (args.open) {
    const r = await helper.openSetup();
    process.stdout.write(r.ok ? 'Opened the setup page in ' + r.label + '. Select "Connect workspace" there.\n' : 'Could not open a browser automatically. Run the start script again to retry.\n');
  } else {
    process.stdout.write('Run the start script (start-helper.command) to open the setup page.\n');
  }
  process.stdout.write('Keep this window open while you use browser sign-in. Press Ctrl+C to stop.\n');

  const stop = () => {
    if (fixtureChild) fixtureChild.kill('SIGTERM');
    helper.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
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
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write('Helper failed to start: ' + errors.redact(e && e.message) + '\n');
    process.exit(1);
  });
}
