/*
 * Native SQL Query History row parsing (spec §8). Reads ONLY:
 *   - statement IDs from row attributes, a statement-ID column, or execution-detail link hrefs;
 *   - the warehouse ID from the compute cell (link href, data attribute or a 16-hex token);
 *   - the displayed start time (second precision, local time → UTC epoch ms);
 *   - the displayed total duration and its rounding tolerance;
 *   - status text and cache indicators from the status/duration/start cells.
 * Columns are identified from header text. The SQL text column, the user column and every other
 * column are never read: no text, no title, no markup. Link hrefs are the only thing read from
 * anywhere else in a row. No React state, no result rows.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const V = dep('validate', '../core/validate.js');
  const ids = dep('ids', '../core/ids.js');

  const OWN = '[data-dcc]';
  const TABLES = 'table, [role="table"], [role="grid"], [role="treegrid"]';
  const UUID_IN_TEXT = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  const HEX16_IN_TEXT = /\b[0-9a-f]{16}\b/g;
  const ROW_STATEMENT_ATTRS = ['data-statement-id', 'data-query-id'];
  const ROW_WAREHOUSE_ATTRS = ['data-warehouse-id'];

  // Header text → column kind. Order matters: the first rule that matches wins, and anything
  // that matches only `sql` (the query text column) is never read.
  const COLUMN_RULES = [
    ['id', /\b(statement|query)\s*id\b/i],
    ['start', /\bstart(ed)?\b/i],
    ['duration', /\bduration\b|\btotal time\b|\belapsed\b/i],
    ['status', /\bstatus\b|\bstate\b/i],
    ['compute', /\bcompute\b|\bwarehouse\b|\bendpoint\b/i],
    ['sql', /\bquery\b|\bstatement\b|\bsql\b/i],
  ];
  const READABLE = new Set(['id', 'start', 'duration', 'status', 'compute']);

  /* ------------------------------------------------------------------ safe text reads */

  /** Text of an allowed cell, excluding the extension's own nodes. */
  function cellText(el) {
    if (!el) return '';
    const doc = el.ownerDocument;
    const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
    let out = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (parent && parent.closest(OWN)) continue;
      out += ' ' + n.data;
    }
    return out.replace(/[\s  ]+/g, ' ').trim();
  }

  /** aria-label / title values inside an allowed cell (icons often carry status and cache flags). */
  function cellHints(el) {
    if (!el) return '';
    const parts = [];
    for (const node of [el, ...el.querySelectorAll('[aria-label], [title]')]) {
      if (node.closest(OWN)) continue;
      for (const a of ['aria-label', 'title']) {
        const v = node.getAttribute(a);
        if (v) parts.push(v);
      }
    }
    return parts.join(' ');
  }

  /* ------------------------------------------------------------------ value parsers */

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*\\.?';
  const TIME_RE = '(\\d{1,2}):(\\d{2}):(\\d{2})(?:[.,]\\d+)?\\s*([ap]\\.?\\s?m\\.?)?';

  function to24(h, ampm) {
    if (!ampm) return h;
    const pm = /^p/i.test(ampm);
    if (h < 1 || h > 12) return NaN;
    return pm ? (h % 12) + 12 : h % 12;
  }

  function localMs(y, mo, d, h, mi, s) {
    if (![y, mo, d, h, mi, s].every(Number.isFinite)) return null;
    if (mo < 0 || mo > 11 || d < 1 || d > 31 || h < 0 || h > 23 || mi > 59 || s > 59) return null;
    const dt = new Date(y, mo, d, h, mi, s, 0);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d || dt.getHours() !== h) return null;
    return dt.getTime();
  }

  function withYear(y, build, nowMs) {
    if (y !== null) return build(y);
    const cur = new Date(nowMs).getFullYear();
    const ms = build(cur);
    return ms !== null && ms > nowMs + 86400000 ? build(cur - 1) : ms;
  }

  /**
   * Parse a displayed start time with second precision. Times without a zone are the browser's
   * local time. Returns UTC epoch ms floored to the second, or null when seconds are not shown or
   * the format is not recognized.
   * @param {string} text
   * @param {{nowMs?:number, locale?:string}} [o]
   */
  function parseDisplayedTime(text, o = {}) {
    const nowMs = o.nowMs || Date.now();
    const t = String(text || '').replace(/[  ]/g, ' ').trim();
    if (!t) return null;
    let m = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/.exec(t);
    if (m) {
      if (m[7]) {
        const zone = m[7] === 'Z' ? 'Z' : m[7].length === 5 ? m[7].slice(0, 3) + ':' + m[7].slice(3) : m[7];
        const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${zone}`);
        return Number.isFinite(ms) ? Math.floor(ms / 1000) * 1000 : null;
      }
      return localMs(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    }
    m = new RegExp('\\b(today|yesterday)\\b,?\\s*(?:at\\s+)?' + TIME_RE, 'i').exec(t);
    if (m) {
      const base = new Date(nowMs);
      if (/^y/i.test(m[1])) base.setDate(base.getDate() - 1);
      return localMs(base.getFullYear(), base.getMonth(), base.getDate(), to24(+m[2], m[5]), +m[3], +m[4]);
    }
    m = new RegExp('\\b' + MONTH_RE + '\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?,?\\s*(?:at\\s+)?' + TIME_RE, 'i').exec(t);
    if (m) {
      const mo = MONTHS[m[1].toLowerCase()];
      return withYear(m[3] ? +m[3] : null, (y) => localMs(y, mo, +m[2], to24(+m[4], m[7]), +m[5], +m[6]), nowMs);
    }
    m = new RegExp('\\b(\\d{1,2})\\s+' + MONTH_RE + ',?\\s*(\\d{4})?,?\\s*(?:at\\s+)?' + TIME_RE, 'i').exec(t);
    if (m) {
      const mo = MONTHS[m[2].toLowerCase()];
      return withYear(m[3] ? +m[3] : null, (y) => localMs(y, mo, +m[1], to24(+m[4], m[7]), +m[5], +m[6]), nowMs);
    }
    m = new RegExp('\\b(\\d{1,2})[/.](\\d{1,2})[/.](\\d{4}),?\\s*' + TIME_RE, 'i').exec(t);
    if (m) {
      const a = +m[1];
      const b = +m[2];
      const locale = String(o.locale || '');
      let mo;
      let d;
      if (a > 12 && b <= 12) [d, mo] = [a, b];
      else if (b > 12 && a <= 12) [mo, d] = [a, b];
      else if (/^en-US$|^en$/i.test(locale)) [mo, d] = [a, b];
      else return null; // day/month order unknown
      return localMs(+m[3], mo - 1, d, to24(+m[4], m[7]), +m[5], +m[6]);
    }
    return null;
  }

  const UNIT_MS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  function unitOf(u) {
    const x = u.toLowerCase();
    if (/^(ms|msecs?|milliseconds?)$/.test(x)) return 'ms';
    if (/^(s|secs?|seconds?)$/.test(x)) return 's';
    if (/^(m|mins?|minutes?)$/.test(x)) return 'm';
    if (/^(h|hrs?|hours?)$/.test(x)) return 'h';
    if (/^(d|days?)$/.test(x)) return 'd';
    return null;
  }

  /**
   * Parse a displayed duration. Tolerance is half of the last displayed digit's unit:
   * "350 ms" → ±0.5 ms, "1.2 s" → ±50 ms, "2m 3s" → ±500 ms, "1h 2m" → ±30 s.
   * @returns {{ms:number, toleranceMs:number}|null}
   */
  function parseDuration(text) {
    const t = String(text || '').replace(/[  ]/g, ' ').trim();
    if (!t || /^[<>~≈]/.test(t)) return null;
    let m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d+))?$/.exec(t);
    if (m) {
      const dec = m[4] || '';
      const ms = ((+(m[1] || 0) * 60 + +m[2]) * 60 + +m[3]) * 1000 + (dec ? Math.round(Number('0.' + dec) * 1000) : 0);
      return { ms, toleranceMs: 500 * Math.pow(10, -dec.length) };
    }
    const re = /(\d+(?:[.,]\d+)?)\s*(milliseconds?|msecs?|ms|minutes?|mins?|m|seconds?|secs?|s|hours?|hrs?|h|days?|d)\b/gi;
    let total = 0;
    let smallest = null;
    let consumed = t;
    let any = false;
    while ((m = re.exec(t))) {
      const unit = unitOf(m[2]);
      if (!unit) return null;
      const num = m[1].replace(',', '.');
      const decimals = num.includes('.') ? num.split('.')[1].length : 0;
      total += Number(num) * UNIT_MS[unit];
      const tol = 0.5 * UNIT_MS[unit] * Math.pow(10, -decimals);
      if (smallest === null || tol < smallest) smallest = tol;
      consumed = consumed.replace(m[0], '');
      any = true;
    }
    if (!any || consumed.replace(/[\s,]+/g, '') !== '') return null;
    return { ms: Math.round(total), toleranceMs: smallest };
  }

  function mapStatus(text) {
    const t = String(text || '').toLowerCase();
    if (/\b(running|executing|in progress|fetching)\b/.test(t)) return 'running';
    if (/\b(queued|pending|waiting|starting|scheduled)\b/.test(t)) return 'queued';
    if (/\b(cancel+ed|canceling|cancelling|aborted)\b/.test(t)) return 'canceled';
    if (/\b(failed|failure|error)\b/.test(t)) return 'failed';
    if (/\b(finished|succeeded|success|successful|completed?)\b/.test(t)) return 'finished';
    return null;
  }

  const CACHE_RE = /\b(from|result|query)?\s*cache[ds]?\b/i;

  /* ------------------------------------------------------------------ table structure */

  function closestTable(el) {
    return el.closest(TABLES);
  }

  function cellsOf(row) {
    if (row.tagName === 'TR') return [...row.cells];
    return [...row.querySelectorAll('[role="cell"], [role="gridcell"], [role="rowheader"], [role="columnheader"]')].filter((c) => c.closest('[role="row"]') === row);
  }

  function indexOf(cell, position) {
    const ci = Number(cell.getAttribute('aria-colindex'));
    return Number.isInteger(ci) && ci > 0 ? ci - 1 : position;
  }

  function headerCells(table) {
    if (table.tagName === 'TABLE') {
      const headRow = (table.tHead && table.tHead.rows[0]) || [...table.rows].find((r) => [...r.cells].some((c) => c.tagName === 'TH' && c.getAttribute('scope') !== 'row'));
      if (headRow) return [...headRow.cells];
    }
    return [...table.querySelectorAll('[role="columnheader"]')].filter((c) => closestTable(c) === table);
  }

  /** Header text → {kind: columnIndex}. Header cells are extension-safe to read (labels only). */
  function mapColumns(table) {
    const cols = {};
    headerCells(table).forEach((cell, pos) => {
      const label = cellText(cell) || cell.getAttribute('aria-label') || '';
      const rule = COLUMN_RULES.find(([, re]) => re.test(label));
      const kind = rule ? rule[0] : 'other';
      if (!(kind in cols)) cols[kind] = indexOf(cell, pos);
    });
    return cols;
  }

  function bodyRows(table) {
    let rows;
    if (table.tagName === 'TABLE') {
      rows = table.tBodies.length ? [...table.tBodies].flatMap((b) => [...b.rows]) : [...table.rows];
    } else {
      rows = [...table.querySelectorAll('[role="row"]')].filter((r) => closestTable(r) === table);
    }
    return rows.filter((r) => !r.closest(OWN) && !cellsOf(r).some((c) => c.tagName === 'TH' && c.getAttribute('scope') !== 'row') && !cellsOf(r).some((c) => c.getAttribute('role') === 'columnheader'));
  }

  function findTables(doc) {
    const scope = (root.DCC && root.DCC.native && root.DCC.native.findBannerContainer && root.DCC.native.findBannerContainer(doc)) || doc.body;
    if (!scope) return [];
    const out = [];
    for (const t of scope.querySelectorAll(TABLES)) {
      if (t.closest(OWN)) continue;
      if (t.parentElement && t.parentElement.closest(TABLES)) continue; // nested table inside a cell
      const columns = mapColumns(t);
      if (!('start' in columns) && !('duration' in columns)) continue;
      out.push({ table: t, columns });
    }
    return out;
  }

  /* ------------------------------------------------------------------ rows */

  function uniqueStatementIds(values) {
    const set = new Set();
    for (const v of values) {
      const s = String(v || '').toLowerCase();
      if (V.isStatementId(s)) set.add(s);
    }
    return [...set];
  }

  /**
   * Parse one native row.
   * @returns {{row, anchor, key, target:object|null, local:{status, reason}|null, info:object}}
   */
  function parseRow(row, columns, ctx) {
    const cells = cellsOf(row);
    const byKind = {};
    cells.forEach((cell, pos) => {
      const idx = indexOf(cell, pos);
      for (const kind of READABLE) if (columns[kind] === idx) byKind[kind] = cell;
      if (columns.sql === idx) byKind.sql = cell; // located only to avoid it; never read
    });
    const info = { statementId: null, warehouseId: null, startMs: null, durationMs: null, toleranceMs: null, status: null, cached: false };

    // Statement ID: row attributes, a statement-ID column, then execution-detail link hrefs.
    let sids = uniqueStatementIds(ROW_STATEMENT_ATTRS.map((a) => row.getAttribute(a)));
    if (!sids.length && byKind.id) sids = uniqueStatementIds(cellText(byKind.id).match(UUID_IN_TEXT) || []);
    const links = [...row.querySelectorAll('a[href]')].filter((a) => !a.closest(OWN)).map((a) => ids.parseResourceLink(a.getAttribute('href'), ctx.origin, ctx.workspaceId)).filter(Boolean);
    if (!sids.length) sids = uniqueStatementIds(links.filter((r) => r.type === 'statement').map((r) => r.statementId));
    if (sids.length === 1) info.statementId = sids[0];

    // Warehouse ID: compute cell (link, data attribute, 16-hex token), row attribute, row links.
    const whs = new Set();
    if (byKind.compute) {
      for (const a of byKind.compute.querySelectorAll('a[href]')) {
        const r = ids.parseResourceLink(a.getAttribute('href'), ctx.origin, ctx.workspaceId);
        if (r && r.type === 'warehouse') whs.add(r.warehouseId);
      }
      for (const el of [byKind.compute, ...byKind.compute.querySelectorAll('[data-warehouse-id]')]) {
        const v = el.getAttribute('data-warehouse-id');
        if (V.isWarehouseId(v)) whs.add(v);
      }
      if (!whs.size) for (const tok of cellText(byKind.compute).toLowerCase().match(HEX16_IN_TEXT) || []) whs.add(tok);
    }
    if (!whs.size) for (const a of ROW_WAREHOUSE_ATTRS) if (V.isWarehouseId(row.getAttribute(a))) whs.add(row.getAttribute(a));
    if (!whs.size) for (const r of links) if (r.type === 'warehouse') whs.add(r.warehouseId);
    if (whs.size === 1) info.warehouseId = [...whs][0];

    // Start time.
    if (byKind.start) {
      const timeEl = byKind.start.querySelector('time[datetime]');
      const iso = timeEl && !timeEl.closest(OWN) ? Date.parse(timeEl.getAttribute('datetime')) : NaN;
      if (Number.isFinite(iso)) info.startMs = Math.floor(iso / 1000) * 1000;
      else {
        const parseOpts = { nowMs: ctx.nowMs, locale: ctx.locale };
        info.startMs = parseDisplayedTime(cellText(byKind.start), parseOpts);
        if (info.startMs === null) {
          const titled = [byKind.start, ...byKind.start.querySelectorAll('[title]')].find((el) => !el.closest(OWN) && el.getAttribute('title'));
          if (titled) info.startMs = parseDisplayedTime(titled.getAttribute('title'), parseOpts);
        }
      }
    }

    // Duration (strip a trailing cache marker such as "(from cache)" before parsing).
    let durationText = '';
    if (byKind.duration) {
      durationText = cellText(byKind.duration);
      const d = parseDuration(durationText.replace(/\(?[^()]*cache[^()]*\)?/i, '').trim());
      if (d) {
        info.durationMs = d.ms;
        info.toleranceMs = d.toleranceMs;
      }
    }

    // Status and cache flags.
    const statusText = byKind.status ? cellText(byKind.status) + ' ' + cellHints(byKind.status) : '';
    info.status = mapStatus(statusText);
    const cacheText = [statusText, durationText, byKind.duration ? cellHints(byKind.duration) : '', byKind.start ? cellHints(byKind.start) : ''].join(' ');
    info.cached = /^true$/i.test(row.getAttribute('data-from-cache') || '') || CACHE_RE.test(cacheText);

    // Badge anchor: duration cell, else start cell, else the last cell that is not the SQL cell.
    const anchor = byKind.duration || byKind.start || [...cells].reverse().find((c) => c !== byKind.sql) || null;

    let key = null;
    let target = null;
    let local = null;
    const nativeState = { status: info.status, cached: info.cached };
    if (info.statementId) {
      key = 'statement:' + info.statementId;
      target = Object.assign({ key, statementId: info.statementId }, info.startMs !== null ? { startMs: info.startMs } : {}, info.durationMs !== null ? { durationMs: info.durationMs } : {}, nativeState);
    } else if (info.warehouseId && info.startMs !== null && info.durationMs !== null) {
      key = ['meta', info.warehouseId, info.startMs, info.durationMs, info.toleranceMs].join(':');
      target = Object.assign({ key, warehouseId: info.warehouseId, startMs: info.startMs, durationMs: info.durationMs, toleranceMs: info.toleranceMs }, nativeState);
    }
    if (info.status === 'running' || info.status === 'queued') {
      local = { status: 'pending', reason: 'Databricks shows this execution as ' + info.status + '. Estimates are made only for finished executions.' };
    } else if (info.cached) {
      local = { status: 'cached', reason: 'Databricks shows this result as served from cache; no warehouse execution time is allocated to it.' };
    } else if (!target) {
      local = {
        status: 'row_unavailable',
        reason: 'This row does not show a statement ID, or a warehouse ID with a start time to the second and a duration, so it cannot be matched to query history uniquely.',
      };
    }
    if (!key) key = 'row:' + (info.warehouseId || '-') + ':' + (info.startMs === null ? '-' : info.startMs) + ':' + (info.durationMs === null ? '-' : info.durationMs);
    return { row, anchor, key, target, local, info };
  }

  /**
   * Scan the visible Query History table(s).
   * @param {Document} doc
   * @param {{origin, workspaceId, nowMs?, locale?}} ctx
   */
  function scan(doc, ctx) {
    const c = Object.assign({ nowMs: Date.now(), locale: (doc.defaultView && doc.defaultView.navigator && doc.defaultView.navigator.language) || '' }, ctx);
    const tables = findTables(doc);
    const rows = [];
    for (const t of tables) for (const r of bodyRows(t.table)) rows.push(parseRow(r, t.columns, c));
    return { tables, rows };
  }

  const api = Object.freeze({ COLUMN_RULES, cellText, parseDisplayedTime, parseDuration, mapStatus, mapColumns, findTables, parseRow, scan });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).nativeCostData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
