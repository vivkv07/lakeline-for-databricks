/*
 * Cost Explorer model: pure functions over summary rows and loaded entity/run results.
 * No DOM, no network. Missing data stays null (never 0): a date with no rows is "unavailable",
 * a day with some unpriced records is "partial" (priced subtotal), a day with only unpriced
 * records is "unpriced".
 *
 * Heuristic flags (spec §11) are explanatory heuristics, not anomaly detection or causes:
 *   - daily positive spike: ≥14 priced prior-period days and recent observed billing; samples are
 *     same-weekday prior days if ≥3, else all prior days; flag cost > MAX(median×1.5, median+3×MAD)
 *   - high-cost runs: ≥8 priced, completed runs with positive duration in the same job; flag
 *     cost > Q3 + 1.5×IQR (quartiles by linear interpolation between closest ranks)
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const V = dep('validate', '../core/validate.js');
  const ids = dep('ids', '../core/ids.js');
  const periods = dep('periods', '../core/periods.js');

  const OWNER_TYPES = Object.freeze(['job', 'pipeline', 'warehouse', 'notebook', 'app', 'cluster', 'unattributed']);
  const OWNER_LABELS = Object.freeze({ job: 'Job', pipeline: 'Pipeline', warehouse: 'SQL warehouse', notebook: 'Notebook', app: 'App', cluster: 'Cluster', unattributed: 'Unattributed' });
  // Categorical palette in fixed slot order. Slot 1 is the theme's accent blue; slots 2–8 are
  // shared by both themes. Validated per theme (white / black surface): every color ≥ 3:1 against
  // the surface, adjacent pairs ΔE ≥ 10 under protan/deutan simulation and ≥ 15 for normal vision.
  // No amber: warm amber is reserved for prior-period overlays and partial coverage. Colors
  // follow the entity, never its rank; extra keys fold into "Other".
  const SHARED_SLOTS = ['#D6407F', '#1A91B8', '#D9473B', '#109689', '#B04BC6', '#3C9A3C', '#8B6CEB'];
  const PALETTE = Object.freeze(['#2F5BEA'].concat(SHARED_SLOTS));
  const PALETTE_DARK = Object.freeze(['#5B8CFF'].concat(SHARED_SLOTS));
  const OTHER_COLOR = '#8A8A93';
  const OTHER_KEY = '__other__';
  const SPIKE_MIN_HISTORY = 14;
  const SPIKE_MIN_SAME_WEEKDAY = 3;
  const FRESHNESS_MAX_AGE_MS = 48 * 3600 * 1000;
  const RUN_COHORT_MIN = 8;

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  /* ------------------------------------------------------------------ statistics */

  function median(values) {
    const a = values.filter(isNum).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /** Median absolute deviation (unscaled). */
  function mad(values) {
    const m = median(values);
    if (m === null) return null;
    return median(values.filter(isNum).map((v) => Math.abs(v - m)));
  }

  /** Quantile by linear interpolation between closest ranks (Hyndman–Fan type 7). */
  function quantile(values, p) {
    const a = values.filter(isNum).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const h = (a.length - 1) * p;
    const lo = Math.floor(h);
    const hi = Math.ceil(h);
    return a[lo] + (h - lo) * (a[hi] - a[lo]);
  }

  /* ------------------------------------------------------------------ normalization */

  function modeOf(summary, settingsMode) {
    if (summary && (summary.synthetic || summary.pricingBasis === 'demo')) return 'demo';
    if (summary && (summary.imported || summary.pricingBasis === 'import')) return 'import';
    return settingsMode === 'demo' || settingsMode === 'import' ? settingsMode : 'connected';
  }

  function periodOf(summary, periodDays, nowMs) {
    const p = summary && summary.period;
    if (p && /^\d{4}-\d{2}-\d{2}$/.test(p.start) && /^\d{4}-\d{2}-\d{2}$/.test(p.endExclusive) && V.isPeriodDays(p.days)) {
      return {
        days: p.days,
        start: p.start,
        endExclusive: p.endExclusive,
        prevStart: p.prevStart || periods.addDays(p.start, -p.days),
        prevEndExclusive: p.prevEndExclusive || p.start,
        today: p.today || p.endExclusive,
      };
    }
    return periods.completePeriod(V.isPeriodDays(periodDays) ? periodDays : 30, nowMs);
  }

  /**
   * Normalize a banner summary (or an exploreSummary result) into model rows. The period of
   * each row is re-derived from its date so imported rows outside the window are dropped.
   */
  function normalize(summary, opts = {}) {
    const nowMs = isNum(opts.nowMs) ? opts.nowMs : Date.now();
    const period = periodOf(summary, opts.periodDays, nowMs);
    const mode = modeOf(summary, opts.mode);
    const rows = [];
    for (const r of (summary && summary.daily) || []) {
      if (!r || typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
      let p = null;
      if (r.date >= period.start && r.date < period.endExclusive) p = 'cur';
      else if (r.date >= period.prevStart && r.date < period.prevEndExclusive) p = 'prev';
      if (!p) continue;
      if (mode === 'import' && summary.coverageEnd && r.date > summary.coverageEnd) continue;
      const unpriced = isNum(r.unpricedRecords) ? r.unpricedRecords : r.complete === false && r.cost !== null ? 1 : 0;
      rows.push({
        period: p,
        date: r.date,
        product: V.safeText(r.product || 'UNKNOWN', 120),
        sku: V.safeText(r.sku || 'UNKNOWN', 200),
        owner: OWNER_TYPES.includes(r.owner) ? r.owner : null,
        unit: r.unit ? V.safeText(r.unit, 40) : null,
        cost: isNum(r.cost) ? r.cost : null,
        unpricedRecords: unpriced,
        // A null cost with no unpriced records is unknown (e.g. an imported day without a value).
        known: isNum(r.cost) || unpriced > 0,
      });
    }
    return {
      mode,
      period,
      currency: (summary && V.isCurrency(summary.currency) && summary.currency) || 'USD',
      pricingBasis: mode === 'demo' ? 'demo' : mode === 'import' ? 'import' : (summary && summary.pricingBasis) || null,
      priceTable: (summary && summary.priceTable) || null,
      latestUsageMs: summary && isNum(summary.latestUsageMs) ? summary.latestUsageMs : null,
      coverageEnd: (summary && summary.coverageEnd) || null,
      hasOwner: rows.some((r) => r.owner),
      hasPrior: rows.some((r) => r.period === 'prev'),
      dates: periods.enumerateDates(period.start, period.endExclusive),
      prevDates: periods.enumerateDates(period.prevStart, period.prevEndExclusive),
      rows,
      nowMs,
    };
  }

  /* ------------------------------------------------------------------ filters and aggregation */

  function matches(row, filters) {
    if (!filters) return true;
    if (filters.product && row.product !== filters.product) return false;
    if (filters.sku && row.sku !== filters.sku) return false;
    if (filters.owner && row.owner !== filters.owner) return false;
    return true;
  }

  function filterRows(rows, filters) {
    return rows.filter((r) => matches(r, filters));
  }

  /** Aggregate rows into {cost|null, status, unpricedRecords, rows}. */
  function aggregate(rows) {
    let sum = 0;
    let priced = false;
    let unpriced = 0;
    let known = false;
    for (const r of rows) {
      if (!r.known) continue;
      known = true;
      if (r.cost !== null) {
        sum += r.cost;
        priced = true;
      }
      unpriced += r.unpricedRecords || 0;
    }
    let status;
    if (!known) status = 'unavailable';
    else if (unpriced === 0) status = 'complete';
    else if (priced) status = 'partial';
    else status = 'unpriced';
    return { cost: priced ? sum : null, status, unpricedRecords: unpriced };
  }

  function indexByDate(rows) {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.date)) m.set(r.date, []);
      m.get(r.date).push(r);
    }
    return m;
  }

  function change(cur, prev) {
    if (!isNum(cur) || !isNum(prev)) return null;
    return { abs: cur - prev, pct: prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100 };
  }

  function dimensionOf(row, dimension) {
    if (dimension === 'owner') return row.owner || 'unattributed';
    if (dimension === 'sku') return row.sku;
    return row.product;
  }

  /**
   * Day-level series for the selected period with aligned prior-period values.
   * @returns {{days:[{date, priorDate, cost, status, unpricedRecords, prior:{cost,status}, change, byKey:Map}]}}
   */
  function dailySeries(model, filters, dimension = 'product') {
    const rows = filterRows(model.rows, filters);
    const byDate = indexByDate(rows);
    return model.dates.map((date) => {
      const dayRows = byDate.get(date) || [];
      const agg = aggregate(dayRows);
      const priorDate = periods.alignedPriorDate(date, model.period);
      const prior = model.hasPrior ? aggregate(byDate.get(priorDate) || []) : { cost: null, status: 'unavailable', unpricedRecords: 0 };
      const byKey = new Map();
      for (const r of dayRows) {
        const k = dimensionOf(r, dimension);
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(r);
      }
      const segments = new Map();
      for (const [k, list] of byKey) segments.set(k, aggregate(list));
      return {
        date,
        weekday: periods.mondayIndex(date),
        priorDate,
        cost: agg.cost,
        status: agg.status,
        unpricedRecords: agg.unpricedRecords,
        prior,
        change: change(agg.cost, prior.cost),
        segments,
      };
    });
  }

  /** Same as dailySeries for the prior-period dates (used by heuristics). */
  function priorDailySeries(model, filters) {
    const byDate = indexByDate(filterRows(model.rows, filters));
    return model.prevDates.map((date) => Object.assign({ date, weekday: periods.mondayIndex(date) }, aggregate(byDate.get(date) || [])));
  }

  /** Totals for the selected and prior period, plus share validity, for the current filters. */
  function periodTotals(model, filters) {
    const rows = filterRows(model.rows, filters);
    const cur = aggregate(rows.filter((r) => r.period === 'cur'));
    const prev = model.hasPrior ? aggregate(rows.filter((r) => r.period === 'prev')) : { cost: null, status: 'unavailable', unpricedRecords: 0 };
    const knownDates = new Set(rows.filter((r) => r.known && r.period === 'cur').map((r) => r.date));
    const missingDates = model.dates.filter((d) => !knownDates.has(d)).length;
    return { current: cur, previous: prev, change: change(cur.cost, prev.cost), missingDates, share: shareValidity(cur) };
  }

  /**
   * Shares are valid only for a complete, positive total. With unpriced records the total is a
   * priced subtotal and shares of it would mislead.
   */
  function shareValidity(total) {
    if (!total || total.status === 'unavailable' || total.cost === null) return { valid: false, reason: 'No priced total for this scope, so shares are not shown.' };
    if (total.status !== 'complete') return { valid: false, reason: 'Some usage in this scope has no matching price. The total is a priced subtotal, so shares of it would be misleading and are not shown.' };
    if (!(total.cost > 0)) return { valid: false, reason: 'The total for this scope is not positive (signed corrections), so shares are not meaningful.' };
    return { valid: true, total: total.cost };
  }

  function shareOf(cost, validity) {
    if (!validity || !validity.valid || !isNum(cost)) return null;
    return cost / validity.total;
  }

  /**
   * Group totals by a dimension (product | sku | owner) for current vs prior period. Keys that
   * appear only in the prior period are kept with current status 'no-usage'.
   */
  function groupTotals(model, dimension, filters) {
    const rows = filterRows(model.rows, filters);
    const groups = new Map();
    for (const r of rows) {
      const k = dimensionOf(r, dimension);
      if (!groups.has(k)) groups.set(k, { cur: [], prev: [], product: r.product, unit: r.unit });
      groups.get(k)[r.period].push(r);
    }
    const total = aggregate(rows.filter((r) => r.period === 'cur'));
    const validity = shareValidity(total);
    const out = [];
    for (const [key, g] of groups) {
      const cur = g.cur.length ? aggregate(g.cur) : { cost: null, status: 'no-usage', unpricedRecords: 0 };
      const prev = !model.hasPrior ? { cost: null, status: 'unavailable', unpricedRecords: 0 } : g.prev.length ? aggregate(g.prev) : { cost: null, status: 'no-usage', unpricedRecords: 0 };
      out.push({
        key,
        name: dimension === 'owner' ? OWNER_LABELS[key] || key : key,
        product: g.product,
        unit: g.unit,
        cost: cur.cost,
        status: cur.status,
        unpricedRecords: cur.unpricedRecords,
        prevCost: prev.cost,
        prevStatus: prev.status,
        change: change(cur.cost, prev.cost),
        share: shareOf(cur.cost, validity),
      });
    }
    return { items: out, total, validity };
  }

  /** Breakdown of one day vs its aligned prior day. */
  function dayDetail(model, date, filters, dimension = 'product') {
    const priorDate = periods.alignedPriorDate(date, model.period);
    const rows = filterRows(model.rows, filters);
    const day = rows.filter((r) => r.date === date);
    const prior = rows.filter((r) => r.date === priorDate);
    const keys = new Set([...day, ...prior].map((r) => dimensionOf(r, dimension)));
    const dayAgg = aggregate(day);
    const validity = shareValidity(dayAgg);
    const items = [...keys].map((k) => {
      const a = aggregate(day.filter((r) => dimensionOf(r, dimension) === k));
      const b = model.hasPrior ? aggregate(prior.filter((r) => dimensionOf(r, dimension) === k)) : { cost: null, status: 'unavailable' };
      return { key: k, name: dimension === 'owner' ? OWNER_LABELS[k] || k : k, cost: a.cost, status: a.status, prevCost: b.cost, prevStatus: b.status, change: change(a.cost, b.cost), share: shareOf(a.cost, validity) };
    });
    const priorAgg = model.hasPrior ? aggregate(prior) : { cost: null, status: 'unavailable', unpricedRecords: 0 };
    return { date, priorDate, weekday: periods.mondayIndex(date), current: dayAgg, prior: priorAgg, change: change(dayAgg.cost, priorAgg.cost), validity, items };
  }

  /* ------------------------------------------------------------------ search and sort */

  function search(items, query, fields) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return items.slice();
    return items.filter((it) => fields.some((f) => {
      const v = typeof f === 'function' ? f(it) : it[f];
      return v !== null && v !== undefined && String(v).toLowerCase().includes(q);
    }));
  }

  /**
   * Sort by cost | change | name, asc | desc. Missing values always sort last, whatever the
   * direction; ties fall back to name ascending for a stable order.
   */
  function sortItems(items, sort, acc = {}) {
    const key = sort && sort.key ? sort.key : 'cost';
    const dir = sort && sort.dir === 'asc' ? 1 : -1;
    const nameOf = acc.name || ((it) => it.name || it.key || '');
    const valueOf = acc[key] || (key === 'change' ? (it) => (it.change ? it.change.abs : null) : key === 'name' ? nameOf : (it) => it.cost);
    return items.slice().sort((a, b) => {
      const va = valueOf(a);
      const vb = valueOf(b);
      const ma = va === null || va === undefined || (typeof va === 'number' && !Number.isFinite(va));
      const mb = vb === null || vb === undefined || (typeof vb === 'number' && !Number.isFinite(vb));
      if (ma !== mb) return ma ? 1 : -1;
      let c = 0;
      if (!ma) c = typeof va === 'string' || typeof vb === 'string' ? String(va).localeCompare(String(vb)) : va - vb;
      if (c !== 0) return c * dir;
      return String(nameOf(a)).localeCompare(String(nameOf(b)));
    });
  }

  /* ------------------------------------------------------------------ colors */

  /**
   * Stable colors: keys sorted by name take palette slots in fixed order. With more keys than
   * slots, the smallest (by `weights`) fold into "Other".
   */
  function paletteFor(theme) {
    return theme === 'dark' ? PALETTE_DARK : PALETTE;
  }

  function colorMap(keys, weights = new Map(), fixedOrder = null, palette = PALETTE) {
    let ordered = [...new Set(keys)];
    if (fixedOrder) ordered.sort((a, b) => fixedOrder.indexOf(a) - fixedOrder.indexOf(b));
    else ordered.sort();
    const map = new Map();
    let folded = [];
    if (ordered.length > palette.length) {
      const keep = new Set(ordered.slice().sort((a, b) => (weights.get(b) || 0) - (weights.get(a) || 0)).slice(0, palette.length - 1));
      folded = ordered.filter((k) => !keep.has(k));
      ordered = ordered.filter((k) => keep.has(k));
    }
    ordered.forEach((k, i) => map.set(k, palette[i]));
    for (const k of folded) map.set(k, OTHER_COLOR);
    return { map, folded, colorOf: (k) => map.get(k) || OTHER_COLOR, groupOf: (k) => (folded.includes(k) ? OTHER_KEY : k) };
  }

  /* ------------------------------------------------------------------ calendar */

  /**
   * Monday-first UTC calendar weeks covering the period. Cells outside the period are
   * placeholders; in-period dates without data are 'unavailable' (never zero).
   */
  function calendar(model, series) {
    const byDate = new Map(series.map((d) => [d.date, d]));
    const first = model.period.start;
    const last = periods.addDays(model.period.endExclusive, -1);
    const gridStart = periods.addDays(first, -periods.mondayIndex(first));
    const gridEnd = periods.addDays(last, 6 - periods.mondayIndex(last));
    const weeks = [];
    let week = [];
    for (let d = gridStart; d <= gridEnd; d = periods.addDays(d, 1)) {
      const inPeriod = d >= first && d <= last;
      const s = inPeriod ? byDate.get(d) : null;
      week.push(inPeriod ? { date: d, inPeriod, cost: s ? s.cost : null, status: s ? s.status : 'unavailable', day: s || null } : { date: d, inPeriod: false });
      if (week.length === 7) {
        weeks.push(week);
        week = [];
      }
    }
    const values = series.filter((d) => isNum(d.cost)).map((d) => d.cost);
    return { weeks, min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null, weekdayLabels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] };
  }

  /** Intensity bucket 0..steps for a heatmap value (0 = non-positive). */
  function intensity(value, max, steps = 5) {
    if (!isNum(value) || !isNum(max) || max <= 0 || value <= 0) return 0;
    return Math.max(1, Math.min(steps, Math.ceil((value / max) * steps)));
  }

  /* ------------------------------------------------------------------ heuristics */

  /**
   * Daily positive spike heuristic.
   * @param {object[]} curDays  dailySeries() output
   * @param {object[]} prevDays priorDailySeries() output
   * @param {{latestUsageMs, nowMs}} o
   * @returns {{status:'ok'|'suppressed', reason?, detail?, flags: Map<date, info>, evaluated}}
   */
  function spikeFlags(curDays, prevDays, o = {}) {
    const flags = new Map();
    const priced = prevDays.filter((d) => d.status === 'complete' && isNum(d.cost));
    if (priced.length < SPIKE_MIN_HISTORY) {
      return { status: 'suppressed', reason: 'history', detail: 'Spike flags need at least ' + SPIKE_MIN_HISTORY + ' fully priced days in the comparison period; this scope has ' + priced.length + '.', flags, evaluated: 0 };
    }
    const nowMs = isNum(o.nowMs) ? o.nowMs : Date.now();
    if (!isNum(o.latestUsageMs) || nowMs - o.latestUsageMs > FRESHNESS_MAX_AGE_MS) {
      return { status: 'suppressed', reason: 'freshness', detail: 'Spike flags are suppressed because no billing was observed in the last 48 hours; recent days may still be incomplete.', flags, evaluated: 0 };
    }
    let evaluated = 0;
    for (const d of curDays) {
      if (d.status !== 'complete' || !isNum(d.cost) || d.cost <= 0) continue;
      evaluated++;
      const same = priced.filter((p) => p.weekday === d.weekday);
      const useSame = same.length >= SPIKE_MIN_SAME_WEEKDAY;
      const samples = (useSame ? same : priced).map((p) => p.cost);
      const med = median(samples);
      const dev = mad(samples);
      const threshold = Math.max(med * 1.5, med + 3 * dev);
      if (d.cost > threshold) flags.set(d.date, { date: d.date, cost: d.cost, threshold, median: med, mad: dev, samples: samples.length, sampleKind: useSame ? 'same-weekday' : 'all-prior' });
    }
    return { status: 'ok', flags, evaluated };
  }

  /**
   * High-cost run heuristic per job cohort.
   * @param {object[]} runs exploreRuns items
   * @returns {{flags: Map<key, info>, cohorts: Map<jobId, {status, eligible, reason?, q1?, q3?, fence?}>}}
   */
  function highCostRuns(runs) {
    const byJob = new Map();
    for (const r of runs) {
      if (!byJob.has(r.jobId)) byJob.set(r.jobId, []);
      byJob.get(r.jobId).push(r);
    }
    const flags = new Map();
    const cohorts = new Map();
    for (const [jobId, list] of byJob) {
      const eligible = list.filter((r) => r.status === 'ok' && isNum(r.amount) && r.durationStatus === 'ok' && isNum(r.durationMs) && r.durationMs > 0);
      if (list.some((r) => r.cohortComplete === false)) {
        cohorts.set(jobId, { status: 'suppressed', eligible: eligible.length, reason: 'Only the highest-cost runs of this job were returned, so its cohort is incomplete.' });
        continue;
      }
      if (eligible.length < RUN_COHORT_MIN) {
        cohorts.set(jobId, { status: 'suppressed', eligible: eligible.length, reason: 'Needs at least ' + RUN_COHORT_MIN + ' priced, completed runs with a positive duration; found ' + eligible.length + '.' });
        continue;
      }
      const costs = eligible.map((r) => r.amount);
      const q1 = quantile(costs, 0.25);
      const q3 = quantile(costs, 0.75);
      const fence = q3 + 1.5 * (q3 - q1);
      cohorts.set(jobId, { status: 'ok', eligible: eligible.length, q1, q3, fence });
      for (const r of eligible) if (r.amount > fence) flags.set(r.key, { key: r.key, jobId, amount: r.amount, fence, q1, q3, n: eligible.length });
    }
    return { flags, cohorts };
  }

  /* ------------------------------------------------------------------ native links */

  // Canonical native routes recognized by ids.parseResourceLink. A link is produced only when
  // the built href parses back to the same identity for this origin and workspace.
  const ROUTES = Object.freeze({
    job: (r) => '/jobs/' + r.jobId,
    job_run: (r) => '/jobs/' + r.jobId + '/runs/' + r.runId,
    pipeline: (r) => '/pipelines/' + r.pipelineId,
    warehouse: (r) => '/sql/warehouses/' + r.warehouseId,
    notebook: (r) => '/editor/notebooks/' + r.notebookId,
    app: (r) => '/apps/' + r.appName,
  });

  function nativeHref(ref, origin, workspaceId) {
    const clean = ids.sanitizeRef(ref);
    if (!clean || !ROUTES[clean.type]) return null;
    const cls = ids.classifyOrigin(origin);
    if (!cls.ok || cls.origin !== origin || !V.isWorkspaceId(workspaceId)) return null;
    const href = origin + ROUTES[clean.type](clean) + '?o=' + workspaceId;
    const parsed = ids.parseResourceLink(href, origin, workspaceId);
    if (!parsed || ids.refKey(parsed) !== ids.refKey(clean) || parsed.workspaceId !== workspaceId) return null;
    return href;
  }

  /** Resource reference for an entity, or null when no validated native route exists. */
  function entityRef(item) {
    if (!item || item.id === null || item.id === undefined) return null;
    switch (item.ownerType) {
      case 'job': return { type: 'job', jobId: item.id };
      case 'pipeline': return { type: 'pipeline', pipelineId: item.id };
      case 'warehouse': return { type: 'warehouse', warehouseId: item.id };
      case 'notebook': return { type: 'notebook', notebookId: item.id };
      // The app route uses the app name; an app ID alone is never turned into a route.
      case 'app': return V.isAppName(item.name) ? { type: 'app', appName: item.name } : null;
      default: return null;
    }
  }

  function runRef(run) {
    return run ? { type: 'job_run', jobId: run.jobId, runId: run.runId } : null;
  }

  function entityLabel(item) {
    if (!item) return '';
    if (item.ownerType === 'unattributed') return 'Unattributed usage';
    return item.name || OWNER_LABELS[item.ownerType] + ' ' + item.id;
  }

  const api = Object.freeze({
    OWNER_TYPES,
    OWNER_LABELS,
    PALETTE,
    PALETTE_DARK,
    paletteFor,
    OTHER_COLOR,
    OTHER_KEY,
    SPIKE_MIN_HISTORY,
    RUN_COHORT_MIN,
    FRESHNESS_MAX_AGE_MS,
    median,
    mad,
    quantile,
    modeOf,
    periodOf,
    normalize,
    filterRows,
    aggregate,
    change,
    dailySeries,
    priorDailySeries,
    periodTotals,
    shareValidity,
    shareOf,
    groupTotals,
    dayDetail,
    search,
    sortItems,
    colorMap,
    calendar,
    intensity,
    spikeFlags,
    highCostRuns,
    nativeHref,
    entityRef,
    runRef,
    entityLabel,
  });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).exploreModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
