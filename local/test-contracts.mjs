import test from 'node:test';
import assert from 'node:assert/strict';
import { load, fakeArea } from './support/load.mjs';

const periods = load('core/periods.js');
const labels = load('core/labels.js');
const errors = load('errors.js');
const sender = load('background/sender.js');
const secrets = load('background/secrets.js');

const NOW = Date.parse('2026-10-15T17:30:00Z');

test('complete UTC periods exclude today and compare with the preceding equal window', () => {
  const p = periods.completePeriod(7, NOW);
  assert.deepEqual(p, {
    days: 7,
    start: '2026-10-08',
    endExclusive: '2026-10-15',
    prevStart: '2026-10-01',
    prevEndExclusive: '2026-10-08',
    today: '2026-10-15',
  });
  assert.equal(periods.daysBetween(p.start, p.endExclusive), 7);
  const p90 = periods.completePeriod(90, NOW);
  assert.equal(periods.daysBetween(p90.prevStart, p90.prevEndExclusive), 90);
  assert.throws(() => periods.completePeriod(14, NOW));
});

test('lookback windows include today when asked (run search spans 365 dates)', () => {
  const lb = periods.lookback(365, NOW);
  assert.equal(lb.endExclusive, '2026-10-16');
  assert.equal(periods.daysBetween(lb.start, lb.endExclusive), 365);
  assert.equal(periods.lookback(90, NOW, false).endExclusive, '2026-10-15');
});

test('UTC boundaries hold just before and after midnight', () => {
  assert.equal(periods.completePeriod(7, Date.parse('2026-10-15T23:59:59.999Z')).endExclusive, '2026-10-15');
  assert.equal(periods.completePeriod(7, Date.parse('2026-10-16T00:00:00.000Z')).endExclusive, '2026-10-16');
  assert.equal(periods.mondayIndex('2026-10-12'), 0); // Monday
  assert.equal(periods.mondayIndex('2026-10-18'), 6); // Sunday
});

test('amount formatting keeps tiny nonzero values, negatives, and never renders missing as zero', () => {
  assert.equal(labels.formatAmount(12.345, 'USD'), '$12.35');
  assert.equal(labels.formatAmount(0.000412, 'USD'), '$0.000412');
  assert.equal(labels.formatAmount(0, 'USD'), '$0.00');
  assert.equal(labels.formatAmount(-3.5, 'USD'), '-$3.50');
  assert.equal(labels.formatAmount(null, 'USD'), null);
  assert.equal(labels.formatAmount(undefined), null);
  assert.equal(labels.formatAmount(NaN), null);
  assert.match(labels.formatAmount(0.0000001, 'USD'), /^<\$0\.000001$/);
  assert.equal(labels.formatChange(110, 100).text, '+10% vs prior');
  assert.equal(labels.formatChange(5, null).text, 'No comparison');
  assert.equal(labels.DISCLAIMER, 'Estimated costs. Billing can be delayed; final invoices may differ.');
});

test('error classification is specific and never generic for known failures', () => {
  const c = (input) => errors.classify(input).code;
  assert.equal(c({ errorCode: 'FIELD_NOT_FOUND', message: '[FIELD_NOT_FOUND] No such struct field `effective_list` in `default`' }), 'PRICE_FIELD_MISMATCH');
  assert.equal(c({ errorCode: 'TABLE_OR_VIEW_NOT_FOUND', message: 'The table or view `system`.`billing`.`account_prices` cannot be found' }), 'TABLE_NOT_FOUND');
  assert.equal(c({ message: 'User does not have SELECT on Table system.billing.usage' , errorCode: 'INSUFFICIENT_PERMISSIONS' }), 'BILLING_ACCESS_DENIED');
  assert.equal(c({ errorCode: 'PERMISSION_DENIED', message: 'User does not have SELECT on system.query.history' }), 'HISTORY_ACCESS_DENIED');
  assert.equal(c({ errorCode: 'PERMISSION_DENIED', message: 'does not have SELECT on system.lakeflow.pipeline_update_timeline' }), 'LAKEFLOW_ACCESS_DENIED');
  assert.equal(c({ errorCode: 'PERMISSION_DENIED', message: 'You do not have permission to use the SQL warehouse (CAN_USE)' }), 'WAREHOUSE_ACCESS_DENIED');
  assert.equal(c({ httpStatus: 401, message: 'Invalid access token' }), 'AUTH_EXPIRED');
  assert.equal(c({ message: 'Failed to fetch' }), 'NETWORK');
  assert.equal(c({ errorCode: 'UNRESOLVED_COLUMN', message: 'column `record_id` cannot be resolved' }), 'SCHEMA_MISMATCH');
  assert.equal(c({ code: 'HELPER_OUTDATED' }), 'HELPER_OUTDATED');
  const mismatch = errors.classify({ errorCode: 'FIELD_NOT_FOUND', message: 'effective_list' });
  assert.ok(mismatch.steps.some((s) => /account-price table was queried by a list-price adapter/.test(s)));
  assert.ok(!mismatch.steps.some((s) => /create a custom price view/i.test(s) && !/Do not/.test(s)));
});

test('diagnostics keep error code and statement ID but redact every secret shape', () => {
  const secretMsg = [
    'Authorization: Bearer abc.def.ghi',
    'token ' + 'dapi' + '0123456789abcdef'.repeat(2) + '-2',
    'jwt eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl',
    '{"access_token":"tok-123","refresh_token":"ref-456"}',
    'X-DCC-Key: 0123456789abcdef01234567',
    'setup#key=0123456789abcdef01234567',
  ].join(' | ');
  const out = errors.classify({ errorCode: 'X', message: secretMsg, statementId: '01EF0A1B-2C3D-4E5F-8A9B-0C1D2E3F4A5B' });
  const text = JSON.stringify(out);
  for (const leaked of ['abc.def.ghi', 'dapi0123456789abcdef', 'eyJhbGci', 'tok-123', 'ref-456', '0123456789abcdef01234567']) {
    assert.ok(!text.includes(leaked), 'leaked ' + leaked);
  }
  assert.equal(out.details.statementId, '01ef0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b');
  assert.equal(out.details.errorCode, 'X');
});

const EXT = { extensionId: 'abcdefghijklmnopabcdefghijklmnop', extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', helperPort: 8766 };
const tabSender = (url, extra = {}) => ({ id: EXT.extensionId, url, tab: { id: 9 }, frameId: 0, ...extra });

test('content senders must be our top-frame script on a supported origin with a matching workspace ID', () => {
  const ok = sender.validateContentSender(tabSender('https://dbc-1.cloud.databricks.com/jobs?o=42'), { origin: 'https://dbc-1.cloud.databricks.com', workspaceId: '42' }, EXT);
  assert.equal(ok.ok, true);
  const v = (s, msg, ctx = EXT) => sender.validateContentSender(s, msg, ctx).reason;
  const msg = { origin: 'https://dbc-1.cloud.databricks.com', workspaceId: '42' };
  assert.equal(v(tabSender('https://dbc-1.cloud.databricks.com/', { id: 'other' }), msg), 'foreign-extension');
  assert.equal(v(tabSender('https://dbc-1.cloud.databricks.com/', { frameId: 3 }), msg), 'not-top-frame');
  assert.equal(v(tabSender('https://evil.example/'), msg), 'unsupported-origin');
  assert.equal(v(tabSender('https://accounts.cloud.databricks.com/'), { ...msg, origin: 'https://accounts.cloud.databricks.com' }), 'unsupported-origin');
  assert.equal(v(tabSender('https://dbc-2.cloud.databricks.com/'), msg), 'origin-mismatch');
  assert.equal(v(tabSender('https://dbc-1.cloud.databricks.com/?o=43'), msg), 'workspace-id-mismatch');
  assert.equal(v(tabSender('https://dbc-1.cloud.databricks.com/'), msg, { ...EXT, connection: { workspaceId: '99' } }), 'workspace-id-mismatch');
  assert.equal(v(tabSender('https://dbc-1.cloud.databricks.com/'), { ...msg, workspaceId: '42; DROP' }), 'invalid-workspace-id');
});

test('admin messages only from the options page; setup handoff only from the exact helper /setup origin', () => {
  const page = (path) => ({ id: EXT.extensionId, url: EXT.extensionOrigin + path });
  assert.equal(sender.validatePageSender(page('/ui/options.html'), EXT, { admin: true }).ok, true);
  assert.equal(sender.validatePageSender(page('/ui/popup.html'), EXT, { admin: true }).ok, false);
  assert.equal(sender.validatePageSender(page('/ui/popup.html'), EXT).ok, true);
  assert.equal(sender.validatePageSender({ id: EXT.extensionId, url: 'https://dbc-1.cloud.databricks.com/ui/options.html' }, EXT, { admin: true }).ok, false);
  assert.equal(sender.validateSetupSender({ url: 'http://127.0.0.1:8766/setup', origin: 'http://127.0.0.1:8766' }, EXT).ok, true);
  assert.equal(sender.validateSetupSender({ url: 'http://127.0.0.1:9999/setup', origin: 'http://127.0.0.1:9999' }, EXT).ok, false);
  assert.equal(sender.validateSetupSender({ url: 'http://127.0.0.1:8766/other' }, EXT).ok, false);
  assert.equal(sender.validateSetupSender({ url: 'http://localhost:8766/setup' }, EXT).ok, false);
  assert.equal(sender.validateSetupSender({ id: EXT.extensionId, url: 'http://127.0.0.1:8766/setup' }, EXT).ok, false);
});

test('secrets live in session storage, rotate cleanly, and describe() never returns values', async () => {
  const area = fakeArea();
  const s = secrets.create(area);
  await s.setPat('https://dbc-1.cloud.databricks.com', ('dapi' + '0123456789abcdef'.repeat(2)));
  assert.equal(await s.getPat('https://dbc-1.cloud.databricks.com'), ('dapi' + '0123456789abcdef'.repeat(2)));
  await assert.rejects(s.setPat('https://x', 'short'));
  const first = await s.setBridge({ key: '0123456789abcdef01234567', port: 8766, helperVersion: '0.1.0', capabilities: { accountPrices: true, priceAdapterVersion: 2, evil: 'x' } });
  assert.equal(first.rotated, false);
  const second = await s.setBridge({ key: 'fedcba9876543210fedcba98', port: 8766, helperVersion: '0.1.0', capabilities: {} });
  assert.equal(second.rotated, true);
  assert.equal((await s.getBridge()).capabilities.accountPrices, false);
  const described = JSON.stringify(await s.describe('https://dbc-1.cloud.databricks.com'));
  assert.ok(!described.includes('dapi'));
  assert.ok(!described.includes('fedcba9876543210fedcba98'));
  await assert.rejects(s.setBridge({ key: 'not-hex', port: 8766 }));
});
