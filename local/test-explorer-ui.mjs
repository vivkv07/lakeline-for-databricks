// Explorer UI in a SIMULATED jsdom environment (support/content-harness.mjs): mounting in a
// shadow-root panel, keyboard tabs, exact values on hover/focus/tap, drilldowns, breadcrumbs,
// chips, explicit loads, runs overlap selection, layouts, CSV, and banner integration.
// Not proof of behavior in a real Databricks tab.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContentEnv, BASE_CONTENT_FILES, settle } from './support/content-harness.mjs';
import { load } from './support/load.mjs';

const demoData = load('core/demo-data.js');
const labels = load('core/labels.js');
const EXPLORER_FILES = [
  'src/explorer/explore-model.js',
  'src/explorer/explore-demo.js',
  'src/explorer/explore-data.js',
  'src/explorer/csv.js',
  'src/explorer/charts.js',
  'src/explorer/explorer.css.js',
  'src/explorer/explorer.js',
];
const ORIGIN = 'https://dbc-1.cloud.databricks.com';
const WS = '42';
const NOW = Date.parse('2026-10-15T12:00:00Z'); // 30d: 2026-09-15..10-14

/** Connected-shaped summary derived from the deterministic demo rows, with one missing date and one partial day. */
function connectedSummary() {
  const s = demoData.summary(ORIGIN, WS, 30, NOW);
  const daily = s.daily.filter((r) => r.date !== '2026-10-01').map((r) => (r.date === '2026-10-02' && r.product === 'SQL' ? Object.assign({}, r, { cost: null, complete: false, unpricedRecords: 3 }) : r));
  return Object.assign({}, s, { synthetic: false, pricingBasis: 'list', priceTable: 'system.billing.list_prices', priceField: 'pricing.effective_list.default', daily, current: Object.assign({}, s.current, { coverage: 'partial' }) });
}

const ENTITIES = {
  kind: 'exploreEntities', pricingBasis: 'list', priceTable: 'system.billing.list_prices', currency: 'USD',
  period: { days: 30, start: '2026-09-15', endExclusive: '2026-10-15', prevStart: '2026-08-16', prevEndExclusive: '2026-09-15', today: '2026-10-15' },
  limit: 200, candidateCount: 250, limited: true, latestUsageMs: NOW - 3600e3,
  totals: { coverage: 'complete', amount: 1000, pricedRecords: 9, unpricedRecords: 0 },
  items: [
    { key: 'job:111', ownerType: 'job', id: '111', name: 'nightly_etl', nameSource: 'job_name', amount: 400, status: 'ok', pricedRecords: 3, unpricedRecords: 0, prevAmount: 300, prevStatus: 'ok', activeDays: 30, latestUsageMs: NOW, scope: 'period', attribution: 'exclusive', warnings: [] },
    { key: 'cluster:0101-123456-abcdefgh', ownerType: 'cluster', id: '0101-123456-abcdefgh', name: null, nameSource: null, amount: 250.5, status: 'ok', pricedRecords: 2, unpricedRecords: 0, prevAmount: null, prevStatus: 'no-usage', activeDays: 10, latestUsageMs: NOW, scope: 'period', attribution: 'exclusive', warnings: [] },
    { key: 'app:a-1', ownerType: 'app', id: 'a-1', name: 'Bad Name <img>', nameSource: 'app_name', amount: 100, status: 'ok', pricedRecords: 1, unpricedRecords: 0, prevAmount: 120, prevStatus: 'ok', activeDays: 5, latestUsageMs: NOW, scope: 'period', attribution: 'exclusive', warnings: [] },
  ],
};

function runsResult(jobId) {
  const mk = (runId, amount, durationMs, extra = {}) => Object.assign({ key: 'job_run:' + (extra.jobId || '111') + ':' + runId, jobId: extra.jobId || '111', runId, jobName: 'nightly_etl', amount, status: 'ok', pricedRecords: 1, unpricedRecords: 0, firstUsageMs: NOW, lastUsageMs: NOW, cohortRuns: 3, cohortComplete: true, startMs: null, endMs: null, durationMs, resultState: durationMs ? 'SUCCEEDED' : null, durationStatus: durationMs ? 'ok' : 'unavailable', scope: 'period', attribution: 'exclusive', warnings: [] }, extra);
  return {
    kind: 'exploreRuns', pricingBasis: 'list', priceTable: 'system.billing.list_prices', currency: 'USD', period: ENTITIES.period, jobId: jobId || null,
    limit: 500, candidateCount: 4, limited: false, durationStatus: 'ok', latestUsageMs: NOW,
    warnings: [{ code: 'PERIOD_SCOPED', text: 'Run amounts include only billing recorded in the selected period. A run that started earlier or continued later has a different lifetime cost.' }],
    items: [mk('9001', 12.5, 3600000), mk('9002', 3.25, 600000), mk('9003', 3.25, 600000), mk('9004', 7, null)],
  };
}

function setup({ mode = 'connected', summary = mode === 'demo' ? demoData.summary(ORIGIN, WS, 30, NOW) : connectedSummary(), onQuery, panelWidth } = {}) {
  const queries = [];
  const env = createContentEnv({
    url: ORIGIN + '/jobs?o=' + WS,
    html: '<body><main></main></body>',
    files: [...BASE_CONTENT_FILES, ...EXPLORER_FILES],
    onMessage: async (msg) => {
      if (msg.type === 'dcc:query') {
        queries.push(msg);
        return onQuery ? onQuery(msg) : { ok: true, data: { unavailableInMode: mode } };
      }
      return { ok: true, data: null };
    },
  });
  const w = env.window;
  const doc = env.document;
  const host = doc.createElement('div');
  doc.querySelector('main').appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const panel = doc.createElement('div');
  panel.className = 'panel';
  if (panelWidth) Object.defineProperty(panel, 'clientWidth', { get: () => panelWidth });
  shadow.appendChild(panel);
  const data = w.DCC.workspaceData.create({ sendMessage: (m) => w.chrome.runtime.sendMessage(m), getContext: () => ({ origin: ORIGIN, workspaceId: WS }) });
  const ctx = { doc, origin: ORIGIN, workspaceId: WS, settings: { mode, periodDays: 30, showCosts: true }, connection: mode === 'connected' ? { workspaceId: WS, priceTable: 'system.billing.list_prices', currency: 'USD' } : null, data };
  const handle = w.DCC.explorer.mount(panel, ctx, { status: 'available', summary, periodDays: 30, nowMs: NOW });
  const $ = (sel) => shadow.querySelector(sel);
  const $$ = (sel) => [...shadow.querySelectorAll(sel)];
  const key = (el, k) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
  const chipsText = () => $$('.x-chips .chip > span').map((s) => s.textContent);
  const crumbText = () => $$('.x-crumbs li').map((li) => li.textContent);
  return { env, w, doc, shadow, panel, ctx, handle, queries, $, $$, key, chipsText, crumbText, summary };
}

const fmt = (v) => labels.formatAmount(v, 'USD');
const dayTotal = (summary, date) => summary.daily.filter((r) => r.period === 'cur' && r.date === date && r.cost !== null).reduce((a, r) => a + r.cost, 0);

test('mounts inside a shadow-root panel with its own style and six keyboard-operable tabs', () => {
  const t = setup();
  const style = t.panel.querySelector('style[data-dcc="explorer"]');
  assert.ok(style && style.textContent.includes('.dcc-x'));
  assert.equal(t.doc.querySelector('.dcc-x'), null, 'nothing leaks into the light DOM');
  const tabs = t.$$('[role="tablist"] [role="tab"]');
  assert.deepEqual(tabs.map((b) => b.textContent), ['Products', 'Top drivers', 'Runs', 'Calendar', 'SKUs', 'Daily detail']);
  assert.deepEqual(tabs.map((b) => b.getAttribute('tabindex')), ['0', '-1', '-1', '-1', '-1', '-1']);
  assert.equal(t.$('[role="tabpanel"]').getAttribute('aria-labelledby'), 'dcc-x-tab-products');
  tabs[0].focus();
  t.key(tabs[0], 'ArrowRight');
  assert.equal(t.$('[role="tab"][aria-selected="true"]').textContent, 'Top drivers');
  assert.equal(t.shadow.activeElement.textContent, 'Top drivers', 'focus follows the selected tab');
  t.key(t.shadow.activeElement, 'End');
  assert.equal(t.shadow.activeElement.textContent, 'Daily detail');
  t.key(t.shadow.activeElement, 'ArrowRight');
  assert.equal(t.shadow.activeElement.textContent, 'Products', 'wraps around');
  t.key(t.shadow.activeElement, 'ArrowLeft');
  assert.equal(t.shadow.activeElement.textContent, 'Daily detail');
  t.key(t.shadow.activeElement, 'Home');
  assert.equal(t.$('[role="tabpanel"]').getAttribute('aria-labelledby'), 'dcc-x-tab-products');
  // Visiting every view sends no SQL: Top drivers and Runs need an explicit Load.
  for (const b of t.$$('[role="tab"]')) t.$('#' + b.id).click();
  assert.equal(t.queries.length, 0);
  t.$('#dcc-x-tab-runs').click();
  assert.ok(t.$('[data-fk="load:exploreRuns"]'));
  assert.equal(t.queries.length, 0);
  t.env.close();
});

test('exact values on hover, keyboard focus and tap; arrow keys move between day marks', () => {
  const t = setup();
  const date = '2026-10-08';
  const mark = t.$('svg.stacked [role="button"][data-date="' + date + '"]');
  assert.ok(mark);
  assert.equal(t.$('svg.stacked').getAttribute('role'), 'group');
  assert.ok(t.$('svg.stacked g[role="img"]').getAttribute('aria-label').startsWith('Daily cost by product'));
  const exact = fmt(dayTotal(t.summary, date));
  assert.ok(mark.getAttribute('aria-label').includes(exact), 'aria-label carries the exact value');
  const tip = t.$('.tip');
  assert.equal(tip.hidden, true);
  mark.focus();
  assert.equal(t.$('.tip').hidden, false);
  assert.ok(t.$('.tip').textContent.includes(exact));
  assert.ok(t.$('.inspect').textContent.includes(exact));
  assert.ok(t.$('.tip').textContent.includes('Aligned prior day'));
  mark.dispatchEvent(new t.w.FocusEvent('blur'));
  assert.equal(t.$('.tip').hidden, true);
  mark.dispatchEvent(new t.w.MouseEvent('mouseenter'));
  assert.equal(t.$('.tip').hidden, false);
  const seg = mark.querySelector('rect.seg[data-key="JOBS"]');
  seg.dispatchEvent(new t.w.MouseEvent('mouseenter'));
  const jobs = t.summary.daily.find((r) => r.period === 'cur' && r.date === date && r.product === 'JOBS').cost;
  assert.ok(t.$('.tip').textContent.startsWith('JOBS: ' + fmt(jobs)), 'segment hover shows that product exactly');
  mark.dispatchEvent(new t.w.MouseEvent('mouseleave'));
  assert.equal(t.$('.tip').hidden, true);
  // Missing date: unavailable, never zero. Partial day: priced subtotal.
  assert.match(t.$('[data-date="2026-10-01"]').getAttribute('aria-label'), /Cost: unavailable/);
  assert.match(t.$('[data-date="2026-10-02"]').getAttribute('aria-label'), /priced subtotal/);
  // Roving tabindex: one Tab stop; ArrowRight moves focus to the next day.
  mark.focus();
  t.key(mark, 'ArrowRight');
  assert.equal(t.shadow.activeElement.getAttribute('data-date'), '2026-10-09');
  assert.equal(t.$$('svg.stacked [role="button"][tabindex="0"]').length, 1);
  // Tap: the first touch tap shows values only; a second tap drills down.
  const m2 = t.$('[data-date="2026-10-09"]');
  m2.dispatchEvent(new t.w.PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
  m2.dispatchEvent(new t.w.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(t.chipsText(), []);
  assert.equal(t.$('.tip').hidden, false);
  assert.ok(t.$('.tip').textContent.includes(fmt(dayTotal(t.summary, '2026-10-09'))));
  m2.dispatchEvent(new t.w.PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
  m2.dispatchEvent(new t.w.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(t.chipsText(), ['Day: Fri, Oct 9']);
  t.env.close();
});

test('drilldowns, breadcrumbs, removable chips and reset; a selected day keeps its aligned prior day', () => {
  const t = setup();
  t.$('[data-fk="legend:JOBS"]').click();
  assert.deepEqual(t.chipsText(), ['Product: JOBS']);
  assert.equal(t.$('[data-fk="legend:JOBS"]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(t.crumbText(), ['Workspace 42', 'Product: JOBS']);
  assert.equal(t.$('.x-crumbs [aria-current]').textContent, 'Product: JOBS');
  const day = t.$('svg.stacked [data-date="2026-10-07"]');
  day.focus();
  t.key(day, 'Enter');
  assert.deepEqual(t.chipsText(), ['Product: JOBS', 'Day: Wed, Oct 7']);
  assert.deepEqual(t.crumbText(), ['Workspace 42', 'Product: JOBS', 'Day: Wed, Oct 7']);
  const card = t.$('section.card[aria-label="Selected day detail"]');
  assert.ok(card.textContent.includes('Wed, Oct 7, 2026 (UTC) vs aligned prior day Mon, Sep 7, 2026'));
  const jobsDay = t.summary.daily.find((r) => r.date === '2026-10-07' && r.product === 'JOBS').cost;
  const jobsPrior = t.summary.daily.find((r) => r.date === '2026-09-07' && r.product === 'JOBS').cost;
  assert.ok(card.textContent.includes(fmt(jobsDay)) && card.textContent.includes(fmt(jobsPrior)));
  // The day stays selected with its aligned prior comparison in other summary views.
  t.$('#dcc-x-tab-daily').click();
  assert.ok(t.$('section.card[aria-label="Selected day detail"]').textContent.includes('aligned prior day Mon, Sep 7, 2026'));
  assert.equal(t.$('tbody tr.selected').querySelector('th').textContent, 'Wed, Oct 7, 2026');
  // Breadcrumb back to the product level drops the day.
  t.$('[data-fk="crumb:product"]').click();
  assert.deepEqual(t.chipsText(), ['Product: JOBS']);
  // Chip removal.
  t.$('[data-fk="chip:product"]').click();
  assert.deepEqual(t.chipsText(), []);
  assert.match(t.$('.x-chips').textContent, /No filters/);
  // SKU drilldown with daily detail, then search, then reset to workspace.
  t.$('#dcc-x-tab-skus').click();
  const skuBtn = t.$('tbody [data-fk^="row:"]');
  const sku = skuBtn.textContent;
  skuBtn.click();
  assert.deepEqual(t.chipsText(), ['SKU: ' + sku]);
  assert.ok(t.$('section.card[aria-label="SKU daily drilldown"]').textContent.includes('Daily cost of ' + sku));
  assert.ok(t.$('section.card svg.stacked'));
  const input = t.$('input[type="search"]');
  input.focus();
  input.value = 'premium';
  input.dispatchEvent(new t.w.Event('input', { bubbles: true }));
  assert.equal(t.shadow.activeElement.getAttribute('data-fk'), 'search', 'search keeps focus across re-render');
  assert.ok(t.chipsText().includes('Search: “premium”'));
  t.$('[data-fk="reset"]').click();
  assert.deepEqual(t.chipsText(), []);
  assert.equal(t.$('input[type="search"]').value, '');
  t.env.close();
});

test('sorting by cost, change and name in both directions; share hidden when coverage is partial', () => {
  const t = setup();
  t.$('#dcc-x-tab-skus').click();
  const order = () => t.$$('tbody tr th').map((th) => th.textContent);
  const sel = t.$('select[data-fk="sort"]');
  for (const v of ['cost:desc', 'cost:asc', 'change:desc', 'change:asc', 'name:asc', 'name:desc']) {
    t.$('select[data-fk="sort"]').value = v;
    t.$('select[data-fk="sort"]').dispatchEvent(new t.w.Event('change', { bubbles: true }));
    const rows = order();
    if (v === 'name:asc') assert.deepEqual(rows, rows.slice().sort());
    if (v === 'name:desc') assert.deepEqual(rows, rows.slice().sort().reverse());
  }
  assert.ok(sel);
  // Header button toggles direction and reports aria-sort.
  t.$('[data-fk="th:cost"]').click();
  assert.equal(t.$('th[aria-sort="descending"]').textContent.startsWith('Selected period'), true);
  t.$('[data-fk="th:cost"]').click();
  assert.equal(t.$('th[aria-sort="ascending"]').textContent.startsWith('Selected period'), true);
  // The summary has an unpriced SQL record: whole-workspace shares would mislead, so none are shown.
  assert.match(t.$('[role="tabpanel"]').textContent, /Share of total not shown: Some usage in this scope has no matching price/);
  // Within a fully priced product, shares are valid.
  t.$('#dcc-x-tab-products').click();
  t.$('[data-fk="legend:JOBS"]').click();
  t.$('#dcc-x-tab-skus').click();
  assert.doesNotMatch(t.$('[role="tabpanel"]').textContent, /Share of total not shown/);
  assert.match(t.$('tbody').textContent, /100%/);
  t.env.close();
});

test('Top drivers and Runs load only on explicit action, with cache, validated links and limit disclosure', async () => {
  const t = setup({
    onQuery: (msg) => ({ ok: true, data: msg.kind === 'exploreEntities' ? ENTITIES : runsResult(msg.args.jobId) }),
  });
  t.$('#dcc-x-tab-drivers').click();
  assert.equal(t.queries.length, 0);
  assert.match(t.$('[role="tabpanel"]').textContent, /Explorer ownership is exclusive/);
  t.$('[data-fk="load:exploreEntities"]').click();
  assert.match(t.$('[role="tabpanel"]').textContent, /Loading top drivers/);
  await settle(20);
  assert.equal(t.queries.length, 1);
  assert.equal(t.queries[0].kind, 'exploreEntities');
  assert.equal(t.queries[0].args.periodDays, 30);
  assert.equal(t.queries[0].scope, 'entities');
  assert.equal(t.queries[0].workspaceId, WS);
  assert.match(t.$('[role="tabpanel"]').textContent, /Showing the top 3 of 250 resources.*limited to 200/);
  const links = t.$$('tbody a');
  assert.deepEqual(links.map((a) => a.getAttribute('href')), [ORIGIN + '/jobs/111?o=42']);
  assert.match(t.$('tbody').textContent, /No link/, 'clusters and invalid app names get no guessed link');
  assert.equal(t.$$('svg.hbars [role="button"]').length, 3);
  // Names are text, never markup.
  assert.equal(t.shadow.querySelector('img'), null);
  assert.ok(t.$('tbody').textContent.includes('Bad Name <img>'));
  // Share is valid here (complete totals): 400 / 1000.
  assert.match(t.$('tbody').textContent, /40%/);
  // Tab away and back: still loaded, no new request.
  t.$('#dcc-x-tab-calendar').click();
  t.$('#dcc-x-tab-drivers').click();
  assert.equal(t.queries.length, 1);
  // Drill into the job, then load its runs.
  t.$('[data-fk="row:job:111"]').click();
  assert.deepEqual(t.chipsText(), ['Resource: nightly_etl (Job)']);
  assert.ok(t.$('section.card[aria-label="Selected resource"]').textContent.includes('$400.00'));
  t.$('[data-fk="show-runs"]').click();
  assert.equal(t.$('[role="tab"][aria-selected="true"]').textContent, 'Runs');
  assert.equal(t.$('[data-fk="load:exploreRuns"]').textContent, 'Load runs of nightly_etl');
  t.$('[data-fk="load:exploreRuns"]').click();
  await settle(20);
  assert.equal(t.queries.length, 2);
  assert.equal(t.queries[1].kind, 'exploreRuns');
  assert.equal(t.queries[1].args.jobId, '111');
  assert.equal(t.queries[1].scope, 'runs:job:111');
  const runLinks = t.$$('tbody a').map((a) => a.getAttribute('href'));
  assert.ok(runLinks.includes(ORIGIN + '/jobs/111/runs/9001?o=42'));
  assert.match(t.$('[role="tabpanel"]').textContent, /1 run\(s\) are left out of the scatter/);
  assert.match(t.$('[role="tabpanel"]').textContent, /different lifetime cost/);
  assert.match(t.$('tbody').textContent, /unavailable/);
  // Reload forces a fresh request past the client cache.
  t.$('[data-fk="reload:exploreRuns"]').click();
  await settle(20);
  assert.equal(t.queries.length, 3);
  t.env.close();
});

test('Runs: overlapping points can be cycled with arrow keys and listed', async () => {
  const t = setup({ onQuery: (msg) => ({ ok: true, data: runsResult() }) });
  t.$('#dcc-x-tab-runs').click();
  t.$('[data-fk="load:exploreRuns"]').click();
  await settle(20);
  const group = t.$('svg.scatter g.pt[data-count="2"]');
  assert.ok(group, 'two runs at the same spot form one group');
  assert.match(group.getAttribute('aria-label'), /2 runs at about 10m and \$3\.25/);
  group.focus();
  assert.match(t.$('.tip').textContent, /2 runs at about 10m/);
  t.key(group, 'ArrowDown');
  assert.match(t.$('.tip').textContent, /Run 2 of 2 here/);
  t.key(group, 'ArrowDown');
  assert.match(t.$('.tip').textContent, /Run 1 of 2 here/);
  t.key(group, 'Enter');
  const list = t.$('section.overlap');
  assert.ok(list);
  const buttons = [...list.querySelectorAll('button.linkish')];
  assert.equal(buttons.length, 2);
  assert.equal(list.querySelectorAll('a[href*="/jobs/111/runs/"]').length, 2);
  buttons[1].click();
  assert.equal(t.$('section.overlap'), null);
  assert.equal(t.chipsText().length, 1);
  assert.match(t.chipsText()[0], /^Run: 900[23] of nightly_etl$/);
  assert.ok(t.$('section.card[aria-label="Selected run"]'));
  t.env.close();
});

test('import mode: resource and run detail are not available; summary views still work', () => {
  const imported = { kind: 'summary', imported: true, pricingBasis: 'import', priceTable: null, currency: 'USD', currentAmount: 50, previousAmount: 40, current: { coverage: 'complete', total: 50 }, previous: { coverage: 'complete', total: 40 }, latestUsageMs: NOW - 86400e3, daily: [{ period: 'cur', date: '2026-10-10', product: 'IMPORTED', sku: 'IMPORTED', cost: 50, complete: true }] };
  const t = setup({ mode: 'import', summary: imported });
  assert.equal(t.$('.x-head .pill').textContent, 'Imported');
  t.$('#dcc-x-tab-drivers').click();
  assert.match(t.$('[role="tabpanel"]').textContent, /not available for imported summaries/);
  assert.equal(t.$('[data-fk="load:exploreEntities"]'), null);
  t.$('#dcc-x-tab-runs').click();
  assert.match(t.$('[role="tabpanel"]').textContent, /not available for imported summaries/);
  t.$('#dcc-x-tab-calendar').click();
  const cells = t.$$('svg.heatmap [role="button"]');
  assert.equal(cells.length, 30);
  assert.match(t.$('svg.heatmap [data-date="2026-10-11"]').getAttribute('aria-label'), /Cost: unavailable/);
  assert.match(t.$('svg.heatmap [data-date="2026-10-10"]').getAttribute('aria-label'), /\$50\.00/);
  t.$('#dcc-x-tab-products').click();
  t.$('[data-fk="dim:owner"]').click();
  assert.match(t.$('[role="tabpanel"]').textContent, /Ownership breakdowns are not available for imported summaries/);
  assert.equal(t.queries.length, 0);
  t.env.close();
});

test('demo mode: explicit loads return synthetic DEMO data without any request', async () => {
  const t = setup({ mode: 'demo' });
  t.$('#dcc-x-tab-drivers').click();
  t.$('[data-fk="load:exploreEntities"]').click();
  await settle(20);
  assert.equal(t.queries.length, 0);
  assert.ok(t.$$('[role="tabpanel"] .pill').some((p) => p.textContent === 'DEMO'));
  assert.equal(t.$$('tbody tr').length, 200);
  assert.match(t.$('[role="tabpanel"]').textContent, /limited to 200/);
  t.$('#dcc-x-tab-products').click();
  t.$('[data-fk="dim:owner"]').click();
  t.$('[data-fk="load:exploreSummary"]').click();
  await settle(20);
  const legend = t.$$('.legend button').map((b) => b.textContent);
  assert.ok(legend.includes('Job') && legend.includes('SQL warehouse') && legend.includes('Unattributed'));
  assert.equal(t.queries.length, 0);
  t.env.close();
});

test('compact and expanded layouts', async () => {
  const narrow = setup({ panelWidth: 480 });
  assert.equal(narrow.$('.dcc-x').classList.contains('compact'), true);
  assert.equal(narrow.$('[data-fk="layout"]').getAttribute('aria-pressed'), 'true');
  narrow.$('[data-fk="layout"]').click();
  assert.equal(narrow.$('.dcc-x').classList.contains('expanded'), true);
  narrow.env.close();
  const wide = setup({ panelWidth: 1100 });
  assert.equal(wide.$('.dcc-x').classList.contains('expanded'), true);
  wide.$('[data-fk="layout"]').click();
  assert.equal(wide.$('.dcc-x').classList.contains('compact'), true);
  assert.equal(wide.$('svg.stacked').getAttribute('viewBox').split(' ')[2], '420', 'compact charts use a narrower drawing');
  wide.env.close();
});

test('CSV export of the filtered table carries metadata, filters and safe cells', () => {
  const t = setup();
  t.$('[data-fk="legend:JOBS"]').click();
  t.$('#dcc-x-tab-skus').click();
  const csv = t.w.DCC.explorer.buildCsv(t.handle);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Source,Databricks Cost Companion · Cost Explorer: SKUs · SKUs: selected vs prior period (JOBS)');
  assert.ok(lines.includes('Pricing basis,List price: Uses system.billing.list_prices (effective list). Private discounts are excluded. Cloud-provider charges are excluded.'));
  assert.ok(lines.includes('Price table,system.billing.list_prices'));
  assert.ok(lines.includes('Currency,USD'));
  assert.ok(lines.includes('"Period start (UTC, inclusive)",2026-09-15'));
  assert.ok(lines.includes('"Period end (UTC, exclusive)",2026-10-15'));
  assert.ok(lines.some((l) => l.startsWith('Freshness,Latest usage 2026-10-15T09:00:00.000Z')));
  assert.ok(lines.some((l) => l.startsWith('Scope,Workspace 42') && l.includes('Product = JOBS')));
  assert.ok(lines.includes('Notice,Estimated costs. Billing can be delayed; final invoices may differ.'));
  const header = lines.indexOf('SKU,Product,Selected period,Prior period,Change,Share of scope total (fraction)');
  assert.ok(header > 0);
  const body = lines.slice(header + 1).filter(Boolean);
  assert.equal(body.length, 1);
  assert.match(body[0], /^PREMIUM_JOBS_SERVERLESS_COMPUTE_US_EAST,JOBS,\d+(\.\d+)?,\d+(\.\d+)?,-?\d+(\.\d+)?,1$/);
  // Explicit click downloads through Blob + <a download>.
  let downloaded = null;
  t.w.URL.createObjectURL = () => 'blob:x';
  t.w.URL.revokeObjectURL = () => {};
  t.w.HTMLAnchorElement.prototype.click = function () {
    downloaded = this.download;
  };
  t.$('[data-fk="csv"]').click();
  assert.equal(downloaded, 'dcc-explorer_skus_42_2026-09-15_2026-10-15.csv');
  t.env.close();
});

test('banner integration: explorer files load before content-main and mount on Explore', async () => {
  const summary = demoData.summary(ORIGIN, WS, 30, Date.now());
  const env = createContentEnv({
    url: ORIGIN + '/jobs?o=' + WS,
    html: '<body><main><h1>Jobs</h1></main></body>',
    files: [...BASE_CONTENT_FILES, ...EXPLORER_FILES, 'src/content/content-main.js'],
    onMessage: (msg) => {
      if (msg.type === 'dcc:hello') return { ok: true, data: { origin: ORIGIN, workspaceId: WS, idSource: 'param:o', settings: { mode: 'demo', periodDays: 30, showCosts: true, revision: 1 }, connection: null } };
      if (msg.type === 'dcc:summary') return { ok: true, data: summary };
      return { ok: true, data: null };
    },
  });
  await settle(120);
  const shadow = env.document.querySelector('[data-dcc="banner"]').shadowRoot;
  const explore = [...shadow.querySelectorAll('button')].find((b) => /Explore/.test(b.textContent));
  assert.ok(explore);
  explore.click();
  await settle(20);
  assert.ok(shadow.querySelector('.dcc-x [role="tablist"]'));
  assert.ok(shadow.querySelector('style[data-dcc="explorer"]'));
  assert.equal(env.messages.filter((m) => m.type === 'dcc:query').length, 0);
  env.close();
});

test('explorer sources never use innerHTML and register their namespaces', () => {
  for (const f of EXPLORER_FILES.concat(['src/databricks/queries/explore.js'])) {
    const src = readFileSync(new URL('../extension/' + f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/, f);
    assert.match(src, /module\.exports = api/, f);
  }
  const t = setup();
  for (const ns of ['exploreModel', 'exploreDemo', 'exploreData', 'exploreCsv', 'exploreCharts', 'explorerCss', 'explorer']) assert.ok(t.w.DCC[ns], ns);
  t.env.close();
});
