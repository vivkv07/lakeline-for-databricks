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

/** Query-history index of the one non-warehouse statement (see buildDataset). */
export const NON_WAREHOUSE_STATEMENT_INDEX = 90;

/**
 * Days before today of the most recent complete weekday with query history (1–29), or null.
 * The Query History fixture page shows statements from this day.
 */
export function queryHistoryDaysAgo(nowMs) {
  const todayMs = Date.parse(utcDate(nowMs) + 'T00:00:00Z');
  for (let k = 1; k < 30; k++) {
    const wd = new Date(todayMs - k * DAY).getUTCDay();
    if (wd >= 1 && wd <= 5) return k;
  }
  return null;
}

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

  // One statement that ran on non-warehouse compute (no rng draw, so every other row is
  // unchanged): the Query History fixture page links it to show "Compute unsupported".
  const qhK = queryHistoryDaysAgo(nowMs);
  if (qhK !== null && qhK < days) {
    const date = utcDate(todayMs - qhK * DAY);
    history.push({
      statement_id: historyStatementId(epochDayOf(date), NON_WAREHOUSE_STATEMENT_INDEX),
      workspace_id: WORKSPACE_ID,
      execution_status: 'FINISHED',
      compute: { type: 'SERVERLESS_COMPUTE', warehouse_id: null, cluster_id: null },
      start_time: at(date, 10 * 60 + 30),
      end_time: at(date, 10 * 60 + 30 + 4.75 / 60),
      total_duration_ms: 4750,
      execution_duration_ms: 4100,
      from_result_cache: false,
      statement_text: SENTINEL_SQL_TEXT,
    });
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

/* ------------------------------------------------------------------ Genie (Conversation API mock) */

/*
 * Synthetic Genie Agents for the fixture origin (shapes per notes/GENIE.md). Space IDs are 32 hex
 * characters like the documented examples. The "Broken" agent always FAILS so the error path is
 * exercised end to end. Answers are canned and say "(fixture)".
 */
export const GENIE_SPACES = Object.freeze([
  { space_id: 'f1c70000000000000000000000000a01', title: 'Sales analytics (fixture)', description: 'Synthetic orders and revenue by region. Fixture data only.', warehouse_id: WAREHOUSES[0].id },
  { space_id: 'f1c70000000000000000000000000a02', title: 'Job operations (fixture)', description: 'Synthetic job run history for the fixture jobs.', warehouse_id: WAREHOUSES[0].id },
  { space_id: 'f1c70000000000000000000000000aff', title: 'Broken agent (fixture)', description: 'Always fails, to exercise the error path.', warehouse_id: WAREHOUSES[0].id },
]);
export const GENIE_FAILING_SPACE = GENIE_SPACES[2].space_id;
export const GENIE_STEPS = Object.freeze(['SUBMITTED', 'FILTERING_CONTEXT', 'ASKING_AI', 'EXECUTING_QUERY', 'COMPLETED']);
export const GENIE_FAIL_STEPS = Object.freeze(['SUBMITTED', 'ASKING_AI', 'FAILED']);

/*
 * Canned answers, routed by agent and question keywords so one fixture covers every result shape
 * the side panel draws. Text is Markdown, like real Genie answers.
 *   Sales:  default → bars by region (with a null); "week"/"trend"/"daily" → weekly line (with a
 *           gap); "headline"/"total"/"overall" → one row (KPI tiles).
 *   Jobs:   default → bars by job; "duration"/"dbu"/"relate" → scatter; "update"/"history"/"latest"
 *           → a wide table with timestamps, ratios and nulls (no chart).
 */
const WEEKS = ['2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12'];
const WEEKLY = [271400, 268900, 279300, 284100, 276800, null, 291200, 302700, 311900, 318400];
const FIXTURE_RUNS = [
  ['5101', '3.6', '2.9'], ['5102', '5.2', '4.8'], ['5103', '6.9', '7.4'], ['5104', '8.8', '7.9'], ['5105', '10.4', '11.6'], ['5106', '13.1', '12.2'],
  ['5107', '15.7', '17.3'], ['5108', '18.2', '16.1'], ['5109', '22.6', '24.9'], ['5110', '27.4', null], ['5111', '33.0', '30.8'], ['5112', '41.5', '44.0'],
];

export function genieAnswer(spaceId, question) {
  const q = String(question || '').toLowerCase();
  if (spaceId === GENIE_SPACES[1].space_id) {
    if (/duration|dbus?\b|relate|correlat/.test(q)) {
      return {
        text: 'Run time and DBUs move together: about **1 DBU per minute**. (fixture)\n\n- The longest run, `5112`, used 44 DBUs.\n- Run `5110` has no DBU figure yet and is left out of the chart.',
        title: 'Run duration vs DBUs, last 5 days',
        description: 'One point per synthetic fixture job run.',
        sql: 'SELECT run_id, ROUND(duration_ms / 60000, 1) AS duration_min, ROUND(dbus, 1) AS dbus\nFROM fixture.ops.job_run_usage\nWHERE period_start >= current_date() - INTERVAL 5 DAYS\nORDER BY duration_min',
        columns: [['run_id', 'BIGINT'], ['duration_min', 'DOUBLE'], ['dbus', 'DOUBLE']],
        rows: FIXTURE_RUNS.map((r) => r.slice()),
        suggested: ['Show the latest pipeline updates', 'Which jobs failed?'],
      };
    }
    if (/updates?\b|history|latest/.test(q)) {
      return {
        text: 'The 6 latest pipeline updates. **One failed**: `orders_silver` stopped on a schema change. (fixture)\n\n> Cost is n/a while an update is still being priced.',
        title: 'Latest pipeline updates',
        description: 'Synthetic fixture pipeline updates with state, timing, volume and cost.',
        sql: 'SELECT update_id, pipeline_name, state, started_at, duration_min, rows_written, error_ratio, cost_usd, cause\nFROM fixture.ops.pipeline_updates\nORDER BY started_at DESC\nLIMIT 6',
        columns: [['update_id', 'STRING'], ['pipeline_name', 'STRING'], ['state', 'STRING'], ['started_at', 'TIMESTAMP'], ['duration_min', 'DOUBLE'], ['rows_written', 'LONG'], ['error_ratio', 'DOUBLE'], ['cost_usd', 'DECIMAL'], ['cause', 'STRING']],
        rows: [
          ['u-fixture-0006', 'orders_bronze', 'COMPLETED', '2026-10-15T06:10:05Z', '6.4', '1840211', '0', '3.12', null],
          ['u-fixture-0005', 'orders_silver', 'FAILED', '2026-10-15T05:40:51Z', '2.1', '0', '1', '0.88', 'Schema change in source column amount_usd'],
          ['u-fixture-0004', 'customers_silver', 'COMPLETED', '2026-10-15T04:15:44Z', '11.8', '402118', '0.0021', null, null],
          ['u-fixture-0003', 'clicks_bronze', 'COMPLETED', '2026-10-14T23:00:00Z', '24.3', '18220419', '0.0004', '14.20', null],
          ['u-fixture-0002', 'orders_bronze', 'COMPLETED', '2026-10-14T18:10:02Z', '5.9', '1722930', '0', '2.98', null],
          ['u-fixture-0001', 'customers_silver', 'COMPLETED', '2026-10-14T08:15:30Z', '12.6', '398765', '0.0018', '5.61', null],
        ],
        suggested: ['Which jobs failed?', 'How do run duration and DBUs relate?'],
      };
    }
    return {
      text: 'Job 102 (Orders ingest and pipeline refresh) had **1 failed run** in the last 5 days; job 101 had none. (fixture)',
      title: 'Job runs by job, last 5 days',
      description: 'Counts synthetic fixture runs and failed runs per job.',
      sql: "SELECT job_name, COUNT(*) AS runs, COUNT_IF(result_state = 'FAILED') AS failed\nFROM fixture.ops.job_runs\nWHERE period_start >= current_date() - INTERVAL 5 DAYS\nGROUP BY job_name\nORDER BY failed DESC",
      columns: [['job_name', 'STRING'], ['runs', 'LONG'], ['failed', 'LONG']],
      rows: [[JOBS[1].name, '5', '1'], [JOBS[0].name, '5', '0']],
      suggested: ['How do run duration and DBUs relate?', 'Show the latest pipeline updates'],
    };
  }
  if (/week|trend|daily|over time/.test(q)) {
    return {
      text: 'Weekly revenue for the last 10 weeks. (fixture)\n\n1. Revenue rose **4 weeks in a row** to $318.4K.\n2. The week of Sep 14 has no data and shows as a gap.',
      title: 'Weekly revenue, last 10 weeks',
      description: 'Sums synthetic fixture orders per week.',
      sql: "SELECT date_trunc('week', order_date) AS week_start, ROUND(SUM(amount_usd), 0) AS revenue_usd\nFROM fixture.sales.orders\nWHERE order_date >= current_date() - INTERVAL 10 WEEKS\nGROUP BY 1\nORDER BY 1",
      columns: [['week_start', 'DATE'], ['revenue_usd', 'DECIMAL']],
      rows: WEEKS.map((w, i) => [w, WEEKLY[i] === null ? null : String(WEEKLY[i])]),
      suggested: ['What were the headline numbers last month?', 'Which products drove EMEA?'],
    };
  }
  if (/headline|total|overall|kpi/.test(q)) {
    return {
      text: 'Last month: **$1.24M** revenue from **10,831** orders and 4,212 active customers. Refunds were 1.8% of orders. (fixture)',
      title: 'Headline numbers, last month',
      description: 'Totals synthetic fixture orders for the previous calendar month.',
      sql: "SELECT SUM(amount_usd) AS total_revenue_usd, COUNT(*) AS orders, COUNT(DISTINCT customer) AS active_customers, ROUND(100 * AVG(CASE WHEN refunded THEN 1 ELSE 0 END), 1) AS refund_pct\nFROM fixture.sales.orders\nWHERE order_month = date_trunc('month', current_date() - INTERVAL 1 MONTH)",
      columns: [['total_revenue_usd', 'DECIMAL'], ['orders', 'LONG'], ['active_customers', 'LONG'], ['refund_pct', 'DOUBLE']],
      rows: [['1240512.40', '10831', '4212', '1.8']],
      suggested: ['Show revenue by week', 'Which products drove EMEA?'],
    };
  }
  return {
    text: 'Revenue last month was **$1.24M** across 4 regions. (fixture)\n\n- **EMEA** led with $412.3K.\n- LATAM has no order count yet, so it shows as n/a.',
    title: 'Revenue by region, last month',
    description: 'Sums synthetic fixture orders per region for the previous calendar month.',
    sql: "SELECT region, ROUND(SUM(amount_usd), 0) AS revenue_usd, COUNT(*) AS orders\nFROM fixture.sales.orders\nWHERE order_month = date_trunc('month', current_date() - INTERVAL 1 MONTH)\nGROUP BY region\nORDER BY revenue_usd DESC",
    columns: [['region', 'STRING'], ['revenue_usd', 'DECIMAL'], ['orders', 'LONG']],
    rows: [['EMEA', '412300', '3120'], ['North America', '398900', '2875'], ['APAC', '301750', '3410'], ['LATAM', '96200', null]],
    suggested: ['Show revenue by week', 'What were the headline numbers last month?'],
  };
}

/* ------------------------------------------------------------------ fixture page templating */

/*
 * The fragments in local/fixture/*.html name resources through placeholders such as {{JOB_101}}
 * or {{JOB_101_RUN_D1}}, so the routed fixture SPA links IDs that exist in this dataset and
 * connected-mode badges and estimates show real (simulated) amounts. The fixture server renders
 * them with fixtureTemplateValues(dataset); values come only from this module, never from a
 * request, and are HTML-escaped. LEGACY_TEMPLATE_VALUES reproduces the original hand-written
 * synthetic IDs (job 1001, run 50101, …) for jsdom tests that load a fragment without a server:
 *   legacyFragment(readFileSync(new URL('./fixture/job-runs.html', import.meta.url), 'utf8'))
 * "Dk" = k UTC days before today (D1 = yesterday).
 */

export const TEMPLATE_PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]{0,63})\}\}/g;

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Replace {{NAME}} placeholders with HTML-escaped values.
 * @returns {{html: string, used: string[], unknown: string[]}} unknown = names without a value
 */
export function renderFixtureTemplate(text, values) {
  const used = new Set();
  const unknown = new Set();
  const html = String(text).replace(TEMPLATE_PLACEHOLDER, (all, name) => {
    if (!Object.prototype.hasOwnProperty.call(values, name) || typeof values[name] !== 'string') {
      unknown.add(name);
      return all;
    }
    used.add(name);
    return escapeHtml(values[name]);
  });
  return { html, used: [...used].sort(), unknown: [...unknown].sort() };
}

/** Original hand-written synthetic IDs and display text of the fragments (jsdom unit tests). */
export const LEGACY_TEMPLATE_VALUES = Object.freeze({
  JOB_101: '1001',
  JOB_101_NAME: 'nightly_sales_etl',
  JOB_102: '1002',
  JOB_102_NAME: 'hourly_events',
  JOB_101_RUN_D1: '50101',
  JOB_101_RUN_D2: '50102',
  JOB_101_RUN_D3: '50103',
  JOB_101_RUN_D4: '50104',
  JOB_101_RUN_D5: '50100',
  JOB_101_RUN_D1_START: 'Oct 14, 2026, 02:00:00 AM',
  JOB_101_RUN_D2_START: 'Oct 13, 2026, 02:00:00 AM',
  JOB_101_RUN_D3_START: 'Oct 12, 2026, 02:00:00 AM',
  JOB_101_RUN_D4_START: 'Oct 11, 2026, 02:00:00 AM',
  JOB_101_RUN_D5_START: 'Oct 10, 2026, 02:00:00 AM',
  JOB_101_RUN_D1_DURATION: '12m 4s',
  JOB_101_RUN_D2_DURATION: '15m 10s',
  JOB_101_RUN_D3_DURATION: '2m 1s',
  JOB_101_RUN_D4_DURATION: '13m 0s',
  JOB_101_RUN_D5_DURATION: '12m 2s',
  JOB_102_RUN_D1: '60001',
  PIPELINE_P1: '0a1b2c3d-1111-4a2b-8c3d-000000000001',
  PIPELINE_P1_NAME: 'bronze_ingest',
  PIPELINE_P1_UPDATE_D1: '0a1b2c3d-2222-4a2b-8c3d-000000000011',
  PIPELINE_P1_UPDATE_D2: '0a1b2c3d-2222-4a2b-8c3d-000000000012',
  PIPELINE_P1_UPDATE_D3: '0a1b2c3d-2222-4a2b-8c3d-000000000013',
  PIPELINE_P1_UPDATE_D1_START: 'Oct 14, 2026, 03:00 AM',
  PIPELINE_P1_UPDATE_D2_START: 'Oct 13, 2026, 03:00 AM',
  PIPELINE_P1_UPDATE_D3_START: 'Oct 12, 2026, 03:00 AM',
  PIPELINE_P1_TRIGGER_JOB: '1001',
  PIPELINE_P1_TRIGGER_JOB_NAME: 'nightly_sales_etl',
  PIPELINE_P1_TRIGGER_RUN: '50101',
  PIPELINE_P2: '0a1b2c3d-1111-4a2b-8c3d-000000000002',
  PIPELINE_P2_NAME: 'silver_rollup',
  PIPELINE_P2_UPDATE_D1: '0a1b2c3d-2222-4a2b-8c3d-000000000021',
  WAREHOUSE_W1: 'a1b2c3d4e5f60001',
  WAREHOUSE_W1_NAME: 'Shared BI warehouse',
  WAREHOUSE_W1_SIZE: 'Small',
  WAREHOUSE_W1_TYPE: 'Serverless',
  WAREHOUSE_W2: 'a1b2c3d4e5f60002',
  WAREHOUSE_W2_NAME: 'ETL warehouse',
  WAREHOUSE_W2_SIZE: 'Medium',
  WAREHOUSE_W2_TYPE: 'Pro',
  WAREHOUSE_W3: 'a1b2c3d4e5f60003',
  WAREHOUSE_W3_NAME: 'Ad hoc analysis',
  WAREHOUSE_W3_SIZE: '2X-Small',
  WAREHOUSE_W3_TYPE: 'Serverless',
  NOTEBOOK_N1: '3001',
  NOTEBOOK_N2: '3002',
  APP_NAME: 'sales-dashboard',
  STMT_FINISHED: '01f0a1b2-c3d4-1e5f-9a8b-7c6d5e4f3a21',
  STMT_FINISHED_START: 'Oct 15, 2026, 10:23:45 AM',
  STMT_FINISHED_DURATION: '1.2 s',
  QH_META_START: 'Oct 15, 2026, 10:24:10 AM',
  QH_META_DURATION: '2m 3s',
  STMT_RUNNING: '01f0a1b2-c3d4-1e5f-9a8b-7c6d5e4f3a23',
  STMT_RUNNING_START: 'Oct 15, 2026, 10:30:02 AM',
  STMT_CACHED: '01f0a1b2-c3d4-1e5f-9a8b-7c6d5e4f3a24',
  STMT_CACHED_START: 'Oct 15, 2026, 10:31:00 AM',
  STMT_NON_WAREHOUSE: '01f0a1b2-c3d4-1e5f-9a8b-7c6d5e4f3a26',
  STMT_NON_WAREHOUSE_START: 'Oct 15, 2026, 09:58:31 AM',
  STMT_NON_WAREHOUSE_DURATION: '4.75 s',
});

/** A fragment rendered with LEGACY_TEMPLATE_VALUES; throws on a placeholder without a value. */
export function legacyFragment(text) {
  const out = renderFixtureTemplate(text, LEGACY_TEMPLATE_VALUES);
  if (out.unknown.length) throw new Error('Unknown fixture placeholder(s): ' + out.unknown.join(', '));
  return out.html;
}

/** '2026-10-14T02:00:00' → '2026-10-14 02:00 UTC' (display only; never parsed). */
const minuteUtc = (ts) => ts.slice(0, 10) + ' ' + ts.slice(11, 16) + ' UTC';
/** '2026-10-14T11:07:00' → '2026-10-14 11:07:00 +00:00': second precision with an explicit offset,
 *  which native-cost-data.js parseDisplayedTime reads as UTC in any browser time zone. */
const secondUtc = (ts) => ts.slice(0, 10) + ' ' + ts.slice(11, 19) + ' +00:00';

/** Run length for display: '1h 40m', '12m 4s', '45s'. */
function runDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return h + 'h ' + m + 'm';
  return m ? m + 'm ' + (s % 60) + 's' : s + 's';
}

/** Query duration with one decimal of seconds ('4.8 s', '2m 3.5s'): parseDuration gives ±50 ms,
 *  and rounding to 0.1 s always keeps the true total_duration_ms inside that window. */
function queryDuration(ms) {
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return (tenths / 10).toFixed(1) + ' s';
  return Math.floor(tenths / 600) + 'm ' + ((tenths % 600) / 10).toFixed(1) + 's';
}

/**
 * Placeholder values for a dataset (same names as LEGACY_TEMPLATE_VALUES). Derived from the
 * dataset's own rows, so every linked ID has billing (job runs D1–D5, P1 updates D1–D3, query
 * history from the most recent complete weekday).
 * @param {{nowMs:number, today:string, tables:object}} dataset from buildDataset()
 * @returns {Readonly<Record<string,string>>}
 */
export function fixtureTemplateValues(dataset) {
  const { nowMs, today, tables } = dataset;
  const todayMs = Date.parse(today + 'T00:00:00Z');
  const dayAgo = (k) => utcDate(todayMs - k * DAY);
  const need = (row, what) => {
    if (!row) throw new Error('Fixture template: ' + what + ' is not in the dataset');
    return row;
  };
  const jobRun = (jobId, k) => need(tables['lakeflow.job_run_timeline'].find((r) => r.job_id === jobId && r.run_id === jobRunId(jobId, epochDayOf(dayAgo(k)))), 'job ' + jobId + ' run D' + k);
  const update = (p, k) => need(tables['lakeflow.pipeline_update_timeline'].find((u) => u.pipeline_id === p.pipeline_id && u.update_id === pipelineUpdateId(p.n, epochDayOf(dayAgo(k)))), p.name + ' update D' + k);
  const qhK = need(queryHistoryDaysAgo(nowMs), 'a weekday with query history');
  const qhEd = epochDayOf(dayAgo(qhK));
  const stmt = (i) => need(tables['query.history'].find((h) => h.statement_id === historyStatementId(qhEd, i)), 'query history statement ' + i);
  const [W1, W2, W3] = WAREHOUSES;
  const [P1, P2] = PIPELINES;
  const v = {
    JOB_101: JOBS[0].job_id,
    JOB_101_NAME: JOBS[0].name,
    JOB_102: JOBS[1].job_id,
    JOB_102_NAME: JOBS[1].name,
  };
  for (let k = 1; k <= 5; k++) {
    const run = jobRun('101', k);
    v['JOB_101_RUN_D' + k] = run.run_id;
    v['JOB_101_RUN_D' + k + '_START'] = minuteUtc(run.period_start_time);
    v['JOB_101_RUN_D' + k + '_DURATION'] = runDuration(tsMs(run.period_end_time) - tsMs(run.period_start_time));
  }
  v.JOB_102_RUN_D1 = jobRun('102', 1).run_id;
  v.PIPELINE_P1 = P1.pipeline_id;
  v.PIPELINE_P1_NAME = P1.name;
  for (let k = 1; k <= 3; k++) {
    const upd = update(P1, k);
    v['PIPELINE_P1_UPDATE_D' + k] = upd.update_id;
    v['PIPELINE_P1_UPDATE_D' + k + '_START'] = minuteUtc(upd.period_start_time);
  }
  // P1's D1 update was triggered by the refresh_pipeline task of job 102's D1 run.
  const trig = update(P1, 1).trigger_details.job_task;
  const task = need(tables['lakeflow.job_task_run_timeline'].find((t) => t.run_id === trig.job_task_run_id), 'triggering task run');
  v.PIPELINE_P1_TRIGGER_JOB = trig.job_id;
  v.PIPELINE_P1_TRIGGER_JOB_NAME = JOBS.find((j) => j.job_id === trig.job_id).name;
  v.PIPELINE_P1_TRIGGER_RUN = task.job_run_id;
  v.PIPELINE_P2 = P2.pipeline_id;
  v.PIPELINE_P2_NAME = P2.name;
  v.PIPELINE_P2_UPDATE_D1 = update(P2, 1).update_id;
  const TYPE = (w) => (w.enable_serverless_compute ? 'Serverless' : w.warehouse_type === 'PRO' ? 'Pro' : 'Classic');
  for (const [n, w] of [['W1', W1], ['W2', W2], ['W3', W3]]) {
    v['WAREHOUSE_' + n] = w.id;
    v['WAREHOUSE_' + n + '_NAME'] = w.name;
    v['WAREHOUSE_' + n + '_SIZE'] = w.cluster_size;
    v['WAREHOUSE_' + n + '_TYPE'] = TYPE(w);
  }
  v.NOTEBOOK_N1 = NOTEBOOKS[0].notebook_id;
  v.NOTEBOOK_N2 = NOTEBOOKS[1].notebook_id;
  v.APP_NAME = APPS[0].app_name;
  // Query history (statement links and one metadata-only row). Indices: 0–7 on W1 in overlapping
  // pairs (each start second unique per warehouse), 8–9 on W2, 90 on non-warehouse compute.
  const finished = stmt(0);
  v.STMT_FINISHED = finished.statement_id;
  v.STMT_FINISHED_START = secondUtc(finished.start_time);
  v.STMT_FINISHED_DURATION = queryDuration(finished.total_duration_ms);
  const meta = stmt(2);
  v.QH_META_START = secondUtc(meta.start_time);
  v.QH_META_DURATION = queryDuration(meta.total_duration_ms);
  // Still running on the page: not in history yet (the extension makes no request for it).
  v.STMT_RUNNING = historyStatementId(epochDayOf(today), 99);
  v.STMT_RUNNING_START = secondUtc(new Date(Math.floor((nowMs - 90000) / 1000) * 1000).toISOString().slice(0, 19));
  const cached = stmt(4);
  v.STMT_CACHED = cached.statement_id;
  v.STMT_CACHED_START = secondUtc(cached.start_time);
  const other = stmt(NON_WAREHOUSE_STATEMENT_INDEX);
  v.STMT_NON_WAREHOUSE = other.statement_id;
  v.STMT_NON_WAREHOUSE_START = secondUtc(other.start_time);
  v.STMT_NON_WAREHOUSE_DURATION = queryDuration(other.total_duration_ms);
  return Object.freeze(v);
}
