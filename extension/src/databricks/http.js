/*
 * Constrained Databricks HTTP client used by the service worker (PAT mode) and by the local
 * helper (CLI OAuth mode). Only allowlisted API paths; GETs are read-only inventory; the only
 * POSTs are SQL statement execution and cancellation of our own statement. Redirects are
 * refused. Shared by browser and Node (fetch is injected).
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const errors = NODE ? require('../errors.js') : root.DCC.errors;
  const V = NODE ? require('../core/validate.js') : root.DCC.validate;
  const ids = NODE ? require('../core/ids.js') : root.DCC.ids;

  const STATEMENT_PATH = /^\/api\/2\.0\/sql\/statements\/([0-9a-f-]{36})$/;
  const GET_ALLOW = [
    /^\/api\/2\.0\/sql\/warehouses$/,
    STATEMENT_PATH,
    /^\/api\/2\.2\/jobs\/runs\/list$/,
    /^\/api\/2\.0\/pipelines$/,
    /^\/api\/2\.1\/clusters\/list$/,
  ];
  const POST_ALLOW = [/^\/api\/2\.0\/sql\/statements$/, /^\/api\/2\.0\/sql\/statements\/[0-9a-f-]{36}\/cancel$/];
  const QUERY_KEY = /^[a-z_.]{1,40}$/;
  const QUERY_VALUE = /^[A-Za-z0-9_.:-]{0,128}$/;

  function isAllowed(method, path) {
    const list = method === 'GET' ? GET_ALLOW : method === 'POST' ? POST_ALLOW : [];
    return list.some((re) => re.test(path));
  }

  function buildUrl(origin, path, query) {
    const cls = ids.classifyOrigin(origin);
    if (!cls.ok || cls.origin !== origin) throw new errors.DccError({ code: 'UNKNOWN', message: 'Unsupported API origin' });
    const url = new URL(path, origin);
    if (url.origin !== origin || url.pathname !== path) throw new errors.DccError({ code: 'UNKNOWN', message: 'Unsupported API path' });
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null) continue;
      if (!QUERY_KEY.test(k) || !QUERY_VALUE.test(String(v))) throw new errors.DccError({ code: 'UNKNOWN', message: 'Unsupported query parameter' });
      url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  /**
   * @param {{origin:string, token:string, fetch:Function}} o
   */
  function create(o) {
    const doFetch = o.fetch;
    async function request(method, path, { query, body } = {}) {
      if (!isAllowed(method, path)) throw new errors.DccError({ code: 'UNKNOWN', message: 'Blocked non-allowlisted API call' });
      const url = buildUrl(o.origin, path, query);
      let res;
      try {
        res = await doFetch(url, {
          method,
          headers: { Authorization: 'Bearer ' + o.token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
        });
      } catch (e) {
        throw new errors.DccError({ network: true, message: e && e.message });
      }
      let json = null;
      const text = await res.text();
      try {
        json = text ? JSON.parse(text) : {};
      } catch (_) {
        json = null;
      }
      if (!res.ok) {
        throw new errors.DccError({
          httpStatus: res.status,
          errorCode: json && json.error_code,
          message: (json && json.message) || 'HTTP ' + res.status,
        });
      }
      if (json === null) throw new errors.DccError({ code: 'UNKNOWN', message: 'Response was not JSON' });
      return json;
    }
    return {
      get: (path, query) => request('GET', path, { query }),
      post: (path, body) => request('POST', path, { body }),
    };
  }

  const TERMINAL_FAIL = new Set(['FAILED', 'CANCELED', 'CLOSED']);

  /**
   * Execute one read-only statement and wait for it. Long-running statements are cancelled at
   * the deadline and reported as SQL_TIMEOUT.
   */
  async function executeStatement(http, req, opts = {}) {
    const now = opts.now || (() => Date.now());
    const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const timeoutMs = opts.timeoutMs || 120000;
    if (!V.isWarehouseId(req.warehouseId)) throw new errors.DccError({ code: 'WAREHOUSE_UNAVAILABLE', message: 'No valid warehouse selected' });
    const body = {
      warehouse_id: req.warehouseId,
      statement: req.statement,
      parameters: req.parameters,
      wait_timeout: '30s',
      on_wait_timeout: 'CONTINUE',
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
    };
    if (req.rowLimit) body.row_limit = req.rowLimit;
    const started = now();
    let res = await http.post('/api/2.0/sql/statements', body);
    const id = String(res.statement_id || '').toLowerCase();
    if (!V.isStatementId(id)) throw new errors.DccError({ code: 'UNKNOWN', message: 'Unexpected statement ID' });
    let delay = 1000;
    while (res.status && (res.status.state === 'PENDING' || res.status.state === 'RUNNING')) {
      if (now() - started > timeoutMs) {
        try {
          await http.post('/api/2.0/sql/statements/' + id + '/cancel');
        } catch (_) {
          /* best effort */
        }
        throw new errors.DccError({ code: 'SQL_TIMEOUT', statementId: id, message: 'Statement exceeded ' + Math.round(timeoutMs / 1000) + 's' });
      }
      await sleep(delay);
      delay = Math.min(delay * 1.5, 5000);
      res = await http.get('/api/2.0/sql/statements/' + id);
    }
    const state = res.status && res.status.state;
    if (state !== 'SUCCEEDED') {
      const err = (res.status && res.status.error) || {};
      throw new errors.DccError({
        code: TERMINAL_FAIL.has(state) || !state ? undefined : 'UNKNOWN',
        errorCode: err.error_code,
        message: err.message || 'Statement ' + (state || 'failed'),
        sqlState: res.status && res.status.sql_state,
        statementId: id,
      });
    }
    res.statement_id = id;
    return res;
  }

  const api = Object.freeze({ create, executeStatement, isAllowed, buildUrl });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).http = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
