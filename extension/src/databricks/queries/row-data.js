/*
 * Native badge amounts ("rows" kind): recorded cost per native resource reference.
 *
 *   period scope    job, pipeline, warehouse, notebook, app — the selected complete UTC period
 *   execution scope job_run, pipeline_update — that execution only, billing searched across 365
 *                   UTC dates including today
 *
 * Direct attribution uses usage_metadata.{job_id, job_run_id, dlt_pipeline_id, dlt_update_id,
 * warehouse_id, notebook_id, app_name}. Jobs additionally get the billing of pipeline updates they
 * triggered (spec §7): system.lakeflow.pipeline_update_timeline (trigger_type = 'JOB_TASK') gives
 * the triggering job and task run; for runs, the task run is joined to
 * system.lakeflow.job_task_run_timeline.run_id (same workspace and job) to find its parent
 * job_run_id. Hourly timeline slices and repeated task rows collapse into one membership set per
 * target (collect_set of 'pipeline_id|update_id'), and billing joins each target once with
 * `direct OR array_contains(members, ...)`, so a record that matches both ways counts once.
 *
 * If the timelines are missing, denied or differently shaped, the scope re-runs direct-only and
 * every job item says so ("Direct job cost" + PIPELINE_ATTRIBUTION_UNAVAILABLE). No shared
 * all-purpose allocation is invented. Missing billing is null, never 0. Status, attribution and
 * warnings are attached per item.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const V = dep('validate', '../../core/validate.js');
  const ids = dep('ids', '../../core/ids.js');
  const periods = dep('periods', '../../core/periods.js');
  const errors = dep('errors', '../../errors.js');
  const pricing = dep('pricing', '../pricing.js');

  const MAX_REFS = 40;
  const MAX_ROWS = 5000;
  const EXECUTION_LOOKBACK_DAYS = 365;
  const PERIOD_TYPES = Object.freeze(['job', 'pipeline', 'warehouse', 'notebook', 'app']);
  const EXECUTION_TYPES = Object.freeze(['job_run', 'pipeline_update']);
  // Timeline failures that downgrade jobs to direct-only attribution instead of failing the batch.
  const FALLBACK_CODES = Object.freeze(['TABLE_NOT_FOUND', 'LAKEFLOW_ACCESS_DENIED', 'TABLE_ACCESS_DENIED', 'SCHEMA_MISMATCH']);
  const UPDATE_TIMELINE = V.quoteThreePartName('system.lakeflow.pipeline_update_timeline');
  const TASK_RUN_TIMELINE = V.quoteThreePartName('system.lakeflow.job_task_run_timeline');

  /** Per type: SQL type tag, identity columns (a, b) and the direct billing predicate over tl/pu. */
  const TYPES = Object.freeze({
    job: { a: 'jobId', direct: "(tl.tt = 'job' AND pu.usage_metadata.job_id = tl.ta)", label: 'Job total' },
    job_run: {
      a: 'jobId',
      b: 'runId',
      direct: "(tl.tt = 'job_run' AND pu.usage_metadata.job_run_id = tl.tb AND COALESCE(pu.usage_metadata.job_id, tl.ta) = tl.ta)",
      label: 'Run cost',
    },
    pipeline: { a: 'pipelineId', direct: "(tl.tt = 'pipeline' AND pu.usage_metadata.dlt_pipeline_id = tl.ta)", label: 'Pipeline total' },
    pipeline_update: {
      a: 'pipelineId',
      b: 'updateId',
      direct: "(tl.tt = 'pipeline_update' AND pu.usage_metadata.dlt_pipeline_id = tl.ta AND pu.usage_metadata.dlt_update_id = tl.tb)",
      label: 'Update cost',
    },
    warehouse: { a: 'warehouseId', direct: "(tl.tt = 'warehouse' AND pu.usage_metadata.warehouse_id = tl.ta)", label: 'Warehouse total' },
    notebook: { a: 'notebookId', direct: "(tl.tt = 'notebook' AND pu.usage_metadata.notebook_id = tl.ta)", label: 'Notebook total' },
    app: { a: 'appName', direct: "(tl.tt = 'app' AND pu.usage_metadata.app_name = tl.ta)", label: 'App total' },
  });
  const DIRECT_ONLY_LABEL = { job: 'Direct job cost', job_run: 'Direct job cost (this run)' };

  /** usage_scoped prefilter: which usage_metadata column carries each type's identity. */
  const PREFILTER = Object.freeze({
    job: { col: 'job_id', side: 'a' },
    job_run: { col: 'job_run_id', side: 'b' },
    pipeline: { col: 'dlt_pipeline_id', side: 'a' },
    pipeline_update: { col: 'dlt_update_id', side: 'b' },
    warehouse: { col: 'warehouse_id', side: 'a' },
    notebook: { col: 'notebook_id', side: 'a' },
    app: { col: 'app_name', side: 'a' },
  });

  function fail(message) {
    return new errors.DccError({ code: 'UNKNOWN', message });
  }

  /** Re-validate refs: sanitized, keyed, deduplicated, ≤ 40. Unsupported types are kept aside. */
  function normalizeRefs(refs) {
    if (!Array.isArray(refs)) throw fail('Invalid resource list');
    const out = [];
    const unsupported = [];
    const seen = new Set();
    for (const r of refs) {
      const clean = ids.sanitizeRef(r);
      if (!clean) continue;
      const key = ids.refKey(clean);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (TYPES[clean.type]) out.push(Object.assign(clean, { key }));
      else unsupported.push(Object.assign(clean, { key }));
    }
    if (out.length + unsupported.length > MAX_REFS) throw fail('Too many resources in one request (limit ' + MAX_REFS + ')');
    return { refs: out, unsupported };
  }

  const ts = (date) => date + ' 00:00:00';

  /**
   * Build one statement for a scope.
   * @param {object} conn
   * @param {object[]} refs normalized refs of one scope
   * @param {{start, endExclusive}} window UTC date window for billing
   * @param {'period'|'execution'} scope
   * @param {boolean} linked include triggered-pipeline attribution (only meaningful with job refs)
   */
  function buildScope(conn, refs, window, scope, linked) {
    const targets = refs.map((ref, i) => ({ ref, i, a: ref[TYPES[ref.type].a], b: TYPES[ref.type].b ? ref[TYPES[ref.type].b] : null }));
    const params = [];
    const targetSql = targets
      .map((t) => {
        params.push(pricing.param('t' + t.i + 'a', t.a));
        if (t.b !== null) params.push(pricing.param('t' + t.i + 'b', t.b));
        // ti and tt are code-generated constants (loop index, fixed type tag), never input values.
        return `SELECT ${t.i} AS ti, '${t.ref.type}' AS tt, :t${t.i}a AS ta, ${t.b !== null ? ':t' + t.i + 'b' : 'CAST(NULL AS STRING)'} AS tb`;
      })
      .join('\n  UNION ALL ');

    const linkType = scope === 'period' ? 'job' : 'job_run';
    const useLinks = linked && targets.some((t) => t.ref.type === linkType);

    // Prefilter billing to records that can match any target (pure parameter lists).
    const byCol = new Map();
    for (const t of targets) {
      const p = PREFILTER[t.ref.type];
      if (!byCol.has(p.col)) byCol.set(p.col, []);
      const name = ':t' + t.i + p.side;
      if (!byCol.get(p.col).includes(name)) byCol.get(p.col).push(name);
    }
    const prefilter = [...byCol.entries()].map(([col, names]) => `u.usage_metadata.${col} IN (${names.join(', ')})`);
    if (useLinks) prefilter.push('u.usage_metadata.dlt_update_id IN (SELECT update_id FROM link_rows)');

    const { cte, params: usageParams } = pricing.pricedUsageCte({
      priceTable: conn.priceTable,
      usageSource: conn.usageSource,
      currency: conn.currency,
      workspaceId: conn.workspaceId,
      startDate: window.start,
      endDate: window.endExclusive,
      extraWhere: prefilter.join('\n      OR '),
    });
    params.push(...usageParams);

    let linkCtes = '';
    if (useLinks) {
      // Timeline scans are bounded to the billing window ± 1 day (hourly slices that overlap it).
      params.push(pricing.param('tl_start', ts(periods.addDays(window.start, -1)), 'TIMESTAMP'));
      params.push(pricing.param('tl_end', ts(periods.addDays(window.endExclusive, 1)), 'TIMESTAMP'));
      const rows =
        linkType === 'job'
          ? `SELECT t.ti, put.pipeline_id, put.update_id
  FROM targets t
  JOIN ${UPDATE_TIMELINE} put
    ON put.trigger_details.job_task.job_id = t.ta
  WHERE t.tt = 'job'
    AND put.workspace_id = :workspace_id
    AND put.trigger_type = 'JOB_TASK'
    AND put.period_end_time >= :tl_start AND put.period_start_time < :tl_end
    AND put.pipeline_id IS NOT NULL AND put.update_id IS NOT NULL`
          : `SELECT t.ti, put.pipeline_id, put.update_id
  FROM targets t
  JOIN ${TASK_RUN_TIMELINE} jt
    ON jt.job_id = t.ta AND jt.job_run_id = t.tb
  JOIN ${UPDATE_TIMELINE} put
    ON put.workspace_id = jt.workspace_id
   AND put.trigger_details.job_task.job_id = jt.job_id
   AND put.trigger_details.job_task.job_task_run_id = jt.run_id
  WHERE t.tt = 'job_run'
    AND jt.workspace_id = :workspace_id
    AND put.workspace_id = :workspace_id
    AND put.trigger_type = 'JOB_TASK'
    AND jt.period_end_time >= :tl_start AND jt.period_start_time < :tl_end
    AND put.period_end_time >= :tl_start AND put.period_start_time < :tl_end
    AND put.pipeline_id IS NOT NULL AND put.update_id IS NOT NULL`;
      linkCtes = `link_rows AS (
  ${rows}
),
links AS (
  SELECT ti, collect_set(concat_ws('|', pipeline_id, update_id)) AS members
  FROM link_rows
  GROUP BY ti
),
`;
    }

    const types = [...new Set(targets.map((t) => t.ref.type))];
    const direct = types.map((t) => TYPES[t].direct).join('\n       OR ');
    const linkedPred = useLinks
      ? `(tl.tt = '${linkType}' AND array_contains(tl.members, concat_ws('|', pu.usage_metadata.dlt_pipeline_id, pu.usage_metadata.dlt_update_id)))`
      : null;
    const targetLinks = useLinks
      ? `SELECT t.ti, t.tt, t.ta, t.tb, l.members FROM targets t LEFT JOIN links l ON l.ti = t.ti`
      : `SELECT t.ti, t.tt, t.ta, t.tb FROM targets t`;

    const statement = `WITH targets AS (
  ${targetSql}
),
${linkCtes}${cte},
target_links AS (
  ${targetLinks}
),
matched AS (
  SELECT tl.ti, pu.record_id, pu.is_priced, pu.cost, pu.price_matches, pu.sku_name, pu.usage_date, pu.usage_end_time,
         CASE WHEN ${direct.replace(/\n {7}OR /g, ' OR ')} THEN 1 ELSE 0 END AS direct_match
  FROM target_links tl
  JOIN priced_usage pu
    ON ${direct}${linkedPred ? '\n       OR ' + linkedPred : ''}
)
SELECT ti,
       sku_name,
       SUM(CASE WHEN is_priced THEN cost END) AS priced_cost,
       SUM(CASE WHEN is_priced THEN 1 ELSE 0 END) AS priced_records,
       SUM(CASE WHEN is_priced THEN 0 ELSE 1 END) AS unpriced_records,
       SUM(CASE WHEN is_priced THEN 0 WHEN price_matches > 1 THEN 1 ELSE 0 END) AS ambiguous_records,
       SUM(CASE WHEN is_priced AND direct_match = 0 THEN cost END) AS linked_cost,
       SUM(CASE WHEN direct_match = 0 THEN 1 ELSE 0 END) AS linked_records,
       CAST(MIN(CASE WHEN is_priced THEN NULL ELSE usage_date END) AS STRING) AS first_unpriced,
       CAST(MAX(CASE WHEN is_priced THEN NULL ELSE usage_date END) AS STRING) AS last_unpriced,
       unix_millis(MAX(usage_end_time)) AS latest_usage_ms
FROM matched
GROUP BY ti, sku_name
ORDER BY ti, sku_name`;

    return {
      kind: 'rows',
      scope,
      linked: useLinks,
      statement,
      parameters: params,
      rowLimit: MAX_ROWS + 1,
      maxRows: MAX_ROWS,
      window: { start: window.start, endExclusive: window.endExclusive },
      targets: targets.map((t) => t.ref),
    };
  }

  function emptyAgg() {
    return { pricedCost: 0, pricedRecords: 0, unpricedRecords: 0, ambiguousRecords: 0, linkedCost: 0, linkedRecords: 0, linkedPriced: 0, skus: new Set(), first: null, last: null, latest: null };
  }

  function aggregate(rows, count) {
    const aggs = Array.from({ length: count }, emptyAgg);
    for (const r of rows) {
      const a = Number.isInteger(r.ti) && r.ti >= 0 && r.ti < count ? aggs[r.ti] : null;
      if (!a) continue;
      if (r.priced_records > 0 && r.priced_cost !== null) a.pricedCost += r.priced_cost;
      a.pricedRecords += r.priced_records || 0;
      a.unpricedRecords += r.unpriced_records || 0;
      a.ambiguousRecords += r.ambiguous_records || 0;
      if (r.linked_cost !== null && r.linked_cost !== undefined) {
        a.linkedCost += r.linked_cost;
        a.linkedPriced += 1;
      }
      a.linkedRecords += r.linked_records || 0;
      if (r.unpriced_records > 0) {
        a.skus.add(r.sku_name);
        if (r.first_unpriced && (!a.first || r.first_unpriced < a.first)) a.first = r.first_unpriced;
        if (r.last_unpriced && (!a.last || r.last_unpriced > a.last)) a.last = r.last_unpriced;
      }
      if (Number.isFinite(r.latest_usage_ms) && (a.latest === null || r.latest_usage_ms > a.latest)) a.latest = r.latest_usage_ms;
    }
    return aggs;
  }

  function coverageOf(a) {
    if (a.pricedRecords + a.unpricedRecords === 0) return 'empty';
    if (a.unpricedRecords === 0) return 'complete';
    if (a.pricedRecords === 0) return 'none';
    return 'partial';
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function windowNote(scope, w) {
    const last = periods.addDays(w.endExclusive, -1);
    if (scope === 'execution') {
      return (
        'Recorded cost of this execution only. Billing was searched across ' + EXECUTION_LOOKBACK_DAYS + ' UTC dates up to and including today (' +
        w.start + ' to ' + last + '). Delayed billing or bounded history can make it incomplete.'
      );
    }
    return 'Total for ' + w.start + ' to ' + last + ' (' + periods.daysBetween(w.start, w.endExclusive) + ' complete UTC days, excluding today). Not lifetime spend.';
  }

  /** One item per ref; never 0 for missing. */
  function makeItem(ref, a, ctx) {
    const coverage = coverageOf(a);
    const directOnly = ctx.directOnly && (ref.type === 'job' || ref.type === 'job_run');
    const attribution = ref.type === 'job' || ref.type === 'job_run' ? (directOnly ? 'direct-only' : 'direct+pipelines') : 'direct';
    const base = directOnly ? DIRECT_ONLY_LABEL[ref.type] : TYPES[ref.type].label;
    const warnings = [];
    let status;
    let amount = null;
    let label = base;
    let reason;
    if (coverage === 'complete') {
      status = 'ok';
      amount = a.pricedCost;
    } else if (coverage === 'partial') {
      status = 'partial';
      amount = a.pricedCost;
      label = base + ' (priced subtotal)';
      const skus = [...a.skus].sort();
      warnings.push({
        code: 'UNPRICED_USAGE',
        text:
          plural(a.unpricedRecords, 'usage record') + ' had no single matching price in ' + ctx.priceTable + ' (SKUs: ' + skus.join(', ') +
          '; usage dates ' + a.first + ' to ' + a.last + '). Shown as a priced subtotal, not a full total; a signed subtotal is not necessarily a lower bound.',
      });
    } else if (coverage === 'none') {
      status = 'unavailable';
      reason = 'price-unavailable';
      warnings.push({
        code: 'PRICE_UNAVAILABLE',
        text: 'Usage was recorded, but none of it has a single matching price in ' + ctx.priceTable + ' (SKUs: ' + [...a.skus].sort().join(', ') + '). No amount is shown.',
      });
    } else {
      status = 'none';
      reason = 'no-usage';
    }
    if (directOnly) {
      warnings.push({
        code: 'PIPELINE_ATTRIBUTION_UNAVAILABLE',
        text:
          'Pipeline updates triggered by this job could not be attributed because the system.lakeflow timelines are unavailable (' + ctx.fallbackTitle +
          '). Showing direct job billing only; this is not a complete job total.',
      });
    }
    const item = {
      key: ref.key,
      type: ref.type,
      status,
      amount,
      coverage,
      pricedRecords: a.pricedRecords,
      unpricedRecords: a.unpricedRecords,
      ambiguousRecords: a.ambiguousRecords,
      unpricedSkus: [...a.skus].sort(),
      firstUnpricedDate: a.first,
      lastUnpricedDate: a.last,
      latestUsageMs: a.latest,
      scope: ctx.scope,
      window: { start: ctx.window.start, endExclusive: ctx.window.endExclusive },
      attribution,
      label,
      note: windowNote(ctx.scope, ctx.window),
      warnings,
    };
    if (reason) item.reason = reason;
    if (attribution === 'direct+pipelines') {
      item.linkedRecords = a.linkedRecords;
      // Priced amount from triggered pipeline updates (records not also tagged directly).
      item.linkedAmount = a.linkedPriced > 0 ? a.linkedCost : null;
    }
    return item;
  }

  function isFallbackError(e) {
    return Boolean(e && e.dcc && FALLBACK_CODES.includes(e.dcc.code));
  }

  /** Execute one scope; on a timeline failure re-run direct-only (or throw that error). */
  async function runScope(conn, refs, window, scope, exec) {
    const hasLinks = refs.some((r) => r.type === (scope === 'period' ? 'job' : 'job_run'));
    let directOnly = false;
    let fallbackTitle = null;
    let query = buildScope(conn, refs, window, scope, true);
    let rows;
    try {
      rows = await exec(query);
    } catch (e) {
      if (!hasLinks || !isFallbackError(e)) throw e;
      directOnly = true;
      fallbackTitle = (e.dcc && e.dcc.title) || 'timeline unavailable';
      query = buildScope(conn, refs, window, scope, false);
      rows = await exec(query); // if direct-only also fails, that error propagates
    }
    const aggs = aggregate(rows, refs.length);
    const ctx = { scope, window, directOnly, fallbackTitle, priceTable: conn.priceTable };
    const items = {};
    refs.forEach((ref, i) => {
      items[ref.key] = makeItem(ref, aggs[i], ctx);
    });
    return { items, directOnly };
  }

  /**
   * @param {{conn, args:{periodDays, refs}, nowMs, exec}} ctx
   * @returns {{pricingBasis, priceTable, priceField, currency, items, windows}}
   */
  async function run({ conn, args, nowMs = Date.now(), exec }) {
    const periodDays = args && args.periodDays;
    if (!V.isPeriodDays(periodDays)) throw fail('Invalid period');
    if (typeof exec !== 'function') throw fail('No executor');
    const prov = pricing.provenance(conn.priceTable, conn.currency);
    const { refs, unsupported } = normalizeRefs(args.refs);
    const period = periods.completePeriod(periodDays, nowMs);
    const lb = periods.lookback(EXECUTION_LOOKBACK_DAYS, nowMs, true);
    const periodWindow = { start: period.start, endExclusive: period.endExclusive };
    const execWindow = { start: lb.start, endExclusive: lb.endExclusive };
    const periodRefs = refs.filter((r) => PERIOD_TYPES.includes(r.type));
    const execRefs = refs.filter((r) => EXECUTION_TYPES.includes(r.type));

    const [p, x] = await Promise.all([
      periodRefs.length ? runScope(conn, periodRefs, periodWindow, 'period', exec) : null,
      execRefs.length ? runScope(conn, execRefs, execWindow, 'execution', exec) : null,
    ]);
    const items = Object.assign({}, p && p.items, x && x.items);
    for (const ref of unsupported) {
      items[ref.key] = { key: ref.key, type: ref.type, status: 'unavailable', reason: 'unsupported-type', amount: null, coverage: 'none', attribution: 'direct', warnings: [] };
    }
    return Object.assign({}, prov, {
      kind: 'rows',
      periodDays,
      windows: { period: periodWindow, execution: execWindow },
      items,
    });
  }

  const api = Object.freeze({ MAX_REFS, MAX_ROWS, EXECUTION_LOOKBACK_DAYS, PERIOD_TYPES, EXECUTION_TYPES, FALLBACK_CODES, normalizeRefs, buildScope, run });
  if (NODE) module.exports = api;
  else ((root.DCC || (root.DCC = {})).queries || (root.DCC.queries = {})).rows = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
