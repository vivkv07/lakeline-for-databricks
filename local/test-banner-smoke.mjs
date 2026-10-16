// Smoke test for the banner bootstrap in the SIMULATED jsdom environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContentEnv, BASE_CONTENT_FILES, settle } from './support/content-harness.mjs';

const ORIGIN = 'https://dbc-1.cloud.databricks.com';
const summaryData = {
  kind: 'summary', pricingBasis: 'list', priceTable: 'system.billing.list_prices', currency: 'USD',
  period: { days: 30, start: '2026-09-15', endExclusive: '2026-10-15', prevStart: '2026-08-16', prevEndExclusive: '2026-09-15' },
  current: { coverage: 'complete', total: 1234.5 }, previous: { coverage: 'complete', total: 1000 },
  currentAmount: 1234.5, previousAmount: 1000, daily: [], freeQuantity: {}, latestUsageMs: Date.now() - 3600e3,
};

function sw(msg) {
  if (msg.type === 'dcc:hello') return { ok: true, data: { origin: ORIGIN, workspaceId: '42', idSource: 'param:o', settings: { mode: 'connected', periodDays: 30, showCosts: true, revision: 1 }, connection: { workspaceId: '42' } } };
  if (msg.type === 'dcc:summary') return { ok: true, data: summaryData };
  return { ok: true, data: null };
}

test('banner mounts once as first child of main, shows estimate and disclaimer', async () => {
  const env = createContentEnv({
    url: ORIGIN + '/jobs?o=42',
    html: '<body><nav aria-label="Top Navigation">nav</nav><main><h1>Jobs</h1></main></body>',
    files: [...BASE_CONTENT_FILES, 'src/content/content-main.js'],
    onMessage: sw,
  });
  await settle(100);
  const main = env.document.querySelector('main');
  assert.equal(main.firstElementChild.getAttribute('data-dcc'), 'banner');
  const text = main.firstElementChild.shadowRoot.textContent;
  assert.match(text, /\$1,234\.50/);
  assert.match(text, /Estimated costs\. Billing can be delayed; final invoices may differ\./);
  assert.match(text, /List price/);
  assert.equal(env.document.querySelectorAll('[data-dcc="banner"]').length, 1);
  env.close();
});
