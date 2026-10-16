/*
 * SYNTHETIC story dataset for the Lakeline launch video (development only; never real data).
 *
 * "Northpeak Retail" runs two AWS workspaces, northpeak-prod and northpeak-analytics, in one
 * account. Everything here is made up and deterministic for a given UTC "today", and has the
 * same table shapes as local/fixture-data.mjs, so the real extension queries it through the
 * shared fixture server internals (local/fixture-server.mjs createFixtureApp, DuckDB simulation).
 *
 * The storyboard beats (notes/VIDEO.md) are TRUE in this data, not painted on:
 *   - 30-day spend is up about 10–15 % on the prior 30 days (organic growth of BI, pipelines and
 *     jobs, plus marketing_attribution, which started 55 days ago, plus one backfill).
 *   - nightly_sales_etl has one manual backfill run on a weekday 4–8 days ago (BACKFILL_DAYS_AGO);
 *     that day is flagged as a spike in the Explorer calendar (workspace daily total ≈ 2.3×).
 *   - customer_360_refresh's task refresh_cust360 triggers pipeline cust360_dlt every day
 *     (pipeline_update_timeline trigger_type JOB_TASK), so its job total includes the pipeline.
 *   - SQL warehouses "BI Serverless" (running, Large) and "ETL Pro"; query history has one heavy
 *     BI dashboard query that runs alone for about 13 minutes, so its estimate is a clear amount.
 *   - A priced GENIE billing line and the documented GENIE_FREE_USAGE line.
 *   - Every SKU has a list price (the periods are fully priced: no "priced subtotal").
 * Genie answers are computed by running the SQL each answer shows on the same DuckDB engine
 * (see genieAnswers), so they can't contradict the banner or the badges. Monitor data is
 * relative to "now"; the capture script flips one customer_360_refresh run to FAILED mid-session
 * (failCustomer360) so the extension's real failure notification fires.
 *
 * Stable identifiers (ed = UTC epoch day of the run's date):
 *   job run      <job id><ed, 6 digits><seq>            e.g. 4120207410 (seq 1 = the backfill)
 *   task run     <job run><task index>
 *   update       <pipeline prefix>-<ed, 12 digits>
 *   statement    UUID derived from (workspace, ed, index)
 */
import crypto from 'node:crypto';

export const COMPANY = 'Northpeak Retail';
export const ACCOUNT_ID = 'northpeak-account-7b21';
export const CLOUD = 'AWS';
export const CURRENCY = 'USD';
export const DAYS = 185; // 90-day banner needs a full prior 90 days
const DAY = 86400000;

/** Fake bearer tokens, one per workspace. Not credentials: only the local video server accepts them. */
export const WORKSPACES = Object.freeze({
  prod: Object.freeze({
    key: 'prod',
    name: 'northpeak-prod',
    host: 'northpeak-prod.cloud.databricks.com',
    origin: 'https://northpeak-prod.cloud.databricks.com',
    workspaceId: '2208417036951642',
    token: 'dapi-video-northpeak-prod-not-a-real-token',
    color: '#B42318', // the extension's "Red" preset (white text, 6.6:1)
    user: 'Avery Kim',
    initials: 'AK',
  }),
  analytics: Object.freeze({
    key: 'analytics',
    name: 'northpeak-analytics',
    host: 'northpeak-analytics.cloud.databricks.com',
    origin: 'https://northpeak-analytics.cloud.databricks.com',
    workspaceId: '2208417036951897',
    token: 'dapi-video-northpeak-analytics-not-a-real-token',
    color: '#1D4ED8', // the extension's "Blue" preset (white text, 6.7:1)
    user: 'Avery Kim',
    initials: 'AK',
  }),
  // Lightweight workspaces for the workspace-colors scene (small datasets, no Genie agents).
  dev: Object.freeze({
    key: 'dev',
    name: 'northpeak-dev',
    host: 'northpeak-dev.cloud.databricks.com',
    origin: 'https://northpeak-dev.cloud.databricks.com',
    workspaceId: '2208417036951310',
    token: 'dapi-video-northpeak-dev-not-a-real-token',
    color: '#067647', // the extension's "Green" preset (white text)
    user: 'Avery Kim',
    initials: 'AK',
  }),
  stage: Object.freeze({
    key: 'stage',
    name: 'northpeak-stage',
    host: 'northpeak-stage.cloud.databricks.com',
    origin: 'https://northpeak-stage.cloud.databricks.com',
    workspaceId: '2208417036951475',
    token: 'dapi-video-northpeak-stage-not-a-real-token',
    color: '#F79009', // the extension's "Orange" preset (black text)
    user: 'Avery Kim',
    initials: 'AK',
  }),
});

/** USD per DBU, one validity window from 2020 (list and account tables). */
export const LIST_PRICES = Object.freeze({
  PREMIUM_JOBS_COMPUTE: 0.15,
  PREMIUM_JOBS_SERVERLESS_COMPUTE_US_EAST: 0.35,
  PREMIUM_DLT_ADVANCED_COMPUTE: 0.36,
  PREMIUM_DLT_CORE_COMPUTE: 0.2,
  PREMIUM_SERVERLESS_SQL_COMPUTE_US_EAST: 0.7,
  PREMIUM_SQL_PRO_COMPUTE_US_EAST: 0.55,
  PREMIUM_ALL_PURPOSE_COMPUTE: 0.55,
  PREMIUM_ALL_PURPOSE_SERVERLESS_COMPUTE_US_EAST: 0.95,
  PREMIUM_SERVERLESS_REAL_TIME_INFERENCE_US_EAST: 0.082,
  PREMIUM_APPS_COMPUTE_US_EAST: 0.5,
  PREMIUM_GENIE_SERVERLESS_US_EAST: 0.7, // synthetic SKU name for the paid Genie line
});
export const ACCOUNT_DISCOUNT = 0.85;

/* ------------------------------------------------------------------ resources */

const P = (key) => WORKSPACES[key];

export const RESOURCES = Object.freeze({
  prod: Object.freeze({
    jobs: Object.freeze([
      { job_id: '412', name: 'nightly_sales_etl', schedule: 'Daily at 01:00 UTC', owner: 'data-platform@northpeak.example', tasks: ['extract_pos', 'transform_sales', 'publish_marts'] },
      { job_id: '418', name: 'customer_360_refresh', schedule: 'Daily at 03:00 UTC', owner: 'customer-data@northpeak.example', tasks: ['prepare_inputs', 'refresh_cust360'] },
      { job_id: '421', name: 'inventory_snapshot', schedule: 'Daily at 05:00 UTC', owner: 'supply-chain@northpeak.example', tasks: ['snapshot'] },
      { job_id: '433', name: 'marketing_attribution', schedule: 'Daily at 06:00 UTC', owner: 'growth-analytics@northpeak.example', tasks: ['attribute'] },
      { job_id: '440', name: 'demand_forecast_weekly', schedule: 'Sundays at 08:00 UTC', owner: 'ml-platform@northpeak.example', tasks: ['train', 'score'] },
    ]),
    pipelines: Object.freeze([
      { pipeline_id: '7c3a6f10-2b4d-4e8a-9f1c-0000c360d1e7', name: 'cust360_dlt', prefix: 'c3601e5a-7c4d-4f8e-9a6b' },
      { pipeline_id: '3e9d2a44-81c6-4b0f-a7d2-00000cdc0a1f', name: 'orders_cdc_dlt', prefix: 'cdc01e5a-7c4d-4f8e-9a6b' },
    ]),
    warehouses: Object.freeze([
      { id: '5f2a9c1e7b3d4a60', name: 'BI Serverless', state: 'RUNNING', cluster_size: 'Large', warehouse_type: 'PRO', enable_serverless_compute: true, min_num_clusters: 1, max_num_clusters: 4, auto_stop_mins: 10 },
      { id: '6a3b0d2f8c4e5b71', name: 'ETL Pro', state: 'STOPPED', cluster_size: 'Small', warehouse_type: 'PRO', enable_serverless_compute: false, min_num_clusters: 1, max_num_clusters: 2, auto_stop_mins: 15 },
      { id: '7b4c1e3a9d5f6c82', name: 'Ad hoc Serverless', state: 'STOPPED', cluster_size: 'Small', warehouse_type: 'PRO', enable_serverless_compute: true, min_num_clusters: 1, max_num_clusters: 1, auto_stop_mins: 5 },
    ]),
    clusters: Object.freeze({ shared: '0919-081522-npk7h2q1', sandbox: '0919-081522-mlsbx3r4', jobA: '1015-010203-jcls8m41', jobB: '1015-010203-jcls9n52' }),
    notebooks: Object.freeze([{ notebook_id: '81403', path: '/Users/avery.kim@northpeak.example/Store KPIs' }]),
    app: Object.freeze({ app_id: '4d1e7a20-6b3c-4f0e-8a91-2c5d7e9f0b13', app_name: 'store-ops-dashboard' }),
    endpoint: 'demand-forecast',
  }),
  analytics: Object.freeze({
    jobs: Object.freeze([
      { job_id: '510', name: 'web_sessionize', schedule: 'Daily at 02:00 UTC', owner: 'web-analytics@northpeak.example', tasks: ['sessionize'] },
      { job_id: '514', name: 'campaign_rollup', schedule: 'Daily at 04:00 UTC', owner: 'growth-analytics@northpeak.example', tasks: ['rollup'] },
    ]),
    pipelines: Object.freeze([{ pipeline_id: '9a1b2c3d-4e5f-4a6b-8c7d-0000c11c5a1e', name: 'clickstream_dlt', prefix: 'c11c1e5a-7c4d-4f8e-9a6b' }]),
    warehouses: Object.freeze([
      { id: '8c5d2f4b0e6a7d93', name: 'Analyst Serverless', state: 'RUNNING', cluster_size: 'Medium', warehouse_type: 'PRO', enable_serverless_compute: true, min_num_clusters: 1, max_num_clusters: 2, auto_stop_mins: 10 },
      { id: '9d6e3a5c1f7b8ea4', name: 'Reporting Pro', state: 'STOPPED', cluster_size: 'Small', warehouse_type: 'PRO', enable_serverless_compute: false, min_num_clusters: 1, max_num_clusters: 1, auto_stop_mins: 20 },
    ]),
    clusters: Object.freeze({ shared: '0921-140455-anl2k7p3', sandbox: '0921-140455-anlsb8q4', jobA: '1015-020304-acls1a21', jobB: '1015-020304-acls2b32' }),
    notebooks: Object.freeze([{ notebook_id: '92517', path: '/Users/avery.kim@northpeak.example/Campaign lift' }]),
    app: null,
    endpoint: null,
  }),
  dev: Object.freeze({
    jobs: Object.freeze([
      { job_id: '610', name: 'nightly_sales_etl_dev', schedule: 'Daily at 01:30 UTC', owner: 'data-platform@northpeak.example', tasks: ['transform_sales'] },
      { job_id: '611', name: 'customer_360_refresh_dev', schedule: 'Manual', owner: 'customer-data@northpeak.example', tasks: ['refresh_cust360'] },
    ]),
    pipelines: Object.freeze([{ pipeline_id: '1d2e3f40-5a6b-4c7d-8e9f-0000de7c3601', name: 'cust360_dlt_dev', prefix: 'de7c1e5a-7c4d-4f8e-9a6b' }]),
    warehouses: Object.freeze([
      { id: 'a1e2d3c4b5f60718', name: 'Dev Serverless', state: 'RUNNING', cluster_size: 'X-Small', warehouse_type: 'PRO', enable_serverless_compute: true, min_num_clusters: 1, max_num_clusters: 1, auto_stop_mins: 5 },
      { id: 'b2f3e4d5c6a70829', name: 'Dev Pro', state: 'STOPPED', cluster_size: '2X-Small', warehouse_type: 'PRO', enable_serverless_compute: false, min_num_clusters: 1, max_num_clusters: 1, auto_stop_mins: 10 },
    ]),
    clusters: Object.freeze({ shared: '0930-101010-devsh1a2', sandbox: '0930-101010-devsb3b4', jobA: '1015-030405-dvcl1c21', jobB: '1015-030405-dvcl2d32' }),
    notebooks: Object.freeze([{ notebook_id: '70311', path: '/Users/avery.kim@northpeak.example/Scratch' }]),
    app: null,
    endpoint: null,
  }),
  stage: Object.freeze({
    jobs: Object.freeze([
      { job_id: '710', name: 'nightly_sales_etl_stage', schedule: 'Daily at 01:15 UTC', owner: 'data-platform@northpeak.example', tasks: ['transform_sales'] },
      { job_id: '711', name: 'customer_360_refresh_stage', schedule: 'Daily at 03:30 UTC', owner: 'customer-data@northpeak.example', tasks: ['refresh_cust360'] },
    ]),
    pipelines: Object.freeze([{ pipeline_id: '2e3f4051-6b7c-4d8e-9fa0-0000574c3602', name: 'cust360_dlt_stage', prefix: '574c1e5a-7c4d-4f8e-9a6b' }]),
    warehouses: Object.freeze([
      { id: 'c3a4f5e6d7b8091a', name: 'Stage Serverless', state: 'RUNNING', cluster_size: 'Small', warehouse_type: 'PRO', enable_serverless_compute: true, min_num_clusters: 1, max_num_clusters: 1, auto_stop_mins: 5 },
      { id: 'd4b5a6f7e8c9102b', name: 'Stage Pro', state: 'STOPPED', cluster_size: 'Small', warehouse_type: 'PRO', enable_serverless_compute: false, min_num_clusters: 1, max_num_clusters: 1, auto_stop_mins: 10 },
    ]),
    clusters: Object.freeze({ shared: '0930-121212-stgsh5e6', sandbox: '0930-121212-stgsb7f8', jobA: '1015-040506-stcl1e21', jobB: '1015-040506-stcl2f32' }),
    notebooks: Object.freeze([{ notebook_id: '75122', path: '/Users/avery.kim@northpeak.example/Release checks' }]),
    app: null,
    endpoint: null,
  }),
});

/* ------------------------------------------------------------------ helpers */

function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;
const pad = (n, w = 2) => String(n).padStart(w, '0');
export const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const at = (date, minutes) => new Date(Date.parse(date + 'T00:00:00Z') + Math.round(minutes * 60000)).toISOString().slice(0, 19);
const tsMs = (s) => Date.parse(s + 'Z');
export const epochDayOf = (date) => Math.floor(Date.parse(date + 'T00:00:00Z') / DAY);
const hex = (key) => crypto.createHash('sha256').update(key).digest('hex');

export const jobRunId = (jobId, ed, seq = 0) => String(jobId) + String(ed).padStart(6, '0') + String(seq);
export const taskRunId = (jobRun, taskIndex) => jobRun + String(taskIndex + 1);
export const updateId = (pipeline, ed) => pipeline.prefix + '-' + String(ed).padStart(12, '0');
export function statementId(wsKey, ed, i) {
  const h = hex('stmt|' + wsKey + '|' + ed + '|' + i);
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-8' + h.slice(17, 20) + '-' + h.slice(20, 32);
}

/** Growth: value k days ago relative to today, for a monthly growth rate. */
const trend = (k, monthly) => Math.pow(1 + monthly, -k / 30);

/** The backfill day: the first weekday among 6, 5, 7, 4, 8 days ago (so it is "last week"). */
export function backfillDaysAgo(nowMs) {
  const todayMs = Date.parse(utcDate(nowMs) + 'T00:00:00Z');
  for (const k of [6, 5, 7, 4, 8]) {
    const wd = new Date(todayMs - k * DAY).getUTCDay();
    if (wd >= 1 && wd <= 5) return k;
  }
  return 6;
}

/** The most recent complete weekday (1–7 days ago): the Query History page shows that day. */
export function queryHistoryDaysAgo(nowMs) {
  const todayMs = Date.parse(utcDate(nowMs) + 'T00:00:00Z');
  for (let k = 1; k < 8; k++) {
    const wd = new Date(todayMs - k * DAY).getUTCDay();
    if (wd >= 1 && wd <= 5) return k;
  }
  return 1;
}

/** Query History page rows of that day: [index, warehouse, start minute, duration s, label]. */
export const QH_PAGE = Object.freeze([
  { i: 6, wh: 0, startMin: 14 * 60 + 20 + 10 / 60, dur: 64.0, user: 'merch-team@northpeak.example', sql: 'SELECT category, SUM(units) AS units FROM northpeak.sales.daily_store_sales WHERE sale_date >= …' },
  { i: 4, wh: 0, startMin: 11 * 60 + 15 + 3 / 60, dur: 37.9, user: 'avery.kim@northpeak.example', sql: 'SELECT store_id, stockout_rate FROM northpeak.supply.inventory_daily ORDER BY …' },
  { i: 3, wh: 0, startMin: 11 * 60 + 2 + 51 / 60, dur: 131.4, user: 'finance-bi@northpeak.example', sql: 'WITH margin AS (SELECT sku, SUM(net_sales - cogs) AS gross_margin FROM …' },
  { i: 2, wh: 0, startMin: 10 * 60 + 32 + 5 / 60, dur: 18.7, user: 'merch-team@northpeak.example', sql: 'SELECT region, COUNT(DISTINCT order_id) AS orders FROM northpeak.sales.orders …' },
  { i: 1, wh: 0, startMin: 10 * 60 + 31 + 40 / 60, dur: 4.2, user: 'store-ops-dashboard (app)', sql: 'SELECT * FROM northpeak.ops.store_alerts WHERE resolved = false LIMIT 100' },
  { i: 0, wh: 0, startMin: 10 * 60 + 5 + 12 / 60, dur: 768.3, user: 'exec-dashboards@northpeak.example', sql: 'SELECT d.week, s.region, s.store_id, SUM(s.net_sales) AS net_sales, … FROM northpeak.sales.daily_store_sales s JOIN …', heavy: true },
  { i: 5, wh: 1, startMin: 3 * 60 + 12 + 44 / 60, dur: 362.5, user: 'dbt-runner@northpeak.example', sql: 'MERGE INTO northpeak.sales.daily_store_sales t USING (SELECT …' },
]);

/* ------------------------------------------------------------------ dataset */

/**
 * @param {'prod'|'analytics'} wsKey
 * @param {{nowMs?:number, days?:number}} [o]
 * @returns {{nowMs, today, wsKey, backfillK, qhK, tables, runs}}
 */
export function buildStoryDataset(wsKey, o = {}) {
  const W = P(wsKey);
  const R = RESOURCES[wsKey];
  if (!W || !R) throw new Error('Unknown workspace ' + wsKey);
  const nowMs = o.nowMs === undefined ? Date.now() : o.nowMs;
  const days = o.days || DAYS;
  const today = utcDate(nowMs);
  const todayMs = Date.parse(today + 'T00:00:00Z');
  const r = rng({ prod: 20261015, analytics: 20261016, dev: 20261017, stage: 20261018 }[wsKey]);
  const noise = (spread) => 1 - spread + 2 * spread * r();
  const backfillK = backfillDaysAgo(nowMs);
  const qhK = queryHistoryDaysAgo(nowMs);
  let seq = 0;
  const usage = [];
  const pipelineUpdates = [];
  const taskRuns = [];
  const jobRuns = [];
  const history = [];
  const runs = []; // display facts for the fixture pages: {jobId, runId, k, start, end, launched, result}

  function u(x) {
    seq += 1;
    return {
      record_id: 'np-' + wsKey.slice(0, 1) + '-' + pad(seq, 7),
      account_id: ACCOUNT_ID,
      workspace_id: W.workspaceId,
      sku_name: x.sku,
      cloud: CLOUD,
      usage_unit: 'DBU',
      usage_start_time: x.start,
      usage_end_time: x.end,
      usage_date: x.start.slice(0, 10),
      usage_quantity: round(x.qty),
      record_type: 'ORIGINAL',
      billing_origin_product: x.product,
      usage_metadata: {
        job_id: x.job_id || null,
        job_run_id: x.job_run_id || null,
        dlt_pipeline_id: x.pipeline_id || null,
        dlt_update_id: x.update_id || null,
        warehouse_id: x.warehouse_id || null,
        cluster_id: x.cluster_id || null,
        notebook_id: x.notebook_id || null,
        notebook_path: x.notebook_path || null,
        app_id: x.app_id || null,
        app_name: x.app_name || null,
        job_name: x.job_name || null,
        endpoint_name: x.endpoint_name || null,
      },
      product_features: { is_photon: x.photon === true, is_serverless: x.serverless === true, sql_tier: x.sql_tier || null },
    };
  }

  /** Usage for [startMin, endMin) of `date`, split at hour boundaries, `dbu` spread evenly. */
  function sliced(date, startMin, endMin, dbu, base) {
    const total = endMin - startMin;
    let t = startMin;
    while (t < endMin) {
      const next = Math.min(endMin, (Math.floor(t / 60) + 1) * 60);
      usage.push(u(Object.assign({}, base, { start: at(date, t), end: at(date, next), qty: (dbu * (next - t)) / total })));
      t = next;
    }
  }

  /** One job run with its tasks; tasks = [[task_key, startMin, endMin], ...]. */
  function jobRun(job, date, k, runSeq, startMin, endMin, launched, tasks, result = 'SUCCEEDED') {
    const ed = epochDayOf(date);
    const id = jobRunId(job.job_id, ed, runSeq);
    jobRuns.push({ workspace_id: W.workspaceId, job_id: job.job_id, run_id: id, period_start_time: at(date, startMin), period_end_time: at(date, endMin), result_state: result, run_type: 'JOB_RUN' });
    tasks.forEach(([key, s, e], i) => taskRuns.push({ workspace_id: W.workspaceId, job_id: job.job_id, run_id: taskRunId(id, i), job_run_id: id, task_key: key, period_start_time: at(date, s), period_end_time: at(date, e), result_state: result }));
    runs.push({ jobId: job.job_id, runId: id, k, start: at(date, startMin), end: at(date, endMin), launched, result });
    return id;
  }

  for (let k = days - 1; k >= 0; k--) {
    const date = utcDate(todayMs - k * DAY);
    const ed = epochDayOf(date);
    const wd = new Date(date + 'T00:00:00Z').getUTCDay(); // 0 Sun … 6 Sat
    const weekday = wd >= 1 && wd <= 5;

    if (wsKey === 'prod') {
      const [ETL, C360, INV, MKT, FCST] = R.jobs;
      const [CUST360, CDC] = R.pipelines;
      const [BI, ETLWH, ADHOC] = R.warehouses;

      // nightly_sales_etl: 01:00, about 1 h 50 m on job compute, growing ~8 %/month.
      {
        const dur = 104 + 10 * r();
        const dbu = 1450 * trend(k, 0.06) * noise(0.06);
        const id = jobRun(ETL, date, k, 0, 60, 60 + dur, 'By scheduler', [['extract_pos', 60, 85], ['transform_sales', 85, 60 + dur - 22], ['publish_marts', 60 + dur - 22, 60 + dur]]);
        sliced(date, 60, 60 + dur, dbu, { sku: 'PREMIUM_JOBS_COMPUTE', product: 'JOBS', job_id: ETL.job_id, job_run_id: id, job_name: ETL.name, cluster_id: R.clusters.jobA, photon: true });
        if (k === backfillK) {
          // The backfill: launched manually at 09:12, 7 h 24 m, about 6.6× a nightly run.
          const s = 9 * 60 + 12;
          const e = s + 7 * 60 + 24;
          const bid = jobRun(ETL, date, k, 1, s, e, 'Manually', [['extract_pos', s, s + 70], ['transform_sales', s + 70, e - 40], ['publish_marts', e - 40, e]]);
          sliced(date, s, e, 9800 * noise(0.01), { sku: 'PREMIUM_JOBS_COMPUTE', product: 'JOBS', job_id: ETL.job_id, job_run_id: bid, job_name: ETL.name, cluster_id: R.clusters.jobB, photon: true });
        }
      }

      // customer_360_refresh: prepare_inputs on job compute, then refresh_cust360 triggers cust360_dlt.
      {
        const p1 = 18 + 4 * r();
        const p2 = 44 + 8 * r();
        const s = 180;
        const id = jobRun(C360, date, k, 0, s, s + p1 + p2, 'By scheduler', [['prepare_inputs', s, s + p1], ['refresh_cust360', s + p1, s + p1 + p2]]);
        sliced(date, s, s + p1, 260 * trend(k, 0.06) * noise(0.08), { sku: 'PREMIUM_JOBS_COMPUTE', product: 'JOBS', job_id: C360.job_id, job_run_id: id, job_name: C360.name, cluster_id: R.clusters.jobB });
        const upd = updateId(CUST360, ed);
        sliced(date, s + p1, s + p1 + p2, 560 * trend(k, 0.1) * noise(0.06), { sku: 'PREMIUM_DLT_ADVANCED_COMPUTE', product: 'DLT', pipeline_id: CUST360.pipeline_id, update_id: upd });
        pipelineUpdates.push({ workspace_id: W.workspaceId, pipeline_id: CUST360.pipeline_id, update_id: upd, trigger_type: 'JOB_TASK', trigger_details: { job_task: { job_id: C360.job_id, job_task_run_id: taskRunId(id, 1) } }, period_start_time: at(date, s + p1), period_end_time: at(date, s + p1 + p2), result_state: 'COMPLETED' });
      }

      // inventory_snapshot: small serverless job.
      {
        const id = jobRun(INV, date, k, 0, 300, 312, 'By scheduler', [['snapshot', 300, 312]]);
        sliced(date, 300, 312, 80 * noise(0.1), { sku: 'PREMIUM_JOBS_SERVERLESS_COMPUTE_US_EAST', product: 'JOBS', job_id: INV.job_id, job_run_id: id, job_name: INV.name, serverless: true });
      }

      // marketing_attribution: new job, started 55 days ago.
      if (k <= 55) {
        const id = jobRun(MKT, date, k, 0, 360, 410, 'By scheduler', [['attribute', 360, 410]]);
        sliced(date, 360, 410, 480 * noise(0.07), { sku: 'PREMIUM_JOBS_COMPUTE', product: 'JOBS', job_id: MKT.job_id, job_run_id: id, job_name: MKT.name, cluster_id: R.clusters.jobA });
      }

      // demand_forecast_weekly: Sundays.
      if (wd === 0) {
        const id = jobRun(FCST, date, k, 0, 480, 630, 'By scheduler', [['train', 480, 600], ['score', 600, 630]]);
        sliced(date, 480, 630, 1800 * trend(k, 0.05) * noise(0.05), { sku: 'PREMIUM_JOBS_COMPUTE', product: 'JOBS', job_id: FCST.job_id, job_run_id: id, job_name: FCST.name, cluster_id: R.clusters.jobA });
      }

      // orders_cdc_dlt: standalone pipeline, one update per day in four 6-hour chunks.
      {
        const upd = updateId(CDC, ed);
        for (const h of [0, 6, 12, 18]) usage.push(u({ sku: 'PREMIUM_DLT_CORE_COMPUTE', start: at(date, h * 60), end: at(date, h * 60 + 360), qty: 120 * trend(k, 0.06) * noise(0.08), product: 'DLT', pipeline_id: CDC.pipeline_id, update_id: upd }));
        pipelineUpdates.push({ workspace_id: W.workspaceId, pipeline_id: CDC.pipeline_id, update_id: upd, trigger_type: 'API_CALL', trigger_details: null, period_start_time: at(date, 0), period_end_time: at(date, 1440), result_state: 'COMPLETED' });
      }

      // BI Serverless (Large, 40 DBU/h per cluster): weekdays 07–19 with a busy-hour profile.
      const PROFILE = [0.45, 0.7, 0.95, 1.0, 0.9, 0.75, 0.8, 0.95, 1.0, 0.85, 0.6, 0.4];
      const hours = weekday ? PROFILE.map((p, i) => [7 + i, p]) : [[10, 0.35], [11, 0.4], [12, 0.3]];
      for (const [h, p] of hours) {
        const clusters = p >= 0.9 ? 1.4 : 1;
        usage.push(u({ sku: 'PREMIUM_SERVERLESS_SQL_COMPUTE_US_EAST', start: at(date, h * 60), end: at(date, h * 60 + 60), qty: 40 * p * clusters * trend(k, 0.09) * noise(0.05), product: 'SQL', warehouse_id: BI.id, serverless: true, sql_tier: 'PRO' }));
      }
      // ETL Pro (Small, 12 DBU/h): dbt runs 02–05 every day.
      for (const h of [2, 3, 4]) usage.push(u({ sku: 'PREMIUM_SQL_PRO_COMPUTE_US_EAST', start: at(date, h * 60), end: at(date, h * 60 + 60), qty: 12 * 0.9 * noise(0.05), product: 'SQL', warehouse_id: ETLWH.id, sql_tier: 'PRO' }));
      // Ad hoc Serverless: Tuesdays and Thursdays 14–16.
      if (wd === 2 || wd === 4) for (const h of [14, 15]) usage.push(u({ sku: 'PREMIUM_SERVERLESS_SQL_COMPUTE_US_EAST', start: at(date, h * 60), end: at(date, h * 60 + 60), qty: 12 * 0.5 * noise(0.1), product: 'SQL', warehouse_id: ADHOC.id, serverless: true, sql_tier: 'PRO' }));

      // Interactive: shared all-purpose cluster weekdays 09–18; serverless notebooks.
      if (weekday) {
        for (let h = 9; h < 18; h++) usage.push(u({ sku: 'PREMIUM_ALL_PURPOSE_COMPUTE', start: at(date, h * 60), end: at(date, h * 60 + 60), qty: 10 * trend(k, 0.05) * noise(0.1), product: 'ALL_PURPOSE', cluster_id: R.clusters.shared, photon: true }));
        usage.push(u({ sku: 'PREMIUM_ALL_PURPOSE_SERVERLESS_COMPUTE_US_EAST', start: at(date, 13 * 60), end: at(date, 15 * 60), qty: 25 * noise(0.15), product: 'INTERACTIVE', notebook_id: R.notebooks[0].notebook_id, notebook_path: R.notebooks[0].path, serverless: true }));
      }

      // Model serving, app, Genie (paid line on weekdays, free allowance daily).
      usage.push(u({ sku: 'PREMIUM_SERVERLESS_REAL_TIME_INFERENCE_US_EAST', start: at(date, 0), end: at(date, 1440), qty: 520 * noise(0.05), product: 'MODEL_SERVING', endpoint_name: R.endpoint, serverless: true }));
      usage.push(u({ sku: 'PREMIUM_APPS_COMPUTE_US_EAST', start: at(date, 0), end: at(date, 1440), qty: 24, product: 'APPS', app_id: R.app.app_id, app_name: R.app.app_name, serverless: true }));
      if (weekday) usage.push(u({ sku: 'PREMIUM_GENIE_SERVERLESS_US_EAST', start: at(date, 9 * 60), end: at(date, 18 * 60), qty: 12 * trend(k, 0.2) * noise(0.15), product: 'GENIE', serverless: true }));
      usage.push(u({ sku: 'GENIE_FREE_USAGE', start: at(date, 9 * 60), end: at(date, 18 * 60), qty: 2, product: 'GENIE', serverless: true }));

      // Query history (BI Serverless and ETL Pro), last 30 days on weekdays.
      if (k < 30 && weekday) {
        if (k === qhK) {
          for (const q of QH_PAGE) addQuery(q.i, R.warehouses[q.wh], date, q.startMin, q.dur, ed);
        } else {
          let i = 0;
          for (const h of [9, 11, 13, 15, 17]) {
            const m = Math.floor(r() * 40);
            addQuery(i++, BI, date, h * 60 + m, 20 + r() * 300, ed);
            addQuery(i++, BI, date, h * 60 + m + 2, 3 + r() * 40, ed);
          }
          addQuery(i++, ETLWH, date, 3 * 60 + 10, 200 + r() * 200, ed);
        }
      }
    } else if (wsKey === 'dev' || wsKey === 'stage') {
      // Lightweight: one nightly job, one triggered pipeline, a small serverless warehouse.
      const scale = wsKey === 'dev' ? 0.35 : 0.6;
      const [ETL, C360] = R.jobs;
      const [CUST] = R.pipelines;
      const [WH] = R.warehouses;
      {
        const id = jobRun(ETL, date, k, 0, 90, 130, 'By scheduler', [['transform_sales', 90, 130]]);
        sliced(date, 90, 130, 240 * scale * noise(0.1), { sku: 'PREMIUM_JOBS_COMPUTE', product: 'JOBS', job_id: ETL.job_id, job_run_id: id, job_name: ETL.name, cluster_id: R.clusters.jobA });
      }
      if (wsKey === 'stage' || wd === 3) {
        const id = jobRun(C360, date, k, 0, 210, 240, wsKey === 'dev' ? 'Manually' : 'By scheduler', [['refresh_cust360', 210, 240]]);
        const upd = updateId(CUST, ed);
        sliced(date, 210, 240, 200 * scale * noise(0.1), { sku: 'PREMIUM_DLT_ADVANCED_COMPUTE', product: 'DLT', pipeline_id: CUST.pipeline_id, update_id: upd });
        pipelineUpdates.push({ workspace_id: W.workspaceId, pipeline_id: CUST.pipeline_id, update_id: upd, trigger_type: 'JOB_TASK', trigger_details: { job_task: { job_id: C360.job_id, job_task_run_id: taskRunId(id, 0) } }, period_start_time: at(date, 210), period_end_time: at(date, 240), result_state: 'COMPLETED' });
      }
      if (weekday) for (const h of [10, 11, 14, 15]) usage.push(u({ sku: 'PREMIUM_SERVERLESS_SQL_COMPUTE_US_EAST', start: at(date, h * 60), end: at(date, h * 60 + 60), qty: 6 * scale * (0.5 + 0.5 * r()), product: 'SQL', warehouse_id: WH.id, serverless: true, sql_tier: 'PRO' }));
      if (weekday) usage.push(u({ sku: 'PREMIUM_ALL_PURPOSE_SERVERLESS_COMPUTE_US_EAST', start: at(date, 13 * 60), end: at(date, 14 * 60), qty: 8 * scale * noise(0.2), product: 'INTERACTIVE', notebook_id: R.notebooks[0].notebook_id, notebook_path: R.notebooks[0].path, serverless: true }));
    } else {
      // northpeak-analytics: a smaller marketing analytics workspace.
      const [SESS, CAMP] = R.jobs;
      const [CLICK] = R.pipelines;
      const [AN, REP] = R.warehouses;
      {
        const id = jobRun(SESS, date, k, 0, 120, 175, 'By scheduler', [['sessionize', 120, 175]]);
        sliced(date, 120, 175, 520 * trend(k, 0.07) * noise(0.07), { sku: 'PREMIUM_JOBS_COMPUTE', product: 'JOBS', job_id: SESS.job_id, job_run_id: id, job_name: SESS.name, cluster_id: R.clusters.jobA });
      }
      {
        const id = jobRun(CAMP, date, k, 0, 240, 262, 'By scheduler', [['rollup', 240, 262]]);
        sliced(date, 240, 262, 70 * noise(0.1), { sku: 'PREMIUM_JOBS_SERVERLESS_COMPUTE_US_EAST', product: 'JOBS', job_id: CAMP.job_id, job_run_id: id, job_name: CAMP.name, serverless: true });
      }
      {
        const upd = updateId(CLICK, ed);
        for (const h of [0, 12]) usage.push(u({ sku: 'PREMIUM_DLT_CORE_COMPUTE', start: at(date, h * 60), end: at(date, h * 60 + 720), qty: 110 * trend(k, 0.05) * noise(0.08), product: 'DLT', pipeline_id: CLICK.pipeline_id, update_id: upd }));
        pipelineUpdates.push({ workspace_id: W.workspaceId, pipeline_id: CLICK.pipeline_id, update_id: upd, trigger_type: 'API_CALL', trigger_details: null, period_start_time: at(date, 0), period_end_time: at(date, 1440), result_state: 'COMPLETED' });
      }
      const hours = weekday ? [9, 10, 11, 12, 13, 14, 15, 16] : [];
      for (const h of hours) usage.push(u({ sku: 'PREMIUM_SERVERLESS_SQL_COMPUTE_US_EAST', start: at(date, h * 60), end: at(date, h * 60 + 60), qty: 24 * (0.5 + 0.4 * r()) * trend(k, 0.06), product: 'SQL', warehouse_id: AN.id, serverless: true, sql_tier: 'PRO' }));
      if (wd === 1) usage.push(u({ sku: 'PREMIUM_SQL_PRO_COMPUTE_US_EAST', start: at(date, 7 * 60), end: at(date, 8 * 60), qty: 12 * 0.8, product: 'SQL', warehouse_id: REP.id, sql_tier: 'PRO' }));
      if (weekday) {
        usage.push(u({ sku: 'PREMIUM_ALL_PURPOSE_SERVERLESS_COMPUTE_US_EAST', start: at(date, 14 * 60), end: at(date, 16 * 60), qty: 18 * noise(0.2), product: 'INTERACTIVE', notebook_id: R.notebooks[0].notebook_id, notebook_path: R.notebooks[0].path, serverless: true }));
        usage.push(u({ sku: 'PREMIUM_GENIE_SERVERLESS_US_EAST', start: at(date, 9 * 60), end: at(date, 18 * 60), qty: 8 * noise(0.2), product: 'GENIE', serverless: true }));
      }
      usage.push(u({ sku: 'GENIE_FREE_USAGE', start: at(date, 9 * 60), end: at(date, 18 * 60), qty: 2, product: 'GENIE', serverless: true }));
      if (k < 30 && weekday) {
        let i = 0;
        for (const h of [10, 13, 15]) addQuery(i++, AN, date, h * 60 + Math.floor(r() * 40), 10 + r() * 200, ed);
      }
    }
  }

  function addQuery(i, wh, date, startMin, durSec, ed) {
    history.push({
      statement_id: statementId(wsKey, ed, i),
      workspace_id: W.workspaceId,
      execution_status: 'FINISHED',
      compute: { type: 'WAREHOUSE', warehouse_id: wh.id, cluster_id: null },
      start_time: at(date, startMin),
      end_time: at(date, startMin + durSec / 60),
      total_duration_ms: Math.round(durSec * 1000),
      execution_duration_ms: Math.round(durSec * 950),
      from_result_cache: false,
      statement_text: SENTINEL_SQL_TEXT,
    });
  }

  // Prices: one window from 2020 for every SKU; account prices at 85 % of list.
  const listPrices = [];
  const accountPrices = [];
  for (const [sku, price] of Object.entries(LIST_PRICES)) {
    const row = (account) => ({
      price_start_time: '2020-01-01T00:00:00',
      price_end_time: null,
      account_id: ACCOUNT_ID,
      sku_name: sku,
      cloud: CLOUD,
      currency_code: CURRENCY,
      usage_unit: 'DBU',
      pricing: account ? { default: String(round(price * ACCOUNT_DISCOUNT, 6)) } : { default: String(price), promotional: { default: String(price) }, effective_list: { default: String(price) } },
    });
    listPrices.push(row(false));
    accountPrices.push(row(true));
  }

  const past = (t) => tsMs(t) <= nowMs;
  return {
    nowMs,
    today,
    wsKey,
    backfillK,
    qhK,
    runs: runs.filter((x) => past(x.end)),
    tables: {
      'billing.usage': usage.filter((x) => past(x.usage_end_time)),
      'billing.list_prices': listPrices,
      'billing.account_prices': accountPrices,
      'lakeflow.pipeline_update_timeline': pipelineUpdates.filter((x) => past(x.period_end_time)),
      'lakeflow.job_task_run_timeline': taskRuns.filter((x) => past(x.period_end_time)),
      'lakeflow.job_run_timeline': jobRuns.filter((x) => past(x.period_end_time)),
      'query.history': history.filter((x) => past(x.end_time)),
    },
  };
}

/** Same sentinel as the fixture: the extension must never select statement_text. */
export const SENTINEL_SQL_TEXT = 'SENTINEL_SQL_TEXT_MUST_NEVER_BE_READ';

/* ------------------------------------------------------------------ independent cost math */

/** Σ quantity × list price (GENIE_FREE_USAGE is free) over rows matching `pred`. */
export function listCost(dataset, pred) {
  let total = 0;
  for (const x of dataset.tables['billing.usage']) {
    if (!pred(x)) continue;
    if (x.sku_name === 'GENIE_FREE_USAGE') continue;
    const p = LIST_PRICES[x.sku_name];
    if (p === undefined) throw new Error('Unpriced SKU ' + x.sku_name);
    total += x.usage_quantity * p;
  }
  return total;
}

/** Complete-UTC-day window: [today − days, today). */
export function window(dataset, days, offset = 0) {
  const todayMs = Date.parse(dataset.today + 'T00:00:00Z');
  return { start: utcDate(todayMs - (days + offset) * DAY), endExclusive: utcDate(todayMs - offset * DAY) };
}

export const inWindow = (w) => (x) => x.usage_date >= w.start && x.usage_date < w.endExclusive;

/* ------------------------------------------------------------------ fixture page values */

const HTML_DATE = (ts) => new Date(Date.parse(ts + 'Z')).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) + ' UTC';
const SHORT_DATE = (ts) => new Date(Date.parse(ts + 'Z')).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });

function runLength(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return h + 'h ' + m + 'm';
  return m ? m + 'm ' + (s % 60) + 's' : s + 's';
}

function queryLength(sec) {
  if (sec < 60) return sec.toFixed(1) + ' s';
  const m = Math.floor(sec / 60);
  return m + 'm ' + Math.round(sec - m * 60) + 's';
}

/**
 * {{NAME}} values for local/video/fragments/*.html and local/video/shell.html (HTML-escaped by
 * the fixture server). Derived from the dataset rows, so every link points at billed data.
 */
export function storyTemplateValues(dataset) {
  const W = P(dataset.wsKey);
  const R = RESOURCES[dataset.wsKey];
  const v = {
    COMPANY,
    WS_NAME: W.name,
    WS_ID: W.workspaceId,
    WS_HOST: W.host,
    USER_NAME: W.user,
    USER_INITIALS: W.initials,
  };
  const other = dataset.wsKey === 'prod' ? WORKSPACES.analytics : WORKSPACES.prod;
  v.OTHER_WS_NAME = other.name;
  R.jobs.forEach((j, i) => {
    v['JOB_' + (i + 1)] = j.job_id;
    v['JOB_' + (i + 1) + '_NAME'] = j.name;
    v['JOB_' + (i + 1) + '_SCHEDULE'] = j.schedule;
    v['JOB_' + (i + 1) + '_OWNER'] = j.owner;
  });
  R.pipelines.forEach((p, i) => {
    v['PIPELINE_' + (i + 1)] = p.pipeline_id;
    v['PIPELINE_' + (i + 1) + '_NAME'] = p.name;
    const upd = dataset.tables['lakeflow.pipeline_update_timeline'].find((u) => u.pipeline_id === p.pipeline_id);
    const job = upd && upd.trigger_type === 'JOB_TASK' ? R.jobs.find((j) => j.job_id === upd.trigger_details.job_task.job_id) : null;
    v['PIPELINE_' + (i + 1) + '_TRIGGER'] = job ? 'Triggered by ' + job.name : 'Continuous';
  });
  R.warehouses.forEach((w, i) => {
    v['WH_' + (i + 1)] = w.id;
    v['WH_' + (i + 1) + '_NAME'] = w.name;
    v['WH_' + (i + 1) + '_SIZE'] = w.cluster_size;
    v['WH_' + (i + 1) + '_STATE'] = w.state === 'RUNNING' ? 'Running' : 'Stopped';
    v['WH_' + (i + 1) + '_TYPE'] = w.enable_serverless_compute ? 'Serverless' : w.warehouse_type === 'PRO' ? 'Pro' : 'Classic';
  });

  // Runs list of job 1 (newest first) and of job 2: 9 and 6 rows.
  const runsOf = (jobId, n) => dataset.runs.filter((x) => x.jobId === jobId && x.k >= 1).sort((a, b) => tsMs(b.start) - tsMs(a.start)).slice(0, n);
  const fill = (prefix, list) => {
    const longest = Math.max(...list.map((x) => tsMs(x.end) - tsMs(x.start)));
    list.forEach((x, i) => {
      const n = prefix + (i + 1);
      const ms = tsMs(x.end) - tsMs(x.start);
      v[n] = x.runId;
      v[n + '_START'] = HTML_DATE(x.start);
      v[n + '_DURATION'] = runLength(ms);
      v[n + '_LAUNCHED'] = x.launched;
      v[n + '_H'] = String(Math.max(4, Math.round((72 * ms) / longest))); // run chart bar height (px)
      v[n + '_W'] = String(Math.max(6, Math.round((160 * ms) / longest))); // duration bar width (px)
    });
  };
  if (R.jobs[0]) fill('J1_RUN_', runsOf(R.jobs[0].job_id, 9));
  if (R.jobs[1]) fill('J2_RUN_', runsOf(R.jobs[1].job_id, 6));
  if (dataset.wsKey === 'prod') {
    const backfill = dataset.runs.find((x) => x.jobId === R.jobs[0].job_id && x.k === dataset.backfillK && x.launched === 'Manually');
    v.BACKFILL_RUN = backfill ? backfill.runId : '';
    // Query History page rows (statement links of the most recent complete weekday).
    const qhDate = utcDate(Date.parse(dataset.today + 'T00:00:00Z') - dataset.qhK * DAY);
    const ed = epochDayOf(qhDate);
    v.QH_DATE = new Date(Date.parse(qhDate + 'T00:00:00Z')).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
    QH_PAGE.forEach((q, n) => {
      const row = dataset.tables['query.history'].find((h) => h.statement_id === statementId(dataset.wsKey, ed, q.i));
      if (!row) throw new Error('Query History row ' + q.i + ' is not in the dataset');
      const key = 'QH_' + (n + 1);
      v[key] = row.statement_id;
      v[key + '_START'] = SHORT_DATE(row.start_time);
      v[key + '_DURATION'] = queryLength(row.total_duration_ms / 1000);
      v[key + '_WH'] = R.warehouses[q.wh].id;
      v[key + '_WH_NAME'] = R.warehouses[q.wh].name;
      v[key + '_USER'] = q.user;
      v[key + '_SQL'] = q.sql;
    });
  }
  return Object.freeze(v);
}

/* ------------------------------------------------------------------ monitor REST snapshot */

/**
 * Monitor data relative to `nowMs` (Jobs API 2.2, Pipelines 2.0, Clusters 2.1 shapes).
 * `live.c360FailedAt` (ms) turns today's running customer_360_refresh run into a FAILED run
 * that ended then (the capture sets it between two monitor polls).
 */
export function storyMonitorSnapshot(wsKey, nowMs, origin, live = {}) {
  const W = P(wsKey);
  const R = RESOURCES[wsKey];
  const min = 60000;
  const today = utcDate(nowMs);
  const ed = epochDayOf(today);
  const url = (jobId, runId) => origin + '/jobs/' + jobId + '/runs/' + runId + '?o=' + W.workspaceId;
  const user = 'avery.kim@northpeak.example';
  const done = (job, runId, startMs, endMs, ok, message) => ({
    job_id: Number(job.job_id),
    run_id: Number(runId),
    run_name: job.name,
    creator_user_name: user,
    run_type: 'JOB_RUN',
    trigger: 'PERIODIC',
    start_time: startMs,
    end_time: endMs,
    run_duration: endMs - startMs,
    status: ok ? { state: 'TERMINATED', termination_details: { code: 'SUCCESS', type: 'SUCCESS', message: '' } } : { state: 'TERMINATED', termination_details: { code: 'RUN_EXECUTION_ERROR', type: 'CLIENT_ERROR', message } },
    state: ok ? { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS', state_message: '' } : { life_cycle_state: 'TERMINATED', result_state: 'FAILED', state_message: message },
    run_page_url: url(job.job_id, runId),
  });
  const active = (job, runId, startMs, state) => ({
    job_id: Number(job.job_id),
    run_id: Number(runId),
    run_name: job.name,
    creator_user_name: user,
    run_type: 'JOB_RUN',
    trigger: state === 'QUEUED' ? 'ONE_TIME' : 'PERIODIC',
    start_time: startMs,
    end_time: 0,
    run_duration: 0,
    status: state === 'QUEUED' ? { state: 'QUEUED', queue_details: { code: 'ACTIVE_RUNS_LIMIT_REACHED', message: 'Queued behind an active run.' } } : { state: 'RUNNING' },
    state: { life_cycle_state: state, state_message: state === 'QUEUED' ? 'Queued' : 'In run' },
    run_page_url: url(job.job_id, runId),
  });
  const runs = [];
  const pipelines = [];
  const iso = (ms) => new Date(ms).toISOString();
  let clusters;
  if (wsKey === 'prod') {
    const [ETL, C360, INV, MKT, FCST] = R.jobs;
    const [CUST360, CDC] = R.pipelines;
    const c360Run = jobRunId(C360.job_id, ed, 2);
    const c360Start = nowMs - 38 * min;
    if (Number.isFinite(live.c360FailedAt)) runs.push(done(C360, c360Run, c360Start, live.c360FailedAt, false, 'Task refresh_cust360 failed: pipeline cust360_dlt update failed (schema mismatch in silver.customer_profiles).'));
    else runs.push(active(C360, c360Run, c360Start, 'RUNNING'));
    runs.push(active(MKT, jobRunId(MKT.job_id, ed, 2), nowMs - 14 * min, 'RUNNING'));
    runs.push(active(INV, jobRunId(INV.job_id, ed, 2), nowMs - 2 * min, 'RUNNING'));
    runs.push(active(FCST, jobRunId(FCST.job_id, ed, 2), nowMs - 1 * min, 'QUEUED'));
    runs.push(done(ETL, jobRunId(ETL.job_id, ed, 2), nowMs - 7 * 60 * min, nowMs - 5 * 60 * min - 12 * min, true));
    runs.push(done(INV, jobRunId(INV.job_id, ed, 3), nowMs - 4 * 60 * min, nowMs - 4 * 60 * min + 11 * min, true));
    runs.push(done(C360, jobRunId(C360.job_id, ed - 1, 2), nowMs - 22 * 60 * min, nowMs - 21 * 60 * min, true));
    runs.push(done(MKT, jobRunId(MKT.job_id, ed - 1, 2), nowMs - 20 * 60 * min, nowMs - 19 * 60 * min - 10 * min, true));
    const c360Failed = Number.isFinite(live.c360FailedAt);
    pipelines.push({ pipeline_id: CUST360.pipeline_id, name: CUST360.name, state: c360Failed ? 'FAILED' : 'RUNNING', health: c360Failed ? 'UNHEALTHY' : 'HEALTHY', creator_user_name: user, run_as_user_name: user, latest_updates: [{ update_id: updateId(CUST360, ed + 1), state: c360Failed ? 'FAILED' : 'RUNNING', creation_time: iso(c360Start + 19 * min) }] });
    pipelines.push({ pipeline_id: CDC.pipeline_id, name: CDC.name, state: 'RUNNING', health: 'HEALTHY', creator_user_name: user, run_as_user_name: user, latest_updates: [{ update_id: updateId(CDC, ed), state: 'RUNNING', creation_time: iso(Date.parse(today + 'T00:00:00Z')) }] });
    clusters = [
      { cluster_id: R.clusters.shared, cluster_name: 'shared-analytics', state: 'RUNNING', state_message: '', cluster_source: 'UI', creator_user_name: user, spark_version: '16.4.x-scala2.12', node_type_id: 'i3.2xlarge', driver_node_type_id: 'i3.2xlarge', autoscale: { min_workers: 2, max_workers: 8 }, autotermination_minutes: 60, start_time: nowMs - 260 * min, data_security_mode: 'USER_ISOLATION' },
      { cluster_id: R.clusters.jobA, cluster_name: 'job-433-run-' + jobRunId(MKT.job_id, ed, 2), state: 'RUNNING', state_message: '', cluster_source: 'JOB', creator_user_name: user, spark_version: '16.4.x-scala2.12', node_type_id: 'i3.2xlarge', driver_node_type_id: 'i3.2xlarge', num_workers: 6, start_time: nowMs - 14 * min, data_security_mode: 'SINGLE_USER' },
      { cluster_id: R.clusters.jobB, cluster_name: 'job-418-run-' + c360Run, state: c360Failed ? 'TERMINATED' : 'RUNNING', state_message: c360Failed ? 'Job run finished.' : '', cluster_source: 'JOB', creator_user_name: user, spark_version: '16.4.x-scala2.12', node_type_id: 'r6id.2xlarge', num_workers: 4, start_time: c360Start, ...(c360Failed ? { terminated_time: live.c360FailedAt, termination_reason: { code: 'JOB_FINISHED', type: 'SUCCESS' } } : {}), data_security_mode: 'SINGLE_USER' },
      { cluster_id: R.clusters.sandbox, cluster_name: 'ml-sandbox', state: 'TERMINATED', state_message: 'Inactive cluster terminated (inactive for 60 minutes).', cluster_source: 'UI', creator_user_name: user, spark_version: '16.4.x-cpu-ml-scala2.12', node_type_id: 'm5d.xlarge', num_workers: 0, start_time: nowMs - 600 * min, terminated_time: nowMs - 300 * min, termination_reason: { code: 'INACTIVITY', type: 'SUCCESS' } },
    ];
  } else if (wsKey === 'dev' || wsKey === 'stage') {
    const [ETL] = R.jobs;
    runs.push(done(ETL, jobRunId(ETL.job_id, ed, 2), nowMs - 8 * 60 * min, nowMs - 7 * 60 * min, true));
    clusters = [];
  } else {
    const [SESS, CAMP] = R.jobs;
    const [CLICK] = R.pipelines;
    runs.push(active(CAMP, jobRunId(CAMP.job_id, ed, 2), nowMs - 6 * min, 'RUNNING'));
    runs.push(done(SESS, jobRunId(SESS.job_id, ed, 2), nowMs - 9 * 60 * min, nowMs - 8 * 60 * min, true));
    pipelines.push({ pipeline_id: CLICK.pipeline_id, name: CLICK.name, state: 'RUNNING', health: 'HEALTHY', creator_user_name: user, run_as_user_name: user, latest_updates: [{ update_id: updateId(CLICK, ed), state: 'RUNNING', creation_time: iso(Date.parse(today + 'T00:00:00Z')) }] });
    clusters = [{ cluster_id: R.clusters.shared, cluster_name: 'analyst-shared', state: 'RUNNING', state_message: '', cluster_source: 'UI', creator_user_name: user, spark_version: '16.4.x-scala2.12', node_type_id: 'i3.xlarge', autoscale: { min_workers: 1, max_workers: 4 }, autotermination_minutes: 45, start_time: nowMs - 120 * min, data_security_mode: 'USER_ISOLATION' }];
  }
  runs.sort((a, b) => b.start_time - a.start_time || b.run_id - a.run_id);
  return { runs, pipelines, clusters };
}

/* ------------------------------------------------------------------ Genie (computed answers) */

export const GENIE_SPACES = Object.freeze({
  prod: Object.freeze([
    { space_id: '6e1d4c0a9b2f4e7d8a3c5b1f0e2d4a01', title: 'Platform ops', description: 'Jobs, pipelines, warehouses and billing for northpeak-prod (system tables).', warehouse_id: RESOURCES.prod.warehouses[0].id },
    { space_id: '6e1d4c0a9b2f4e7d8a3c5b1f0e2d4a02', title: 'Revenue analytics', description: 'Orders, revenue and customers by region and channel (northpeak.sales).', warehouse_id: RESOURCES.prod.warehouses[0].id },
  ]),
  analytics: Object.freeze([
    { space_id: '7f2e5d1b0c3a4f8e9b4d6c2a1f3e5b01', title: 'Marketing insights', description: 'Sessions, conversions and campaign spend by channel (northpeak.marketing).', warehouse_id: RESOURCES.analytics.warehouses[0].id },
    { space_id: '7f2e5d1b0c3a4f8e9b4d6c2a1f3e5b02', title: 'Store performance', description: 'Store traffic, sales per square foot and stockouts (northpeak.stores).', warehouse_id: RESOURCES.analytics.warehouses[0].id },
  ]),
  dev: Object.freeze([]),
  stage: Object.freeze([]),
});

/** Questions the capture asks (and the sidepanel's follow-up chips suggest). */
export const QUESTIONS = Object.freeze({
  jobsIncrease: "Which jobs drove last week's compute increase?",
  dailyCost: 'Show daily compute cost for the last 2 weeks',
  computeHeadline: 'What were the headline compute numbers for the last 30 days?',
  revenueRegion: 'What was revenue by region last month?',
  revenueWeekly: 'Show weekly revenue for the last 12 weeks',
  revenueHeadline: 'What were the headline numbers last month?',
  sessionsChannel: 'Which channels drove sessions last week?',
  sessionsDaily: 'Show daily sessions and conversions for the last 2 weeks',
});

/** Synthetic sales and marketing tables in an attached `northpeak` catalog (DuckDB). */
async function createBusinessTables(engine, dataset) {
  const todayMs = Date.parse(dataset.today + 'T00:00:00Z');
  const r = rng(dataset.wsKey === 'prod' ? 515 : 616);
  await engine.exec("ATTACH ':memory:' AS northpeak");
  await engine.exec('CREATE SCHEMA northpeak.sales; CREATE SCHEMA northpeak.marketing');
  await engine.exec('CREATE TABLE northpeak.sales.orders_daily (order_date DATE, region VARCHAR, channel VARCHAR, orders BIGINT, revenue_usd DECIMAL(18,2), customers BIGINT)');
  await engine.exec('CREATE TABLE northpeak.marketing.sessions_daily (session_date DATE, channel VARCHAR, sessions BIGINT, conversions BIGINT, spend_usd DECIMAL(18,2))');
  const regions = [['Northeast', 1.25], ['West', 1.1], ['Midwest', 0.85], ['Southeast', 0.95], ['Online', 1.4]];
  const rows = [];
  for (let k = 120; k >= 1; k--) {
    const date = utcDate(todayMs - k * DAY);
    const wd = new Date(date + 'T00:00:00Z').getUTCDay();
    const weekend = wd === 0 || wd === 6 ? 1.35 : 1;
    const season = 1 + 0.18 * (1 - k / 120);
    for (const [region, w] of regions) {
      for (const [channel, cw] of [['Stores', region === 'Online' ? 0 : 0.72], ['Web', region === 'Online' ? 0.8 : 0.2], ['App', region === 'Online' ? 0.2 : 0.08]]) {
        if (!cw) continue;
        const orders = Math.round(980 * w * cw * weekend * season * (0.9 + 0.2 * r()));
        const aov = (channel === 'Stores' ? 46 : 58) * (0.95 + 0.1 * r());
        rows.push(`(DATE '${date}', '${region}', '${channel}', ${orders}, ${(orders * aov).toFixed(2)}, ${Math.round(orders * 0.82)})`);
      }
    }
  }
  for (let i = 0; i < rows.length; i += 400) await engine.exec('INSERT INTO northpeak.sales.orders_daily VALUES ' + rows.slice(i, i + 400).join(', '));
  const mrows = [];
  for (let k = 60; k >= 1; k--) {
    const date = utcDate(todayMs - k * DAY);
    const wd = new Date(date + 'T00:00:00Z').getUTCDay();
    const weekend = wd === 0 || wd === 6 ? 0.72 : 1;
    const campaign = k === 5 || k === 6 ? (k === 6 ? 1.38 : 1.22) : 1; // autumn email + social push
    for (const [channel, base, cpc] of [['Paid search', 42000, 0.62], ['Social', 31000, 0.41], ['Email', 18500, 0], ['Organic', 56000, 0], ['Affiliates', 9200, 0.85]]) {
      const lift = channel === 'Email' || channel === 'Social' ? campaign : 1 + (campaign - 1) / 3;
      const sessions = Math.round(base * (1 + 0.1 * (1 - k / 60)) * weekend * lift * (0.95 + 0.1 * r()));
      mrows.push(`(DATE '${date}', '${channel}', ${sessions}, ${Math.round(sessions * (0.021 + 0.01 * r()))}, ${(sessions * cpc).toFixed(2)})`);
    }
  }
  await engine.exec('INSERT INTO northpeak.marketing.sessions_daily VALUES ' + mrows.join(', '));
  // Names for system.lakeflow joins (the real system tables have these columns).
  await engine.exec('CREATE TABLE lakeflow.jobs (workspace_id VARCHAR, job_id VARCHAR, name VARCHAR)');
  await engine.exec('CREATE TABLE lakeflow.pipelines (workspace_id VARCHAR, pipeline_id VARCHAR, name VARCHAR)');
  const R = RESOURCES[dataset.wsKey];
  const W = P(dataset.wsKey);
  await engine.exec('INSERT INTO lakeflow.jobs VALUES ' + R.jobs.map((j) => `('${W.workspaceId}', '${j.job_id}', '${j.name}')`).join(', '));
  await engine.exec('INSERT INTO lakeflow.pipelines VALUES ' + R.pipelines.map((p) => `('${W.workspaceId}', '${p.pipeline_id}', '${p.name}')`).join(', '));
}

/** DuckDB values in Statement API string form ('YYYY-MM-DD' dates, ISO timestamps). */
function apiValue(v, type) {
  if (v === null || v === undefined) return null;
  if (type === 'DATE' && /^\{"days":/.test(v)) return utcDate(JSON.parse(v).days * DAY);
  if (type === 'TIMESTAMP' && /^\{"micros":/.test(v)) return new Date(Number(BigInt(JSON.parse(v).micros) / 1000n)).toISOString();
  return v;
}

async function run(engine, sql) {
  const res = await engine.execute({ statement: sql });
  const cols = res.manifest.schema.columns.map((c) => [c.name, c.type_name]);
  const rows = res.result.data_array.map((row) => row.map((v, i) => apiValue(v, cols[i][1])));
  return { columns: cols, rows };
}

const usd0 = (n) => '$' + Math.round(Number(n)).toLocaleString('en-US');
const usdK = (n) => (Math.abs(n) >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : usd0(n));
const fmtDay = (d) => new Date(Date.parse(d + 'T00:00:00Z')).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

/**
 * Run every canned answer's SQL on the workspace's engine once (after its tables are loaded)
 * and return a synchronous genieAnswer(spaceId, question) for the fixture server. Each answer's
 * text is written from its own result rows.
 */
export async function prepareGenie(engine, dataset) {
  await createBusinessTables(engine, dataset);
  const W = P(dataset.wsKey);
  const today = dataset.today;
  const d = (k) => utcDate(Date.parse(today + 'T00:00:00Z') - k * DAY);
  const priced = (from, to, extra = '') => `WITH priced AS (
  SELECT u.usage_date, u.billing_origin_product,
         COALESCE(u.usage_metadata.job_id, u.usage_metadata.dlt_pipeline_id) AS resource_id,
         u.usage_quantity,
         CAST(u.usage_quantity AS DOUBLE) * CAST(p.pricing.effective_list.default AS DOUBLE) AS cost_usd
  FROM system.billing.usage u
  JOIN system.billing.list_prices p
    ON p.sku_name = u.sku_name AND p.cloud = u.cloud AND p.usage_unit = u.usage_unit
   AND u.usage_end_time >= p.price_start_time
   AND (p.price_end_time IS NULL OR u.usage_end_time < p.price_end_time)
  WHERE u.workspace_id = '${W.workspaceId}'
    AND u.usage_date >= DATE '${from}' AND u.usage_date < DATE '${to}'${extra}
)`;
  const answers = new Map(); // key → answer
  const space = GENIE_SPACES[dataset.wsKey];

  if (dataset.wsKey === 'prod') {
    // 1. Which jobs drove last week's compute increase? (bars)
    {
      const sql = `${priced(d(14), today, "\n    AND u.billing_origin_product IN ('JOBS', 'DLT')")}
SELECT r.name AS job_or_pipeline,
       ROUND(SUM(CASE WHEN usage_date >= DATE '${d(7)}' THEN cost_usd ELSE 0 END)
           - SUM(CASE WHEN usage_date < DATE '${d(7)}' THEN cost_usd ELSE 0 END), 2) AS change_usd,
       ROUND(SUM(CASE WHEN usage_date >= DATE '${d(7)}' THEN cost_usd ELSE 0 END), 2) AS last_7_days_usd,
       ROUND(SUM(CASE WHEN usage_date < DATE '${d(7)}' THEN cost_usd ELSE 0 END), 2) AS prior_7_days_usd
FROM priced
JOIN (SELECT job_id AS resource_id, name FROM system.lakeflow.jobs
      UNION ALL
      SELECT pipeline_id AS resource_id, name FROM system.lakeflow.pipelines) r
  USING (resource_id)
GROUP BY r.name
ORDER BY change_usd DESC
LIMIT 5`;
      const res = await run(engine, sql);
      const top = res.rows[0];
      const second = res.rows[1];
      const total = res.rows.reduce((s, x) => s + Number(x[1]), 0);
      const backfillDate = d(dataset.backfillK);
      answers.set('jobsIncrease', {
        text: `**${top[0]}** drove most of last week's increase: **+${usd0(top[1])}** over the week before (${usd0(top[3])} → ${usd0(top[2])}).\n\n- A manual backfill run on ${fmtDay(backfillDate)} accounts for most of it.\n- ${second[0]} added ${usd0(second[1])} as its daily volume grew.\n- Together, these ${res.rows.length} jobs and pipelines rose by ${usd0(total)}.`,
        title: 'Cost change by job and pipeline, last 7 days vs the 7 before',
        description: 'List-price cost from system.billing.usage for jobs and pipelines, complete UTC days.',
        sql,
        columns: res.columns,
        rows: res.rows,
        suggested: [QUESTIONS.dailyCost, QUESTIONS.computeHeadline],
      });
    }
    // 2. Daily compute cost, last 14 days (line).
    {
      const sql = `${priced(d(14), today)}
SELECT usage_date, ROUND(SUM(cost_usd), 2) AS cost_usd
FROM priced
GROUP BY usage_date
ORDER BY usage_date`;
      const res = await run(engine, sql);
      const vals = res.rows.map((x) => Number(x[1]));
      const avg = vals.reduce((s, x) => s + x, 0) / vals.length;
      const peak = res.rows.reduce((a, b) => (Number(b[1]) > Number(a[1]) ? b : a));
      answers.set('dailyCost', {
        text: `Daily compute cost averaged **${usd0(avg)}** over the last 14 days.\n\nThe peak was **${usd0(peak[1])} on ${fmtDay(peak[0])}**, the day of the nightly_sales_etl backfill. Weekends run lower because BI Serverless is mostly idle.`,
        title: 'Daily compute cost, last 14 days',
        description: 'List-price cost per UTC day from system.billing.usage, all products.',
        sql,
        columns: res.columns,
        rows: res.rows,
        suggested: [QUESTIONS.computeHeadline, QUESTIONS.jobsIncrease],
      });
    }
    // 3. Headline compute numbers, last 30 days (KPI tiles).
    {
      const sql = `${priced(d(30), today)}
SELECT ROUND(SUM(cost_usd), 2) AS compute_cost_usd,
       ROUND(SUM(usage_quantity), 0) AS total_dbus,
       ROUND(SUM(CASE WHEN billing_origin_product = 'SQL' THEN cost_usd ELSE 0 END), 2) AS sql_warehouse_cost_usd,
       ROUND(SUM(CASE WHEN billing_origin_product IN ('JOBS', 'DLT') THEN cost_usd ELSE 0 END), 2) AS jobs_and_pipelines_cost_usd
FROM priced`;
      const res = await run(engine, sql);
      const [cost, dbus, sqlCost, jobs] = res.rows[0];
      answers.set('computeHeadline', {
        text: `In the last 30 complete days, compute cost **${usdK(Number(cost))}** at list price across ${Number(dbus).toLocaleString('en-US')} DBUs.\n\nJobs and pipelines were ${usd0(jobs)}; SQL warehouses were ${usd0(sqlCost)}.`,
        title: 'Headline compute numbers, last 30 days',
        description: 'Totals from system.billing.usage at list price, complete UTC days.',
        sql,
        columns: res.columns,
        rows: res.rows,
        suggested: [QUESTIONS.dailyCost, QUESTIONS.jobsIncrease],
      });
    }
  }

  // Revenue analytics (prod) and Store performance / Marketing insights (analytics).
  const firstOfMonth = (ms) => utcDate(Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), 1));
  const todayMs = Date.parse(today + 'T00:00:00Z');
  const monthStart = firstOfMonth(todayMs);
  const lastMonthStart = firstOfMonth(Date.parse(monthStart + 'T00:00:00Z') - DAY);
  const monthName = new Date(Date.parse(lastMonthStart + 'T00:00:00Z')).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long' });
  {
    const sql = `SELECT region,
       ROUND(SUM(revenue_usd), 0) AS revenue_usd,
       SUM(orders) AS orders
FROM northpeak.sales.orders_daily
WHERE order_date >= DATE '${lastMonthStart}' AND order_date < DATE '${monthStart}'
GROUP BY region
ORDER BY revenue_usd DESC`;
    const res = await run(engine, sql);
    const total = res.rows.reduce((s, x) => s + Number(x[1]), 0);
    answers.set('revenueRegion', {
      text: `Revenue in ${monthName} was **${usdK(total)}** across ${res.rows.length} regions.\n\n- **${res.rows[0][0]}** led with ${usdK(Number(res.rows[0][1]))}.\n- ${res.rows[res.rows.length - 1][0]} was smallest at ${usdK(Number(res.rows[res.rows.length - 1][1]))}.`,
      title: 'Revenue by region, ' + monthName,
      description: 'Sums northpeak.sales.orders_daily per region for the previous calendar month.',
      sql,
      columns: res.columns,
      rows: res.rows,
      suggested: [QUESTIONS.revenueWeekly, QUESTIONS.revenueHeadline],
    });
  }
  {
    const sql = `SELECT CAST(date_trunc('week', order_date) AS DATE) AS week_start,
       ROUND(SUM(revenue_usd), 0) AS revenue_usd
FROM northpeak.sales.orders_daily
WHERE order_date >= DATE '${utcDate(todayMs - 12 * 7 * DAY - ((new Date(todayMs).getUTCDay() + 6) % 7) * DAY)}'
  AND order_date < DATE '${utcDate(todayMs - ((new Date(todayMs).getUTCDay() + 6) % 7) * DAY)}'
GROUP BY 1
ORDER BY 1`;
    const res = await run(engine, sql);
    const first = Number(res.rows[0][1]);
    const last = Number(res.rows[res.rows.length - 1][1]);
    answers.set('revenueWeekly', {
      text: `Weekly revenue grew from **${usdK(first)}** to **${usdK(last)}** over the last ${res.rows.length} weeks (${(((last - first) / first) * 100).toFixed(1)}%).`,
      title: 'Weekly revenue, last 12 weeks',
      description: 'Sums northpeak.sales.orders_daily per ISO week (weeks start on Monday).',
      sql,
      columns: res.columns,
      rows: res.rows,
      suggested: [QUESTIONS.revenueHeadline, QUESTIONS.revenueRegion],
    });
  }
  {
    const sql = `SELECT ROUND(SUM(revenue_usd), 2) AS total_revenue_usd,
       SUM(orders) AS orders,
       SUM(customers) AS customers,
       ROUND(SUM(revenue_usd) / SUM(orders), 2) AS avg_order_value_usd
FROM northpeak.sales.orders_daily
WHERE order_date >= DATE '${lastMonthStart}' AND order_date < DATE '${monthStart}'`;
    const res = await run(engine, sql);
    const [rev, orders, customers, aov] = res.rows[0];
    answers.set('revenueHeadline', {
      text: `${monthName}: **${usdK(Number(rev))}** revenue from **${Number(orders).toLocaleString('en-US')}** orders and ${Number(customers).toLocaleString('en-US')} customers. The average order was $${Number(aov).toFixed(2)}.`,
      title: 'Headline numbers, ' + monthName,
      description: 'Totals northpeak.sales.orders_daily for the previous calendar month.',
      sql,
      columns: res.columns,
      rows: res.rows,
      suggested: [QUESTIONS.revenueRegion, QUESTIONS.revenueWeekly],
    });
  }
  {
    const from = d(7);
    const sql = `SELECT channel,
       SUM(sessions) AS sessions,
       SUM(conversions) AS conversions,
       ROUND(SUM(spend_usd), 0) AS spend_usd
FROM northpeak.marketing.sessions_daily
WHERE session_date >= DATE '${from}' AND session_date < DATE '${today}'
GROUP BY channel
ORDER BY sessions DESC`;
    const res = await run(engine, sql);
    answers.set('sessionsChannel', {
      text: `**${res.rows[0][0]}** brought the most sessions last week: ${Number(res.rows[0][1]).toLocaleString('en-US')}.\n\nPaid channels spent ${usd0(res.rows.reduce((s, x) => s + Number(x[3]), 0))} in total.`,
      title: 'Sessions by channel, last 7 days',
      description: 'Sums northpeak.marketing.sessions_daily per channel, complete UTC days.',
      sql,
      columns: res.columns,
      rows: res.rows,
      suggested: [QUESTIONS.sessionsChannel],
    });
  }

  {
    const sql = `SELECT session_date,
       SUM(sessions) AS sessions,
       SUM(conversions) AS conversions
FROM northpeak.marketing.sessions_daily
WHERE session_date >= DATE '${d(14)}' AND session_date < DATE '${today}'
GROUP BY session_date
ORDER BY session_date`;
    const res = await run(engine, sql);
    const sessions = res.rows.map((x) => Number(x[1]));
    const conv = res.rows.reduce((s, x) => s + Number(x[2]), 0);
    const peak = res.rows.reduce((a, b) => (Number(b[1]) > Number(a[1]) ? b : a));
    answers.set('sessionsDaily', {
      text: `Sessions averaged **${Math.round(sessions.reduce((s, x) => s + x, 0) / sessions.length).toLocaleString('en-US')} a day** over the last 14 days, with ${conv.toLocaleString('en-US')} conversions.\n\nThe busiest day was ${fmtDay(peak[0])} (${Number(peak[1]).toLocaleString('en-US')} sessions)${peak[0] === d(6) ? ', when the email and social campaign went out' : ''}. Weekends run about a quarter lower.`,
      title: 'Daily sessions and conversions, last 14 days',
      description: 'Sums northpeak.marketing.sessions_daily per UTC day, all channels.',
      sql,
      columns: res.columns,
      rows: res.rows,
      suggested: [QUESTIONS.sessionsChannel],
    });
  }

  function route(spaceId, question) {
    const q = String(question || '').toLowerCase();
    const idx = space.findIndex((s) => s.space_id === spaceId);
    if (dataset.wsKey === 'prod' && idx === 0) {
      if (/daily|trend|2 weeks|two weeks|over time/.test(q)) return answers.get('dailyCost');
      if (/headline|kpi|summary|total|30 days/.test(q)) return answers.get('computeHeadline');
      return answers.get('jobsIncrease');
    }
    if (dataset.wsKey === 'analytics' && idx === 0) return /daily|trend|2 weeks|two weeks|over time/.test(q) ? answers.get('sessionsDaily') : answers.get('sessionsChannel');
    if (/week|trend|over time/.test(q)) return answers.get('revenueWeekly');
    if (/headline|kpi|total|overall/.test(q)) return answers.get('revenueHeadline');
    return answers.get('revenueRegion');
  }

  return {
    answers,
    genieAnswer(spaceId, question) {
      const a = route(spaceId, question);
      return Object.assign({}, a, { columns: a.columns.map((c) => c.slice()), rows: a.rows.map((x) => x.slice()), suggested: a.suggested.slice() });
    },
  };
}
