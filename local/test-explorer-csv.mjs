// Explorer CSV export safety. Pure Node, plus a SIMULATED jsdom download check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { load } from './support/load.mjs';

const CSV = load('explorer/csv.js');

test('text cells: quotes, commas and newlines are escaped by quoting', () => {
  assert.equal(CSV.cell('plain'), 'plain');
  assert.equal(CSV.cell('a,b'), '"a,b"');
  assert.equal(CSV.cell('say "hi"'), '"say ""hi"""');
  assert.equal(CSV.cell('line1\nline2'), '"line1\nline2"');
  assert.equal(CSV.cell('cr\rlf'), '"cr\rlf"');
  assert.equal(CSV.cell(null), '');
  assert.equal(CSV.cell(undefined, 'number'), '');
});

test('formula prefixes are neutralized in text cells', () => {
  for (const [input, expected] of [
    ['=HYPERLINK("http://x","y")', '"\'=HYPERLINK(""http://x"",""y"")"'],
    ['+cmd', "'+cmd"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\t=1', "'\t=1"],
    ['\r=1', '"\'\r=1"'],
    ['  =1+1', "'  =1+1"],
    ['/Users/a@b.com/nb', '/Users/a@b.com/nb'],
    ['job-name-1', 'job-name-1'],
  ]) assert.equal(CSV.cell(input), expected, JSON.stringify(input));
  // A negative-looking value that arrives as TEXT is still neutralized (it is not a cost).
  assert.equal(CSV.cell('-3.5', 'text'), "'-3.5");
});

test('numeric cells stay numbers: negatives preserved unquoted, missing is empty (never 0)', () => {
  assert.equal(CSV.cell(-3.5, 'number'), '-3.5');
  assert.equal(CSV.cell(-0.000412, 'number'), '-0.000412');
  assert.equal(CSV.cell(0.1 + 0.2, 'number'), '0.3');
  assert.equal(CSV.cell(1e-12, 'number'), '1e-12');
  assert.equal(CSV.cell(0, 'number'), '0');
  assert.equal(CSV.cell(null, 'number'), '');
  assert.equal(CSV.cell(NaN, 'number'), '');
  assert.equal(CSV.cell('12', 'number'), '', 'strings are never coerced into numbers');
  assert.equal(CSV.cell(42), '42');
});

test('toCsv writes metadata rows, a blank line, the header and rows with CRLF', () => {
  const text = CSV.toCsv({
    meta: [
      ['Source', 'Databricks Cost Companion — Cost Explorer: Top drivers'],
      ['Pricing basis', 'List price'],
      ['Price table', 'system.billing.list_prices'],
      ['Currency', 'USD'],
      ['Period start (UTC, inclusive)', '2026-09-15'],
      ['Period end (UTC, exclusive)', '2026-10-15'],
      ['Freshness', 'Latest usage 2026-10-15T09:00:00.000Z'],
      ['Scope', 'Workspace 42; Search = "=evil"'],
      ['Limit', 'Top 200 of 230'],
    ],
    columns: [
      { label: 'Resource', type: 'text', value: (r) => r.name },
      { label: 'Cost', type: 'number', value: (r) => r.cost },
      { label: 'Change', type: 'number', value: (r) => r.change },
    ],
    rows: [
      { name: '=cmd|"/c calc"!A1', cost: 12.5, change: -3.25 },
      { name: 'Correction, "retraction"', cost: -4, change: null },
      { name: 'multi\nline', cost: null, change: 0 },
    ],
  });
  const lines = text.split('\r\n');
  assert.equal(lines[0], 'Source,Databricks Cost Companion — Cost Explorer: Top drivers');
  assert.equal(lines[2], 'Price table,system.billing.list_prices');
  assert.equal(lines[4], '"Period start (UTC, inclusive)",2026-09-15');
  assert.equal(lines[7], 'Scope,"Workspace 42; Search = ""=evil"""');
  assert.equal(lines[9], '');
  assert.equal(lines[10], 'Resource,Cost,Change');
  assert.equal(lines[11], '"\'=cmd|""/c calc""!A1",12.5,-3.25');
  assert.equal(lines[12], '"Correction, ""retraction""",-4,');
  assert.equal(lines[13], '"multi\nline",,0'.split('\r\n')[0]);
  assert.ok(text.endsWith('\r\n'));
  // No cell anywhere starts with a raw formula character.
  for (const l of text.split(/\r\n/)) for (const c of l.split(',')) assert.doesNotMatch(c.replace(/^"/, ''), /^[=+@]/);
});

test('download: Blob + temporary <a download> on explicit call (SIMULATED jsdom)', () => {
  const dom = new JSDOM('<body><div id="c"></div></body>', { url: 'https://dbc-1.cloud.databricks.com/' });
  const w = dom.window;
  const created = [];
  const revoked = [];
  w.URL.createObjectURL = (blob) => {
    created.push(blob);
    return 'blob:https://dbc-1.cloud.databricks.com/abc';
  };
  w.URL.revokeObjectURL = (u) => revoked.push(u);
  let clicked = null;
  w.HTMLAnchorElement.prototype.click = function () {
    clicked = { href: this.href, download: this.download, connected: this.isConnected };
  };
  const container = w.document.getElementById('c');
  assert.equal(CSV.download(w.document, container, 'dcc explorer/../x.csv', 'a,b\r\n'), true);
  assert.equal(created.length, 1);
  assert.equal(created[0].type, 'text/csv;charset=utf-8');
  assert.equal(clicked.href, 'blob:https://dbc-1.cloud.databricks.com/abc');
  assert.equal(clicked.download, 'dcc-explorer-.-x.csv');
  assert.equal(clicked.connected, true);
  assert.equal(container.querySelector('a'), null, 'temporary anchor removed');
  dom.window.close();
  // Without object URLs the download reports false instead of throwing.
  const bare = new JSDOM('<body></body>');
  bare.window.URL.createObjectURL = undefined;
  assert.equal(CSV.download(bare.window.document, bare.window.document.body, 'x', 'y'), false);
});
