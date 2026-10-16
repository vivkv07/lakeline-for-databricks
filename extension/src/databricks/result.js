/*
 * Statement Execution API result parsing. INLINE + JSON_ARRAY results arrive as strings; this
 * coerces by manifest type and refuses anything that is truncated, chunked, or over the caller's
 * row cap — partial results are never presented as complete.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const errors = NODE ? require('../errors.js') : root.DCC.errors;

  const NUMERIC = new Set(['DOUBLE', 'FLOAT', 'DECIMAL', 'LONG', 'INT', 'SHORT', 'BYTE', 'BIGINT', 'INTEGER', 'SMALLINT', 'TINYINT']);

  function coerce(value, typeName) {
    if (value === null || value === undefined) return null;
    const t = String(typeName || 'STRING').toUpperCase();
    if (NUMERIC.has(t)) {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    if (t === 'BOOLEAN') return value === true || value === 'true';
    return String(value);
  }

  /**
   * @param {object} response GET/POST statement response with status SUCCEEDED
   * @param {{maxRows:number}} opts
   * @returns {{columns:string[], rows:object[], rowCount:number}}
   */
  function parseResult(response, opts = {}) {
    const maxRows = opts.maxRows || 20000;
    const manifest = response && response.manifest;
    if (!manifest || !manifest.schema || !Array.isArray(manifest.schema.columns)) {
      throw new errors.DccError({ code: 'UNKNOWN', message: 'Result manifest missing' });
    }
    if (manifest.truncated === true) {
      throw new errors.DccError({ code: 'RESULT_TOO_LARGE', message: 'Result truncated by the server', statementId: response.statement_id });
    }
    if ((manifest.total_chunk_count || 1) > 1) {
      throw new errors.DccError({ code: 'RESULT_TOO_LARGE', message: 'Result split into multiple chunks', statementId: response.statement_id });
    }
    const totalRows = Number(manifest.total_row_count || 0);
    if (totalRows > maxRows) {
      throw new errors.DccError({ code: 'RESULT_TOO_LARGE', message: 'Result has ' + totalRows + ' rows; limit is ' + maxRows, statementId: response.statement_id });
    }
    const cols = manifest.schema.columns.map((c) => ({ name: c.name, type: c.type_name }));
    const data = (response.result && response.result.data_array) || [];
    if (data.length !== totalRows && totalRows !== 0) {
      throw new errors.DccError({ code: 'RESULT_TOO_LARGE', message: 'Inline result incomplete', statementId: response.statement_id });
    }
    const rows = data.map((arr) => {
      const o = {};
      cols.forEach((c, i) => {
        o[c.name] = coerce(arr[i], c.type);
      });
      return o;
    });
    return { columns: cols.map((c) => c.name), rows, rowCount: rows.length };
  }

  const api = Object.freeze({ coerce, parseResult });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).result = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
