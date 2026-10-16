// queryEstimates and computeRates against the SIMULATED DuckDB engine (support/sqlengine.mjs).
// This checks query logic and the no-SQL-text rule; it is not proof of Databricks compatibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './support/load.mjs';
import { createEngine, usageRow, listPrice, accountPrice, WS, SENTINEL_SQL_TEXT } from './support/sqlengine.mjs';

const registry = load('databricks/queries/index.js');
const qh = load('databricks/queries/query-history.js');
const rates = load('databricks/queries/compute-rates.js');
const result = load('databricks/result.js');

const NOW = Date.parse('2026-10-15T12:00:00Z');
const W1 = 'a1b2c3d4e5f60001';
const W2 = 'a1b2c3d4e5f60002';
const SKU = 'PREMIUM_SERVERLESS_SQL_COMPUTE_US_EAST';
const SKU_UNPRICED = 'PREMIUM_SQL_PRO_COMPUTE_US_EAST';
const sid = (n) => '01f0a1b2-c3d4-1e5f-9a8b-' + String(n).padStart(12, '0');
const ms = (iso) => Date.parse(iso + 'Z');
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} expected ${b}, got ${a}`);

const conn = (priceTable = 'system.billing.list_prices', extra = {}) => ({
  origin: 'https://dbc-1.cloud.databricks.com', workspaceId: WS, authMode: 'pat', priceTable,
  usageSource: 'system.billing.usage', historySource: 'system.query.history', currency: 'USD', cloud: 'aws', ...extra,
});

function hist(o) {
  return {
    statement_id: o.id,
    workspace_id: o.ws || WS,
    execution_status: o.status || 'FINISHED',
    compute: { type: o.type || 'WAREHOUSE', warehouse_id: o.wh === undefined ? W1 : o.wh, cluster_id: null },
    start_time: { $raw: `TIMESTAMP '${o.start}'` },
    end_time: o.end ? { $raw: `TIMESTAMP '${o.end}'` } : null,
    total_duration_ms: o.total ?? (o.end ? ms(o.end) - ms(o.start) : null),
    execution_duration_ms: o.exec ?? null,
    from_result_cache: o.cache || false,
    statement_text: SENTINEL_SQL_TEXT,
  };
}

/** Executor like the PAT path: Statement API response → parsed rows; records every statement. */
function executor(engine, seen) {
  return async (q) => {
    seen.push(q.statement);
    const res = await engine.execute({ statement: q.statement, parameters: q.parameters, row_limit: q.rowLimit });
    const rows = result.parseResult(res, { maxRows: q.maxRows }).rows;
    assert.ok(!JSON.stringify(rows).includes(SENTINEL_SQL_TEXT), 'no SQL text in any result row');
    return rows;
  };
}

function assertNoSqlText(statements, out) {
  assert.ok(statements.length > 0);
  for (const s of statements) assert.doesNotMatch(s, /statement_text/i, 'generated SQL never references statement_text');
  for (const s of statements) assert.doesNotMatch(s, /\bh\.\*|\bSELECT\s+\*/i, 'no SELECT * over history');
  assert.ok(!JSON.stringify(out).includes(SENTINEL_SQL_TEXT), 'sentinel never reaches the result');
}

async function scenario(priceTable = 'system.billing.list_prices') {
  const db = await createEngine();
  const price = priceTable.endsWith('account_prices') ? accountPrice : listPrice;
  await db.insert('billing.usage', [
    usageRow({ date: '2026-10-14', start: '2026-10-14T10:00:00', end: '2026-10-14T11:00:00', qty: 10, sku: SKU, product: 'SQL', warehouse_id: W1, serverless: true }),
    usageRow({ date: '2026-10-14', start: '2026-10-14T11:00:00', end: '2026-10-14T12:00:00', qty: 20, sku: SKU, product: 'SQL', warehouse_id: W1, serverless: true }),
    // W2 has no price for its SKU.
    usageRow({ date: '2026-10-14', start: '2026-10-14T10:00:00', end: '2026-10-14T11:00:00', qty: 5, sku: SKU_UNPRICED, product: 'SQL', warehouse_id: W2 }),
  ]);
  await db.insert(priceTable.replace('system.', ''), [price({ sku: SKU, price: 0.7 })]);
  await db.insert('query.history', [
    hist({ id: sid(1), start: '2026-10-14T10:10:00', end: '2026-10-14T10:20:00', exec: 600000 }),
    hist({ id: sid(2), start: '2026-10-14T10:15:00', end: '2026-10-14T10:25:00', exec: 300000 }), // active 10:20–10:25
    hist({ id: sid(3), start: '2026-10-14T10:40:00', end: '2026-10-14T10:50:00', exec: 600000 }), // not on screen
    hist({ id: sid(4), start: '2026-10-14T10:22:00', end: '2026-10-14T10:24:00', exec: 120000, status: 'FAILED' }), // shares, never shown
    hist({ id: sid(5), start: '2026-10-14T10:30:00', end: '2026-10-14T10:30:00.040', exec: 0, cache: true }),
    hist({ id: sid(6), start: '2026-10-14T10:31:00', end: '2026-10-14T10:31:04', exec: 3500, type: 'SERVERLESS_COMPUTE', wh: null }),
    // Two executions in the same displayed second with durations both shown as "1.2 s".
    hist({ id: sid(7), start: '2026-10-14T10:35:05.100', end: '2026-10-14T10:35:06.300', exec: 1000 }),
    hist({ id: sid(8), start: '2026-10-14T10:35:05.700', end: '2026-10-14T10:35:06.930', exec: 1100 }),
    // Unique metadata match for "2m 3s" at 11:05:07.
    hist({ id: sid(9), start: '2026-10-14T11:05:07.250', end: '2026-10-14T11:07:10.650', exec: 120000 }),
    // Exact "350 ms" match and a 351 ms neighbour in the same second on another warehouse.
    hist({ id: sid(10), start: '2026-10-14T11:20:00.100', end: '2026-10-14T11:20:00.450', exec: 300 }),
    hist({ id: sid(11), start: '2026-10-14T11:20:00.200', end: '2026-10-14T11:20:00.551', exec: 300, wh: W2 }),
    // W2 execution (priced? no — W2's SKU has no price).
    hist({ id: sid(12), start: '2026-10-14T10:05:00', end: '2026-10-14T10:06:00', exec: 60000, wh: W2 }),
    // Recent execution on W1 with no billing yet.
    hist({ id: sid(13), start: '2026-10-15T11:40:00', end: '2026-10-15T11:50:00', exec: 600000 }),
    // Another workspace's execution in the same window (must never be matched).
    hist({ id: sid(14), ws: '999', start: '2026-10-14T10:10:00', end: '2026-10-14T10:20:00', exec: 600000 }),
  ]);
  return db;
}

const targets = () => [
  { key: 'statement:' + sid(1), statementId: sid(1) },
  { key: 'statement:' + sid(2), statementId: sid(2) },
  { key: 'statement:' + sid(4), statementId: sid(4) },
  { key: 'statement:' + sid(5), statementId: sid(5) },
  { key: 'statement:' + sid(6), statementId: sid(6) },
  { key: 'meta:amb', warehouseId: W1, startMs: ms('2026-10-14T10:35:05'), durationMs: 1200, toleranceMs: 50 },
  { key: 'meta:unique', warehouseId: W1, startMs: ms('2026-10-14T11:05:07'), durationMs: 123000, toleranceMs: 500 },
  { key: 'meta:350', warehouseId: W1, startMs: ms('2026-10-14T11:20:00'), durationMs: 350, toleranceMs: 0.5 },
  { key: 'statement:' + sid(12), statementId: sid(12) },
  { key: 'statement:' + sid(13), statementId: sid(13) },
  { key: 'meta:recent-missing', warehouseId: W1, startMs: NOW - 10 * 60000, durationMs: 2000, toleranceMs: 50 },
  { key: 'meta:old-missing', warehouseId: W1, startMs: ms('2026-09-01T08:00:00'), durationMs: 2000, toleranceMs: 50 },
  { key: 'meta:before-lookback', warehouseId: W1, startMs: ms('2026-06-01T08:00:00'), durationMs: 2000, toleranceMs: 50 },
  { key: 'statement:unknown', statementId: sid(999) },
  { key: 'statement:native-running', statementId: sid(1), status: 'running' },
  { key: 'statement:native-cached', statementId: sid(1), cached: true },
  { key: 'bad', warehouseId: 'nothex', startMs: 1, durationMs: 1, toleranceMs: 1 },
];

for (const priceTable of ['system.billing.list_prices', 'system.billing.account_prices']) {
  test(`queryEstimates end to end (${priceTable.split('.').pop()}): states, matching and allocation`, async () => {
    const db = await scenario(priceTable);
    const statements = [];
    const out = await registry.run('queryEstimates', { conn: conn(priceTable), args: { targets: targets() }, nowMs: NOW, exec: executor(db, statements) });
    const it = out.items;
    const st = (k) => it[k] && it[k].status;

    assert.equal(out.priceTable, priceTable);
    assert.equal(out.pricingBasis, priceTable.endsWith('list_prices') ? 'list' : 'account');
    assert.equal(out.currency, 'USD');
    assert.equal(out.lookback.start, '2026-07-18');
    assert.equal(out.lookback.endExclusive, '2026-10-16');

    // Interval 10:00–11:00 costs 10 × 0.7 = $7 ($7/60 per minute).
    // S1 alone 10:10–10:20 → 10 min. S2 active 10:20–10:25, sharing 10:22–10:24 with failed S4.
    assert.equal(st('statement:' + sid(1)), 'ok');
    close(it['statement:' + sid(1)].amount, (7 * 10) / 60, 'S1');
    assert.equal(it['statement:' + sid(1)].concurrency, 1);
    assert.equal(it['statement:' + sid(1)].intervals, 1);
    assert.equal(it['statement:' + sid(1)].warehouseId, W1);
    assert.equal(st('statement:' + sid(2)), 'ok');
    close(it['statement:' + sid(2)].amount, (7 * (2 + 1 + 1)) / 60, 'S2 shares with a failed execution');
    assert.equal(it['statement:' + sid(2)].concurrency, 2);
    assert.ok(it['statement:' + sid(2)].assumptions.length >= 5);

    assert.equal(st('statement:' + sid(4)), 'unavailable', 'failed executions get no number');
    assert.equal(st('statement:' + sid(5)), 'cached');
    assert.equal(it['statement:' + sid(5)].label, 'Cached · unallocated');
    assert.equal(st('statement:' + sid(6)), 'compute_unsupported');
    assert.equal(it['statement:' + sid(6)].label, 'Compute unsupported');

    // Metadata matching.
    assert.equal(st('meta:amb'), 'ambiguous');
    assert.equal(it['meta:amb'].label, 'Match ambiguous');
    assert.equal(it['meta:amb'].amount, null);
    assert.equal(st('meta:unique'), 'ok');
    assert.equal(it['meta:unique'].statementId, sid(9));
    // Interval 11:00–12:00 costs $14; S9 active 11:05:10.650−120 s … 11:07:10.650, overlapping S10? no.
    close(it['meta:unique'].amount, (14 * 120000) / 3600000, 'unique metadata match');
    assert.equal(st('meta:350'), 'ok', 'rounded "350 ms" matches exactly 350 and not the 351 ms neighbour');
    assert.equal(it['meta:350'].statementId, sid(10));
    close(it['meta:350'].amount, (14 * 300) / 3600000);

    assert.equal(st('statement:' + sid(12)), 'price_unavailable');
    assert.match(it['statement:' + sid(12)].reason, new RegExp(SKU_UNPRICED));
    assert.equal(st('statement:' + sid(13)), 'waiting_billing');
    assert.equal(it['statement:' + sid(13)].label, 'Waiting for billing');

    assert.equal(st('meta:recent-missing'), 'waiting_history');
    assert.equal(it['meta:recent-missing'].label, 'Waiting for history');
    assert.equal(st('meta:old-missing'), 'unavailable');
    assert.match(it['meta:old-missing'].reason, /older than the lookback|not yet ingested|not visible/);
    assert.equal(st('meta:before-lookback'), 'unavailable');
    assert.equal(st('statement:unknown'), 'unavailable');
    assert.equal(st('statement:native-running'), 'pending');
    assert.equal(it['statement:native-running'].label, 'Execution pending');
    assert.equal(st('statement:native-cached'), 'cached');
    assert.equal(st('bad'), 'row_unavailable');
    assert.equal(it.bad.label, 'Row unavailable');

    // Missing data is never zero.
    for (const item of Object.values(it)) if (item.status !== 'ok') assert.equal(item.amount, null, item.key);

    // Conservation over the allocated intervals.
    close(out.totals.allocated + out.totals.idle, out.totals.cost, 'allocated + idle = interval cost');
    assert.ok(out.totals.idle > 0, 'idle time stays unallocated');

    // Exactly three statements; billing SQL uses the shared adapter with the selected field only.
    assert.deepEqual(out.statements, ['queryEstimates:identity', 'queryEstimates:billing', 'queryEstimates:executions']);
    const billing = statements[1];
    assert.match(billing, /priced_usage/);
    if (priceTable.endsWith('list_prices')) {
      assert.match(billing, /p\.pricing\.effective_list\.default/);
      assert.doesNotMatch(billing, /p\.pricing\.default/);
    } else {
      assert.match(billing, /p\.pricing\.default/);
      assert.doesNotMatch(billing, /effective_list/);
    }
    assertNoSqlText(statements, out);
  });
}

test('sentinel: every statement_text cell holds the sentinel, and no SQL or result touches it', async () => {
  const db = await scenario();
  // Verify the fixture really has the sentinel in every row (read directly from the engine, not the extension).
  const res = await db.execute({ statement: 'SELECT COUNT(*) AS n, SUM(CASE WHEN statement_text = \'' + SENTINEL_SQL_TEXT + '\' THEN 1 ELSE 0 END) AS s FROM query.history' });
  assert.equal(res.result.data_array[0][0], res.result.data_array[0][1]);
  assert.ok(Number(res.result.data_array[0][0]) >= 14);
  const statements = [];
  const out = await qh.run({ conn: conn(), args: { targets: targets() }, nowMs: NOW, exec: executor(db, statements) });
  assertNoSqlText(statements, out);
  // The builders themselves never mention the column, for any target mix.
  const lb = { start: '2026-07-18', endExclusive: '2026-10-16' };
  const c = { workspaceId: WS, history: '`system`.`query`.`history`' };
  const idq = qh.buildIdentityQuery(c, qh.sanitizeTargets(targets(), NOW).targets, lb);
  assert.doesNotMatch(idq.statement, /statement_text/i);
});

test('statement IDs and a configured history view are quoted; invalid sources are refused', async () => {
  const db = await scenario();
  const statements = [];
  await assert.rejects(qh.run({ conn: conn('system.billing.list_prices', { historySource: 'x.y; DROP TABLE z' }), args: { targets: targets() }, nowMs: NOW, exec: executor(db, statements) }));
  await assert.rejects(qh.run({ conn: conn('main.finops.prices'), args: { targets: targets() }, nowMs: NOW, exec: executor(db, statements) }));
  assert.equal(statements.length, 0);
  const { targets: ok } = qh.sanitizeTargets([{ key: 'k', statementId: "x' OR 1=1 --" }, { key: "bad key'", statementId: sid(1) }], NOW);
  assert.equal(ok.length, 0, 'invalid statement IDs and keys are dropped');
});

test('at most 40 targets are accepted per request', () => {
  const many = Array.from({ length: 55 }, (_, i) => ({ key: 'statement:' + i, statementId: sid(100 + i) }));
  const { targets: t } = qh.sanitizeTargets(many, NOW);
  assert.equal(t.length, 40);
});

test('no request SQL at all when every row is resolved natively', async () => {
  const statements = [];
  const out = await qh.run({
    conn: conn(),
    args: { targets: [{ key: 'a', statementId: sid(1), status: 'queued' }, { key: 'b', warehouseId: W1, startMs: ms('2026-10-14T10:00:00'), durationMs: 5, toleranceMs: 0.5, cached: true }] },
    nowMs: NOW,
    exec: async (q) => statements.push(q),
  });
  assert.equal(statements.length, 0);
  assert.equal(out.items.a.status, 'pending');
  assert.equal(out.items.b.status, 'cached');
});

test('over the execution cap: estimates are withheld with a reason, never undercounted', async () => {
  const db = await scenario();
  // 10,001 extra executions overlapping 10:00–11:00 on W1.
  await db.exec(`INSERT INTO query.history
    SELECT '00000000-0000-4000-8000-' || lpad(CAST(i AS VARCHAR), 12, '0'), '${WS}', 'FINISHED',
           {'type': 'WAREHOUSE', 'warehouse_id': '${W1}', 'cluster_id': NULL},
           TIMESTAMP '2026-10-14 10:30:00', TIMESTAMP '2026-10-14 10:30:01', 1000, 1000, FALSE, '${SENTINEL_SQL_TEXT}'
    FROM range(10001) t(i)`);
  const statements = [];
  const out = await qh.run({ conn: conn(), args: { targets: [{ key: 's1', statementId: sid(1) }] }, nowMs: NOW, exec: executor(db, statements) });
  assert.equal(out.items.s1.status, 'unavailable');
  assert.equal(out.items.s1.label, 'Estimate unavailable');
  assert.equal(out.items.s1.amount, null);
  assert.match(out.items.s1.reason, /10,000 executions/);
  assertNoSqlText(statements, out);
});

test('history access errors propagate as classified errors (not cached as estimates)', async () => {
  const errors = load('errors.js');
  const exec = async () => {
    throw new errors.DccError({ errorCode: 'INSUFFICIENT_PERMISSIONS', message: 'User does not have SELECT on table system.query.history' });
  };
  await assert.rejects(qh.run({ conn: conn(), args: { targets: [{ key: 's1', statementId: sid(1) }] }, nowMs: NOW, exec }), (e) => e.dcc.code === 'HISTORY_ACCESS_DENIED');
});

test('partial billing coverage for an old window keeps the number and says so', async () => {
  const db = await createEngine();
  await db.insert('billing.usage', [usageRow({ date: '2026-10-10', start: '2026-10-10T10:00:00', end: '2026-10-10T11:00:00', qty: 6, sku: SKU, product: 'SQL', warehouse_id: W1 }),
    usageRow({ date: '2026-10-12', start: '2026-10-12T10:00:00', end: '2026-10-12T11:00:00', qty: 1, sku: SKU, product: 'SQL', warehouse_id: W1 })]);
  await db.insert('billing.list_prices', [listPrice({ sku: SKU, price: 1 })]);
  await db.insert('query.history', [hist({ id: sid(1), start: '2026-10-10T10:50:00', end: '2026-10-10T11:10:00', exec: 1200000 })]);
  const statements = [];
  const out = await qh.run({ conn: conn(), args: { targets: [{ key: 's1', statementId: sid(1) }] }, nowMs: NOW, exec: executor(db, statements) });
  assert.equal(out.items.s1.status, 'ok');
  close(out.items.s1.amount, 1, '10 of 60 minutes of a $6 interval');
  assert.ok(out.items.s1.assumptions.some((a) => /no recorded billing interval/.test(a)));
});

test('signed corrections in an interval are summed before allocation', async () => {
  const db = await createEngine();
  const base = { date: '2026-10-14', start: '2026-10-14T10:00:00', end: '2026-10-14T11:00:00', sku: SKU, product: 'SQL', warehouse_id: W1 };
  await db.insert('billing.usage', [usageRow({ ...base, qty: 10 }), usageRow({ ...base, qty: -10, record_type: 'RETRACTION' }), usageRow({ ...base, qty: 4, record_type: 'RESTATEMENT' })]);
  await db.insert('billing.list_prices', [listPrice({ sku: SKU, price: 1.5 })]);
  await db.insert('query.history', [hist({ id: sid(1), start: '2026-10-14T10:00:00', end: '2026-10-14T10:30:00', exec: 1800000 })]);
  const out = await qh.run({ conn: conn(), args: { targets: [{ key: 's1', statementId: sid(1) }] }, nowMs: NOW, exec: executor(db, []) });
  close(out.items.s1.amount, (4 * 1.5) / 2);
});

/* ------------------------------------------------------------------ computeRates */

async function rateDb(priceTable = 'system.billing.list_prices') {
  const db = await createEngine();
  const price = priceTable.endsWith('account_prices') ? accountPrice : listPrice;
  await db.insert('billing.usage', [
    // W1 was Pro until Oct 5, then serverless.
    usageRow({ date: '2026-10-01', start: '2026-10-01T10:00:00', end: '2026-10-01T11:00:00', qty: 3, sku: SKU_UNPRICED, product: 'SQL', warehouse_id: W1 }),
    usageRow({ date: '2026-10-10', start: '2026-10-10T10:00:00', end: '2026-10-10T11:00:00', qty: 3, sku: SKU, product: 'SQL', warehouse_id: W1, serverless: true }),
    // Older than 90 days: ignored.
    usageRow({ date: '2026-06-01', start: '2026-06-01T10:00:00', end: '2026-06-01T11:00:00', qty: 3, sku: 'OLD_SKU', product: 'SQL', warehouse_id: W2 }),
    // All-purpose usage: Photon and non-Photon SKUs.
    usageRow({ date: '2026-10-10', qty: 2, sku: 'PREMIUM_ALL_PURPOSE_COMPUTE', product: 'ALL_PURPOSE', cluster_id: '1015-101010-abcdefgh', photon: false }),
    usageRow({ date: '2026-10-11', qty: 2, sku: 'PREMIUM_ALL_PURPOSE_COMPUTE_(PHOTON)', product: 'ALL_PURPOSE', cluster_id: '1015-202020-ijklmnop', photon: true }),
    usageRow({ date: '2026-10-11', qty: 2, sku: 'PREMIUM_JOBS_COMPUTE', product: 'JOBS', photon: false }),
    usageRow({ date: '2026-10-11', qty: 2, sku: 'PREMIUM_JOBS_SERVERLESS_COMPUTE', product: 'ALL_PURPOSE', serverless: true }),
  ]);
  await db.insert(priceTable.replace('system.', ''), [
    // Old serverless price ended; the current one is open-ended.
    price({ sku: SKU, price: 0.5, from: '2020-01-01T00:00:00', to: '2026-10-12T00:00:00' }),
    price({ sku: SKU, price: 0.7, from: '2026-10-12T00:00:00' }),
    price({ sku: 'PREMIUM_ALL_PURPOSE_COMPUTE', price: 0.55 }),
    price({ sku: 'PREMIUM_ALL_PURPOSE_COMPUTE_(PHOTON)', price: 0.6 }),
    price({ sku: 'PREMIUM_JOBS_COMPUTE', price: 0.15 }),
    price({ sku: 'PREMIUM_JOBS_SERVERLESS_COMPUTE', price: 0.35 }),
  ]);
  return db;
}

for (const priceTable of ['system.billing.list_prices', 'system.billing.account_prices']) {
  test(`computeRates warehouse (${priceTable.split('.').pop()}): latest billed SKU at its CURRENT price`, async () => {
    const db = await rateDb(priceTable);
    const statements = [];
    const r = await registry.run('computeRates', { conn: conn(priceTable), args: { target: 'warehouse', warehouseId: W1, serverless: true }, nowMs: NOW, exec: executor(db, statements) });
    assert.equal(r.status, 'ok');
    assert.equal(r.sku, SKU);
    close(r.ratePerDbu, 0.7, 'current price, not the expired one');
    assert.equal(r.currency, 'USD');
    assert.equal(r.priceTable, priceTable);
    assert.equal(r.label, 'DBU only');
    const sql = statements[0];
    if (priceTable.endsWith('list_prices')) assert.doesNotMatch(sql, /p\.pricing\.default/);
    else assert.doesNotMatch(sql, /effective_list/);
    assert.doesNotMatch(sql, /COALESCE\s*\([^)]*pricing/i);
    const mismatch = await rates.run({ conn: conn(priceTable), args: { target: 'warehouse', warehouseId: W1, serverless: false }, nowMs: NOW, exec: executor(db, []) });
    assert.equal(mismatch.status, 'unavailable', 'selected type differs from the latest billed SKU');
    assert.equal(mismatch.ratePerDbu, null);
  });
}

test('computeRates warehouse: no billing, missing price, and create-page rules', async () => {
  const db = await rateDb();
  const none = await rates.run({ conn: conn(), args: { target: 'warehouse', warehouseId: W2, serverless: true }, nowMs: NOW, exec: executor(db, []) });
  assert.equal(none.status, 'unavailable', 'billing older than 90 days is not used');
  const before = await rates.run({ conn: conn(), args: { target: 'warehouse', warehouseId: W1, serverless: null }, nowMs: Date.parse('2026-10-08T00:00:00Z'), exec: executor(db, []) });
  assert.equal(before.status, 'unavailable', 'latest SKU then was the unpriced Pro SKU');
  assert.match(before.reason, /No current price/);
  const fresh = await rates.run({ conn: conn(), args: { target: 'warehouse', serverless: true }, nowMs: NOW, exec: executor(db, []) });
  assert.equal(fresh.status, 'ok', 'new serverless warehouse: the single serverless SQL SKU billed in the workspace');
  close(fresh.ratePerDbu, 0.7);
  const statements = [];
  const classic = await rates.run({ conn: conn(), args: { target: 'warehouse', serverless: false }, nowMs: NOW, exec: executor(db, statements) });
  assert.equal(classic.status, 'unavailable');
  assert.equal(statements.length, 0, 'no SQL when a new non-serverless warehouse cannot be priced');
  await assert.rejects(rates.run({ conn: conn(), args: { target: 'warehouse', warehouseId: "x' OR '1'='1" }, nowMs: NOW, exec: executor(db, []) }));
});

test('computeRates allPurpose: Photon filter, ambiguity, cluster scope, never SQL or jobs SKUs', async () => {
  const db = await rateDb();
  const run = (args) => rates.run({ conn: conn(), args: { target: 'allPurpose', ...args }, nowMs: NOW, exec: executor(db, []) });
  const photon = await run({ photon: true });
  assert.equal(photon.status, 'ok');
  close(photon.ratePerDbu, 0.6);
  assert.equal(photon.sku, 'PREMIUM_ALL_PURPOSE_COMPUTE_(PHOTON)');
  const plain = await run({ photon: false });
  assert.equal(plain.status, 'ok');
  close(plain.ratePerDbu, 0.55);
  const unknown = await run({ photon: null });
  assert.equal(unknown.status, 'ambiguous', 'two observed SKUs with different prices and Photon unknown');
  assert.equal(unknown.ratePerDbu, null);
  assert.ok(!unknown.skus.includes('PREMIUM_JOBS_COMPUTE') && !unknown.skus.includes('PREMIUM_JOBS_SERVERLESS_COMPUTE') && !unknown.skus.includes(SKU));
  const cluster = await run({ photon: null, clusterId: '1015-202020-ijklmnop' });
  assert.equal(cluster.status, 'ok', 'existing cluster narrows to its own SKU');
  assert.equal(cluster.basis, 'cluster');
  close(cluster.ratePerDbu, 0.6);
  await assert.rejects(run({ clusterId: 'bad id' }));
});

test('computeRates allPurpose: missing and duplicate current prices are not guessed', async () => {
  const db = await createEngine();
  await db.insert('billing.usage', [usageRow({ date: '2026-10-10', qty: 1, sku: 'AP_A', product: 'ALL_PURPOSE' }), usageRow({ date: '2026-10-10', qty: 1, sku: 'AP_B', product: 'ALL_PURPOSE', photon: true })]);
  await db.insert('billing.list_prices', [listPrice({ sku: 'AP_A', price: 0.4 }), listPrice({ sku: 'AP_B', price: 0.4 }), listPrice({ sku: 'AP_B', price: 0.45, from: '2026-01-01T00:00:00' })]);
  const run = (photon) => rates.run({ conn: conn(), args: { target: 'allPurpose', photon }, nowMs: NOW, exec: executor(db, []) });
  assert.equal((await run(false)).status, 'ok');
  assert.equal((await run(true)).status, 'ambiguous', 'two current price rows for one SKU');
  const db2 = await createEngine();
  await db2.insert('billing.usage', [usageRow({ date: '2026-10-10', qty: 1, sku: 'AP_A', product: 'ALL_PURPOSE' })]);
  const missing = await rates.run({ conn: conn(), args: { target: 'allPurpose', photon: null }, nowMs: NOW, exec: executor(db2, []) });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.ratePerDbu, null);
});
