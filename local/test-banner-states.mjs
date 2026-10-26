// Banner rendering per state, controls, focus and placement — workspace-ui rendered directly in
// a SIMULATED jsdom window (not a real browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContentEnv, BASE_CONTENT_FILES } from './support/content-harness.mjs';

const DISCLAIMER = 'Estimated costs. Billing can be delayed; final invoices may differ.';
const STATEMENT_ID = '01ef0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
const NOW = Date.parse('2026-10-15T12:00:00Z');

function summary(extra = {}) {
  return Object.assign(
    {
      kind: 'summary',
      pricingBasis: 'list',
      priceTable: 'system.billing.list_prices',
      currency: 'USD',
      period: { days: 30, start: '2026-09-15', endExclusive: '2026-10-15', prevStart: '2026-08-16', prevEndExclusive: '2026-09-15' },
      current: { coverage: 'complete', total: 1234.5, unpricedRecords: 0, unpricedSkus: [] },
      previous: { coverage: 'complete', total: 1000 },
      currentAmount: 1234.5,
      previousAmount: 1000,
      daily: [],
      freeQuantity: {},
      latestUsageMs: NOW - 2 * 3600e3,
    },
    extra
  );
}

function setup(cbOverrides = {}, opts) {
  const env = createContentEnv({ url: 'https://dbc-1.cloud.databricks.com/jobs?o=42', html: '<body><main><h1>Jobs</h1></main></body>', files: BASE_CONTENT_FILES });
  const calls = [];
  const cb = Object.assign(
    {
      onPeriod: (d) => calls.push(['period', d]),
      onRefresh: () => calls.push(['refresh']),
      onSettings: () => calls.push(['settings']),
      onGuide: () => calls.push(['guide']),
      onResume: () => calls.push(['resume']),
      onConnect: () => calls.push(['connect']),
    },
    cbOverrides
  );
  const ui = env.window.DCC.workspaceUi;
  const banner = ui.createBanner(env.document, cb, opts);
  const main = env.document.querySelector('main');
  banner.ensurePlaced(main);
  const text = () => banner.shadow.textContent;
  const $ = (sel) => banner.shadow.querySelector(sel);
  const show = (st) => banner.render(Object.assign({ periodDays: 30, nowMs: NOW }, st));
  return { env, ui, banner, main, calls, text, $, show };
}

test('loading: placeholder text, aria-busy, period and refresh controls', () => {
  const t = setup();
  t.show({ status: 'loading' });
  assert.match(t.text(), /Loading costs…/);
  assert.equal(t.$('.bar').getAttribute('aria-busy'), 'true');
  assert.ok(t.$('[data-k="period-30"]') && t.$('[data-k="refresh"]'));
  assert.ok(t.text().includes(DISCLAIMER), 'the disclaimer is shown verbatim');
  t.env.close();
});

test('available: estimate, est. label, period, comparison, freshness, basis and disclaimer', () => {
  const t = setup();
  t.show(Object.assign(t.ui.statusFor({ ok: true, data: summary() })));
  const text = t.text();
  assert.match(text, /\$1,234\.50/);
  assert.match(text, /est\./);
  assert.match(text, /Last 30 days · Sep 15 – Oct 14, 2026 \(UTC\)/);
  assert.match(text, /\+23% vs prior/);
  assert.match(text, /Latest usage 120 min ago|Latest usage 2 h ago/);
  assert.match(text, /List price/);
  assert.ok(text.includes(DISCLAIMER));
  assert.equal(t.$('.bar').getAttribute('aria-busy'), 'false');
  assert.match(t.$('[role="status"]').textContent, /Estimated cost \$1,234\.50 for the last 30 days/);
  t.env.close();
});

test('partial: labeled priced subtotal with unpriced count, SKUs and first/last dates; no full total', () => {
  const t = setup();
  const s = summary({
    current: { coverage: 'partial', total: null, pricedSubtotal: 800, unpricedRecords: 3, ambiguousRecords: 1, unpricedSkus: ['PREMIUM_JOBS_COMPUTE', 'PREMIUM_SQL_PRO'], firstUnpricedDate: '2026-09-20', lastUnpricedDate: '2026-10-01' },
    currentAmount: 800,
  });
  t.show(t.ui.statusFor({ ok: true, data: s }));
  const text = t.text();
  assert.match(text, /Priced subtotal\$800\.00/);
  assert.match(text, /Some usage unpriced/);
  assert.match(text, /3 usage records without a matching price/);
  assert.match(text, /SKUs: PREMIUM_JOBS_COMPUTE, PREMIUM_SQL_PRO/);
  assert.match(text, /UTC dates 2026-09-20 to 2026-10-01/);
  assert.match(text, /full total withheld/);
  assert.match(text, /1 record matched more than one price row/);
  assert.match(text, /\(priced subtotals\)/, 'comparison is labeled as subtotal-based');
  assert.doesNotMatch(text, /\$1,234\.50/);
  t.env.close();
});

test('none, empty, no-import and missing amounts never render as $0.00', () => {
  const t = setup();
  const cases = [
    [summary({ current: { coverage: 'none', unpricedRecords: 5, unpricedSkus: ['X_SKU'], firstUnpricedDate: '2026-09-16', lastUnpricedDate: '2026-09-18' }, currentAmount: null, previousAmount: null }), /No priced usage/, /no subtotal shown/],
    [summary({ current: { coverage: 'empty' }, currentAmount: null, previousAmount: null, latestUsageMs: null }), /No usage recorded in this period/, /No usage observed/],
    [{ kind: 'summary', imported: true, pricingBasis: 'import', current: { coverage: 'empty' }, currentAmount: null, previousAmount: null, noImport: true }, /No imported summary for this workspace and period/, /Imported/],
    [summary({ currentAmount: null }), /Amount unavailable/, /No comparison/],
  ];
  for (const [s, re1, re2] of cases) {
    t.show(t.ui.statusFor({ ok: true, data: s }));
    const text = t.text();
    assert.match(text, re1);
    assert.match(text, re2);
    assert.doesNotMatch(text, /\$0\.00/);
    assert.doesNotMatch(text, /\$\d/, 'no amount at all: ' + text);
  }
  t.env.close();
});

test('error: title, steps and technical details with SQL error code and statement ID, never token-like text', () => {
  const t = setup();
  const secrets = [('dapi' + '0123456789abcdef'.repeat(2)), 'Bearer abc.def.ghi', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNpZw', 'a1b2c3d4e5f6a1b2c3d4e5f6', 'supersecretvalue'];
  t.show(
    t.ui.statusFor({
      ok: false,
      error: {
        code: 'BILLING_ACCESS_DENIED',
        title: 'No permission to read billing system tables',
        steps: ['Ask an account or metastore admin to grant SELECT on system.billing.usage.'],
        details: {
          errorCode: 'INSUFFICIENT_PERMISSIONS',
          sqlState: '42501',
          statementId: STATEMENT_ID.toUpperCase(),
          httpStatus: 403,
          message: 'User lacks SELECT on system.billing.usage. Authorization: ' + secrets[1] + ' pat ' + secrets[0] + ' jwt ' + secrets[2] + ' key ' + secrets[3] + ' token=' + secrets[4],
        },
      },
    })
  );
  const text = t.text();
  assert.match(text, /No permission to read billing system tables/);
  assert.match(text, /Ask an account or metastore admin/);
  assert.match(text, /Technical details/);
  assert.match(text, /Code: BILLING_ACCESS_DENIED/);
  assert.match(text, /SQL error code: INSUFFICIENT_PERMISSIONS/);
  assert.match(text, /SQL state: 42501/);
  assert.ok(text.includes('Statement ID: ' + STATEMENT_ID), 'statement ID shown (normalized)');
  assert.match(text, /HTTP status: 403/);
  for (const s of secrets) assert.ok(!text.includes(s.replace('Bearer ', '')), 'leaked: ' + s);
  assert.ok(t.$('[data-k="refresh"]'), 'Refresh is offered to retry');
  // An invalid statement ID is dropped rather than shown.
  t.show(t.ui.statusFor({ ok: false, error: { code: 'UNKNOWN', title: 'Something went wrong', steps: [], details: { statementId: 'not-a-statement-id' } } }));
  assert.doesNotMatch(t.text(), /Statement ID/);
  t.env.close();
});

test('paused, disconnected, unidentified, conflict and mismatch states', () => {
  const t = setup();
  t.show({ status: 'paused' });
  assert.match(t.text(), /Cost display paused/);
  assert.match(t.text(), /Workspace colors stay active/);
  assert.equal(t.$('[data-k="period-30"]'), null, 'no period controls while paused');
  assert.equal(t.$('[data-k="refresh"]'), null);
  t.$('[data-k="resume"]').click();
  assert.deepEqual(t.calls.at(-1), ['resume']);

  t.show(t.ui.statusFor({ ok: false, error: { code: 'NOT_CONNECTED', title: 'Not connected', steps: [] } }));
  assert.match(t.text(), /not connected to this workspace/);
  t.$('[data-k="connect"]').click();
  assert.deepEqual(t.calls.at(-1), ['connect']);

  t.show({ status: 'unidentified' });
  assert.match(t.text(), /Workspace ID not identified/);
  assert.match(t.text(), /\?o=<workspace ID>/);
  t.show({ status: 'unidentified', conflict: true });
  assert.match(t.text(), /Conflicting workspace IDs in this URL/);

  t.show({ status: 'mismatch', error: { code: 'WORKSPACE_MISMATCH', title: 'This page belongs to a different workspace', steps: ['Open Connection preferences.'] }, pageWorkspaceId: '42', connectedWorkspaceId: '99' });
  assert.match(t.text(), /This page belongs to a different workspace/);
  assert.match(t.text(), /This page: workspace 42/);
  assert.match(t.text(), /Saved connection: workspace 99/);
  assert.ok(t.$('[data-k="settings"]'), 'settings stays reachable');
  assert.deepEqual(t.ui.statusFor({ ok: false, error: { code: 'WORKSPACE_MISMATCH' } }).status, 'mismatch');
  t.env.close();
});

test('demo and import data are labeled; free usage is listed separately', () => {
  const t = setup();
  t.show(t.ui.statusFor({ ok: true, data: summary({ pricingBasis: 'demo', synthetic: true, freeQuantity: { GENIE_FREE_USAGE: 12.5 } }) }));
  assert.match(t.text(), /DEMO/);
  assert.match(t.text(), /Free usage \(not charged\): GENIE_FREE_USAGE 12\.5/);
  t.show(t.ui.statusFor({ ok: true, data: summary({ pricingBasis: 'import', priceTable: null, period: undefined, coverageEnd: '2026-10-10' }) }));
  assert.match(t.text(), /Imported/);
  assert.match(t.text(), /Last 30 days \(imported\) · through 2026-10-10/);
  t.env.close();
});

test('period buttons expose aria-pressed, call onPeriod, and keep keyboard focus across re-renders', () => {
  const t = setup();
  t.show(t.ui.statusFor({ ok: true, data: summary() }));
  assert.equal(t.$('[data-k="period-30"]').getAttribute('aria-pressed'), 'true');
  assert.equal(t.$('[data-k="period-7"]').getAttribute('aria-pressed'), 'false');
  assert.equal(t.$('.seg').getAttribute('role'), 'group');
  t.$('[data-k="period-7"]').focus();
  t.$('[data-k="period-7"]').click();
  assert.deepEqual(t.calls.at(-1), ['period', 7]);
  t.show({ status: 'loading', periodDays: 7 });
  const focused = t.banner.shadow.activeElement;
  assert.ok(focused, 'focus stayed inside the banner');
  assert.equal(focused.getAttribute('data-k'), 'period-7');
  assert.equal(focused.getAttribute('aria-pressed'), 'true');
  assert.equal(t.$('[data-k="period-30"]').getAttribute('aria-pressed'), 'false');
  // A control that disappears hands focus to the banner region, not the page.
  t.$('[data-k="refresh"]').focus();
  t.show({ status: 'paused', periodDays: 7 });
  assert.ok(t.banner.shadow.activeElement && t.banner.shadow.activeElement.classList.contains('bar'));
  t.env.close();
});

test('open details stay open across re-renders', () => {
  const t = setup();
  const err = { ok: false, error: { code: 'NETWORK', title: 'Could not reach Databricks', steps: ['Check your network.'], details: { statementId: STATEMENT_ID } } };
  t.show(t.ui.statusFor(err));
  t.$('details[data-k="technical"]').open = true;
  t.show(t.ui.statusFor(err));
  assert.equal(t.$('details[data-k="technical"]').open, true);
  t.env.close();
});

test('explorer panel: mounted on expand, reused across same-summary re-renders, remounted on new data, kept expanded through loading', () => {
  let mounts = 0;
  let cleanups = 0;
  const t = setup({
    renderPanel: (panel) => {
      mounts++;
      panel.appendChild(panel.ownerDocument.createTextNode('explorer #' + mounts));
      return () => cleanups++;
    },
  });
  const first = t.ui.statusFor({ ok: true, data: summary() });
  t.show(first);
  assert.equal(t.$('[data-k="toggle"]').getAttribute('aria-expanded'), 'false');
  t.$('[data-k="toggle"]').click();
  assert.equal(mounts, 1);
  assert.equal(t.$('[data-k="toggle"]').getAttribute('aria-expanded'), 'true');
  assert.equal(t.$('[data-k="toggle"]').getAttribute('aria-controls'), 'dcc-panel');
  assert.ok(t.$('#dcc-panel'));
  assert.equal(t.banner.host.hasAttribute('data-dcc-expanded'), true, 'expanded banner scrolls with the page');
  t.show(first); // unrelated re-render
  assert.equal(mounts, 1, 'panel reused');
  t.show({ status: 'loading' });
  assert.equal(t.$('#dcc-panel'), null);
  assert.equal(cleanups, 1);
  assert.equal(t.banner.host.hasAttribute('data-dcc-expanded'), false);
  t.show(t.ui.statusFor({ ok: true, data: summary({ currentAmount: 10 }) }));
  assert.equal(mounts, 2, 'remounted for the new summary; expansion survived loading');
  assert.match(t.$('#dcc-panel').textContent, /explorer #2/);
  // A failing explorer doesn't break the banner.
  const t2 = setup({ renderPanel: () => { throw new Error('explorer bug'); } });
  t2.show(t2.ui.statusFor({ ok: true, data: summary() }));
  t2.$('[data-k="toggle"]').click();
  assert.match(t2.text(), /cost explorer could not be shown/);
  assert.match(t2.text(), /\$1,234\.50/);
  t.env.close();
  t2.env.close();
});

test('ensurePlaced: no DOM write when already first (even hidden), removes duplicate hosts, re-mounts into a new container', () => {
  const t = setup();
  const d = t.env.document;
  assert.equal(t.main.firstElementChild, t.banner.host);
  const s0 = t.banner.stats().placements;
  t.banner.host.style.display = 'none'; // the page hides it
  for (let i = 0; i < 5; i++) assert.equal(t.banner.ensurePlaced(t.main), true);
  assert.equal(t.banner.stats().placements, s0, 'hidden host already first is not reinserted');
  const stray = d.createElement('div');
  stray.setAttribute('data-dcc', 'banner');
  d.body.appendChild(stray);
  t.banner.ensurePlaced(t.main);
  assert.equal(d.querySelectorAll('[data-dcc="banner"]').length, 1);
  const fresh = d.createElement('main');
  fresh.appendChild(d.createElement('h1'));
  t.main.replaceWith(fresh);
  t.banner.ensurePlaced(fresh);
  assert.equal(fresh.firstElementChild, t.banner.host);
  assert.equal(t.banner.stats().placements, s0 + 1);
  t.env.close();
});

test('ensurePlaced backs off when something keeps evicting the banner', () => {
  let now = 0;
  const t = setup({}, { now: () => now });
  const evict = () => t.banner.host.remove();
  let placed = 0;
  for (let i = 0; i < 40; i++) {
    evict();
    now += 100;
    if (t.banner.ensurePlaced(t.main)) placed++;
  }
  assert.ok(placed <= 21, 'fight limited: ' + placed);
  assert.ok(t.banner.backoffRemaining() > 0);
  now += 11000;
  evict();
  assert.equal(t.banner.ensurePlaced(t.main), true, 'placement resumes after the backoff');
  t.env.close();
});

test('banner CSS keeps focus rings visible and adapts to narrow containers', () => {
  const t = setup();
  const css = t.ui.CSS;
  assert.match(css, /button:focus-visible[^{]*\{[^}]*outline: 2px solid/);
  assert.doesNotMatch(css, /\.seg\s*\{[^}]*overflow:\s*hidden/, 'segmented control must not clip focus rings');
  assert.match(css, /@container \(max-width: 640px\)/);
  assert.match(css, /\.row \{[^}]*flex-wrap: wrap/);
  assert.match(css, /forced-colors: active/);
  assert.match(css, /:host \{ position: sticky !important; top: 0 !important; left: 0 !important/);
  assert.match(css, /:host\(\[data-dcc-expanded\]\) \{ position: relative !important; \}/);
  assert.match(css, /@media \(max-width: 640px\), \(max-height: 500px\) \{ :host \{ position: relative !important; \} \}/);
  assert.equal(t.banner.host.getAttribute('style'), 'display: block;', 'only display is inline, so a page can still hide the host');
  t.env.close();
});
