/*
 * SYNTHETIC fixture dataset (development and tests only; never real data).
 *
 * Deterministic for a given UTC "today": the same calendar dates always produce the same rows.
 * Workspace 1234567890, account fixture-account-0001, cloud AWS, currency USD, 200 days of
 * usage ending today. Covers:
 *   - jobs 101 (nightly, classic + some serverless usage) and 102 (daily; its task
 *     `refresh_pipeline` triggers pipeline P1 through pipeline_update_timeline JOB_TASK details;
 *     yesterday's run of job 102 FAILED),
 *   - pipelines P1 (job-triggered) and P2 (standalone),
 *   - SQL warehouses W1 (serverless, RUNNING), W2 (pro), W3 (classic) with query history whose
 *     statement_text is always SENTINEL_SQL_TEXT (any accidental read fails loudly),
 *   - notebooks on an all-purpose cluster and serverless notebooks, an app, a serving endpoint,
 *   - signed corrections (RETRACTION/RESTATEMENT), GENIE_FREE_USAGE, one unpriced SKU on three
 *     days 12, 19 and 20 days ago (the 7-day period is fully priced; 30 days is a priced subtotal),
 *   - a list-price change for PREMIUM_JOBS_COMPUTE 100 days ago (validity windows), and
 *     account prices at 85 % of list.
 *
 * Stable identifiers (epochDay = days since 1970-01-01 UTC of the run's date):
 *   job run       jobId * 1_000_000 + epochDay              e.g. 101020376
 *   task run      (job run) * 10 + taskIndex + 1
 *   P1/P2 update  b000000<n>-0000-4000-8000-<epochDay padded to 12>
 *   query history a0000000-0000-4000-8000-<epochDay * 100 + i padded to 12>
 */

export const SENTINEL_SQL_TEXT = 'SENTINEL_SQL_TEXT_MUST_NEVER_BE_READ';
export const WORKSPACE_ID = '1234567890';
export const ACCOUNT_ID = 'fixture-account-0001';
export const CLOUD = 'AWS';
export const CURRENCY = 'USD';
export const USER = 'fixture.user@example.com';
const DAY = 86400000;

export const JOBS = Object.freeze([
  { job_id: '101', name: 'Nightly sales ETL (fixture)' },
  { job_id: '102', name: 'Orders ingest and pipeline refresh (fixture)' },
]);

export const PIPELINES = Object.freeze([
  { pipeline_id: '5e1f0c2a-7b3d-4e8f-9a01-0000000000a1', name: 'Orders pipeline (fixture)', n: 1 },
  { pipeline_id: '5e1f0c2a-7b3d-4e8f-9a01-0000000000a2', name: 'Inventory snapshot pipeline (fixture)', n: 2 },
  { pipeline_id: '5e1f0c2a-7b3d-4e8f-9a01-0000000000a3', name: 'Customer 360 pipeline (fixture)', n: 3 },
]);

export const WAREHOUSES = Object.freeze([
  { id: '0a1b2c3d4e5f6071', name: 'Serverless Starter Warehouse (fixture)', state: 'RUNNING', cluster_size: '2X-Small', warehouse_type: 'PRO', enable_serverless_compute: true, min_num_clusters: 1, max_num_clusters: 2, auto_stop_mins: 10 },
  { id: '1b2c3d4e5f607182', name: 'Analytics Pro (fixture)', state: 'STOPPED', cluster_size: 'Small', warehouse_type: 'PRO', enable_serverless_compute: false, min_num_clusters: 1, max_num_clusters: 1, auto_stop_mins: 20 },
  { id: '2c3d4e5f60718293', name: 'Classic Reporting (fixture)', state: 'STOPPED', cluster_size: 'Medium', warehouse_type: 'CLASSIC', enable_serverless_compute: false, min_num_clusters: 1, max_num_clusters: 1, auto_stop_mins: 30 },
]);

export const CLUSTERS = Object.freeze({
  shared: '0101-123456-fixture1',
  sandbox: '0101-123456-fixture2',
  jobCluster: '0101-123456-jobclst1',
  gpu: '0101-123456-fixture4',
});

export const NOTEBOOKS = Object.freeze([
  { notebook_id: '3001', path: '/Users/fixture.user@example.com/Exploration (fixture)' },
  { notebook_id: '3002', path: '/Shared/Reports/Weekly summary (fixture)' },
]);

export const APPS = Object.freeze([{ app_id: '7a7a7a7a-1111-4222-8333-000000000001', app_name: 'cost-dashboard' }]);
export const SERVING_ENDPOINT = 'fixture-endpoint';
export const UNPRICED_SKU = 'PREMIUM_FIXTURE_UNPRICED_SKU';
export const UNPRICED_DAYS_AGO = Object.freeze([12, 19, 20]);
export const PRICE_CHANGE_DAYS_AGO = 100;

/** List prices (USD per DBU). GENIE_FREE_USAGE and the unpriced SKU deliberately have none. */
export const LIST_PRICES = Object.freeze({
  PREMIUM_JOBS_COMPUTE: 0.15, // 0.16 from PRICE_CHANGE_DAYS_AGO
  PREMIUM_JOBS_SERVERLESS_COMPUTE_US_EAST: 0.35,
  PREMIUM_DLT_ADVANCED_COMPUTE: 0.36,
  PREMIUM_DLT_CORE_COMPUTE: 0.2,
  PREMIUM_SERVERLESS_SQL_COMPUTE_US_EAST: 0.7,
  PREMIUM_SQL_PRO_COMPUTE_US_EAST: 0.55,
  PREMIUM_SQL_COMPUTE: 0.22,
  PREMIUM_ALL_PURPOSE_COMPUTE: 0.55,
  PREMIUM_ALL_PURPOSE_SERVERLESS_COMPUTE_US_EAST: 0.95,
  PREMIUM_APPS_COMPUTE_US_EAST: 0.5,
  PREMIUM_SERVERLESS_REAL_TIME_INFERENCE_US_EAST: 0.082,
});
export const JOBS_PRICE_AFTER_CHANGE = 0.16;
export const ACCOUNT_DISCOUNT = 0.85;

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
const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
/** 'YYYY-MM-DDTHH:MM:SS' for minutes from midnight of `date` (may run past 24:00). */
function at(date, minutes) {
  return new Date(Date.parse(date + 'T00:00:00Z') + Math.round(minutes * 60000)).toISOString().slice(0, 19);
}
const tsMs = (s) => Date.parse(s + 'Z');

export const epochDayOf = (date) => Math.floor(Date.parse(date + 'T00:00:00Z') / DAY);
export const jobRunId = (jobId, epochDay) => String(Number(jobId) * 1000000 + epochDay);
export const taskRunId = (jobId, epochDay, taskIndex) => String((Number(jobId) * 1000000 + epochDay) * 10 + taskIndex + 1);
export const pipelineUpdateId = (n, epochDay) => 'b000000' + n + '-0000-4000-8000-' + String(epochDay).padStart(12, '0');
export const historyStatementId = (epochDay, i) => 'a0000000-0000-4000-8000-' + String(epochDay * 100 + i).padStart(12, '0');

/* ------------------------------------------------------------------ dataset */

/**
 * @param {{nowMs?:number, days?:number}} [o]
 * @returns {{nowMs, today, tables: {[table]: object[]}}}
 */
export function buildDataset(o = {}) {
  const nowMs = o.nowMs === undefined ? Date.now() : o.nowMs;
  const days = o.days || 200;
  const today = utcDate(nowMs);
  const todayMs = Date.parse(today + 'T00:00:00Z');
  const r = rng(20261015);
  let seq = 0;

  const usage = [];
  const pipelineUpdates = [];
  const taskRuns = [];
  const jobRuns = [];
  const history = [];

  function u(o2) {
    seq += 1;
    return {
      record_id: 'fx-' + pad(seq, 6),
      account_id: ACCOUNT_ID,
      workspace_id: WORKSPACE_ID,
      sku_name: o2.sku,
      cloud: CLOUD,
      usage_unit: 'DBU',
      usage_start_time: o2.start,
      usage_end_time: o2.end,
      usage_date: o2.start.slice(0, 10),
      usage_quantity: round(o2.qty),
      record_type: o2.recordType || 'ORIGINAL',
      billing_origin_product: o2.product,
      usage_metadata: {
        job_id: o2.job_id || null,
        job_run_id: o2.job_run_id || null,
        dlt_pipeline_id: o2.pipeline_id || null,
        dlt_update_id: o2.update_id || null,
        warehouse_id: o2.warehouse_id || null,
        cluster_id: o2.cluster_id || null,
        notebook_id: o2.notebook_id || null,
        notebook_path: o2.notebook_path || null,
        app_id: o2.app_id || null,
        app_name: o2.app_name || null,
        job_name: o2.job_name || null,
        endpoint_name: o2.endpoint_name || null,
      },
      product_features: { is_photon: o2.photon === true, is_serverless: o2.serverless === true, sql_tier: o2.sql_tier || null },
    };
  }

  /** ORIGINAL + optional correction pair (RETRACTION of the full amount, RESTATEMENT at 80 %). */
  function push(row, correct) {
    usage.push(row);
    if (!correct) return;
    usage.push(Object.assign(u({ sku: row.sku_name, start: row.usage_start_time, end: row.usage_end_time, qty: -row.usage_quantity, product: row.billing_origin_product, recordType: 'RETRACTION' }), { usage_metadata: Object.assign({}, row.usage_metadata), product_features: Object.assign({}, row.product_features) }));
    usage.push(Object.assign(u({ sku: row.sku_name, start: row.usage_start_time, end: row.usage_end_time, qty: row.usage_quantity * 0.8, product: row.billing_origin_product, recordType: 'RESTATEMENT' }), { usage_metadata: Object.assign({}, row.usage_metadata), product_features: Object.assign({}, row.product_features) }));
  }

  const [W1, W2, W3] = WAREHOUSES;
  const [P1, P2] = PIPELINES;
  const [N1, N2] = NOTEBOOKS;
  const APP = APPS[0];

  for (let k = days - 1; k >= 0; k--) {
    const date = utcDate(todayMs - k * DAY);
    const ed = epochDayOf(date);
    const wd = new Date(date + 'T00:00:00Z').getUTCDay(); // 0 Sun … 6 Sat
    const weekday = wd >= 1 && wd <= 5;

    // Job 101: 02:00–03:40 on job compute (two hourly slices), serverless top-up every fifth day.
    const run101 = jobRunId('101', ed);
    const q1 = 6 + r() * 4;
    push(u({ sku: 'PREMIUM_JOBS_COMPUTE', start: at(date, 120), end: at(date, 180), qty: q1, product: 'JOBS', job_id: '101', job_run_id: run101, job_name: JOBS[0].name }), k === 15);
    usage.push(u({ sku: 'PREMIUM_JOBS_COMPUTE', start: at(date, 180), end: at(date, 220), qty: q1 * 0.6, product: 'JOBS', job_id: '101', job_run_id: run101, job_name: JOBS[0].name }));
    if (k % 5 === 0) usage.push(u({ sku: 'PREMIUM_JOBS_SERVERLESS_COMPUTE_US_EAST', start: at(date, 200), end: at(date, 220), qty: 1 + r(), product: 'JOBS', job_id: '101', job_run_id: run101, job_name: JOBS[0].name, serverless: true }));
    jobRuns.push({ workspace_id: WORKSPACE_ID, job_id: '101', run_id: run101, period_start_time: at(date, 120), period_end_time: at(date, 220), result_state: 'SUCCEEDED', run_type: 'JOB_RUN' });
    taskRuns.push({ workspace_id: WORKSPACE_ID, job_id: '101', run_id: taskRunId('101', ed, 0), job_run_id: run101, task_key: 'transform', period_start_time: at(date, 120), period_end_time: at(date, 220), result_state: 'SUCCEEDED' });

    // Job 102: ingest 06:00–06:20, then refresh_pipeline 06:20–07:00 triggers a P1 update.
    const run102 = jobRunId('102', ed);
    const failed = k === 1;
    usage.push(u({ sku: 'PREMIUM_JOBS_COMPUTE', start: at(date, 360), end: at(date, 380), qty: 2 + r() * 2, product: 'JOBS', job_id: '102', job_run_id: run102, job_name: JOBS[1].name }));
    const upd1 = pipelineUpdateId(P1.n, ed);
    usage.push(u({ sku: 'PREMIUM_DLT_ADVANCED_COMPUTE', start: at(date, 380), end: at(date, 420), qty: 4 + r() * 3, product: 'DLT', pipeline_id: P1.pipeline_id, update_id: upd1 }));
    jobRuns.push({ workspace_id: WORKSPACE_ID, job_id: '102', run_id: run102, period_start_time: at(date, 360), period_end_time: at(date, 420), result_state: failed ? 'FAILED' : 'SUCCEEDED', run_type: 'JOB_RUN' });
    taskRuns.push({ workspace_id: WORKSPACE_ID, job_id: '102', run_id: taskRunId('102', ed, 0), job_run_id: run102, task_key: 'ingest', period_start_time: at(date, 360), period_end_time: at(date, 380), result_state: 'SUCCEEDED' });
    taskRuns.push({ workspace_id: WORKSPACE_ID, job_id: '102', run_id: taskRunId('102', ed, 1), job_run_id: run102, task_key: 'refresh_pipeline', period_start_time: at(date, 380), period_end_time: at(date, 420), result_state: failed ? 'FAILED' : 'SUCCEEDED' });
    pipelineUpdates.push({ workspace_id: WORKSPACE_ID, pipeline_id: P1.pipeline_id, update_id: upd1, trigger_type: 'JOB_TASK', trigger_details: { job_task: { job_id: '102', job_task_run_id: taskRunId('102', ed, 1) } }, period_start_time: at(date, 380), period_end_time: at(date, 420), result_state: failed ? 'FAILED' : 'COMPLETED' });

    // Pipeline P2: standalone update 12:00–12:30.
    const upd2 = pipelineUpdateId(P2.n, ed);
    usage.push(u({ sku: 'PREMIUM_DLT_CORE_COMPUTE', start: at(date, 720), end: at(date, 750), qty: 2 + r(), product: 'DLT', pipeline_id: P2.pipeline_id, update_id: upd2 }));
    pipelineUpdates.push({ workspace_id: WORKSPACE_ID, pipeline_id: P2.pipeline_id, update_id: upd2, trigger_type: 'USER_ACTION', trigger_details: null, period_start_time: at(date, 720), period_end_time: at(date, 750), result_state: 'COMPLETED' });

    // Warehouses: W1 serverless hourly (09–16 weekdays, 10–11 weekends), W2 pro 13–15 weekdays, W3 classic Mondays.
    const w1Hours = weekday ? [9, 10, 11, 12, 13, 14, 15, 16] : [10, 11];
    for (const h of w1Hours) usage.push(u({ sku: 'PREMIUM_SERVERLESS_SQL_COMPUTE_US_EAST', start: at(date, h * 60), end: at(date, h * 60 + 60), qty: 4 * (0.3 + r() * 0.7), product: 'SQL', warehouse_id: W1.id, serverless: true, sql_tier: 'PRO' }));
    if (weekday) {
      for (const h of [13, 14, 15]) push(u({ sku: 'PREMIUM_SQL_PRO_COMPUTE_US_EAST', start: at(date, h * 60), end: at(date, h * 60 + 60), qty: 12 * (0.6 + r() * 0.4), product: 'SQL', warehouse_id: W2.id, sql_tier: 'PRO' }), k === 45 && h === 13);
    }
    if (wd === 1) usage.push(u({ sku: 'PREMIUM_SQL_COMPUTE', start: at(date, 480), end: at(date, 540), qty: 20 * (0.8 + r() * 0.2), product: 'SQL', warehouse_id: W3.id, sql_tier: 'CLASSIC' }));

    // Notebooks: classic all-purpose cluster 10–12 weekdays; serverless notebooks.
    if (weekday) {
      for (const h of [10, 11]) usage.push(u({ sku: 'PREMIUM_ALL_PURPOSE_COMPUTE', start: at(date, h * 60), end: at(date, h * 60 + 60), qty: 3 + r() * 2, product: 'ALL_PURPOSE', cluster_id: CLUSTERS.shared, photon: true }));
      usage.push(u({ sku: 'PREMIUM_ALL_PURPOSE_SERVERLESS_COMPUTE_US_EAST', start: at(date, 840), end: at(date, 900), qty: 1 + r(), product: 'INTERACTIVE', notebook_id: N1.notebook_id, notebook_path: N1.path, serverless: true }));
    }
    if (wd === 2 || wd === 4) usage.push(u({ sku: 'PREMIUM_ALL_PURPOSE_SERVERLESS_COMPUTE_US_EAST', start: at(date, 960), end: at(date, 990), qty: 0.5 + r() * 0.5, product: 'INTERACTIVE', notebook_id: N2.notebook_id, notebook_path: N2.path, serverless: true }));

    // App (daily), serving endpoint, free Genie usage, unpriced SKU.
    usage.push(u({ sku: 'PREMIUM_APPS_COMPUTE_US_EAST', start: at(date, 0), end: at(date, 1440), qty: 12, product: 'APPS', app_id: APP.app_id, app_name: APP.app_name, serverless: true }));
    usage.push(u({ sku: 'PREMIUM_SERVERLESS_REAL_TIME_INFERENCE_US_EAST', start: at(date, 1080), end: at(date, 1140), qty: 1 + r(), product: 'MODEL_SERVING', endpoint_name: SERVING_ENDPOINT, serverless: true }));
    if (k % 3 === 0) usage.push(u({ sku: 'GENIE_FREE_USAGE', start: at(date, 600), end: at(date, 660), qty: 0.75, product: 'GENIE', serverless: true }));
    if (UNPRICED_DAYS_AGO.includes(k)) usage.push(u({ sku: UNPRICED_SKU, start: at(date, 660), end: at(date, 720), qty: 3, product: 'DATABASE', serverless: true }));

    // Query history (last 30 days, weekdays): overlapping statements on W1 and a few on W2.
    if (k < 30 && weekday) {
      let i = 0;
      const addQuery = (wh, startMin, durSec) => {
        const idx = i++;
        const start = at(date, startMin);
        const end = at(date, startMin + durSec / 60);
        const status = idx % 17 === 16 ? 'FAILED' : idx % 23 === 22 ? 'CANCELED' : 'FINISHED';
        history.push({
          statement_id: historyStatementId(ed, idx),
          workspace_id: WORKSPACE_ID,
          execution_status: status,
          compute: { type: 'WAREHOUSE', warehouse_id: wh.id, cluster_id: null },
          start_time: start,
          end_time: end,
          total_duration_ms: Math.round(durSec * 1000),
          execution_duration_ms: Math.round(durSec * 850),
          from_result_cache: idx % 11 === 10,
          statement_text: SENTINEL_SQL_TEXT,
        });
      };
      for (const h of [9, 11, 13, 15]) {
        const m = Math.floor(r() * 30);
        addQuery(W1, h * 60 + m, 30 + r() * 240);
        addQuery(W1, h * 60 + m + 1, 20 + r() * 90); // overlaps the previous one
      }
      addQuery(W2, 13 * 60 + 5, 120 + r() * 300);
      addQuery(W2, 14 * 60 + 20, 60 + r() * 120);
    }
  }

  // Prices: one validity change for jobs compute; account prices at 85 % of list.
  const changeAt = utcDate(todayMs - PRICE_CHANGE_DAYS_AGO * DAY) + 'T00:00:00';
  const listPrices = [];
  const accountPrices = [];
  const priceRow = (sku, price, from, to, account) => ({
    price_start_time: from,
    price_end_time: to,
    account_id: ACCOUNT_ID,
    sku_name: sku,
    cloud: CLOUD,
    currency_code: CURRENCY,
    usage_unit: 'DBU',
    pricing: account ? { default: String(round(price * ACCOUNT_DISCOUNT, 6)) } : { default: String(price), promotional: { default: String(price) }, effective_list: { default: String(price) } },
  });
  for (const [sku, price] of Object.entries(LIST_PRICES)) {
    if (sku === 'PREMIUM_JOBS_COMPUTE') {
      for (const account of [false, true]) {
        const list = account ? accountPrices : listPrices;
        list.push(priceRow(sku, price, '2020-01-01T00:00:00', changeAt, account));
        list.push(priceRow(sku, JOBS_PRICE_AFTER_CHANGE, changeAt, null, account));
      }
    } else {
      listPrices.push(priceRow(sku, price, '2020-01-01T00:00:00', null, false));
      accountPrices.push(priceRow(sku, price, '2020-01-01T00:00:00', null, true));
    }
  }

  // Nothing that ends after "now" (billing data is never from the future).
  const past = (t) => tsMs(t) <= nowMs;
  return {
    nowMs,
    today,
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

/* ------------------------------------------------------------------ SQL loading */

const COLUMN_TYPES = {
  usage_start_time: 'TIMESTAMP',
  usage_end_time: 'TIMESTAMP',
  usage_date: 'DATE',
  price_start_time: 'TIMESTAMP',
  price_end_time: 'TIMESTAMP',
  period_start_time: 'TIMESTAMP',
  period_end_time: 'TIMESTAMP',
  start_time: 'TIMESTAMP',
  end_time: 'TIMESTAMP',
};

function sqlValue(v, type) {
  if (v === null || v === undefined) return 'NULL';
  if (type === 'TIMESTAMP') return "TIMESTAMP '" + String(v).replace(/'/g, "''") + "'";
  if (type === 'DATE') return "DATE '" + String(v).replace(/'/g, "''") + "'";
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => "'" + k + "': " + sqlValue(x)).join(', ') + '}';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/** Multi-row INSERT statements for a table (batches of `batch` rows). */
export function toInsertSql(table, rows, batch = 400) {
  if (!/^[a-z_]+\.[a-z_]+$/.test(table)) throw new Error('Bad table name');
  const out = [];
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const cols = Object.keys(chunk[0]);
    const values = chunk.map((row) => '(' + cols.map((c) => sqlValue(row[c], COLUMN_TYPES[c])).join(', ') + ')');
    out.push('INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES\n' + values.join(',\n'));
  }
  return out;
}

/* ------------------------------------------------------------------ monitor REST snapshot */

/**
 * Synthetic monitor data relative to `nowMs`: job runs (Jobs API 2.2 shape, some running, one
 * failed), pipelines (2.0 statuses), clusters (2.1). Numbers and timestamps follow the APIs:
 * job/run IDs are numbers, times are epoch milliseconds.
 */
export function monitorSnapshot(nowMs = Date.now(), origin = 'http://127.0.0.1:8765') {
  const today = utcDate(nowMs);
  const todayMs = Date.parse(today + 'T00:00:00Z');
  const min = 60000;
  const runs = [];
  const runUrl = (jobId, runId) => origin + '/jobs/' + jobId + '/runs/' + runId;
  const terminated = (job, runId, start, end, ok, message) => ({
    job_id: Number(job.job_id),
    run_id: runId,
    run_name: job.name,
    creator_user_name: USER,
    run_type: 'JOB_RUN',
    trigger: 'PERIODIC',
    start_time: start,
    end_time: end,
    run_duration: end - start,
    status: ok
      ? { state: 'TERMINATED', termination_details: { code: 'SUCCESS', type: 'SUCCESS', message: '' } }
      : { state: 'TERMINATED', termination_details: { code: 'RUN_EXECUTION_ERROR', type: 'CLIENT_ERROR', message: message } },
    state: ok ? { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS', state_message: '' } : { life_cycle_state: 'TERMINATED', result_state: 'FAILED', state_message: message },
    run_page_url: runUrl(job.job_id, runId),
  });
  for (let k = 0; k < 5; k++) {
    const date = utcDate(todayMs - k * DAY);
    const ed = epochDayOf(date);
    const d0 = Date.parse(date + 'T00:00:00Z');
    if (d0 + 220 * min <= nowMs) runs.push(terminated(JOBS[0], Number(jobRunId('101', ed)), d0 + 120 * min, d0 + 220 * min, true));
    if (d0 + 420 * min <= nowMs) runs.push(terminated(JOBS[1], Number(jobRunId('102', ed)), d0 + 360 * min, d0 + 420 * min, k !== 1, 'Task refresh_pipeline failed (synthetic fixture failure).'));
  }
  runs.push({
    job_id: 101,
    run_id: 101900001,
    run_name: JOBS[0].name,
    creator_user_name: USER,
    run_type: 'JOB_RUN',
    trigger: 'ONE_TIME',
    start_time: nowMs - 18 * min,
    end_time: 0,
    run_duration: 0,
    status: { state: 'RUNNING' },
    state: { life_cycle_state: 'RUNNING', state_message: 'In run' },
    run_page_url: runUrl('101', 101900001),
  });
  runs.push({
    job_id: 102,
    run_id: 102900002,
    run_name: JOBS[1].name,
    creator_user_name: USER,
    run_type: 'JOB_RUN',
    trigger: 'ONE_TIME',
    start_time: nowMs - 1 * min,
    end_time: 0,
    run_duration: 0,
    status: { state: 'QUEUED', queue_details: { code: 'ACTIVE_RUNS_LIMIT_REACHED', message: 'Queued behind an active run (fixture).' } },
    state: { life_cycle_state: 'QUEUED', state_message: 'Queued' },
    run_page_url: runUrl('102', 102900002),
  });
  runs.sort((a, b) => b.start_time - a.start_time || b.run_id - a.run_id);

  const [P1, P2, P3] = PIPELINES;
  const iso = (ms) => new Date(ms).toISOString();
  const lastP1 = runs.find((x) => x.job_id === 102 && x.status.state === 'TERMINATED');
  const pipelines = [
    {
      pipeline_id: P1.pipeline_id,
      name: P1.name,
      state: 'IDLE',
      health: lastP1 && lastP1.state.result_state === 'FAILED' ? 'UNHEALTHY' : 'HEALTHY',
      creator_user_name: USER,
      run_as_user_name: USER,
      latest_updates: lastP1 ? [{ update_id: pipelineUpdateId(P1.n, epochDayOf(utcDate(lastP1.start_time))), state: lastP1.state.result_state === 'FAILED' ? 'FAILED' : 'COMPLETED', creation_time: iso(lastP1.start_time + 20 * min) }] : [],
    },
    {
      pipeline_id: P2.pipeline_id,
      name: P2.name,
      state: 'RUNNING',
      health: 'HEALTHY',
      creator_user_name: USER,
      run_as_user_name: USER,
      latest_updates: [{ update_id: 'b0000002-0000-4000-8000-ffffffffffff', state: 'RUNNING', creation_time: iso(nowMs - 7 * min) }],
    },
    {
      pipeline_id: P3.pipeline_id,
      name: P3.name,
      state: 'FAILED',
      health: 'UNHEALTHY',
      creator_user_name: USER,
      run_as_user_name: USER,
      latest_updates: [{ update_id: 'b0000003-0000-4000-8000-ffffffffffff', state: 'FAILED', creation_time: iso(nowMs - 180 * min) }],
    },
  ];

  const clusters = [
    { cluster_id: CLUSTERS.shared, cluster_name: 'Shared analysis (fixture)', state: 'RUNNING', state_message: '', cluster_source: 'UI', creator_user_name: USER, spark_version: '15.4.x-scala2.12', node_type_id: 'i3.xlarge', driver_node_type_id: 'i3.xlarge', autoscale: { min_workers: 1, max_workers: 4 }, autotermination_minutes: 60, start_time: nowMs - 190 * min, data_security_mode: 'USER_ISOLATION' },
    { cluster_id: CLUSTERS.jobCluster, cluster_name: 'job-101-run-101900001', state: 'RUNNING', state_message: '', cluster_source: 'JOB', creator_user_name: USER, spark_version: '15.4.x-scala2.12', node_type_id: 'i3.xlarge', driver_node_type_id: 'i3.xlarge', num_workers: 2, start_time: nowMs - 18 * min, data_security_mode: 'SINGLE_USER' },
    { cluster_id: CLUSTERS.sandbox, cluster_name: 'ML sandbox (fixture)', state: 'TERMINATED', state_message: 'Inactive cluster terminated (inactive for 60 minutes).', cluster_source: 'UI', creator_user_name: USER, spark_version: '15.4.x-cpu-ml-scala2.12', node_type_id: 'm5d.large', num_workers: 0, start_time: nowMs - 600 * min, terminated_time: nowMs - 300 * min, termination_reason: { code: 'INACTIVITY', type: 'SUCCESS' } },
    { cluster_id: CLUSTERS.gpu, cluster_name: 'Nightly GPU (fixture)', state: 'TERMINATED', state_message: 'Synthetic launch failure (fixture).', cluster_source: 'UI', creator_user_name: USER, spark_version: '15.4.x-gpu-ml-scala2.12', node_type_id: 'g5.xlarge', num_workers: 1, start_time: nowMs - 95 * min, terminated_time: nowMs - 90 * min, termination_reason: { code: 'CLOUD_PROVIDER_LAUNCH_FAILURE', type: 'CLOUD_FAILURE' } },
  ];

  return { runs, pipelines, clusters };
}
