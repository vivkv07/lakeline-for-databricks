import { legacyFragment } from './fixture-data.mjs';
// Content-side tests for Query History estimates and compute-size previews in the SIMULATED jsdom
// environment (support/content-harness.mjs). Not proof of behavior in a real Databricks tab.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { load } from './support/load.mjs';
import { createContentEnv, BASE_CONTENT_FILES, settle } from './support/content-harness.mjs';
import { SENTINEL_SQL_TEXT } from './support/sqlengine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => legacyFragment(readFileSync(path.join(HERE, 'fixture', name), 'utf8'));
const ncd = load('content/native-cost-data.js');

const FILES = [
  ...BASE_CONTENT_FILES,
  'src/core/allocation.js',
  'src/content/native-cost-data.js',
  'src/content/native-estimates-ui.js',
  'src/content/warehouse-ui.js',
  'src/content/content-main.js',
];
const WS = '1234567890';
const SID = (n) => '01f0a1b2-c3d4-1e5f-9a8b-7c6d5e4f3a' + n;
const W1 = 'a1b2c3d4e5f60001';
const page = (body) => `<!doctype html><html><head></head><body><nav aria-label="Top Navigation">nav</nav><main>${body}</main></body></html>`;

function serviceWorker(opts = {}) {
  const calls = { estimates: [], rates: [], rows: 0 };
  const settings = { mode: 'connected', periodDays: 30, showCosts: true, revision: 1 };
  const fn = (raw) => {
    const msg = JSON.parse(JSON.stringify(raw)); // plain Node-realm copy of the jsdom message
    if (msg.type === 'dcc:hello') return { ok: true, data: { origin: msg.origin, workspaceId: opts.workspaceId || WS, idSource: 'param:o', settings: { ...settings }, connection: { workspaceId: opts.workspaceId || WS } } };
    if (msg.type === 'dcc:summary') return { ok: true, data: { kind: 'summary', pricingBasis: 'list', priceTable: 'system.billing.list_prices', currency: 'USD', current: { coverage: 'empty' }, currentAmount: null, previousAmount: null, daily: [] } };
    if (msg.type === 'dcc:rows') {
      calls.rows += 1;
      return { ok: true, data: { items: {} } };
    }
    if (msg.type === 'dcc:query' && msg.kind === 'queryEstimates') {
      calls.estimates.push(msg);
      const items = {};
      for (const t of msg.args.targets) items[t.key] = (opts.estimate || defaultEstimate)(t);
      return { ok: true, data: { kind: 'queryEstimates', pricingBasis: 'list', priceTable: 'system.billing.list_prices', currency: 'USD', items } };
    }
    if (msg.type === 'dcc:query' && msg.kind === 'computeRates') {
      calls.rates.push(msg);
      return { ok: true, data: Object.assign({ kind: 'computeRates', pricingBasis: 'list', priceTable: 'system.billing.list_prices', currency: 'USD', unit: 'DBU' }, (opts.rate || defaultRate)(msg.args)) };
    }
    return { ok: true, data: null };
  };
  return { fn, calls, settings };
}

/** createContentEnv + guaranteed close (a failed assertion must not leave timers running). */
function openEnv(t, o) {
  const env = createContentEnv(o);
  t.after(() => env.close());
  return env;
}

function defaultEstimate(t) {
  if (t.statementId === SID(21)) return { key: t.key, status: 'ok', amount: 0.000412, reason: 'Allocated from 1 billing interval, no concurrent queries observed.', statementId: SID(21), warehouseId: W1, intervals: 1, concurrency: 1, assumptions: ['Cost is assumed uniform within each warehouse billing interval.', 'Queries active at the same time share a segment equally.'] };
  if (t.warehouseId === W1 && t.durationMs === 123000) return { key: t.key, status: 'ok', amount: 0.0123, reason: 'Allocated from 1 billing interval, shared with up to 2 other concurrent queries.', warehouseId: W1, intervals: 1, concurrency: 3, assumptions: [] };
  if (t.statementId === SID(26)) return { key: t.key, status: 'compute_unsupported', label: 'Compute unsupported', amount: null, reason: 'Only SQL warehouse executions are estimated. This statement ran on SERVERLESS_COMPUTE compute.' };
  return { key: t.key, status: 'ok', amount: 1.5, reason: 'Allocated.', assumptions: [] };
}

function defaultRate(args) {
  if (args.target === 'warehouse') return { target: 'warehouse', status: 'ok', ratePerDbu: 0.7, sku: 'PREMIUM_SERVERLESS_SQL_COMPUTE_US_EAST' };
  if (args.photon === true) return { target: 'allPurpose', status: 'ok', ratePerDbu: 0.6, sku: 'PREMIUM_ALL_PURPOSE_COMPUTE_(PHOTON)' };
  if (args.photon === false) return { target: 'allPurpose', status: 'ok', ratePerDbu: 0.55, sku: 'PREMIUM_ALL_PURPOSE_COMPUTE' };
  return { target: 'allPurpose', status: 'ambiguous', ratePerDbu: null, reason: 'Observed all-purpose SKUs have different DBU prices.' };
}

/**
 * Record any read of SQL text cells (class fx-sql): text, markup, titles and attributes other than
 * href, on the cell, its descendants, or any ancestor that contains it (e.g. row.textContent).
 */
function guardSqlCells(w) {
  const violations = [];
  // jsdom's selector engine calls public DOM APIs, so the checks below avoid selectors and guard
  // against re-entry.
  let busy = false;
  const isSqlEl = (el) => {
    for (let e = el; e; e = e.parentNode) if (e.nodeType === 1 && typeof e.className === 'string' && /(^|\s)fx-sql(\s|$)/.test(e.className)) return true;
    return false;
  };
  const insideSql = (node) => Boolean(node) && isSqlEl(node.nodeType === 1 ? node : node.parentNode);
  const touches = (node) => {
    if (!node) return false;
    if (insideSql(node)) return true;
    return (node.nodeType === 1 || node.nodeType === 9 || node.nodeType === 11) && node.getElementsByClassName ? node.getElementsByClassName('fx-sql').length > 0 : false;
  };
  const record = (what, node, check) => {
    if (busy) return;
    busy = true;
    try {
      if (check(node)) violations.push(what);
    } finally {
      busy = false;
    }
  };
  const wrapGetter = (proto, prop, check = touches) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.get) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get() {
        record(prop, this, check);
        return d.get.call(this);
      },
      set: d.set,
    });
  };
  wrapGetter(w.Node.prototype, 'textContent');
  wrapGetter(w.Node.prototype, 'nodeValue');
  wrapGetter(w.CharacterData.prototype, 'data');
  wrapGetter(w.Text.prototype, 'wholeText');
  wrapGetter(w.Element.prototype, 'innerHTML');
  wrapGetter(w.Element.prototype, 'outerHTML');
  wrapGetter(w.HTMLElement.prototype, 'innerText');
  wrapGetter(w.HTMLElement.prototype, 'outerText');
  wrapGetter(w.HTMLElement.prototype, 'title', insideSql);
  // Attributes that can carry text. Structural attributes (role, class, data-dcc, href…) are read by
  // jsdom's own selector matching on every element and carry no SQL text.
  const TEXTY = new Set(['title', 'aria-label', 'aria-description', 'alt', 'placeholder', 'value', 'data-sql', 'data-text', 'data-query', 'content']);
  for (const method of ['getAttribute', 'getAttributeNS', 'getAttributeNode']) {
    const orig = w.Element.prototype[method];
    w.Element.prototype[method] = function (...args) {
      const name = String(args[args.length - 1]).toLowerCase();
      if (TEXTY.has(name)) record(method + ':' + name, this, insideSql);
      return orig.apply(this, args);
    };
  }
  wrapGetter(w.HTMLElement.prototype, 'dataset', insideSql);
  return violations;
}

const badgeIn = (row) => row.querySelector('[data-dcc="estimates"].dcc-est-badge');
const rowsOf = (doc) => [...doc.querySelectorAll('tbody tr')];

test('parsers: displayed durations keep their rounding tolerance; times are local to the second', () => {
  const d = (t) => ncd.parseDuration(t);
  assert.deepEqual(d('350 ms'), { ms: 350, toleranceMs: 0.5 });
  assert.deepEqual(d('1.2 s'), { ms: 1200, toleranceMs: 50 });
  assert.deepEqual(d('12 s'), { ms: 12000, toleranceMs: 500 });
  assert.deepEqual(d('1.23 s'), { ms: 1230, toleranceMs: 5 });
  assert.deepEqual(d('2m 3s'), { ms: 123000, toleranceMs: 500 });
  assert.deepEqual(d('2 min 3 sec'), { ms: 123000, toleranceMs: 500 });
  assert.deepEqual(d('1h 2m'), { ms: 3720000, toleranceMs: 30000 });
  assert.deepEqual(d('00:02:03'), { ms: 123000, toleranceMs: 500 });
  for (const bad of ['', '—', '< 1 ms', 'about 2 minutes', '2 apples']) assert.equal(d(bad), null, bad);

  const now = new Date(2026, 9, 15, 12, 0, 0).getTime();
  const t = (s, locale) => ncd.parseDisplayedTime(s, { nowMs: now, locale });
  const want = new Date(2026, 9, 15, 10, 23, 45).getTime();
  assert.equal(t('Oct 15, 2026, 10:23:45 AM'), want);
  assert.equal(t('October 15, 2026 at 10:23:45 AM'), want);
  assert.equal(t('15 Oct 2026, 10:23:45'), want);
  assert.equal(t('2026-10-15 10:23:45'), want);
  assert.equal(t('Oct 15, 10:23:45 AM'), want, 'year inferred');
  assert.equal(t('Today, 10:23:45 AM'), want);
  assert.equal(t('2026-10-15T10:23:45.900Z'), Date.parse('2026-10-15T10:23:45Z'), 'explicit UTC floors to the second');
  assert.equal(t('10/15/2026, 10:23:45 AM', 'en-US'), want);
  assert.equal(t('15/10/2026, 10:23:45', 'en-GB'), want, 'unambiguous day/month');
  assert.equal(t('05/10/2026, 10:23:45', 'de-DE'), null, 'ambiguous day/month order is refused');
  assert.equal(t('Oct 15, 2026, 10:23 AM'), null, 'no seconds → no second-precision match');
  assert.equal(t('2 minutes ago'), null);
  assert.equal(ncd.mapStatus('Running'), 'running');
  assert.equal(ncd.mapStatus('Queued'), 'queued');
  assert.equal(ncd.mapStatus('Finished'), 'finished');
  assert.equal(ncd.mapStatus('Canceled'), 'canceled');
});

test('Query History: one estimate per row, note under the heading, local states, no SQL text reads', async (t) => {
  const sw = serviceWorker();
  const env = openEnv(t, { url: 'https://dbc-1.cloud.databricks.com/sql/history?o=' + WS, html: page(fixture('query-history.html')), files: FILES, onMessage: sw.fn });
  const violations = guardSqlCells(env.window);
  const doc = env.document;
  const rowClicks = [];
  for (const r of rowsOf(doc)) r.addEventListener('click', () => rowClicks.push(r));
  await settle(400);

  const rows = rowsOf(doc);
  assert.equal(rows.length, 6);
  for (const r of rows) {
    assert.equal(r.querySelectorAll('[data-dcc="estimates"]').length, 1, 'exactly one badge per row');
    assert.equal(badgeIn(r).parentElement, r.cells[2], 'badge sits in the Duration cell');
  }
  const text = (i) => badgeIn(rows[i]).textContent;
  assert.equal(text(0), '≈ $0.000412 approx.');
  assert.equal(text(1), '≈ $0.0123 approx.');
  assert.equal(text(2), 'Execution pending');
  assert.equal(text(3), 'Cached · unallocated');
  assert.equal(text(4), 'Row unavailable');
  assert.equal(text(5), 'Compute unsupported');

  // Requests: one batch, only rows that need the service; running/cached/unparsed rows are local.
  assert.equal(sw.calls.estimates.length, 1);
  const targets = sw.calls.estimates[0].args.targets;
  assert.deepEqual(targets.map((t) => t.key).sort(), ['statement:' + SID(21), 'statement:' + SID(26), [
    'meta', W1, new Date(2026, 9, 15, 10, 24, 10).getTime(), 123000, 500].join(':')].sort());
  const meta = targets.find((t) => t.warehouseId);
  assert.deepEqual({ w: meta.warehouseId, s: meta.startMs, d: meta.durationMs, tol: meta.toleranceMs }, { w: W1, s: new Date(2026, 9, 15, 10, 24, 10).getTime(), d: 123000, tol: 500 });
  assert.equal(targets.find((t) => t.statementId === SID(21)).startMs, new Date(2026, 9, 15, 10, 23, 45).getTime());
  assert.ok(sw.calls.estimates[0].scope.length < 200, 'scope is a short hash, not a truncated key list');
  assert.equal(sw.calls.rows, 0, 'no generic warehouse-total badges requested on Query History');
  assert.equal(doc.querySelectorAll('[data-dcc]:not([data-dcc="estimates"]):not([data-dcc="banner"])').length, 0, 'no other badges on this page');

  // Explanatory note right under the native heading.
  const h1 = doc.querySelector('h1');
  const note = h1.nextElementSibling;
  assert.equal(note.getAttribute('data-dcc'), 'estimates');
  for (const phrase of [/allocated estimate/, /uniform/, /shared equally/, /approximated/, /hidden from you/, /delayed or partial/, /unused capacity/, /not measured CPU or memory/, /not an invoice line/]) assert.match(note.textContent, phrase);

  // Tooltip on focus and hover; Escape hides; clicks never reach the native row.
  const b0 = badgeIn(rows[0]);
  assert.equal(b0.getAttribute('tabindex'), '0');
  b0.dispatchEvent(new env.window.FocusEvent('focusin', { bubbles: true }));
  const tip = doc.getElementById('dcc-est-tip');
  assert.equal(tip.hidden, false);
  assert.equal(tip.getAttribute('role'), 'tooltip');
  assert.equal(b0.getAttribute('aria-describedby'), 'dcc-est-tip');
  assert.match(tip.textContent, /Allocated query estimate: \$0\.000412/);
  assert.match(tip.textContent, /uniform within each warehouse billing interval/);
  assert.match(tip.textContent, /List price/);
  badgeIn(rows[5]).dispatchEvent(new env.window.MouseEvent('mouseover', { bubbles: true }));
  assert.match(tip.textContent, /SERVERLESS_COMPUTE/);
  assert.match(tip.textContent, /older than the 90-day lookback/);
  doc.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(tip.hidden, true);
  badgeIn(rows[4]).dispatchEvent(new env.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(rowClicks.length, 0, 'badge clicks do not trigger native row navigation');
  assert.equal(tip.hidden, false, 'click/tap toggles the tooltip');
  assert.match(tip.textContent, /cannot be matched to query history uniquely/);

  // Stable: further ticks make no DOM writes and send no new requests.
  const writes = [];
  const mo = new env.window.MutationObserver((list) => writes.push(...list));
  mo.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  env.window.__dccTest.scheduler.request();
  await settle(300);
  mo.disconnect();
  assert.equal(writes.length, 0, 'idle ticks make no DOM writes');
  assert.equal(sw.calls.estimates.length, 1);
  assert.equal(doc.querySelectorAll('[data-dcc="estimates"].dcc-est-badge').length, 6);

  assert.deepEqual(violations, [], 'SQL text cells were never read');
  assert.ok(!doc.querySelector('.dcc-est-note').textContent.includes(SENTINEL_SQL_TEXT));
  assert.ok(!JSON.stringify(sw.calls.estimates).includes(SENTINEL_SQL_TEXT), 'no SQL text in any request');
  env.close();
});

test('recycled and replaced rows get the estimate of the execution they now show', async (t) => {
  const sw = serviceWorker();
  const env = openEnv(t, { url: 'https://dbc-1.cloud.databricks.com/sql/history?o=' + WS, html: page(fixture('query-history.html')), files: FILES, onMessage: sw.fn });
  const violations = guardSqlCells(env.window);
  const doc = env.document;
  await settle(400);
  const rows = rowsOf(doc);
  // Virtualized recycling: row 1 now shows a different statement.
  rows[0].querySelector('.fx-sql a').setAttribute('href', '/sql/history?o=' + WS + '&queryId=' + SID(99));
  rows[0].cells[1].firstChild.data = 'Oct 15, 2026, 11:00:00 AM';
  // React re-render: row 2 replaced by a fresh node with the same data (badge must come back once).
  const clone = env.window.document.importNode(rows[1], true);
  clone.querySelectorAll('[data-dcc]').forEach((n) => n.remove());
  rows[1].replaceWith(clone);
  // Row 3 finishes.
  rows[2].cells[3].lastChild.data = 'Finished';
  rows[2].cells[3].querySelector('span').setAttribute('aria-label', 'Finished');
  await settle(500);
  const now = rowsOf(doc);
  assert.equal(badgeIn(now[0]).getAttribute('data-dcc-key'), 'statement:' + SID(99));
  assert.equal(badgeIn(now[0]).textContent, '≈ $1.50 approx.');
  assert.equal(now[1].querySelectorAll('[data-dcc="estimates"]').length, 1);
  assert.equal(badgeIn(now[1]).textContent, '≈ $0.0123 approx.');
  assert.equal(badgeIn(now[2]).textContent, '≈ $1.50 approx.', 'finished row is now requested');
  const keys = sw.calls.estimates.flatMap((m) => m.args.targets.map((t) => t.key));
  assert.ok(keys.includes('statement:' + SID(99)) && keys.includes('statement:' + SID(23)));
  assert.equal(keys.filter((k) => k.startsWith('meta:')).length, 1, 'the replaced row reused the cached estimate');
  assert.equal(doc.querySelectorAll('[data-dcc="estimates"].dcc-est-badge').length, 6);
  assert.deepEqual(violations, []);
  env.close();
});

test('role="grid" div rows parse the same way; ambiguous and waiting states show their labels', async (t) => {
  const html = `<section><h2>Query history</h2><div role="grid" aria-label="Query history">
    <div role="row"><div role="columnheader">Query</div><div role="columnheader">Started</div><div role="columnheader">Duration</div><div role="columnheader">Status</div><div role="columnheader">Compute</div></div>
    <div role="row" data-r="a"><div role="gridcell" class="fx-sql" title="${SENTINEL_SQL_TEXT}">${SENTINEL_SQL_TEXT}</div><div role="gridcell"><time datetime="2026-10-15T08:00:01.400Z">8:00:01 AM</time></div><div role="gridcell">1.2 s</div><div role="gridcell">Finished</div><div role="gridcell"><a href="/sql/warehouses/${W1}">wh</a></div></div>
    <div role="row" data-r="b"><div role="gridcell" class="fx-sql">${SENTINEL_SQL_TEXT}</div><div role="gridcell">2026-10-15 09:00:02</div><div role="gridcell">350 ms</div><div role="gridcell">Finished</div><div role="gridcell" data-warehouse-id="${W1}">wh</div></div>
  </div></section>`;
  const sw = serviceWorker({
    estimate: (t) => (t.durationMs === 1200 ? { key: t.key, status: 'ambiguous', amount: null, reason: '2 executions match.' } : { key: t.key, status: 'waiting_history', amount: null, reason: 'No record yet.' }),
  });
  const env = openEnv(t, { url: 'https://dbc-1.cloud.databricks.com/sql/history?o=' + WS, html: page(html), files: FILES, onMessage: sw.fn });
  const violations = guardSqlCells(env.window);
  await settle(400);
  const doc = env.document;
  const a = doc.querySelector('[data-r="a"] .dcc-est-badge');
  const b = doc.querySelector('[data-r="b"] .dcc-est-badge');
  assert.equal(a.textContent, 'Match ambiguous');
  assert.equal(b.textContent, 'Waiting for history');
  const tg = sw.calls.estimates[0].args.targets;
  assert.equal(tg.find((x) => x.durationMs === 1200).startMs, Date.parse('2026-10-15T08:00:01Z'));
  assert.equal(tg.find((x) => x.durationMs === 350).toleranceMs, 0.5);
  assert.equal(doc.querySelector('h2').nextElementSibling.className, 'dcc-est-note');
  assert.deepEqual(violations, []);
  env.close();
});

test('pause and route change remove every estimate element; errors become reasons', async (t) => {
  const sw = serviceWorker();
  const env = openEnv(t, { url: 'https://dbc-1.cloud.databricks.com/sql/history?o=' + WS, html: page(fixture('query-history.html')), files: FILES, onMessage: sw.fn });
  const doc = env.document;
  await settle(400);
  assert.ok(doc.querySelectorAll('[data-dcc="estimates"]').length >= 7);
  sw.settings.showCosts = false;
  await env.setStorage({ 'dcc.settings': { showCosts: false } });
  await settle(300);
  assert.equal(doc.querySelectorAll('[data-dcc="estimates"]').length, 0, 'paused: badges, note, tooltip and style removed');
  sw.settings.showCosts = true;
  await env.setStorage({ 'dcc.settings': { showCosts: true } });
  await settle(400);
  assert.equal(doc.querySelectorAll('.dcc-est-badge').length, 6);
  env.navigate('/jobs?o=' + WS);
  doc.body.appendChild(doc.createElement('div'));
  await settle(400);
  assert.equal(doc.querySelectorAll('[data-dcc="estimates"]').length, 0, 'left the route');
  env.close();

  const failing = openEnv(t, {
    url: 'https://dbc-1.cloud.databricks.com/sql/history?o=' + WS,
    html: page(fixture('query-history.html')),
    files: FILES,
    onMessage: (msg) => (msg.type === 'dcc:query' ? { ok: false, error: { code: 'HISTORY_ACCESS_DENIED', title: 'No permission to read query history', steps: ['Ask an admin for SELECT on system.query.history.'] } } : serviceWorker().fn(msg)),
  });
  await settle(400);
  const badge = failing.document.querySelector('tbody tr .dcc-est-badge');
  assert.equal(badge.textContent, 'Estimate unavailable');
  assert.match(badge.getAttribute('aria-label'), /No permission to read query history/);
  failing.close();
});

/* ------------------------------------------------------------------ warehouse size previews */

const AZURE = 'https://adb-1234567890123456.7.azuredatabricks.net';
const optionPreview = (doc, size) => {
  const opt = [...doc.querySelectorAll('[role="option"]')].find((o) => o.firstElementChild && o.firstElementChild.textContent === size);
  const p = opt && opt.querySelector('[data-dcc="warehouse-preview"]');
  return p ? p.textContent : null;
};

function watchNative(doc) {
  const clicks = [];
  doc.addEventListener('click', (e) => clicks.push(e.target), true);
  doc.addEventListener('submit', (e) => clicks.push(e.target), true);
  const inputs = [...doc.querySelectorAll('input')].map((i) => [i, i.value, i.checked]);
  return { clicks, unchanged: () => inputs.every(([i, v, c]) => i.value === v && i.checked === c) };
}

test('warehouse size dropdown: explicit DBU/h first, per-cluster wording, 5X-Large unavailable', async (t) => {
  const sw = serviceWorker();
  const env = openEnv(t, { url: AZURE + '/sql/warehouses/' + W1 + '/edit', html: page(fixture('warehouse-size.html')), files: FILES, onMessage: sw.fn });
  const doc = env.document;
  const native = watchNative(doc);
  await settle(400);
  assert.equal(optionPreview(doc, 'Small'), '≈ $8.40/h per cluster · DBU only');
  assert.equal(optionPreview(doc, '2X-Small'), '≈ $2.80/h per cluster · DBU only');
  assert.equal(optionPreview(doc, '4X-Large'), '≈ $369.60/h per cluster · DBU only');
  assert.equal(optionPreview(doc, '5X-Large'), 'Rate unavailable');
  const trigger = doc.querySelector('button[role="combobox"]');
  assert.equal(trigger.nextElementSibling.textContent, '≈ $8.40/h per cluster · DBU only');
  assert.match(trigger.nextElementSibling.getAttribute('title'), /Autoscaling multiplies it/);
  assert.match(trigger.nextElementSibling.getAttribute('title'), /VM, disk, network/);
  assert.equal(sw.calls.rates.length, 1);
  assert.deepEqual(sw.calls.rates[0].args, { target: 'warehouse', warehouseId: W1, serverless: true });
  assert.equal(native.clicks.length, 0, 'nothing clicked or submitted');
  assert.ok(native.unchanged(), 'native inputs untouched');
  assert.equal(trigger.textContent, 'Small', 'native control text unchanged');
  env.close();
});

const stripHints = (html) => html.replace(/<span class="fx-hint">[^<]*<\/span>/g, '');

test('Azure serverless mapping only on Azure, only for detectable serverless, never real-time', async (t) => {
  // Azure + Serverless selected + no DBU text → published table (Medium = 24 DBU/h).
  let sw = serviceWorker();
  let env = openEnv(t, { url: AZURE + '/sql/warehouses/' + W1 + '/edit', html: page(stripHints(fixture('warehouse-size.html'))), files: FILES, onMessage: sw.fn });
  await settle(400);
  assert.equal(optionPreview(env.document, 'Medium'), '≈ $16.80/h per cluster · DBU only');
  assert.equal(optionPreview(env.document, '4X-Large'), '≈ $369.60/h per cluster · DBU only');
  assert.equal(optionPreview(env.document, '5X-Large'), 'Rate unavailable', 'no published rate for 5X-Large');
  assert.match(env.document.querySelector('.dcc-wh-preview').getAttribute('title'), /published Azure serverless table/);
  env.close();

  // Same page on AWS: no mapping, no rate request.
  sw = serviceWorker();
  env = openEnv(t, { url: 'https://dbc-1.cloud.databricks.com/sql/warehouses/' + W1 + '/edit?o=' + WS, html: page(stripHints(fixture('warehouse-size.html'))), files: FILES, onMessage: sw.fn });
  await settle(400);
  assert.equal(optionPreview(env.document, 'Medium'), 'Rate unavailable');
  assert.equal(sw.calls.rates.length, 0);
  env.close();

  // Azure but Pro selected.
  sw = serviceWorker();
  const pro = stripHints(fixture('warehouse-size.html')).replace('value="serverless" checked', 'value="serverless"').replace('value="pro">', 'value="pro" checked>');
  env = openEnv(t, { url: AZURE + '/sql/warehouses/' + W1 + '/edit', html: page(pro), files: FILES, onMessage: sw.fn });
  await settle(400);
  assert.equal(optionPreview(env.document, 'Small'), 'Rate unavailable');
  env.close();

  // Azure, serverless type not detectable (no type control at all).
  sw = serviceWorker();
  const noType = stripHints(fixture('warehouse-size.html')).replace(/<fieldset>[\s\S]*?<\/fieldset>/, '');
  env = openEnv(t, { url: AZURE + '/sql/warehouses/' + W1 + '/edit', html: page(noType), files: FILES, onMessage: sw.fn });
  await settle(400);
  assert.equal(optionPreview(env.document, 'Small'), 'Rate unavailable');
  env.close();

  // Azure, real-time serverless selection.
  sw = serviceWorker();
  const rt = stripHints(fixture('warehouse-size.html')).replace('checked> Serverless', 'checked> Serverless (real-time)');
  env = openEnv(t, { url: AZURE + '/sql/warehouses/' + W1 + '/edit', html: page(rt), files: FILES, onMessage: sw.fn });
  await settle(400);
  assert.equal(optionPreview(env.document, 'Small'), 'Rate unavailable');
  env.close();
});

test('warehouse rate unavailable from the service shows "Rate unavailable" with its reason', async (t) => {
  const sw = serviceWorker({ rate: () => ({ status: 'unavailable', ratePerDbu: null, reason: 'No DBU billing for this warehouse in the last 90 UTC days.' }) });
  const env = openEnv(t, { url: AZURE + '/sql/warehouses/' + W1 + '/edit', html: page(fixture('warehouse-size.html')), files: FILES, onMessage: sw.fn });
  await settle(400);
  assert.equal(optionPreview(env.document, 'Small'), 'Rate unavailable');
  const opt = [...env.document.querySelectorAll('[role="option"]')][2];
  assert.match(opt.querySelector('[data-dcc]').getAttribute('title'), /No DBU billing/);
  env.close();
});

/* ------------------------------------------------------------------ interactive compute previews */

test('interactive compute: native DBU/h range × all-purpose rate; updates on input and DOM changes', async (t) => {
  const sw = serviceWorker();
  const env = openEnv(t, { url: 'https://dbc-1.cloud.databricks.com/compute/clusters/create?o=' + WS, html: page(fixture('compute-create.html')), files: FILES, onMessage: sw.fn });
  const doc = env.document;
  const native = watchNative(doc);
  await settle(400);
  const dbuEl = doc.querySelector('[data-fx="dbu"]');
  const preview = () => dbuEl.nextElementSibling && dbuEl.nextElementSibling.matches('[data-dcc="warehouse-preview"]') ? dbuEl.nextElementSibling.textContent : null;
  assert.equal(preview(), '≈ $1.80–$5.40/h · DBU only');
  assert.match(dbuEl.nextElementSibling.getAttribute('title'), /driver is included only if that estimate includes it/);
  const opts = [...doc.querySelectorAll('[role="option"]')];
  assert.equal(opts[0].querySelector('[data-dcc]').textContent, '≈ $0.60/h · DBU only');
  assert.equal(opts[1].querySelector('[data-dcc]').textContent, '≈ $1.20/h · DBU only');
  assert.equal(opts[2].querySelector('[data-dcc]'), null, 'no DBU info → not priced');
  assert.ok(sw.calls.rates.every((m) => m.args.target === 'allPurpose'), 'never a SQL warehouse rate on compute pages');
  assert.deepEqual(sw.calls.rates[0].args, { target: 'allPurpose', photon: true });
  assert.equal(native.clicks.length, 0);
  assert.ok(native.unchanged());

  // The user unchecks Photon (simulated user input): rate re-queried without Photon.
  const photon = doc.getElementById('fx-cl-photon');
  photon.checked = false;
  photon.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  await settle(400);
  assert.equal(preview(), '≈ $1.65–$4.95/h · DBU only');
  assert.deepEqual(sw.calls.rates.at(-1).args, { target: 'allPurpose', photon: false });

  // The user raises max workers; Databricks re-renders its DBU estimate.
  const max = doc.getElementById('fx-cl-max');
  max.value = '10';
  max.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  dbuEl.firstChild.data = '3–11 DBU/h';
  await settle(400);
  assert.equal(preview(), '≈ $1.65–$6.05/h · DBU only');
  assert.equal(max.value, '10', 'input value is the user\'s, not changed by the extension');
  assert.equal(photon.checked, false);
  assert.equal(native.clicks.length, 0, 'nothing clicked, saved or resized');

  // Photon not detectable and rates ambiguous → "Rate unavailable".
  photon.closest('label').remove();
  doc.body.appendChild(doc.createElement('div'));
  await settle(400);
  assert.equal(preview(), 'Rate unavailable');
  assert.match(dbuEl.nextElementSibling.getAttribute('title'), /different DBU prices/);
  env.close();
});

test('existing cluster page passes the cluster ID; pause removes previews', async (t) => {
  const sw = serviceWorker();
  const env = openEnv(t, { url: 'https://dbc-1.cloud.databricks.com/compute/clusters/1015-202020-ijklmnop/configuration?o=' + WS, html: page(fixture('compute-create.html')), files: FILES, onMessage: sw.fn });
  await settle(400);
  assert.deepEqual(sw.calls.rates[0].args, { target: 'allPurpose', photon: true, clusterId: '1015-202020-ijklmnop' });
  assert.ok(env.document.querySelectorAll('[data-dcc="warehouse-preview"]').length >= 3);
  sw.settings.showCosts = false;
  await env.setStorage({ 'dcc.settings': { showCosts: false } });
  await settle(300);
  assert.equal(env.document.querySelectorAll('[data-dcc="warehouse-preview"]').length, 0);
  env.close();
});
