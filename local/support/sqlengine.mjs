/*
 * SIMULATED SQL ENGINE FOR TESTS. Executes the extension's generated Databricks SQL on DuckDB
 * through a small dialect shim, and returns results in Statement Execution API shape.
 * This checks query logic (joins, dedupe, signed sums, validity windows) — it is NOT proof of
 * Databricks compatibility. Live read-only validation is a separate, authorized step.
 *
 * Shim: backticks → double quotes; `system` catalog dropped (DuckDB reserves it);
 * `.default` field quoted; :named params substituted as typed literals; collect_set,
 * array_contains, unix_millis provided as macros.
 */
import { DuckDBInstance } from '@duckdb/node-api';

export const SENTINEL_SQL_TEXT = 'SENTINEL_SQL_TEXT_MUST_NEVER_BE_READ';

const DDL = `
CREATE SCHEMA billing; CREATE SCHEMA query; CREATE SCHEMA lakeflow; CREATE SCHEMA compute;
CREATE TABLE billing.usage (
  record_id VARCHAR, account_id VARCHAR, workspace_id VARCHAR, sku_name VARCHAR, cloud VARCHAR,
  usage_unit VARCHAR, usage_start_time TIMESTAMP, usage_end_time TIMESTAMP, usage_date DATE,
  usage_quantity DECIMAL(38,18), record_type VARCHAR, billing_origin_product VARCHAR,
  usage_metadata STRUCT(job_id VARCHAR, job_run_id VARCHAR, dlt_pipeline_id VARCHAR, dlt_update_id VARCHAR,
    warehouse_id VARCHAR, cluster_id VARCHAR, notebook_id VARCHAR, notebook_path VARCHAR, app_id VARCHAR, app_name VARCHAR,
    job_name VARCHAR, endpoint_name VARCHAR),
  product_features STRUCT(is_photon BOOLEAN, is_serverless BOOLEAN, sql_tier VARCHAR)
);
CREATE TABLE billing.list_prices (
  price_start_time TIMESTAMP, price_end_time TIMESTAMP, account_id VARCHAR, sku_name VARCHAR, cloud VARCHAR,
  currency_code VARCHAR, usage_unit VARCHAR,
  pricing STRUCT("default" VARCHAR, promotional STRUCT("default" VARCHAR), effective_list STRUCT("default" VARCHAR))
);
CREATE TABLE billing.account_prices (
  price_start_time TIMESTAMP, price_end_time TIMESTAMP, account_id VARCHAR, sku_name VARCHAR, cloud VARCHAR,
  currency_code VARCHAR, usage_unit VARCHAR,
  pricing STRUCT("default" VARCHAR)
);
CREATE TABLE lakeflow.pipeline_update_timeline (
  workspace_id VARCHAR, pipeline_id VARCHAR, update_id VARCHAR, trigger_type VARCHAR,
  trigger_details STRUCT(job_task STRUCT(job_id VARCHAR, job_task_run_id VARCHAR)),
  period_start_time TIMESTAMP, period_end_time TIMESTAMP, result_state VARCHAR
);
CREATE TABLE lakeflow.job_task_run_timeline (
  workspace_id VARCHAR, job_id VARCHAR, run_id VARCHAR, job_run_id VARCHAR, task_key VARCHAR,
  period_start_time TIMESTAMP, period_end_time TIMESTAMP, result_state VARCHAR
);
CREATE TABLE lakeflow.job_run_timeline (
  workspace_id VARCHAR, job_id VARCHAR, run_id VARCHAR, period_start_time TIMESTAMP, period_end_time TIMESTAMP,
  result_state VARCHAR, run_type VARCHAR
);
CREATE TABLE query.history (
  statement_id VARCHAR, workspace_id VARCHAR, execution_status VARCHAR,
  compute STRUCT(type VARCHAR, warehouse_id VARCHAR, cluster_id VARCHAR),
  start_time TIMESTAMP, end_time TIMESTAMP, total_duration_ms BIGINT, execution_duration_ms BIGINT,
  from_result_cache BOOLEAN, statement_text VARCHAR
);
CREATE MACRO collect_set(x) AS list_distinct(list(x));
CREATE MACRO array_contains(a, v) AS list_contains(a, v);
CREATE MACRO unix_millis(t) AS epoch_ms(t);
`;

const TYPE_NAMES = { VARCHAR: 'STRING', DOUBLE: 'DOUBLE', BIGINT: 'LONG', INTEGER: 'INT', BOOLEAN: 'BOOLEAN', DATE: 'DATE', TIMESTAMP: 'TIMESTAMP', HUGEINT: 'LONG', FLOAT: 'FLOAT' };

function literal(p) {
  if (p.value === null || p.value === undefined) return 'NULL';
  const quoted = "'" + String(p.value).replace(/'/g, "''") + "'";
  switch ((p.type || 'STRING').toUpperCase()) {
    case 'DATE': return 'DATE ' + quoted;
    case 'TIMESTAMP': return 'TIMESTAMP ' + quoted;
    case 'BIGINT': case 'INT': case 'DOUBLE': case 'DECIMAL':
      if (!/^-?\d+(\.\d+)?$/.test(String(p.value))) throw new Error('Bad numeric param ' + p.name);
      return String(p.value);
    default: return quoted;
  }
}

export function translate(sql, params = []) {
  let out = sql.replace(/`/g, '"');
  out = out.replace(/"system"\."(billing|query|lakeflow|compute)"\./g, '"$1".');
  out = out.replace(/\bsystem\.(billing|query|lakeflow|compute)\./g, '$1.');
  out = out.replace(/\.default\b/g, '."default"');
  const byName = new Map(params.map((p) => [p.name, p]));
  out = out.replace(/(^|[^:\w]):([A-Za-z_][A-Za-z0-9_]*)/g, (m, pre, name) => {
    if (!byName.has(name)) throw new Error('Unbound parameter :' + name);
    return pre + literal(byName.get(name));
  });
  return out;
}

function toApiString(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
  return String(v);
}

export async function createEngine() {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run(DDL);
  const statements = [];

  return {
    statements,
    async exec(sql) { await conn.run(sql); },
    async insert(table, rows) {
      for (const row of rows) {
        const cols = Object.keys(row);
        const vals = cols.map((c) => sqlValue(row[c]));
        await conn.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')})`);
      }
    },
    /** Execute like POST /api/2.0/sql/statements and return a SUCCEEDED response. */
    async execute({ statement, parameters = [], row_limit }) {
      statements.push({ statement, parameters });
      const reader = await conn.runAndReadAll(translate(statement, parameters));
      const names = reader.columnNames();
      const types = reader.columnTypes().map((t) => TYPE_NAMES[String(t).replace(/\(.*/, '')] || (String(t).startsWith('DECIMAL') ? 'DECIMAL' : 'STRING'));
      let rows = reader.getRows().map((r) => r.map((v) => toApiString(typeof v === 'object' && v !== null && 'toDouble' in v ? v.toDouble() : v)));
      const total = rows.length;
      const truncated = row_limit ? total > Number(row_limit) : false;
      if (truncated) rows = rows.slice(0, Number(row_limit));
      return {
        statement_id: '00000000-0000-4000-8000-' + String(statements.length).padStart(12, '0'),
        status: { state: 'SUCCEEDED' },
        manifest: { format: 'JSON_ARRAY', schema: { columns: names.map((n, i) => ({ name: n, type_name: types[i], position: i })) }, total_row_count: rows.length, total_chunk_count: 1, truncated },
        result: { data_array: rows },
      };
    },
  };
}

function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object' && v.$raw) return v.$raw;
  if (typeof v === 'object') {
    const parts = Object.entries(v).map(([k, x]) => `'${k}': ${sqlValue(x)}`);
    return '{' + parts.join(', ') + '}';
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/* ------------------------------------------------------------------ fixture builders */

export const ACCOUNT = 'acct-1';
export const WS = '1234567890';

let seq = 0;
export function usageRow(o) {
  seq += 1;
  const start = o.start || o.date + 'T01:00:00';
  const end = o.end || o.date + 'T02:00:00';
  return {
    record_id: o.record_id || 'rec-' + seq,
    account_id: o.account_id || ACCOUNT,
    workspace_id: o.workspace_id || WS,
    sku_name: o.sku || 'PREMIUM_JOBS_COMPUTE',
    cloud: o.cloud || 'AWS',
    usage_unit: o.unit || 'DBU',
    usage_start_time: { $raw: `TIMESTAMP '${start}'` },
    usage_end_time: { $raw: `TIMESTAMP '${end}'` },
    usage_date: { $raw: `DATE '${o.date || end.slice(0, 10)}'` },
    usage_quantity: o.qty,
    record_type: o.record_type || 'ORIGINAL',
    billing_origin_product: o.product || 'JOBS',
    usage_metadata: {
      job_id: o.job_id || null, job_run_id: o.job_run_id || null, dlt_pipeline_id: o.pipeline_id || null,
      dlt_update_id: o.update_id || null, warehouse_id: o.warehouse_id || null, cluster_id: o.cluster_id || null,
      notebook_id: o.notebook_id || null, notebook_path: o.notebook_path || null, app_id: o.app_id || null,
      app_name: o.app_name || null, job_name: o.job_name || null, endpoint_name: null,
    },
    product_features: { is_photon: o.photon ?? false, is_serverless: o.serverless ?? false, sql_tier: o.sql_tier || null },
  };
}

export function listPrice(o) {
  return {
    price_start_time: { $raw: `TIMESTAMP '${o.from || '2020-01-01T00:00:00'}'` },
    price_end_time: o.to ? { $raw: `TIMESTAMP '${o.to}'` } : null,
    account_id: o.account_id || ACCOUNT,
    sku_name: o.sku || 'PREMIUM_JOBS_COMPUTE',
    cloud: o.cloud || 'AWS',
    currency_code: o.currency || 'USD',
    usage_unit: o.unit || 'DBU',
    pricing: { default: String(o.list ?? o.price), promotional: { default: String(o.price) }, effective_list: { default: String(o.price) } },
  };
}

export function accountPrice(o) {
  const lp = listPrice(o);
  lp.pricing = { default: String(o.price) };
  return lp;
}
