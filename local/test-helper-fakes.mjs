// SIMULATED test doubles for the local helper: a fake Databricks CLI script, a fake Databricks
// REST server, and a raw HTTP client that can send any Host/Origin header. Imported by the other
// test-helper-*.mjs files; its own self-test only runs when this file is executed directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodeHttp from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const FAKE_CLI = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const file = (n) => path.join(dir, n);
const read = (n, d) => { try { return fs.readFileSync(file(n), 'utf8').trim(); } catch { return d; } };
fs.appendFileSync(file('calls.jsonl'), JSON.stringify({ args, env: { DATABRICKS_HOST: process.env.DATABRICKS_HOST || null, DATABRICKS_TOKEN: process.env.DATABRICKS_TOKEN || null, DATABRICKS_CONFIG_PROFILE: process.env.DATABRICKS_CONFIG_PROFILE || null, DATABRICKS_CONFIG_FILE: process.env.DATABRICKS_CONFIG_FILE || null } }) + '\\n');
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const state = JSON.parse(read('state.json', '{}'));
const save = () => fs.writeFileSync(file('state.json'), JSON.stringify(state));
if (args[0] === '--version') {
  process.stdout.write('Databricks CLI v' + read('version.txt', '1.21.0') + '\\n');
  process.exit(0);
} else if (args[0] === 'auth' && args[1] === 'token') {
  const p = flag('--profile');
  const s = state[p];
  if (!s) { process.stderr.write('Error: profile ' + p + ' is not configured. Run databricks auth login\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ access_token: 'FAKEACCESS-' + p, token_type: 'Bearer', refresh_token: 'FAKEREFRESH-MUST-NOT-LEAK', expiry: s.expiry }) + '\\n');
  process.exit(0);
} else if (args[0] === 'auth' && args[1] === 'login') {
  const mode = read('login-mode.txt', 'ok');
  const finish = () => {
    state[flag('--profile')] = { expiry: new Date(Date.now() + 3600e3).toISOString(), host: flag('--host'), scopes: flag('--scopes') };
    save();
    process.stdout.write('Profile ' + flag('--profile') + ' was successfully saved\\n');
    process.exit(0);
  };
  if (mode === 'hang') setInterval(() => {}, 1000);
  else if (mode === 'fail') { process.stderr.write('Error: authorization was denied by the user\\n'); process.exit(1); }
  else if (mode === 'slow') setTimeout(finish, 250);
  else finish();
} else {
  process.stderr.write('Error: unknown command\\n');
  process.exit(2);
}
`;

/** Fresh fake-CLI directory under the OS temp dir. */
export function fakeCliDir({ version = '1.21.0', state = {}, loginMode = 'ok' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcc-fakecli-'));
  fs.writeFileSync(path.join(dir, 'databricks.mjs'), FAKE_CLI);
  fs.writeFileSync(path.join(dir, 'version.txt'), version);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(dir, 'login-mode.txt'), loginMode);
  const calls = () => {
    try {
      return fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (_) {
      return [];
    }
  };
  return { dir, cli: path.join(dir, 'databricks.mjs'), calls, setState: (s) => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s)) };
}

export const future = () => new Date(Date.now() + 3600e3).toISOString();

/** Raw HTTP request with full header control (Host, Origin, …). */
export function rawRequest({ port, method = 'GET', path: p = '/', headers = {}, body, setHost = true }) {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request({ host: '127.0.0.1', port, method, path: p, headers, setHost, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (_) {
          /* not JSON */
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    req.end();
  });
}

/** Columns returned by queries/summary.js, for canned statement responses. */
export const SUMMARY_COLUMNS = [
  ['period', 'STRING'],
  ['usage_date', 'STRING'],
  ['product', 'STRING'],
  ['sku_name', 'STRING'],
  ['usage_unit', 'STRING'],
  ['priced_cost', 'DOUBLE'],
  ['priced_records', 'LONG'],
  ['unpriced_records', 'LONG'],
  ['ambiguous_records', 'LONG'],
  ['quantity', 'DOUBLE'],
  ['free_quantity', 'DOUBLE'],
  ['latest_usage_ms', 'LONG'],
];

/**
 * Fake Databricks REST server (warehouses, statements, monitor GETs). Records what it received.
 * mode.reject401 → every API call answers 401.
 */
export async function startFakeDatabricks() {
  const seen = { statements: [], gets: [] };
  const mode = { reject401: false };
  const server = nodeHttp.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const reply = (status, obj) => {
        const b = JSON.stringify(obj);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
        res.end(b);
      };
      if (mode.reject401) return reply(401, { error_code: 'UNAUTHENTICATED', message: 'Invalid access token.' });
      if (req.method === 'GET') seen.gets.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
      if (req.method === 'GET' && url.pathname === '/api/2.0/sql/warehouses') {
        if (url.searchParams.get('page_token') === 'page2') return reply(200, { warehouses: [{ id: 'cccccccccccccccc', name: 'Third', state: 'STOPPED', cluster_size: 'Medium', warehouse_type: 'CLASSIC', enable_serverless_compute: false, min_num_clusters: 1, max_num_clusters: 1 }] });
        return reply(200, {
          warehouses: [
            { id: 'aaaaaaaaaaaaaaaa', name: 'Starter', state: 'RUNNING', cluster_size: '2X-Small', warehouse_type: 'PRO', enable_serverless_compute: true, min_num_clusters: 1, max_num_clusters: 2, odbc_params: { hostname: 'x', path: '/sql/1.0/warehouses/aaaaaaaaaaaaaaaa' }, creator_name: 'someone@example.com', tags: { custom_tags: [] } },
            { id: 'NOT-A-WAREHOUSE', name: 'Bad id', state: 'RUNNING' },
            { id: 'bbbbbbbbbbbbbbbb', name: 'Pro', state: 'STOPPED', cluster_size: 'Small', warehouse_type: 'PRO', enable_serverless_compute: false, min_num_clusters: 1, max_num_clusters: 1 },
          ],
          next_page_token: 'page2',
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/2.0/sql/statements') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        seen.statements.push({ auth: req.headers.authorization, body });
        const rows = [
          ['cur', '2026-10-10', 'JOBS', 'PREMIUM_JOBS_COMPUTE', 'DBU', '12.5', '4', '0', '0', '80', '0', '1792000000000'],
          ['cur', '2026-10-11', 'SQL', 'PREMIUM_SERVERLESS_SQL_COMPUTE_US_EAST', 'DBU', '7.5', '3', '0', '0', '10', '0', '1792090000000'],
          ['prev', '2026-10-03', 'JOBS', 'PREMIUM_JOBS_COMPUTE', 'DBU', '10', '4', '0', '0', '64', '0', '1791500000000'],
        ];
        return reply(200, {
          statement_id: '11111111-2222-4333-8444-555555555555',
          status: { state: 'SUCCEEDED' },
          manifest: { format: 'JSON_ARRAY', schema: { columns: SUMMARY_COLUMNS.map(([name, type_name], position) => ({ name, type_name, position })) }, total_row_count: rows.length, total_chunk_count: 1, truncated: false },
          result: { data_array: rows },
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/2.2/jobs/runs/list') return reply(200, { runs: [{ job_id: 101, run_id: 1, status: { state: 'RUNNING' } }], has_more: false });
      if (req.method === 'GET' && url.pathname === '/api/2.1/clusters/list') return reply(200, { clusters: [] });
      return reply(404, { error_code: 'ENDPOINT_NOT_FOUND', message: 'not found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { server, port, origin: 'http://127.0.0.1:' + port, seen, mode, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

/** fetch that sends requests for `from` origin to `to` origin (keeps path and query). */
export function rewriteFetch(from, to) {
  return (url, init) => {
    const u = String(url);
    if (!u.startsWith(from + '/')) throw new Error('unexpected fetch target');
    return fetch(to + u.slice(from.length), init);
  };
}

/* ------------------------------------------------------------------ self-test */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  test('fake CLI behaves as documented (version, token, login)', () => {
    const fake = fakeCliDir({ version: '1.13.2' });
    const run = (...args) => spawnSync(process.execPath, [fake.cli, ...args], { encoding: 'utf8' });
    assert.match(run('--version').stdout, /^Databricks CLI v1\.13\.2/);
    assert.equal(run('auth', 'token', '--profile', 'dcc-x').status, 1);
    assert.equal(run('auth', 'login', '--host', 'https://h', '--profile', 'dcc-x', '--scopes', 'sql').status, 0);
    const tok = JSON.parse(run('auth', 'token', '--profile', 'dcc-x').stdout);
    assert.equal(tok.access_token, 'FAKEACCESS-dcc-x');
    assert.ok(Date.parse(tok.expiry) > Date.now());
    assert.equal(fake.calls().length, 4);
  });
}
