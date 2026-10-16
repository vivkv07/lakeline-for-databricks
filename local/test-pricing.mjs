// Pricing adapter tests. SQL is executed on the SIMULATED DuckDB engine (see support/sqlengine.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './support/load.mjs';
import { createEngine, usageRow, listPrice, accountPrice, WS } from './support/sqlengine.mjs';

const pricing = load('databricks/pricing.js');
const config = load('databricks/config.js');
const result = load('databricks/result.js');
const summary = load('databricks/queries/summary.js');

const NOW = Date.parse('2026-10-15T12:00:00Z'); // 7d period: 2026-10-08..14, prev 2026-10-01..07
const conn = (priceTable = 'system.billing.list_prices', extra = {}) => ({
  origin: 'https://dbc-1.cloud.databricks.com', workspaceId: WS, authMode: 'pat', priceTable,
  usageSource: 'system.billing.usage', historySource: 'system.query.history', currency: 'USD', ...extra,
});

async function runSummary(engine, c = conn()) {
  const q = summary.build(c, 7, NOW);
  const res = await engine.execute({ statement: q.statement, parameters: q.parameters, row_limit: q.rowLimit });
  return summary.parse(result.parseResult(res, { maxRows: q.maxRows }).rows, q);
}

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} expected ${b}, got ${a}`);

test('adapter derives the struct field from the table; any other table is rejected', () => {
  assert.equal(pricing.adapterFor('system.billing.list_prices').field, 'p.pricing.effective_list.default');
  assert.equal(pricing.adapterFor('system.billing.account_prices').field, 'p.pricing.default');
  for (const bad of ['main.finops.prices', 'system.billing.list_prices_v2', 'SYSTEM.BILLING.LIST_PRICES', 'system.billing.usage', '', undefined, 'constructor', '__proto__', 'toString']) {
    assert.throws(() => pricing.adapterFor(bad), String(bad));
  }
});

test('config validation: fixed price-table allowlist, approved sources only, no extra fields', () => {
  const ok = config.validateConnection({ ...conn('system.billing.account_prices'), warehouse: { mode: 'auto' }, priceField: 'x', schema: 'evil' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.priceTable, 'system.billing.account_prices');
  assert.ok(!('priceField' in ok.value) && !('schema' in ok.value));
  assert.equal(config.validateConnection({ ...conn('main.finops.custom_prices'), warehouse: { mode: 'auto' } }).ok, false);
  assert.equal(config.validateConnection({ ...conn(), usageSource: 'system.billing.list_prices', warehouse: { mode: 'auto' } }).ok, false);
  assert.equal(config.validateConnection({ ...conn(), usageSource: 'finops.views.usage_v', warehouse: { mode: 'auto' } }).value.usageSource, 'finops.views.usage_v');
  assert.equal(config.validateConnection({ ...conn(), usageSource: 'a.b.c; DROP TABLE x', warehouse: { mode: 'auto' } }).ok, false);
  assert.equal(config.validateConnection({ ...conn(), origin: 'https://accounts.cloud.databricks.com', warehouse: { mode: 'auto' } }).ok, false);
  assert.equal(config.validateConnection({ ...conn(), warehouse: { mode: 'manual', id: 'nothex' } }).ok, false);
});

test('generated SQL reads exactly one struct path and never COALESCEs across them', () => {
  const list = summary.build(conn('system.billing.list_prices'), 7, NOW).statement;
  const acct = summary.build(conn('system.billing.account_prices'), 7, NOW).statement;
  assert.match(list, /p\.pricing\.effective_list\.default/);
  assert.doesNotMatch(list, /p\.pricing\.default/);
  assert.match(acct, /p\.pricing\.default/);
  assert.doesNotMatch(acct, /effective_list/);
  for (const sql of [list, acct]) {
    assert.doesNotMatch(sql, /COALESCE\s*\([^)]*pricing/i);
    assert.match(sql, /`system`\.`billing`\.`usage`/);
  }
  assert.match(list, /`system`\.`billing`\.`list_prices`/);
  assert.match(acct, /`system`\.`billing`\.`account_prices`/);
});

test('both price schemas execute and give the same total for the same prices', async () => {
  for (const [table, row] of [['system.billing.list_prices', listPrice], ['system.billing.account_prices', accountPrice]]) {
    const db = await createEngine();
    await db.insert('billing.usage', [usageRow({ date: '2026-10-10', qty: 10 })]);
    await db.insert(table.replace('system.', ''), [row({ price: 0.15, list: 0.2 })]);
    const s = await runSummary(db, conn(table));
    assert.equal(s.current.coverage, 'complete', table);
    close(s.currentAmount, 1.5, table);
    assert.equal(s.priceTable, table);
    assert.equal(s.pricingBasis, table.endsWith('list_prices') ? 'list' : 'account');
  }
});

test('list adapter against an account-price schema fails at compile time (FIELD_NOT_FOUND analogue)', async () => {
  const db = await createEngine();
  await db.exec('DROP TABLE billing.list_prices; CREATE TABLE billing.list_prices AS SELECT * FROM billing.account_prices');
  const q = summary.build(conn('system.billing.list_prices'), 7, NOW);
  await assert.rejects(db.execute({ statement: q.statement, parameters: q.parameters }), /effective_list/);
});

test('price matching requires account, SKU, cloud, unit and currency', async () => {
  const db = await createEngine();
  await db.insert('billing.usage', [
    usageRow({ date: '2026-10-10', qty: 1, sku: 'A' }),
    usageRow({ date: '2026-10-10', qty: 1, sku: 'B' }),
    usageRow({ date: '2026-10-10', qty: 1, sku: 'C' }),
    usageRow({ date: '2026-10-10', qty: 1, sku: 'D' }),
    usageRow({ date: '2026-10-10', qty: 1, sku: 'E' }),
    usageRow({ date: '2026-10-10', qty: 1, sku: 'OK' }),
  ]);
  await db.insert('billing.list_prices', [
    listPrice({ sku: 'A', price: 1, account_id: 'other-account' }),
    listPrice({ sku: 'B', price: 1, cloud: 'AZURE' }),
    listPrice({ sku: 'C', price: 1, unit: 'TOKEN' }),
    listPrice({ sku: 'D', price: 1, currency: 'EUR' }),
    listPrice({ sku: 'OK', price: 2 }),
  ]);
  const s = await runSummary(db);
  assert.equal(s.current.coverage, 'partial');
  assert.equal(s.current.total, null, 'full total withheld');
  close(s.current.pricedSubtotal, 2);
  assert.deepEqual(s.current.unpricedSkus, ['A', 'B', 'C', 'D', 'E']);
  assert.equal(s.current.unpricedRecords, 5);
});

test('price validity: start inclusive, end exclusive, NULL end open-ended', async () => {
  const db = await createEngine();
  await db.insert('billing.usage', [
    usageRow({ date: '2026-10-09', qty: 1, start: '2026-10-09T23:00:00', end: '2026-10-10T00:00:00' }), // == boundary → new price
    usageRow({ date: '2026-10-09', qty: 1, start: '2026-10-09T22:00:00', end: '2026-10-09T23:59:59' }), // old price
    usageRow({ date: '2026-10-12', qty: 1 }), // new (open-ended)
  ]);
  await db.insert('billing.list_prices', [
    listPrice({ price: 1, from: '2020-01-01T00:00:00', to: '2026-10-10T00:00:00' }),
    listPrice({ price: 10, from: '2026-10-10T00:00:00' }),
  ]);
  const s = await runSummary(db);
  assert.equal(s.current.coverage, 'complete');
  close(s.currentAmount, 10 + 1 + 10);
});

test('overlapping price rows are ambiguous, never double counted', async () => {
  const db = await createEngine();
  await db.insert('billing.usage', [usageRow({ date: '2026-10-10', qty: 3 })]);
  await db.insert('billing.list_prices', [listPrice({ price: 1 }), listPrice({ price: 2, from: '2026-01-01T00:00:00' })]);
  const s = await runSummary(db);
  assert.equal(s.current.coverage, 'none');
  assert.equal(s.currentAmount, null);
  assert.equal(s.current.ambiguousRecords, 1);
});

test('signed corrections: ORIGINAL, RETRACTION and RESTATEMENT all count, negatives preserved', async () => {
  const db = await createEngine();
  await db.insert('billing.usage', [
    usageRow({ date: '2026-10-10', qty: 10, record_type: 'ORIGINAL' }),
    usageRow({ date: '2026-10-10', qty: -10, record_type: 'RETRACTION' }),
    usageRow({ date: '2026-10-10', qty: 8, record_type: 'RESTATEMENT' }),
    usageRow({ date: '2026-10-11', qty: -4, record_type: 'RETRACTION' }),
  ]);
  await db.insert('billing.list_prices', [listPrice({ price: 0.5 })]);
  const s = await runSummary(db);
  close(s.currentAmount, (10 - 10 + 8 - 4) * 0.5);
  const day11 = s.daily.find((d) => d.date === '2026-10-11');
  close(day11.cost, -2, 'negative day kept');
});

test('zero is distinct from missing: zero price is a real $0, no usage is "empty"', async () => {
  const db = await createEngine();
  await db.insert('billing.usage', [usageRow({ date: '2026-10-10', qty: 5, sku: 'ZERO' })]);
  await db.insert('billing.list_prices', [listPrice({ sku: 'ZERO', price: 0 })]);
  const s = await runSummary(db);
  assert.equal(s.current.coverage, 'complete');
  assert.equal(s.currentAmount, 0);
  assert.equal(s.previous.coverage, 'empty');
  assert.equal(s.previousAmount, null);
});

test('GENIE_FREE_USAGE is the only SKU assigned zero; its quantity is reported separately', async () => {
  const db = await createEngine();
  await db.insert('billing.usage', [
    usageRow({ date: '2026-10-10', qty: 7, sku: 'GENIE_FREE_USAGE', product: 'GENIE' }),
    usageRow({ date: '2026-10-10', qty: 3, sku: 'SOME_UNPRICED_SKU' }),
  ]);
  const s = await runSummary(db);
  assert.equal(s.current.coverage, 'partial');
  close(s.current.pricedSubtotal, 0);
  assert.deepEqual(s.current.unpricedSkus, ['SOME_UNPRICED_SKU']);
  close(s.freeQuantity.GENIE_FREE_USAGE, 7);
});

test('partial coverage reports count, SKUs and first/last affected dates; nothing priced shows no subtotal', async () => {
  const db = await createEngine();
  await db.insert('billing.usage', [
    usageRow({ date: '2026-10-09', qty: 1, sku: 'X' }),
    usageRow({ date: '2026-10-13', qty: 1, sku: 'Y' }),
    usageRow({ date: '2026-10-11', qty: 2, sku: 'P' }),
    usageRow({ date: '2026-10-03', qty: 1, sku: 'X' }),
  ]);
  await db.insert('billing.list_prices', [listPrice({ sku: 'P', price: 4 })]);
  const s = await runSummary(db);
  assert.equal(s.current.coverage, 'partial');
  close(s.current.pricedSubtotal, 8);
  assert.equal(s.current.firstUnpricedDate, '2026-10-09');
  assert.equal(s.current.lastUnpricedDate, '2026-10-13');
  assert.equal(s.previous.coverage, 'none');
  assert.equal(s.previousAmount, null);
});

test('periods: today excluded, previous period aligned, freshness from latest usage end', async () => {
  const db = await createEngine();
  await db.insert('billing.usage', [
    usageRow({ date: '2026-10-15', qty: 100 }), // today: excluded
    usageRow({ date: '2026-10-14', qty: 1, end: '2026-10-14T23:00:00', start: '2026-10-14T22:00:00' }),
    usageRow({ date: '2026-10-08', qty: 1 }),
    usageRow({ date: '2026-10-07', qty: 2 }),
    usageRow({ date: '2026-10-01', qty: 2 }),
    usageRow({ date: '2026-09-30', qty: 100 }), // before previous period
  ]);
  await db.insert('billing.list_prices', [listPrice({ price: 1 })]);
  const s = await runSummary(db);
  close(s.currentAmount, 2);
  close(s.previousAmount, 4);
  assert.equal(s.latestUsageMs, Date.parse('2026-10-14T23:00:00Z'));
});

test('oversized, truncated or chunked results are rejected, not shown as partial totals', () => {
  const base = { statement_id: '01ef0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b', manifest: { schema: { columns: [{ name: 'a', type_name: 'DOUBLE' }] }, total_row_count: 1, total_chunk_count: 1, truncated: false }, result: { data_array: [['1.5']] } };
  assert.equal(result.parseResult(base).rows[0].a, 1.5);
  assert.throws(() => result.parseResult({ ...base, manifest: { ...base.manifest, truncated: true } }), (e) => e.dcc.code === 'RESULT_TOO_LARGE');
  assert.throws(() => result.parseResult({ ...base, manifest: { ...base.manifest, total_chunk_count: 2 } }), (e) => e.dcc.code === 'RESULT_TOO_LARGE');
  assert.throws(() => result.parseResult({ ...base, manifest: { ...base.manifest, total_row_count: 20001 } }, { maxRows: 20000 }), (e) => e.dcc.code === 'RESULT_TOO_LARGE');
  assert.throws(() => result.parseResult({ ...base, manifest: { ...base.manifest, total_row_count: 2 } }), (e) => e.dcc.code === 'RESULT_TOO_LARGE');
});
