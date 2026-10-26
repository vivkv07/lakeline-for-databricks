// Genie result typing, formatting and automatic chart choice (src/core/genie-viz.js). Pure Node:
// no DOM, no network. Tables use the normalized shape from genie-api normalizeQueryResult.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './support/load.mjs';

const viz = load('core/genie-viz.js');
const demo = load('core/genie-demo.js');

const table = (cols, rows) => ({ columns: cols.map(([name, type]) => ({ name, type, numeric: /INT|LONG|DOUBLE|DECIMAL|FLOAT/.test(type || '') })), rows });
const model = (cols, rows, locale = 'en-US') => viz.profile(table(cols, rows), { locale });
const col = (m, name) => m.columns.find((p) => p.name === name);

test('headers: snake_case and camelCase become title case with unit hints; raw names stay in the tooltip', () => {
  const cases = {
    revenue_usd: 'Revenue (USD)',
    change_pct: 'Change %',
    orderDate: 'Order Date',
    TOTAL_REVENUE: 'Total Revenue',
    job_id: 'Job ID',
    jobId: 'Job ID',
    userid: 'User ID',
    avg_dbus_per_run: 'Avg DBUs per Run',
    p95_latency_ms: 'P95 Latency (ms)',
    duration_min: 'Duration (min)',
    costEUR: 'Cost (EUR)',
    share_of_total: 'Share of Total',
    pct: 'Percent',
    started_at: 'Started at',
  };
  for (const [raw, label] of Object.entries(cases)) assert.equal(viz.humanize(raw).label, label, raw);
  assert.equal(viz.humanize('revenue_usd').currency, 'USD');
  assert.equal(viz.humanize('error_ratio').percent, true);
  assert.equal(viz.humanize('paid').label, 'Paid');
  const m = model([['change_pct', 'DOUBLE'], ['started_at', 'TIMESTAMP']], [['9.4', '2026-10-14T08:15:30Z']]);
  assert.equal(viz.headerTitle(col(m, 'change_pct')), 'change_pct (double) · Values are already percents (0 to 100)');
  assert.equal(col(m, 'started_at').label, 'Started at (UTC)');
});

test('column typing: currency, percent scale from the values, integers, decimals, dates, ISO strings, years, booleans', () => {
  const m = model(
    [['revenue_usd', 'DECIMAL'], ['success_pct', 'DOUBLE'], ['error_ratio', 'DOUBLE'], ['orders', 'LONG'], ['avg_value', 'DOUBLE'], ['tiny', 'DOUBLE'], ['day', 'DATE'], ['iso_day', 'STRING'], ['ts', 'TIMESTAMP'], ['year', 'INT'], ['ok', 'BOOLEAN'], ['zip', 'STRING']],
    [
      ['412300.5', '71.4', '0.0021', '3120', '1.25', '0.00012', '2026-10-01', '2026-10-01', '2026-10-01T00:00:00Z', '2024', 'true', '02139'],
      ['96200', '100', '1', '1024', '2', '0.0031', '2026-10-02', '2026-10-02', '2026-10-02T00:00:00Z', '2025', 'false', '94105'],
      [null, null, null, null, null, null, null, null, null, null, null, null],
    ]
  );
  const f = (n) => col(m, n);
  assert.deepEqual([f('revenue_usd').format, f('revenue_usd').currency, f('revenue_usd').decimals], ['currency', 'USD', 2]);
  assert.deepEqual([f('success_pct').format, f('success_pct').percentScale], ['percent', 'whole']);
  assert.deepEqual([f('error_ratio').format, f('error_ratio').percentScale], ['percent', 'fraction']);
  assert.match(f('error_ratio').note, /fractions \(0 to 1\)/);
  assert.equal(f('orders').format, 'integer');
  assert.deepEqual([f('avg_value').format, f('avg_value').decimals], ['decimal', 2]);
  assert.equal(f('tiny').small, true);
  assert.deepEqual([f('day').kind, f('iso_day').kind, f('ts').kind, f('ts').dateOnly], ['date', 'date', 'timestamp', true]);
  assert.deepEqual([f('year').kind, f('year').role], ['year', 'time']);
  assert.deepEqual([f('ok').kind, f('zip').kind, f('zip').role], ['boolean', 'text', 'category']);
  assert.ok(m.columns.every((p) => p.nulls === 1));
});

test('IDs are recognized and never become measures', () => {
  const ten = Array.from({ length: 10 }, (_, i) => i);
  const m = model(
    [['run_id', 'BIGINT'], ['statement_key', 'STRING'], ['big', 'BIGINT'], ['row_number', 'INT'], ['orders', 'LONG'], ['small', 'INT'], ['amount', 'DOUBLE']],
    ten.map((i) => [String(801104417 + i * 97), 'k' + i, String(5000000 + i * 13), String(i + 1), String(1200 + i * 3), String(7 + (i % 3) * 5 + i), String(10 + i)])
  );
  const roles = Object.fromEntries(m.columns.map((p) => [p.name, p.role]));
  assert.deepEqual(roles, { run_id: 'id', statement_key: 'id', big: 'id', row_number: 'id', orders: 'measure', small: 'measure', amount: 'measure' });
  // A lone ID column next to one amount: bars labeled by the ID, the ID itself never charted.
  const one = model([['order_id', 'BIGINT'], ['amount_usd', 'DOUBLE']], ten.map((i) => [String(9000 + i), String(100 + i)]));
  const c = viz.choose(one);
  assert.equal(c.type, 'bar');
  assert.equal(c.category.name, 'order_id');
  assert.deepEqual(c.measures.map((p) => p.name), ['amount_usd']);
  assert.equal(viz.format('801104417', col(m, 'run_id')), '801104417', 'IDs keep their digits without grouping');
});

test('formatting: locale-aware numbers, currency, both percent scales, dates in UTC, n/a stays null, BigInt exact', () => {
  const m = model([['revenue_usd', 'DECIMAL'], ['orders', 'LONG'], ['change_pct', 'DOUBLE'], ['refund_ratio', 'DOUBLE'], ['score', 'DOUBLE'], ['day', 'DATE'], ['at', 'TIMESTAMP'], ['n', 'BIGINT']], [['412300', '3120', '9.4', '0.061', '3.14159', '2026-10-14', '2026-10-14T08:15:30.123456Z', '12345678901234567890']]);
  const f = (name, v, mode) => viz.format(v, col(m, name), mode);
  assert.equal(f('revenue_usd', '412300'), '$412,300');
  assert.equal(f('orders', '3120'), '3,120');
  assert.equal(f('change_pct', '9.4'), '9.4%');
  assert.equal(f('refund_ratio', '0.061'), '6.1%');
  assert.equal(f('score', '3.14159'), '3.14');
  assert.equal(f('day', '2026-10-14'), 'Oct 14, 2026');
  assert.equal(f('at', '2026-10-14T08:15:30.123456Z'), 'Oct 14, 2026, 08:15:30');
  assert.equal(f('n', '12345678901234567890'), '12,345,678,901,234,567,890');
  assert.equal(f('orders', null), null);
  assert.equal(f('orders', 'NaN'), 'NaN', 'unparseable values are shown as they are');
  assert.equal(f('revenue_usd', '1240512.40', 'kpi'), '$1.24M');
  assert.equal(f('orders', '3120', 'kpi'), '3,120', 'KPI values below 10,000 stay exact');
  assert.equal(viz.axis(250000, col(m, 'revenue_usd')), '$250K');
  assert.equal(viz.axis(0, col(m, 'revenue_usd')), '$0');
  const de = model([['revenue_eur', 'DECIMAL'], ['orders', 'LONG']], [['1234567.5', '3120']], 'de-DE');
  assert.equal(viz.format('1234567.5', col(de, 'revenue_eur')), '1.234.567,50 €');
  assert.equal(viz.format('3120', col(de, 'orders')), '3.120');
  const fr = model([['orders', 'LONG']], [['3120']], 'not a locale!!');
  assert.equal(fr.locale, 'en-US', 'invalid locales fall back');
  // Zone-less timestamps count as UTC; midnight-only timestamps read as dates.
  const ts = model([['at', 'TIMESTAMP_NTZ']], [['2026-10-14 23:59:00']]);
  assert.equal(viz.format('2026-10-14 23:59:00', ts.columns[0]), 'Oct 14, 2026, 23:59');
});

test('choose: KPI tiles for one row with 1 to 4 measures, otherwise a table', () => {
  const kpi = viz.choose(model([['total_usd', 'DECIMAL'], ['orders', 'LONG'], ['month', 'DATE']], [['1240512.4', '10831', '2026-09-01']]));
  assert.equal(kpi.type, 'kpi');
  assert.deepEqual(kpi.measures.map((p) => p.name), ['total_usd', 'orders']);
  assert.deepEqual(kpi.context.map((p) => p.name), ['month']);
  const five = viz.choose(model([['a', 'LONG'], ['b', 'LONG'], ['c', 'LONG'], ['d', 'LONG'], ['e', 'LONG']], [['1', '2', '3', '4', '5']]));
  assert.equal(five.type, 'none');
  assert.equal(viz.choose(model([['a', 'STRING']], [])).type, 'none');
});

test('choose: time series → line; comparable measures share one axis, others get a picker; repeats split by one category or fall back to a table', () => {
  const days = ['2026-10-03', '2026-10-01', '2026-10-02'];
  const together = viz.choose(model([['day', 'DATE'], ['web_usd', 'DECIMAL'], ['store_usd', 'DECIMAL']], days.map((d, i) => [d, String(400 + i), String(300 + i)])));
  assert.deepEqual([together.type, together.together, together.split], ['line', true, null]);
  const apart = viz.choose(model([['day', 'DATE'], ['orders', 'LONG'], ['revenue_usd', 'DECIMAL']], days.map((d, i) => [d, String(1200 + i), String(400000 + i)])));
  assert.deepEqual([apart.type, apart.together], ['line', false], 'different units are never forced onto one axis');
  const scale = viz.choose(model([['day', 'DATE'], ['a', 'LONG'], ['b', 'LONG']], days.map((d, i) => [d, String(1200 + i), String(30 + i)])));
  assert.equal(scale.together, false, 'a 40x magnitude gap gets a picker');
  const iso = viz.choose(model([['week', 'STRING'], ['orders', 'LONG']], days.map((d, i) => [d, String(i)])));
  assert.equal(iso.type, 'line', 'ISO date strings count as time');
  const year = viz.choose(model([['year', 'INT'], ['revenue', 'DOUBLE']], [['2023', '1.5'], ['2024', '2.5'], ['2025', '3.1']]));
  assert.equal(year.type, 'line');
  const split = viz.choose(model([['day', 'DATE'], ['region', 'STRING'], ['revenue', 'DOUBLE']], [['2026-10-01', 'EMEA', '1'], ['2026-10-01', 'APAC', '2'], ['2026-10-02', 'EMEA', '3'], ['2026-10-02', 'APAC', null]]));
  assert.deepEqual([split.type, split.split && split.split.name], ['line', 'region']);
  const repeats = viz.choose(model([['day', 'DATE'], ['revenue', 'DOUBLE']], [['2026-10-01', '1'], ['2026-10-01', '2']]));
  assert.equal(repeats.type, 'none');
  const records = viz.choose(model([['at', 'TIMESTAMP'], ['pipeline', 'STRING'], ['minutes', 'DOUBLE']], [['2026-10-01T01:00:00Z', 'a', '1'], ['2026-10-01T02:00:00Z', 'b', '2']]));
  assert.equal(records.type, 'none', 'rows of different things are not a series');
});

test('choose: one category → bars; two numerics → scatter; ambiguous shapes → table', () => {
  const bar = viz.choose(model([['job_id', 'BIGINT'], ['job_name', 'STRING'], ['runs', 'LONG'], ['failed', 'LONG']], [['101', 'a', '5', '1'], ['102', 'b', '7', '0']]));
  assert.equal(bar.type, 'bar');
  assert.equal(bar.category.name, 'job_name');
  assert.deepEqual(bar.measures.map((p) => p.name), ['runs', 'failed'], 'job_id is never a measure');
  assert.equal(viz.choose(model([['region', 'STRING'], ['v', 'LONG']], [['a', '1'], ['a', '2']])).type, 'none', 'repeated labels are not aggregated');
  assert.equal(viz.choose(model([['region', 'STRING'], ['product', 'STRING'], ['v', 'LONG']], [['a', 'x', '1'], ['b', 'y', '2']])).type, 'none');
  const sc = viz.choose(model([['run_id', 'BIGINT'], ['duration_min', 'DOUBLE'], ['dbus', 'DOUBLE']], demo.ANSWERS[4].rows));
  assert.deepEqual([sc.type, sc.x.name, sc.y.name, sc.label.name], ['scatter', 'duration_min', 'dbus', 'run_id']);
  assert.equal(viz.choose(model([['x', 'DOUBLE'], ['y', 'DOUBLE']], [['1', '2'], ['2', '3'], ['3', '5']])).type, 'none', 'fewer than 5 points: no scatter');
});

test('build: bars sort descending, show the top 12 of N with a note, missing values are n/a (never 0)', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ['item ' + i, i === 4 ? null : String((i * 37) % 101)]);
  const m = model([['item', 'STRING'], ['value_usd', 'DECIMAL']], rows);
  const d = viz.build(m, viz.choose(m));
  assert.equal(d.items.length, 12);
  assert.equal(d.total, 30);
  assert.equal(d.note, 'Showing top 12 of 30');
  assert.ok(!d.items.some((it) => /other/i.test(it.label)), 'no invented Other bar');
  const vals = d.items.map((it) => it.value);
  assert.deepEqual(vals, vals.slice().sort((a, b) => b - a));
  const top = Math.max(...rows.map((r) => (r[1] === null ? -1 : Number(r[1]))));
  assert.equal(d.items[0].value, top);
  assert.equal(d.items[0].text, '$' + top);
  const few = model([['item', 'STRING'], ['value', 'LONG']], [['a', '3'], ['b', null], ['c', '0']]);
  const fd = viz.build(few, viz.choose(few));
  assert.deepEqual(fd.items.map((it) => [it.label, it.value, it.text]), [['a', 3, '3'], ['c', 0, '0'], ['b', null, null]]);
  assert.match(fd.summary, /1 without a value/);
  assert.equal(fd.note, null);
});

test('build: lines keep gaps as null, sort by time, split series by category; scatter omits incomplete rows', () => {
  const a = demo.ANSWERS[2];
  const m = viz.profile({ columns: a.columns.map(([name, type]) => ({ name, type })), rows: a.rows.slice().reverse() }, { locale: 'en-US' });
  const d = viz.build(m, viz.choose(m));
  assert.equal(d.series.length, 3);
  assert.deepEqual(d.series.map((s) => [s.name, s.cls]), [['Web', 's1'], ['Store', 's2'], ['Partner', 's3']], 'shared currency moves to the caption');
  assert.equal(d.caption, 'Web, Store, Partner (USD) by Order Date');
  assert.deepEqual(d.xs, d.xs.slice().sort((x, y) => x - y));
  const partner = d.series[2].points;
  assert.equal(partner.filter((p) => p.y === null).length, 1);
  assert.equal(partner.find((p) => p.y === null).x, Date.parse('2026-10-04T00:00:00Z'), 'the gap stays at its date');
  assert.ok(!partner.some((p) => p.y === 0));
  assert.equal(d.note, '1 missing value shown as gaps');
  assert.match(d.summary, /14 points from Oct 1, 2026 to Oct 14, 2026/);
  assert.equal(d.tick(Date.parse('2026-10-04T00:00:00Z')), 'Oct 4');
  const sm = model([['day', 'DATE'], ['region', 'STRING'], ['revenue', 'DOUBLE']], [['2026-10-01', 'EMEA', '1'], ['2026-10-01', 'APAC', '2'], ['2026-10-02', 'EMEA', '3'], ['2026-10-02', 'APAC', null]]);
  const sd = viz.build(sm, viz.choose(sm));
  assert.deepEqual(sd.series.map((s) => [s.name, s.points.map((p) => p.y)]), [['EMEA', [1, 3]], ['APAC', [2, null]]]);
  const sc = viz.profile({ columns: demo.ANSWERS[4].columns.map(([name, type]) => ({ name, type })), rows: demo.ANSWERS[4].rows }, { locale: 'en-US' });
  const sp = viz.build(sc, viz.choose(sc));
  assert.equal(sp.points.length, 17);
  assert.equal(sp.missing, 1);
  assert.equal(sp.note, '1 row without both values not shown');
  assert.equal(sp.points[0].label, '801104417');
});

test('build: KPI tiles carry compact values with the exact value beside them', () => {
  const a = demo.ANSWERS[3];
  const m = viz.profile({ columns: a.columns.map(([name, type]) => ({ name, type })), rows: a.rows }, { locale: 'en-US' });
  const d = viz.build(m, viz.choose(m));
  assert.deepEqual(d.tiles.map((t) => [t.label, t.value, t.exact]), [
    ['Total Revenue (USD)', '$1.24M', '$1,240,512.40'],
    ['Orders', '10.8K', '10,831'],
    ['Avg Order Value (USD)', '$114.53', null],
    ['Change Ratio', '6.1%', null],
  ]);
  assert.deepEqual(d.context, [{ label: 'Month', value: 'Sep 1, 2026' }]);
});

test('copy and export: TSV and CSV keep raw values, neutralize formulas, never turn null into 0', () => {
  const m = model([['label', 'STRING'], ['delta', 'DOUBLE'], ['big', 'BIGINT'], ['note', 'STRING']], [
    ['=HYPERLINK("https://evil.example","x")', '-2.5', '12345678901234567890', 'a\tb\nc'],
    ['+1 safe?', null, '7', '@SUM(A1)'],
    ['-3', '4', null, ' =1+1'],
    ['plain, "quoted"', '0', '1', null],
  ]);
  const tsv = viz.toTsv(m).split('\n');
  assert.equal(tsv[0], 'label\tdelta\tbig\tnote');
  assert.equal(tsv[1], '\'=HYPERLINK("https://evil.example","x")\t-2.5\t12345678901234567890\ta b c');
  assert.equal(tsv[2], "'+1 safe?\t\t7\t'@SUM(A1)");
  assert.equal(tsv[3], "'-3\t4\t\t' =1+1");
  assert.equal(tsv[4], 'plain, "quoted"\t0\t1\t');
  const csv = viz.toCsv(m).split('\r\n');
  assert.equal(csv[0], 'label,delta,big,note');
  assert.equal(csv[1], '"\'=HYPERLINK(""https://evil.example"",""x"")",-2.5,12345678901234567890,"a\tb\nc"');
  assert.equal(csv[3].split(',')[0], "'-3", 'formula-looking text is neutralized; numeric -2.5 stays a number');
  assert.equal(csv[4], '"plain, ""quoted""",0,1,');
});
