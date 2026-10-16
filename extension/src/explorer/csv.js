/*
 * CSV export for the Explorer's currently filtered table (RFC 4180, CRLF).
 *
 * Safety: numeric cells are written as plain unquoted numbers, so legitimate negative costs
 * (signed corrections) stay numbers. Text cells that a spreadsheet could treat as a formula
 * (starting with =, +, -, @, tab or carriage return, also after leading spaces) get a leading
 * single quote. Quotes, commas and newlines are escaped by quoting. Metadata header rows carry
 * source, pricing basis/table, currency, UTC bounds, freshness and scope/limit.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;

  const FORMULA_START = /^(?:[=+\-@\t\r]|[  ]+[=+\-@])/;

  function numberCell(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '';
    // Trim binary floating noise (0.1 + 0.2) without losing small amounts.
    const rounded = Math.round(v * 1e9) / 1e9;
    return String(rounded === 0 && v !== 0 ? v : rounded);
  }

  function textCell(v) {
    let s = String(v);
    if (FORMULA_START.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /** One cell. `type` 'number' forces numeric output; missing values are empty, never 0. */
  function cell(v, type) {
    if (v === null || v === undefined) return '';
    if (type === 'number') return typeof v === 'number' ? numberCell(v) : '';
    if (typeof v === 'number' && type !== 'text') return numberCell(v);
    return textCell(v);
  }

  /**
   * @param {{meta:[[label, value]], columns:[{key,label,type?, value?(row)}], rows:object[]}} t
   * @returns {string}
   */
  function toCsv(t) {
    const lines = [];
    for (const [k, v] of t.meta || []) lines.push(cell(k, 'text') + ',' + cell(v === null || v === undefined ? '' : String(v), 'text'));
    if (lines.length) lines.push('');
    lines.push(t.columns.map((c) => cell(c.label, 'text')).join(','));
    for (const row of t.rows) {
      lines.push(t.columns.map((c) => cell(typeof c.value === 'function' ? c.value(row) : row[c.key], c.type)).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  /** Safe file name fragment. */
  function fileSafe(s) {
    return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'export';
  }

  /**
   * Download on an explicit click: Blob + temporary <a download>. Returns false when the
   * environment cannot create object URLs.
   */
  function download(doc, container, filename, text) {
    const win = doc.defaultView;
    const URLApi = win && win.URL;
    if (!URLApi || typeof URLApi.createObjectURL !== 'function' || typeof win.Blob !== 'function') return false;
    const blob = new win.Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    const url = URLApi.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = fileSafe(filename.replace(/\.csv$/i, '')) + '.csv';
    a.setAttribute('data-dcc', 'explorer');
    a.style.display = 'none';
    container.appendChild(a);
    a.click();
    a.remove();
    win.setTimeout(() => URLApi.revokeObjectURL(url), 2000);
    return true;
  }

  const api = Object.freeze({ cell, toCsv, download, fileSafe, FORMULA_START });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).exploreCsv = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
