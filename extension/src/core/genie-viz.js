/*
 * Genie result tables: column typing, value formatting and automatic chart choice. Pure: no DOM,
 * no storage, no network. The side panel (ui/sidepanel.js) renders what this decides, and
 * ui/genie-chart.js draws the charts.
 *
 * The Genie Conversation API carries no chart specification (a `viz` attachment has only a
 * title and the query attachment ID; see notes/GENIE.md), so charts are chosen here from the
 * result schema and values, deterministically:
 *
 *   1. No rows → no chart.
 *   2. One row with 1 to 4 measures → KPI tiles (other columns become context).
 *   3. A time column (DATE, TIMESTAMP, ISO date strings, or an integer "year") and at least one
 *      measure, with at least 2 dated rows → line chart, x sorted ascending.
 *        - Time values unique and no varying category column: one series per measure. 2 to 4
 *          measures that share a unit and a scale (largest |max| at most 10× the smallest) draw
 *          together with a legend; otherwise one measure at a time with a picker (never two
 *          y-scales). Unique times with varying labels are separate records → no chart.
 *        - Time values repeat and exactly one category column with 2 to 4 values splits them:
 *          one series per category value, measure picker when several measures.
 *        - Anything else (repeats we can't split) → no chart. Nothing is aggregated.
 *   4. Exactly two measures, no category and no time column, at least 5 rows → scatter
 *      (ID or text columns label the points in the tooltip).
 *   5. One category column (or, failing that, one ID column) with unique labels and at least
 *      one measure → horizontal bars sorted descending, top 12 shown with "Showing top 12 of N"
 *      (no invented "Other" bar); measure picker when several measures.
 *   6. Otherwise → table only.
 *
 * Measures are numeric columns that aren't IDs. A column is an ID when its name ends in id/_id/
 * uuid/guid/key (any case style), or it is an integer column of all-distinct values (5 or more
 * rows) with no measure word in its name that is either very large (all ≥ 1,000,000) or a
 * consecutive run (row numbers). Missing values are gaps in lines, "n/a" bars and omitted
 * scatter points, never zeros.
 *
 * Formatting is locale-aware through Intl. Currency when the name carries a currency code
 * (revenue_usd → "Revenue (USD)"); percent when it says pct/percent/percentage/ratio, with the
 * scale read from the values: all |v| ≤ 1 means fractions (0.061 → 6.1%), otherwise percent
 * points (9.4 → 9.4%). Decimals follow the data, capped at 2 (3 significant digits for tiny
 * magnitudes). Dates and timestamps are formatted in UTC; timestamp headers say "(UTC)".
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const csv = dep('exploreCsv', '../explorer/csv.js');

  const LIMITS = Object.freeze({ kpi: 4, barTop: 12, lineSeries: 4, scatterMin: 5, splitMax: 4, scaleRatio: 10 });
  const NUMERIC = new Set(['BYTE', 'SHORT', 'INT', 'INTEGER', 'LONG', 'BIGINT', 'FLOAT', 'DOUBLE', 'DECIMAL', 'TINYINT', 'SMALLINT', 'NUMERIC', 'REAL']);
  const INTEGER = new Set(['BYTE', 'SHORT', 'INT', 'INTEGER', 'LONG', 'BIGINT', 'TINYINT', 'SMALLINT']);
  const CURRENCIES = new Set(['usd', 'eur', 'gbp', 'jpy', 'inr', 'cad', 'aud', 'chf', 'cny', 'sek', 'nok', 'dkk', 'brl', 'mxn', 'sgd', 'hkd', 'nzd', 'zar', 'krw', 'pln']);
  const PERCENT_WORDS = new Set(['pct', 'percent', 'percentage']);
  const RATIO_WORDS = new Set(['ratio']);
  const SPECIAL = Object.freeze({ id: 'ID', ids: 'IDs', dbu: 'DBU', dbus: 'DBUs', uuid: 'UUID', guid: 'GUID', sql: 'SQL', url: 'URL', api: 'API', ytd: 'YTD', mtd: 'MTD', qtd: 'QTD', wtd: 'WTD', yoy: 'YoY', mom: 'MoM', wow: 'WoW', kpi: 'KPI', etl: 'ETL', sku: 'SKU', cpu: 'CPU', gpu: 'GPU', utc: 'UTC', p50: 'P50', p90: 'P90', p95: 'P95', p99: 'P99', ip: 'IP', io: 'IO' });
  const UNITS = Object.freeze({ ms: 'ms', sec: 's', secs: 's', min: 'min', mins: 'min', hr: 'h', hrs: 'h', kb: 'KB', mb: 'MB', gb: 'GB', tb: 'TB', gib: 'GiB', mib: 'MiB' });
  const SMALL = new Set(['of', 'and', 'or', 'per', 'by', 'in', 'on', 'to', 'the', 'a', 'an', 'vs', 'at', 'for']);
  // Words that make an integer column a measure even when every value is distinct.
  const MEASURE_WORDS = new Set(['count', 'cnt', 'total', 'sum', 'qty', 'quantity', 'amount', 'revenue', 'cost', 'costs', 'spend', 'sales', 'orders', 'runs', 'rows', 'bytes', 'size', 'value', 'price', 'avg', 'mean', 'min', 'max', 'duration', 'seconds', 'minutes', 'hours', 'ms', 'dbu', 'dbus', 'usage', 'users', 'customers', 'items', 'events', 'clicks', 'sessions', 'visits', 'failed', 'errors', 'succeeded', 'tokens']);
  const hasMeasureWord = (name) => words(name).some((w) => MEASURE_WORDS.has(w.toLowerCase()));
  const NUM_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
  const DAY = 86400000;

  /* ---------------------------------------------------------------- locale + Intl cache */

  const cache = new Map();
  function safeLocale(locale) {
    try {
      return typeof locale === 'string' && locale && Intl.NumberFormat.supportedLocalesOf([locale]).length ? locale : 'en-US';
    } catch (_) {
      return 'en-US';
    }
  }
  function nf(locale, opts) {
    const key = 'n|' + locale + '|' + JSON.stringify(opts);
    if (!cache.has(key)) {
      try {
        cache.set(key, new Intl.NumberFormat(locale, opts));
      } catch (_) {
        cache.set(key, new Intl.NumberFormat('en-US', Object.assign({}, opts, { currency: opts.currency ? 'USD' : undefined })));
      }
    }
    return cache.get(key);
  }
  function df(locale, opts) {
    const key = 'd|' + locale + '|' + JSON.stringify(opts);
    if (!cache.has(key)) cache.set(key, new Intl.DateTimeFormat(locale, Object.assign({ timeZone: 'UTC' }, opts)));
    return cache.get(key);
  }

  /* ---------------------------------------------------------------- names */

  function words(name) {
    return String(name || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_.\-/]+/)
      .filter(Boolean);
  }

  /**
   * snake_case / camelCase / SHOUTING → a readable title-case label with unit hints.
   * revenue_usd → {label:'Revenue (USD)', currency:'USD'}; change_pct → {label:'Change %', percent:true}
   */
  function humanize(name) {
    const raw = String(name === null || name === undefined ? '' : name).trim();
    const ws = words(raw);
    let currency = null;
    let percent = false;
    let ratio = false;
    const kept = [];
    for (const w of ws) {
      const lw = w.toLowerCase();
      if (ws.length > 1 && CURRENCIES.has(lw) && !currency) currency = lw.toUpperCase();
      else if (ws.length > 1 && PERCENT_WORDS.has(lw)) percent = true;
      else {
        if (RATIO_WORDS.has(lw)) ratio = true;
        if (lw === '%') percent = true;
        kept.push(w);
      }
    }
    if (ws.length === 1 && PERCENT_WORDS.has(ws[0].toLowerCase())) return { label: 'Percent', currency: null, percent: true, ratio: false };
    if (ws.length === 1 && ID_PREFIX.test(raw)) {
      const base = raw.slice(0, -2);
      return { label: base.charAt(0).toUpperCase() + base.slice(1).toLowerCase() + ' ID', currency: null, percent: false, ratio: false };
    }
    // A trailing unit word becomes a parenthesized unit: latency_ms → "Latency (ms)".
    let unit = null;
    if (kept.length > 1 && UNITS[kept[kept.length - 1].toLowerCase()]) unit = UNITS[kept.pop().toLowerCase()];
    // In mixed-case names a short all-caps word is an acronym ("costEUR", "avgCPU"); in SHOUTING
    // names (TOTAL_COST) it isn't.
    const shouting = /[A-Z]/.test(raw) && raw === raw.toUpperCase();
    const titled = kept.map((w, i) => {
      const lw = w.toLowerCase();
      if (SPECIAL[lw]) return SPECIAL[lw];
      if (i > 0 && SMALL.has(lw)) return lw;
      if (!shouting && /^[A-Z][A-Z0-9]{1,3}$/.test(w)) return w;
      return lw.charAt(0).toUpperCase() + lw.slice(1);
    });
    let label = titled.join(' ');
    if (percent) label = (label ? label + ' ' : '') + '%';
    if (currency) label = (label ? label + ' ' : '') + '(' + currency + ')';
    else if (unit) label = (label ? label + ' ' : '') + '(' + unit + ')';
    return { label: label || raw || 'Column', currency, percent: percent || ratio, ratio };
  }

  // Single-word names like "jobid" count as IDs only with a known entity prefix ("paid" doesn't).
  const ID_PREFIX = /^(?:user|job|run|order|customer|account|session|pipeline|warehouse|cluster|workspace|product|item|event|query|statement|task|request|transaction|invoice|ticket|device|host|node|row|record|update|space|message|conversation|endpoint|model|notebook|file|object|entity|employee|vendor|store|sku)id$/i;

  /** Name says identifier: id, *_id, *Id, *-id, uuid, guid, key, or a known "<entity>id". */
  function isIdName(name) {
    const raw = String(name || '').trim();
    const ws = words(raw);
    const last = ws.length ? ws[ws.length - 1].toLowerCase() : '';
    return ['id', 'ids', 'uuid', 'guid', 'key'].includes(last) || ID_PREFIX.test(raw);
  }

  /* ---------------------------------------------------------------- values */

  function toNumber(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).trim();
    if (!NUM_RE.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  /** ISO date or timestamp string → epoch ms (UTC; a zone-less timestamp counts as UTC), else null. */
  function toTime(v, kind) {
    if (v === null || v === undefined) return null;
    if (kind === 'year') {
      const n = toNumber(v);
      return n !== null && Number.isInteger(n) ? Date.UTC(n, 0, 1) : null;
    }
    const s = String(v).trim();
    let ms = NaN;
    if (DATE_RE.test(s)) ms = Date.parse(s + 'T00:00:00Z');
    else if (TS_RE.test(s)) {
      let t = s.replace(' ', 'T');
      if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(t)) t += 'Z';
      t = t.replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
      ms = Date.parse(t);
    }
    return Number.isFinite(ms) ? ms : null;
  }

  function decimalsOf(s) {
    const m = /\.(\d+)(?:[eE]|$)/.exec(String(s));
    return m ? m[1].replace(/0+$/, '').length : /[eE]-/.test(String(s)) ? 2 : 0;
  }

  /* ---------------------------------------------------------------- profiling */

  /**
   * Profile a normalized table (genie-api normalizeQueryResult shape: columns [{name,type,numeric}],
   * rows of strings or null).
   * @returns {{columns: Profile[], rows: (string|null)[][], locale: string}}
   */
  function profile(table, opts = {}) {
    const locale = safeLocale(opts.locale);
    const cols = (table && Array.isArray(table.columns) ? table.columns : []).map((c, index) => profileColumn(c, index, table.rows || [], locale));
    return { columns: cols, rows: Array.isArray(table && table.rows) ? table.rows : [], locale, table };
  }

  function profileColumn(c, index, rows, locale) {
    const name = String((c && c.name) || 'column ' + (index + 1));
    const type = c && typeof c.type === 'string' ? c.type.toUpperCase() : null;
    const values = rows.map((r) => (Array.isArray(r) ? r[index] : null));
    const present = values.filter((v) => v !== null && v !== undefined && v !== '');
    const h = humanize(name);
    const p = { index, name, type, label: h.label, currency: h.currency, kind: 'text', role: 'category', format: 'text', decimals: 0, percentScale: null, small: false, numeric: false, nulls: values.length - present.length, distinct: new Set(present).size, count: present.length, finite: 0, min: null, max: null, note: null, locale };
    const typeBase = type ? type.replace(/\(.*$/, '') : null;
    const nums = present.map(toNumber);
    const allNumeric = present.length > 0 && nums.every((n) => n !== null);

    if (typeBase === 'DATE' || (!NUMERIC.has(typeBase) && typeBase !== 'BOOLEAN' && present.length && present.every((v) => DATE_RE.test(String(v).trim()) && toTime(v, 'date') !== null))) {
      p.kind = 'date';
    } else if (/^TIMESTAMP/.test(typeBase || '') || (!NUMERIC.has(typeBase) && typeBase !== 'BOOLEAN' && present.length && present.every((v) => TS_RE.test(String(v).trim()) && toTime(v, 'timestamp') !== null))) {
      p.kind = 'timestamp';
    } else if (typeBase === 'BOOLEAN') {
      p.kind = 'boolean';
    } else if (NUMERIC.has(typeBase) || (!typeBase && allNumeric)) {
      p.kind = 'number';
    }

    if (p.kind === 'number') {
      const fin = nums.filter((n) => n !== null);
      p.finite = fin.length;
      p.min = fin.length ? Math.min(...fin) : null;
      p.max = fin.length ? Math.max(...fin) : null;
      p.numeric = true;
      const integerType = INTEGER.has(typeBase) || (!typeBase && fin.every(Number.isInteger));
      if (/(^|_|\b)(year|yr)$/i.test(name) && fin.length && fin.every((n) => Number.isInteger(n) && n >= 1900 && n <= 2200)) {
        p.kind = 'year';
        p.format = 'year';
        p.role = 'time';
        return p;
      }
      if (isIdName(name) || (integerType && fin.length >= 5 && p.distinct === present.length && !hasMeasureWord(name) && (fin.every((n) => Math.abs(n) >= 1e6) || isRun(fin)))) {
        p.role = 'id';
        p.format = 'id';
        return p;
      }
      p.role = 'measure';
      const maxAbs = fin.length ? Math.max(...fin.map(Math.abs)) : 0;
      if (h.percent) {
        p.format = 'percent';
        p.percentScale = maxAbs <= 1 ? 'fraction' : 'whole';
        const scaled = p.percentScale === 'fraction' ? fin.map((n) => Math.round(n * 1e8) / 1e6) : fin;
        p.decimals = Math.min(2, Math.max(0, ...scaled.map(decimalsOf)));
        p.note = p.percentScale === 'fraction' ? 'Values read as fractions (0 to 1) and shown as percents' : 'Values are already percents (0 to 100)';
      } else if (h.currency) {
        p.format = 'currency';
        p.decimals = present.some((v) => decimalsOf(v) > 0) ? 2 : 0;
      } else if (integerType) {
        p.format = 'integer';
      } else {
        p.format = 'decimal';
        p.decimals = Math.min(2, Math.max(0, ...present.map(decimalsOf)));
        p.small = maxAbs > 0 && maxAbs < 0.01;
      }
      return p;
    }
    if (p.kind === 'date' || p.kind === 'timestamp') {
      p.role = 'time';
      p.format = p.kind;
      if (p.kind === 'timestamp') {
        const ms = present.map((v) => toTime(v, 'timestamp')).filter((n) => n !== null);
        p.dateOnly = ms.length > 0 && ms.every((t) => t % DAY === 0);
        p.seconds = ms.some((t) => t % 60000 !== 0);
        if (!p.dateOnly) p.label += ' (UTC)';
      }
      return p;
    }
    if (p.kind === 'boolean') {
      p.format = 'boolean';
      p.role = 'category';
      return p;
    }
    p.role = isIdName(name) ? 'id' : 'category';
    return p;
  }

  function isRun(nums) {
    const s = nums.slice().sort((a, b) => a - b);
    for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] !== 1) return false;
    return true;
  }

  /** Header tooltip: raw name, SQL type, scale note. */
  function headerTitle(p) {
    return [p.name + (p.type ? ' (' + p.type.toLowerCase() + ')' : ''), p.note, p.role === 'id' ? 'Identifier, not charted' : null].filter(Boolean).join(' · ');
  }

  /* ---------------------------------------------------------------- formatting */

  function numberOptions(p, compact) {
    switch (p.format) {
      case 'integer':
        return compact ? { notation: 'compact', maximumSignificantDigits: 3 } : { maximumFractionDigits: 0 };
      case 'currency':
        return compact ? { style: 'currency', currency: p.currency, notation: 'compact', maximumSignificantDigits: 3 } : { style: 'currency', currency: p.currency, minimumFractionDigits: p.decimals, maximumFractionDigits: p.decimals };
      case 'percent':
        return { style: 'percent', minimumFractionDigits: compact ? 0 : p.decimals, maximumFractionDigits: compact ? Math.min(1, p.decimals) : p.decimals };
      case 'year':
      case 'id':
        return { useGrouping: false, maximumFractionDigits: 0 };
      default:
        if (p.small) return { maximumSignificantDigits: 3 };
        return compact ? { notation: 'compact', maximumSignificantDigits: 3 } : { minimumFractionDigits: p.decimals, maximumFractionDigits: p.decimals };
    }
  }

  /**
   * One value as display text, or null for a missing value (the caller shows "n/a").
   * @param {'cell'|'axis'|'kpi'} [mode] axis and kpi use compact notation from 1,000 (10,000 for kpi)
   */
  function format(v, p, mode = 'cell') {
    if (v === null || v === undefined || v === '') return null;
    const locale = p.locale || 'en-US';
    if (p.kind === 'number' || p.kind === 'year') {
      const s = String(v).trim();
      if (p.format === 'id') return s;
      // Integers beyond 2^53 keep every digit through BigInt.
      if ((p.format === 'integer' || p.format === 'year') && /^-?\d{16,}$/.test(s) && typeof BigInt === 'function') {
        try {
          return nf(locale, numberOptions(p, false)).format(BigInt(s));
        } catch (_) {
          return s;
        }
      }
      const n = toNumber(s);
      if (n === null) return s;
      const value = p.format === 'percent' && p.percentScale === 'whole' ? n / 100 : n;
      const compact = (mode === 'axis' && Math.abs(n) >= 1000) || (mode === 'kpi' && Math.abs(n) >= 10000);
      let opts = numberOptions(p, compact && p.format !== 'percent' && p.format !== 'year');
      if (mode === 'axis' && !compact && (p.format === 'currency' || p.format === 'decimal') && !p.small) {
        // Ticks are round numbers: no trailing ".00" on the axis.
        const d = Math.min(2, decimalsOf(String(Math.round(n * 100) / 100)));
        opts = Object.assign({}, opts, { minimumFractionDigits: d, maximumFractionDigits: d });
      }
      return nf(locale, opts).format(value);
    }
    if (p.kind === 'date' || p.kind === 'timestamp') {
      const ms = toTime(v, p.kind);
      if (ms === null) return String(v);
      if (p.kind === 'date' || p.dateOnly) return df(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(ms);
      return df(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: p.seconds ? '2-digit' : undefined, hourCycle: 'h23' }).format(ms);
    }
    return String(v);
  }

  /** Axis label for a measure value (compact from 1,000). */
  const axis = (n, p) => format(n, p, 'axis');

  /** Short labels for time ticks, by granularity of the data. */
  function timeTickFormatter(xs, p) {
    const locale = p.locale || 'en-US';
    if (p.kind === 'year') return (ms) => String(new Date(ms).getUTCFullYear());
    const sorted = xs.slice().sort((a, b) => a - b);
    let step = Infinity;
    for (let i = 1; i < sorted.length; i++) if (sorted[i] > sorted[i - 1]) step = Math.min(step, sorted[i] - sorted[i - 1]);
    const span = sorted.length ? sorted[sorted.length - 1] - sorted[0] : 0;
    const crossesYear = sorted.length > 1 && new Date(sorted[0]).getUTCFullYear() !== new Date(sorted[sorted.length - 1]).getUTCFullYear();
    const monthly = step >= 28 * DAY && sorted.every((t) => new Date(t).getUTCDate() === 1);
    if (monthly) return (ms) => df(locale, crossesYear || span >= 330 * DAY ? { month: 'short', year: 'numeric' } : { month: 'short' }).format(ms);
    if (step >= DAY || p.kind === 'date' || p.dateOnly) return (ms) => df(locale, crossesYear ? { month: 'short', day: 'numeric', year: '2-digit' } : { month: 'short', day: 'numeric' }).format(ms);
    if (span > DAY) return (ms) => df(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
    return (ms) => df(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  }

  /* ---------------------------------------------------------------- chart choice */

  const unitKey = (p) => (p.format === 'currency' ? 'cur:' + p.currency : p.format === 'percent' ? 'pct:' + p.percentScale : 'num');

  /** Measures that can share one y-axis: same unit and comparable magnitudes. */
  function comparable(ms) {
    if (ms.length < 2 || ms.length > LIMITS.lineSeries) return false;
    if (new Set(ms.map(unitKey)).size !== 1) return false;
    const mags = ms.map((p) => Math.max(Math.abs(p.min || 0), Math.abs(p.max || 0)));
    const lo = Math.min(...mags);
    const hi = Math.max(...mags);
    return lo > 0 && hi / lo <= LIMITS.scaleRatio;
  }

  /**
   * @param model profile() result
   * @returns {{type:'kpi'|'line'|'bar'|'scatter'|'none', reason?, ...}}
   */
  function choose(model) {
    const P = model.columns;
    const rows = model.rows;
    const n = rows.length;
    const measures = P.filter((p) => p.role === 'measure' && p.finite > 0);
    const times = P.filter((p) => p.role === 'time');
    const cats = P.filter((p) => p.role === 'category');
    const ids = P.filter((p) => p.role === 'id');
    const none = (reason) => ({ type: 'none', reason });
    if (!n || !P.length) return none('No rows to chart.');
    if (n === 1) {
      if (measures.length >= 1 && measures.length <= LIMITS.kpi) return { type: 'kpi', measures, context: P.filter((p) => !measures.includes(p)) };
      return none(measures.length ? 'More values than fit as tiles.' : 'No numeric values.');
    }
    if (!measures.length) return none('No numeric values to chart.');
    if (times.length) {
      const x = times[0];
      const dated = rows.filter((r) => toTime(r[x.index], x.kind) !== null);
      if (dated.length >= 2) {
        const stamps = dated.map((r) => toTime(r[x.index], x.kind));
        if (new Set(stamps).size === stamps.length) {
          // Rows that also carry varying labels are records of different things, not one series.
          if (cats.every((c) => c.distinct <= 1)) return { type: 'line', x, measures, together: comparable(measures), split: null };
          return none('Each row is a separate record, so the rows are shown as a table.');
        }
        const splitBy = cats.length === 1 ? cats[0] : null;
        if (splitBy) {
          const groups = new Set(dated.map((r) => r[splitBy.index]));
          const keys = new Set(dated.map((r) => toTime(r[x.index], x.kind) + '|' + r[splitBy.index]));
          if (groups.size >= 2 && groups.size <= LIMITS.splitMax && keys.size === dated.length) return { type: 'line', x, measures, together: false, split: splitBy };
        }
        return none('Dates repeat in a way that can only be shown as a table.');
      }
    }
    if (measures.length === 2 && !cats.length && !times.length && n >= LIMITS.scatterMin) {
      return { type: 'scatter', x: measures[0], y: measures[1], label: ids[0] || P.find((p) => p.kind === 'text') || null };
    }
    const labelCols = cats.length ? cats : ids.length === 1 ? ids : [];
    if (labelCols.length === 1) {
      const c = labelCols[0];
      const labels = rows.map((r) => r[c.index]);
      if (labels.every((l) => l !== null && l !== undefined) && new Set(labels).size === labels.length) return { type: 'bar', category: c, measures };
      return none('Labels repeat, so the rows can only be shown as a table.');
    }
    return none(labelCols.length > 1 ? 'Several label columns, so the rows are shown as a table.' : 'No column to chart against.');
  }

  /* ---------------------------------------------------------------- chart data */

  const SERIES = ['s1', 's2', 's3', 's4'];

  /**
   * Chart-ready data for one view of a choice.
   * @param {number} [pick] index into choice.measures when one measure shows at a time
   */
  function build(model, choice, pick = 0) {
    const rows = model.rows;
    if (choice.type === 'line') return buildLine(model, choice, pick);
    if (choice.type === 'bar') {
      const m = choice.measures[Math.max(0, Math.min(choice.measures.length - 1, pick))];
      const c = choice.category;
      const items = rows.map((r) => ({ label: String(r[c.index]), labelText: format(r[c.index], c), value: toNumber(r[m.index]), raw: r[m.index] }));
      items.sort((a, b) => (a.value === null) - (b.value === null) || (b.value || 0) - (a.value || 0));
      const shown = items.slice(0, LIMITS.barTop).map((it) => Object.assign(it, { text: it.value === null ? null : format(it.raw, m), cls: 's1' }));
      const valued = shown.filter((it) => it.value !== null);
      const hi = valued[0];
      const lo = valued[valued.length - 1];
      const missing = items.filter((it) => it.value === null).length;
      return {
        type: 'bar',
        measure: m,
        category: c,
        items: shown,
        total: items.length,
        note: items.length > LIMITS.barTop ? 'Showing top ' + LIMITS.barTop + ' of ' + items.length.toLocaleString(model.locale) : null,
        caption: m.label + ' by ' + c.label,
        summary: 'Bar chart of ' + m.label + ' by ' + c.label + ', ' + shown.length + ' of ' + items.length + ' bars, largest first.' + (hi ? ' Highest ' + hi.labelText + ' ' + hi.text + '.' : '') + (lo && lo !== hi ? ' Lowest shown ' + lo.labelText + ' ' + lo.text + '.' : '') + (missing ? ' ' + missing + ' without a value.' : ''),
        axis: (v) => axis(v, m),
      };
    }
    if (choice.type === 'scatter') {
      const { x, y, label } = choice;
      const pts = [];
      let missing = 0;
      for (const r of rows) {
        const xv = toNumber(r[x.index]);
        const yv = toNumber(r[y.index]);
        if (xv === null || yv === null) {
          missing++;
          continue;
        }
        pts.push({ x: xv, y: yv, xText: format(r[x.index], x), yText: format(r[y.index], y), label: label && r[label.index] !== null ? format(r[label.index], label) : null });
      }
      pts.sort((a, b) => a.x - b.x || a.y - b.y);
      return {
        type: 'scatter',
        xCol: x,
        yCol: y,
        labelCol: label,
        points: pts,
        missing,
        note: missing ? missing + ' row' + (missing === 1 ? '' : 's') + ' without both values not shown' : null,
        caption: y.label + ' vs ' + x.label,
        summary: 'Scatter plot of ' + y.label + ' against ' + x.label + ', ' + pts.length + ' points.' + (pts.length ? ' ' + x.label + ' from ' + format(Math.min(...pts.map((p) => p.x)), x) + ' to ' + format(Math.max(...pts.map((p) => p.x)), x) + '; ' + y.label + ' from ' + format(Math.min(...pts.map((p) => p.y)), y) + ' to ' + format(Math.max(...pts.map((p) => p.y)), y) + '.' : ''),
        xAxis: (v) => axis(v, x),
        yAxis: (v) => axis(v, y),
      };
    }
    if (choice.type === 'kpi') {
      const r = rows[0];
      return {
        type: 'kpi',
        tiles: choice.measures.map((m) => {
          const exact = format(r[m.index], m, 'cell');
          const big = format(r[m.index], m, 'kpi');
          return { label: m.label, value: big, exact: exact !== big ? exact : null, title: headerTitle(m), name: m.name };
        }),
        context: choice.context.filter((p) => r[p.index] !== null && r[p.index] !== undefined).map((p) => ({ label: p.label, value: format(r[p.index], p) })),
      };
    }
    return null;
  }

  function buildLine(model, choice, pick) {
    const x = choice.x;
    const rows = model.rows.filter((r) => toTime(r[x.index], x.kind) !== null).slice().sort((a, b) => toTime(a[x.index], x.kind) - toTime(b[x.index], x.kind));
    const xsAll = rows.map((r) => toTime(r[x.index], x.kind));
    const xs = [...new Set(xsAll)].sort((a, b) => a - b);
    const xText = (ms) => format(rows[xsAll.indexOf(ms)][x.index], x);
    let series;
    if (choice.split) {
      const m = choice.measures[Math.max(0, Math.min(choice.measures.length - 1, pick))];
      const s = choice.split;
      const keys = [];
      for (const r of rows) if (!keys.includes(r[s.index])) keys.push(r[s.index]);
      series = keys.map((k, i) => ({
        key: 'g' + i,
        name: k === null ? 'n/a' : format(k, s),
        measure: m,
        cls: SERIES[i],
        points: xs.map((ms) => {
          const r = rows.find((row) => toTime(row[x.index], x.kind) === ms && row[s.index] === k);
          const v = r ? toNumber(r[m.index]) : null;
          return { x: ms, y: v, text: v === null ? null : format(r[m.index], m) };
        }),
      }));
    } else {
      const ms = choice.together ? choice.measures : [choice.measures[Math.max(0, Math.min(choice.measures.length - 1, pick))]];
      // Series that share a currency drop it from their names; the caption says it once.
      const cur = ms.length > 1 && ms.every((m) => m.format === 'currency' && m.currency === ms[0].currency) ? ms[0].currency : null;
      series = ms.map((m, i) => ({
        key: 'm' + m.index,
        name: cur ? m.label.replace(' (' + cur + ')', '') : m.label,
        unit: cur,
        measure: m,
        cls: SERIES[i],
        points: rows.map((r, j) => {
          const v = toNumber(r[m.index]);
          return { x: xsAll[j], y: v, text: v === null ? null : format(r[m.index], m) };
        }),
      }));
    }
    const first = series[0].measure;
    const gaps = series.reduce((n, s) => n + s.points.filter((p) => p.y === null).length, 0);
    const one = series.length === 1 ? series[0] : null;
    let extremes = '';
    if (one) {
      const valued = one.points.filter((p) => p.y !== null);
      if (valued.length) {
        const hi = valued.reduce((a, b) => (b.y > a.y ? b : a));
        const lo = valued.reduce((a, b) => (b.y < a.y ? b : a));
        extremes = ' Lowest ' + lo.text + ' on ' + xText(lo.x) + '; highest ' + hi.text + ' on ' + xText(hi.x) + '.';
      }
    }
    const names = series.map((s) => s.name);
    return {
      type: 'line',
      xCol: x,
      series,
      xs,
      xText,
      tick: timeTickFormatter(xs, x),
      legend: series.length > 1,
      caption: (one ? one.name : choice.split ? first.label + ' by ' + choice.split.label : names.join(', ') + (series[0].unit ? ' (' + series[0].unit + ')' : '')) + ' by ' + x.label,
      note: gaps ? gaps + ' missing value' + (gaps === 1 ? '' : 's') + ' shown as gaps' : null,
      summary: 'Line chart of ' + (choice.split ? first.label + ' for ' + names.join(', ') : names.join(', ')) + ' by ' + x.label + ', ' + xs.length + ' points from ' + xText(xs[0]) + ' to ' + xText(xs[xs.length - 1]) + '.' + extremes + (gaps ? ' ' + gaps + ' missing, shown as gaps.' : ''),
      axis: (v) => axis(v, first),
    };
  }

  /* ---------------------------------------------------------------- copy + export */

  /** Spreadsheet-safe text cell: formula-looking text gets a leading quote (same rule as csv.js). */
  function safeText(s) {
    const t = String(s).replace(/[\t\r\n]+/g, ' ');
    return csv.FORMULA_START.test(t) ? "'" + t : t;
  }

  /** Raw values with raw column names, tab separated (numbers stay numbers, null → empty). */
  function toTsv(model) {
    const P = model.columns;
    const lines = [P.map((p) => safeText(p.name)).join('\t')];
    for (const r of model.rows) {
      lines.push(
        P.map((p) => {
          const v = r[p.index];
          if (v === null || v === undefined) return '';
          if (p.numeric && NUM_RE.test(String(v).trim())) return String(v).trim();
          return safeText(v);
        }).join('\t')
      );
    }
    return lines.join('\n');
  }

  /** RFC 4180 CSV through explorer/csv.js (formula-prefix neutralization, quoting, CRLF). */
  function toCsv(model) {
    const P = model.columns;
    return csv.toCsv({
      columns: P.map((p) => ({
        key: p.index,
        label: p.name,
        value: (row) => {
          const v = row[p.index];
          if (v === null || v === undefined) return null;
          const s = String(v).trim();
          // Numbers that fit a double stay unquoted numbers; longer integers stay exact as text.
          if (p.numeric && NUM_RE.test(s) && !/^-?\d{16,}$/.test(s)) return Number(s);
          return String(v);
        },
      })),
      rows: model.rows,
    });
  }

  const api = Object.freeze({ LIMITS, SERIES, humanize, isIdName, toNumber, toTime, profile, headerTitle, format, axis, timeTickFormatter, choose, comparable, build, toTsv, toCsv, safeLocale });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).genieViz = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
