/*
 * Cost Explorer query kinds. Every billing record has exactly ONE owner, chosen by priority:
 *   job → pipeline → warehouse → notebook → app → cluster → unattributed
 * so Explorer totals never double count. Native badges may attribute more broadly (a job badge
 * can include the pipelines that job triggered); Explorer amounts are a different breakdown and
 * are never added to badge amounts or the other way round.
 *
 *   exploreSummary  — daily × product × SKU × owner type, selected + prior period (≤ 20,000 rows)
 *   exploreEntities — owners ranked by selected-period cost with prior-period amounts;
 *                     LIMIT 200 plus the full candidate count
 *   exploreRuns     — per job run cost inside the selected period (not lifetime run cost) plus
 *                     optional durations from system.lakeflow.job_run_timeline; if that read
 *                     fails, costs are kept and durations are reported unavailable (never 0)
 *
 * Registered as DCC.queries.explore = { kinds: {...} } (the one exception to one-kind-per-file).
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const V = dep('validate', '../../core/validate.js');
  const periods = dep('periods', '../../core/periods.js');
  const pricing = dep('pricing', '../pricing.js');

  const OWNER_TYPES = Object.freeze(['job', 'pipeline', 'warehouse', 'notebook', 'app', 'cluster', 'unattributed']);
  const SUMMARY_MAX_ROWS = 20000;
  const ENTITY_LIMIT = 200;
  const RUN_LIMIT = 500;
  const DURATION_LOOKBACK_DAYS = 30;
  const RUN_TIMELINE = 'system.lakeflow.job_run_timeline';

  /** Exclusive owner type for alias `a` (priority order above; the CASE order IS the priority). */
  function ownerTypeSql(a) {
    const m = a + '.usage_metadata.';
    return `CASE WHEN ${m}job_id IS NOT NULL THEN 'job'
              WHEN ${m}dlt_pipeline_id IS NOT NULL THEN 'pipeline'
              WHEN ${m}warehouse_id IS NOT NULL THEN 'warehouse'
              WHEN ${m}notebook_id IS NOT NULL THEN 'notebook'
              WHEN ${m}app_id IS NOT NULL OR ${m}app_name IS NOT NULL THEN 'app'
              WHEN ${m}cluster_id IS NOT NULL THEN 'cluster'
              ELSE 'unattributed' END`;
  }

  function ownerIdSql(a) {
    const m = a + '.usage_metadata.';
    return `CASE WHEN ${m}job_id IS NOT NULL THEN ${m}job_id
              WHEN ${m}dlt_pipeline_id IS NOT NULL THEN ${m}dlt_pipeline_id
              WHEN ${m}warehouse_id IS NOT NULL THEN ${m}warehouse_id
              WHEN ${m}notebook_id IS NOT NULL THEN ${m}notebook_id
              WHEN ${m}app_id IS NOT NULL OR ${m}app_name IS NOT NULL THEN COALESCE(${m}app_id, ${m}app_name)
              WHEN ${m}cluster_id IS NOT NULL THEN ${m}cluster_id
              END`;
  }

  /** Display name recorded in billing metadata for the SAME owner the type CASE picked. */
  function ownerNameSql(a) {
    const m = a + '.usage_metadata.';
    return `CASE WHEN ${m}job_id IS NOT NULL THEN ${m}job_name
              WHEN ${m}dlt_pipeline_id IS NOT NULL THEN NULL
              WHEN ${m}warehouse_id IS NOT NULL THEN NULL
              WHEN ${m}notebook_id IS NOT NULL THEN ${m}notebook_path
              WHEN ${m}app_id IS NOT NULL OR ${m}app_name IS NOT NULL THEN ${m}app_name
              END`;
  }

  function checkPeriod(args) {
    const periodDays = args && args.periodDays;
    if (!V.isPeriodDays(periodDays)) throw new Error('Unsupported period');
    return periodDays;
  }

  function cteFor(conn, startDate, endDate, extraWhere) {
    return pricing.pricedUsageCte({
      priceTable: conn.priceTable,
      usageSource: conn.usageSource,
      currency: conn.currency,
      workspaceId: conn.workspaceId,
      startDate,
      endDate,
      extraWhere,
    });
  }

  function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  function freshness(latestMs, nowMs) {
    return { latestUsageMs: num(latestMs), observedAtMs: nowMs };
  }

  function coverageOf(priced, unpriced) {
    if (priced + unpriced === 0) return 'empty';
    if (unpriced === 0) return 'complete';
    if (priced === 0) return 'none';
    return 'partial';
  }

  /* ================================================================ exploreSummary */

  const exploreSummary = Object.freeze({
    MAX_ROWS: SUMMARY_MAX_ROWS,
    build(conn, args, nowMs = Date.now()) {
      const periodDays = checkPeriod(args);
      const period = periods.completePeriod(periodDays, nowMs);
      const { cte, params } = cteFor(conn, period.prevStart, period.endExclusive);
      const statement = `WITH ${cte},
owned AS (
  SELECT pu.usage_date, pu.billing_origin_product, pu.sku_name, pu.usage_unit, pu.is_priced, pu.cost,
         pu.price_matches, pu.usage_quantity, pu.usage_end_time,
         ${ownerTypeSql('pu')} AS owner_type
  FROM priced_usage pu
)
SELECT CASE WHEN usage_date >= :cur_start THEN 'cur' ELSE 'prev' END AS period,
       CAST(usage_date AS STRING) AS usage_date,
       COALESCE(billing_origin_product, 'UNKNOWN') AS product,
       sku_name,
       usage_unit,
       owner_type,
       SUM(CASE WHEN is_priced THEN cost END) AS priced_cost,
       SUM(CASE WHEN is_priced THEN 1 ELSE 0 END) AS priced_records,
       SUM(CASE WHEN is_priced THEN 0 ELSE 1 END) AS unpriced_records,
       SUM(CASE WHEN is_priced THEN 0 WHEN price_matches > 1 THEN 1 ELSE 0 END) AS ambiguous_records,
       SUM(CAST(usage_quantity AS DOUBLE)) AS quantity,
       unix_millis(MAX(usage_end_time)) AS latest_usage_ms
FROM owned
GROUP BY 1, 2, 3, 4, 5, 6
ORDER BY 2, 3, 4, 6`;
      params.push(pricing.param('cur_start', period.start, 'DATE'));
      return {
        kind: 'exploreSummary',
        statement,
        parameters: params,
        rowLimit: SUMMARY_MAX_ROWS + 1,
        maxRows: SUMMARY_MAX_ROWS,
        period,
        nowMs,
        provenance: pricing.provenance(conn.priceTable, conn.currency),
      };
    },
    parse(rows, query) {
      if (rows.length > SUMMARY_MAX_ROWS) throw new Error('Explorer summary exceeds ' + SUMMARY_MAX_ROWS + ' rows');
      const tot = { cur: { p: 0, u: 0 }, prev: { p: 0, u: 0 } };
      let latest = null;
      const daily = rows.map((r) => {
        const t = tot[r.period === 'cur' ? 'cur' : 'prev'];
        t.p += r.priced_records || 0;
        t.u += r.unpriced_records || 0;
        if (Number.isFinite(r.latest_usage_ms) && (latest === null || r.latest_usage_ms > latest)) latest = r.latest_usage_ms;
        return {
          period: r.period === 'cur' ? 'cur' : 'prev',
          date: r.usage_date,
          product: r.product,
          sku: r.sku_name,
          unit: r.usage_unit,
          owner: OWNER_TYPES.includes(r.owner_type) ? r.owner_type : 'unattributed',
          cost: r.priced_records > 0 ? num(r.priced_cost) : null,
          complete: !r.unpriced_records,
          unpricedRecords: r.unpriced_records || 0,
          quantity: num(r.quantity),
        };
      });
      return Object.assign({}, query.provenance, {
        kind: 'exploreSummary',
        period: query.period,
        coverage: { current: coverageOf(tot.cur.p, tot.cur.u), previous: coverageOf(tot.prev.p, tot.prev.u) },
        daily,
        latestUsageMs: latest,
        freshness: freshness(latest, query.nowMs),
        rowCount: rows.length,
        maxRows: SUMMARY_MAX_ROWS,
      });
    },
  });

  /* ================================================================ exploreEntities */

  const exploreEntities = Object.freeze({
    LIMIT: ENTITY_LIMIT,
    build(conn, args, nowMs = Date.now()) {
      const periodDays = checkPeriod(args);
      const period = periods.completePeriod(periodDays, nowMs);
      const { cte, params } = cteFor(conn, period.prevStart, period.endExclusive);
      // Window aggregates are computed before LIMIT, so candidate_count and the all_* totals
      // describe every candidate, not only the returned top 200.
      const statement = `WITH ${cte},
owned AS (
  SELECT CASE WHEN pu.usage_date >= :cur_start THEN 'cur' ELSE 'prev' END AS period,
         ${ownerTypeSql('pu')} AS owner_type,
         ${ownerIdSql('pu')} AS owner_id,
         ${ownerNameSql('pu')} AS owner_name,
         pu.usage_date, pu.is_priced, pu.cost, pu.usage_end_time
  FROM priced_usage pu
),
named AS (
  SELECT owner_type, owner_id, owner_name,
         ROW_NUMBER() OVER (PARTITION BY owner_type, owner_id ORDER BY usage_end_time DESC, owner_name) AS rn
  FROM owned
  WHERE owner_name IS NOT NULL AND owner_id IS NOT NULL
),
ent AS (
  SELECT owner_type, owner_id,
         SUM(CASE WHEN period = 'cur' AND is_priced THEN cost END) AS cur_cost,
         SUM(CASE WHEN period = 'cur' AND is_priced THEN 1 ELSE 0 END) AS cur_priced,
         SUM(CASE WHEN period = 'cur' AND NOT is_priced THEN 1 ELSE 0 END) AS cur_unpriced,
         SUM(CASE WHEN period = 'prev' AND is_priced THEN cost END) AS prev_cost,
         SUM(CASE WHEN period = 'prev' AND is_priced THEN 1 ELSE 0 END) AS prev_priced,
         SUM(CASE WHEN period = 'prev' AND NOT is_priced THEN 1 ELSE 0 END) AS prev_unpriced,
         COUNT(DISTINCT CASE WHEN period = 'cur' THEN usage_date END) AS active_days,
         unix_millis(MAX(usage_end_time)) AS latest_usage_ms
  FROM owned
  GROUP BY owner_type, owner_id
),
ranked AS (
  SELECT e.*,
         COUNT(*) OVER () AS candidate_count,
         SUM(e.cur_cost) OVER () AS all_cur_cost,
         SUM(e.cur_priced) OVER () AS all_cur_priced,
         SUM(e.cur_unpriced) OVER () AS all_cur_unpriced,
         MAX(e.latest_usage_ms) OVER () AS all_latest_ms
  FROM ent e
  WHERE e.cur_priced + e.cur_unpriced > 0
)
SELECT r.owner_type, r.owner_id, n.owner_name, r.cur_cost, r.cur_priced, r.cur_unpriced,
       r.prev_cost, r.prev_priced, r.prev_unpriced, r.active_days, r.latest_usage_ms,
       r.candidate_count, r.all_cur_cost, r.all_cur_priced, r.all_cur_unpriced, r.all_latest_ms
FROM ranked r
LEFT JOIN named n ON n.owner_type = r.owner_type AND n.owner_id = r.owner_id AND n.rn = 1
ORDER BY r.cur_cost DESC NULLS LAST, r.owner_type, r.owner_id
LIMIT ${ENTITY_LIMIT}`;
      params.push(pricing.param('cur_start', period.start, 'DATE'));
      return {
        kind: 'exploreEntities',
        statement,
        parameters: params,
        rowLimit: ENTITY_LIMIT + 1,
        maxRows: ENTITY_LIMIT,
        period,
        nowMs,
        provenance: pricing.provenance(conn.priceTable, conn.currency),
      };
    },
    parse(rows, query) {
      if (rows.length > ENTITY_LIMIT) throw new Error('Explorer entities exceed the limit');
      const first = rows[0] || {};
      const candidateCount = rows.length ? Number(first.candidate_count) || rows.length : 0;
      const items = rows.map((r) => {
        const type = OWNER_TYPES.includes(r.owner_type) ? r.owner_type : 'unattributed';
        const id = type === 'unattributed' || r.owner_id === null ? null : V.safeText(r.owner_id, 200);
        const name = r.owner_name === null || r.owner_name === undefined ? null : V.safeText(r.owner_name, 300);
        const curPriced = r.cur_priced || 0;
        const curUnpriced = r.cur_unpriced || 0;
        const prevPriced = r.prev_priced || 0;
        const prevUnpriced = r.prev_unpriced || 0;
        const warnings = [];
        if (curUnpriced) warnings.push({ code: 'UNPRICED', text: curUnpriced + ' usage record(s) in the selected period have no matching price; amount is a priced subtotal.' });
        if (prevUnpriced) warnings.push({ code: 'PRIOR_UNPRICED', text: 'Prior-period amount is a priced subtotal (' + prevUnpriced + ' unpriced record(s)).' });
        return {
          key: type + ':' + (id === null ? '-' : id),
          ownerType: type,
          id,
          name,
          nameSource: name === null ? null : { job: 'job_name', notebook: 'notebook_path', app: 'app_name' }[type] || null,
          amount: curPriced > 0 ? num(r.cur_cost) : null,
          status: coverageOf(curPriced, curUnpriced) === 'complete' ? 'ok' : curPriced > 0 ? 'partial' : 'unpriced',
          pricedRecords: curPriced,
          unpricedRecords: curUnpriced,
          prevAmount: prevPriced > 0 ? num(r.prev_cost) : null,
          prevStatus: prevPriced + prevUnpriced === 0 ? 'no-usage' : coverageOf(prevPriced, prevUnpriced) === 'complete' ? 'ok' : prevPriced > 0 ? 'partial' : 'unpriced',
          activeDays: r.active_days || 0,
          latestUsageMs: num(r.latest_usage_ms),
          scope: 'period',
          attribution: 'exclusive',
          warnings,
        };
      });
      const allPriced = Number(first.all_cur_priced) || 0;
      const allUnpriced = Number(first.all_cur_unpriced) || 0;
      return Object.assign({}, query.provenance, {
        kind: 'exploreEntities',
        period: query.period,
        limit: ENTITY_LIMIT,
        candidateCount,
        limited: candidateCount > items.length,
        totals: {
          coverage: coverageOf(allPriced, allUnpriced),
          amount: allPriced > 0 ? num(first.all_cur_cost) : null,
          pricedRecords: allPriced,
          unpricedRecords: allUnpriced,
        },
        latestUsageMs: num(first.all_latest_ms),
        freshness: freshness(first.all_latest_ms, query.nowMs),
        items,
      });
    },
  });

  /* ================================================================ exploreRuns */

  function buildRunCosts(conn, args, nowMs) {
    const periodDays = checkPeriod(args);
    const jobId = args.jobId === undefined || args.jobId === null || args.jobId === '' ? null : args.jobId;
    if (jobId !== null && !V.isNumericId(jobId)) throw new Error('Invalid job ID');
    const period = periods.completePeriod(periodDays, nowMs);
    // Job ownership has top priority, so every record with a job ID belongs to that job; records
    // with a job ID but no run ID stay in the job's total but cannot be shown per run.
    let extra = 'u.usage_metadata.job_id IS NOT NULL AND u.usage_metadata.job_run_id IS NOT NULL';
    if (jobId !== null) extra += ' AND u.usage_metadata.job_id = :job_id';
    const { cte, params } = cteFor(conn, period.start, period.endExclusive, extra);
    if (jobId !== null) params.push(pricing.param('job_id', jobId));
    const statement = `WITH ${cte},
run_costs AS (
  SELECT pu.usage_metadata.job_id AS job_id,
         pu.usage_metadata.job_run_id AS run_id,
         SUM(CASE WHEN pu.is_priced THEN pu.cost END) AS cost,
         SUM(CASE WHEN pu.is_priced THEN 1 ELSE 0 END) AS priced_records,
         SUM(CASE WHEN pu.is_priced THEN 0 ELSE 1 END) AS unpriced_records,
         unix_millis(MIN(pu.usage_start_time)) AS first_usage_ms,
         unix_millis(MAX(pu.usage_end_time)) AS last_usage_ms
  FROM priced_usage pu
  GROUP BY pu.usage_metadata.job_id, pu.usage_metadata.job_run_id
),
job_names AS (
  SELECT pu.usage_metadata.job_id AS job_id, pu.usage_metadata.job_name AS job_name,
         ROW_NUMBER() OVER (PARTITION BY pu.usage_metadata.job_id ORDER BY pu.usage_end_time DESC, pu.usage_metadata.job_name) AS rn
  FROM priced_usage pu
  WHERE pu.usage_metadata.job_name IS NOT NULL
),
ranked AS (
  SELECT rc.*,
         COUNT(*) OVER () AS candidate_count,
         COUNT(*) OVER (PARTITION BY rc.job_id) AS job_run_count,
         MAX(rc.last_usage_ms) OVER () AS all_latest_ms
  FROM run_costs rc
)
SELECT r.job_id, r.run_id, jn.job_name, r.cost, r.priced_records, r.unpriced_records,
       r.first_usage_ms, r.last_usage_ms, r.candidate_count, r.job_run_count, r.all_latest_ms
FROM ranked r
LEFT JOIN job_names jn ON jn.job_id = r.job_id AND jn.rn = 1
ORDER BY r.cost DESC NULLS LAST, r.job_id, r.run_id
LIMIT ${RUN_LIMIT}`;
    return {
      kind: 'exploreRuns',
      statement,
      parameters: params,
      rowLimit: RUN_LIMIT + 1,
      maxRows: RUN_LIMIT,
      period,
      jobId,
      nowMs,
      provenance: pricing.provenance(conn.priceTable, conn.currency),
    };
  }

  /** Durations for the given runs: earliest slice start to latest slice end per run. */
  function buildRunDurations(conn, period, runIds) {
    if (!V.isWorkspaceId(conn.workspaceId)) throw new Error('Invalid workspace ID');
    const ids = runIds.filter((id) => V.isNumericId(id));
    if (!ids.length || ids.length > RUN_LIMIT) throw new Error('Invalid run list');
    const params = [
      pricing.param('workspace_id', conn.workspaceId),
      pricing.param('tl_start', periods.addDays(period.start, -DURATION_LOOKBACK_DAYS), 'DATE'),
      pricing.param('tl_end', periods.addDays(period.today, 1), 'DATE'),
    ];
    const names = ids.map((id, i) => {
      params.push(pricing.param('r' + i, id));
      return ':r' + i;
    });
    const statement = `SELECT t.job_id, t.run_id,
       unix_millis(MIN(t.period_start_time)) AS start_ms,
       unix_millis(MAX(t.period_end_time)) AS end_ms,
       MAX(t.result_state) AS result_state
FROM ${V.quoteThreePartName(RUN_TIMELINE)} t
WHERE t.workspace_id = :workspace_id
  AND t.period_start_time >= :tl_start
  AND t.period_start_time < :tl_end
  AND t.run_id IN (${names.join(', ')})
GROUP BY t.job_id, t.run_id`;
    return { kind: 'exploreRunDurations', statement, parameters: params, rowLimit: RUN_LIMIT + 1, maxRows: RUN_LIMIT };
  }

  function parseRunCosts(rows, query) {
    if (rows.length > RUN_LIMIT) throw new Error('Explorer runs exceed the limit');
    const returnedPerJob = new Map();
    for (const r of rows) returnedPerJob.set(r.job_id, (returnedPerJob.get(r.job_id) || 0) + 1);
    return rows
      .filter((r) => V.isNumericId(String(r.job_id)) && V.isNumericId(String(r.run_id)))
      .map((r) => {
        const priced = r.priced_records || 0;
        const unpriced = r.unpriced_records || 0;
        const warnings = [];
        if (unpriced) warnings.push({ code: 'UNPRICED', text: unpriced + ' usage record(s) have no matching price; amount is a priced subtotal.' });
        return {
          key: 'job_run:' + r.job_id + ':' + r.run_id,
          jobId: String(r.job_id),
          runId: String(r.run_id),
          jobName: r.job_name === null || r.job_name === undefined ? null : V.safeText(r.job_name, 300),
          amount: priced > 0 ? num(r.cost) : null,
          status: unpriced === 0 ? 'ok' : priced > 0 ? 'partial' : 'unpriced',
          pricedRecords: priced,
          unpricedRecords: unpriced,
          firstUsageMs: num(r.first_usage_ms),
          lastUsageMs: num(r.last_usage_ms),
          cohortRuns: Number(r.job_run_count) || 0,
          cohortComplete: (Number(r.job_run_count) || 0) === returnedPerJob.get(r.job_id),
          startMs: null,
          endMs: null,
          durationMs: null,
          resultState: null,
          durationStatus: 'pending',
          scope: 'period',
          attribution: 'exclusive',
          warnings,
        };
      });
  }

  /** Merge timeline rows into items. Missing or non-positive durations stay null, never 0. */
  function applyDurations(items, rows) {
    const byRun = new Map();
    for (const r of rows) byRun.set(String(r.run_id), r);
    for (const it of items) {
      const t = byRun.get(it.runId);
      if (!t || String(t.job_id) !== it.jobId) {
        it.durationStatus = 'missing';
        it.warnings.push({ code: 'DURATION_MISSING', text: 'No run timeline found for this run; duration unavailable.' });
        continue;
      }
      it.startMs = num(t.start_ms);
      it.endMs = num(t.end_ms);
      it.resultState = t.result_state ? V.safeText(t.result_state, 40) : null;
      const d = it.startMs !== null && it.endMs !== null ? it.endMs - it.startMs : null;
      if (d === null || d <= 0) {
        it.durationStatus = 'missing';
        it.warnings.push({ code: 'DURATION_MISSING', text: 'Run timeline has no positive duration; duration unavailable.' });
      } else if (!it.resultState) {
        it.durationStatus = 'running';
        it.durationMs = null;
        it.warnings.push({ code: 'RUN_NOT_FINISHED', text: 'Run has no final state in the timeline yet; duration not final.' });
      } else {
        it.durationStatus = 'ok';
        it.durationMs = d;
      }
    }
  }

  const exploreRuns = Object.freeze({
    LIMIT: RUN_LIMIT,
    buildCosts: buildRunCosts,
    buildDurations: buildRunDurations,
    /**
     * Two statements: run costs (required), then durations (optional). A failed duration read
     * keeps the costs and reports a warning; durations are never replaced with zero.
     */
    async run({ conn, args, nowMs = Date.now(), exec }) {
      const q = buildRunCosts(conn, args || {}, nowMs);
      const rows = await exec(q);
      const items = parseRunCosts(rows, q);
      const first = rows[0] || {};
      const warnings = [
        {
          code: 'PERIOD_SCOPED',
          text: 'Run amounts include only billing recorded in the selected period (' + periods.periodLabel(q.period.start, q.period.endExclusive) + '). A run that started earlier or continued later has a different lifetime cost.',
        },
      ];
      let durationStatus = 'ok';
      let durationError = null;
      if (items.length) {
        try {
          const dq = buildRunDurations(conn, q.period, items.map((it) => it.runId));
          applyDurations(items, await exec(dq));
        } catch (e) {
          durationStatus = 'unavailable';
          durationError = (e && e.dcc && e.dcc.code) || 'UNKNOWN';
          for (const it of items) {
            it.durationStatus = 'unavailable';
            it.durationMs = null;
            it.warnings.push({ code: 'DURATION_UNAVAILABLE', text: 'Run durations could not be read.' });
          }
          warnings.push({
            code: 'DURATION_UNAVAILABLE',
            text: 'Run durations could not be read from ' + RUN_TIMELINE + ' (' + durationError + '). Costs are shown; runs without a usable duration are left out of the scatter.',
          });
        }
      } else {
        durationStatus = 'not-needed';
      }
      const candidateCount = rows.length ? Number(first.candidate_count) || rows.length : 0;
      return Object.assign({}, q.provenance, {
        kind: 'exploreRuns',
        period: q.period,
        jobId: q.jobId,
        limit: RUN_LIMIT,
        candidateCount,
        limited: candidateCount > items.length,
        durationStatus,
        durationError,
        durationLookbackDays: DURATION_LOOKBACK_DAYS,
        latestUsageMs: num(first.all_latest_ms),
        freshness: freshness(first.all_latest_ms, nowMs),
        warnings,
        items,
      });
    },
  });

  const api = Object.freeze({
    OWNER_TYPES,
    SUMMARY_MAX_ROWS,
    ENTITY_LIMIT,
    RUN_LIMIT,
    RUN_TIMELINE,
    kinds: Object.freeze({ exploreSummary, exploreEntities, exploreRuns }),
  });
  if (NODE) module.exports = api;
  else ((root.DCC || (root.DCC = {})).queries || (root.DCC.queries = {})).explore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
