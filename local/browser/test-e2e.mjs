// End-to-end: the real extension in REAL headless Chromium (Playwright, disposable profile)
// against the SIMULATED fixture backend (local/fixture-server.mjs: routed fixture SPA + mock
// Databricks REST API whose SQL runs on DuckDB). Real browser, real MV3 service worker, real
// content scripts and messaging; the workspace DOM and the SQL engine are imitations, so this is
// not proof of compatibility with the real Databricks UI or with Databricks SQL.
//
//   npm run test:browser          (screenshots: $DCC_E2E_SHOTS, default <tmpdir>/dcc-e2e-shots)
//
// Safety and setup:
// - Never touches the user's browser or profile. A TEST-ONLY copy of extension/ is built in a temp
//   dir with `host_permissions: ["http://127.0.0.1:8765/*"]` added to its manifest, because the
//   optional host-permission prompt (chrome.permissions.request) cannot be clicked in headless
//   Chromium. The copy keeps the manifest `key`, so its ID must equal extension/EXTENSION_ID.
//   extension/ itself is never modified. Profile and copy are deleted at the end.
// - Uses Playwright's cached Chrome for Testing (no downloads). Skips with a message if it is
//   missing. Fails clearly if port 8765 is busy (stop `npm run fixture` first).
// - Connection setup goes through the real router from the options page context
//   (chrome.runtime.sendMessage), with the documented FAKE fixture token.
// - Selectors are data attributes and roles ([data-dcc], data-k, data-fk, data-fx-*, #ids), not
//   CSS classes or exact copy, so restyling does not break the suite.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { load } from '../support/load.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const EXT_SRC = path.join(ROOT, 'extension');
const PORT = 8765;
const ORIGIN = 'http://127.0.0.1:' + PORT;
const WS = '1234567890';
const O = '?o=' + WS;
const SENTINEL = 'SENTINEL_SQL_TEXT_MUST_NEVER_BE_READ';
const DISCLAIMER = 'Estimated costs. Billing can be delayed; final invoices may differ.';
const SHOTS = process.env.DCC_E2E_SHOTS || path.join(os.tmpdir(), 'dcc-e2e-shots');
const SQL_WAIT = 90000; // generous: every connected number is a DuckDB query behind the mock API

const periods = load('core/periods.js');
const labels = load('core/labels.js');
const summaryQ = load('databricks/queries/summary.js');
const resultMod = load('databricks/result.js');

/* ------------------------------------------------------------------ availability */

let chromium = null;
let skip = false;
try {
  ({ chromium } = await import('playwright'));
  const exe = chromium.executablePath();
  // An installed browser channel (E2E_CHANNEL=msedge) doesn't need Playwright's own Chromium.
  if (!process.env.E2E_CHANNEL && (!exe || !fs.existsSync(exe))) skip = 'Playwright Chromium is not installed (' + exe + '); this suite never downloads browsers';
} catch (e) {
  skip = 'playwright is not installed: ' + String((e && e.message) || e).slice(0, 120);
}

/* ------------------------------------------------------------------ helpers */

async function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function poll(fn, { timeout = 20000, interval = 150, label = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() - t0 > timeout) throw new Error('Timed out after ' + timeout + ' ms waiting for ' + label + (last instanceof Error ? ' (last error: ' + last.message + ')' : ''));
    await new Promise((r) => setTimeout(r, interval));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** First currency amount in a text ("$1,234.56", "−$0.12", "<$0.000001" → number). */
function amountIn(text) {
  const m = /([−-])?<?\$([\d,]+(?:\.\d+)?)/.exec(String(text || ''));
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ''));
  return m[1] ? -n : n;
}

/** Display precision of formatAmount: 2 decimals, 6 below one cent. */
const closeTo = (shown, expected) => shown !== null && Math.abs(shown - expected) <= (Math.abs(expected) < 0.01 ? 5e-7 : 0.0051);

/** Independent expectation from the synthetic rows: Σ signed quantity × valid list price. */
function makeCost(dataset, fixtureData) {
  const { LIST_PRICES, JOBS_PRICE_AFTER_CHANGE, PRICE_CHANGE_DAYS_AGO } = fixtureData;
  const change = Date.parse(periods.addDays(dataset.today, -PRICE_CHANGE_DAYS_AGO) + 'T00:00:00Z');
  const usage = dataset.tables['billing.usage'];
  function price(u) {
    if (u.sku_name === 'PREMIUM_JOBS_COMPUTE' && Date.parse(u.usage_end_time + 'Z') >= change) return JOBS_PRICE_AFTER_CHANGE;
    return LIST_PRICES[u.sku_name];
  }
  function sum(rows) {
    let total = 0;
    let unpriced = 0;
    for (const u of rows) {
      if (u.sku_name === 'GENIE_FREE_USAGE') continue;
      const p = price(u);
      if (p === undefined) unpriced += 1;
      else total += u.usage_quantity * p;
    }
    return { total, unpriced };
  }
  const inPeriod = (u, w) => u.usage_date >= w.start && u.usage_date < w.endExclusive;
  /** Update IDs triggered (JOB_TASK) by the task runs of one job run. */
  function triggeredUpdates(jobId, runId) {
    const tasks = new Set(dataset.tables['lakeflow.job_task_run_timeline'].filter((t) => t.job_id === jobId && t.job_run_id === runId).map((t) => t.run_id));
    return new Set(dataset.tables['lakeflow.pipeline_update_timeline'].filter((x) => x.trigger_type === 'JOB_TASK' && x.trigger_details.job_task.job_id === jobId && tasks.has(x.trigger_details.job_task.job_task_run_id)).map((x) => x.update_id));
  }
  return {
    period: (w) => sum(usage.filter((u) => inPeriod(u, w))),
    jobPeriod: (jobId, w) => sum(usage.filter((u) => inPeriod(u, w) && u.usage_metadata.job_id === jobId)),
    runDirect: (jobId, runId) => sum(usage.filter((u) => u.usage_metadata.job_run_id === runId && (u.usage_metadata.job_id || jobId) === jobId)).total,
    runWithPipelines(jobId, runId) {
      const ups = triggeredUpdates(jobId, runId);
      return sum(usage.filter((u) => (u.usage_metadata.job_run_id === runId && (u.usage_metadata.job_id || jobId) === jobId) || (u.usage_metadata.dlt_update_id && ups.has(u.usage_metadata.dlt_update_id)))).total;
    },
  };
}

/* ------------------------------------------------------------------ suite */

describe('browser e2e: real Chromium + extension against the SIMULATED fixture backend', { skip }, () => {
  let fixtureData;
  let fx;
  let tmp;
  let ctx;
  let extId;
  let launchVariant;
  let opt; // options page (admin messages)
  let page; // fixture workspace tab
  let cost;
  let expect30;
  let expect7;
  const api = []; // every authorized /api/ request the fixture saw: {method, path, body}
  const statements = () => api.filter((r) => r.method === 'POST' && r.path === '/api/2.0/sql/statements');
  const shots = [];
  const notes = [];

  async function shot(p, name, opts) {
    fs.mkdirSync(SHOTS, { recursive: true });
    const file = path.join(SHOTS, name + '.png');
    await p.screenshot(Object.assign({ path: file, fullPage: true }, opts || {}));
    shots.push(file);
  }

  async function send(msg, from = opt) {
    const res = await from.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    assert.ok(res && typeof res === 'object', 'router answered ' + msg.type);
    return res;
  }

  async function sendOk(msg, from) {
    const res = await send(msg, from);
    assert.equal(res.ok, true, msg.type + ' failed: ' + JSON.stringify(res.error));
    return res.data;
  }

  /** Banner state read from its open shadow root: whole text, live-region text, data-k keys. */
  const bannerInfo = () =>
    page.evaluate(() => {
      const hosts = document.querySelectorAll('[data-dcc="banner"]');
      const host = hosts[0];
      const main = document.querySelector('main');
      if (!host || !host.shadowRoot) return { count: hosts.length };
      const live = host.shadowRoot.querySelector('[role="status"]');
      return {
        count: hosts.length,
        first: Boolean(main && main.firstElementChild === host),
        text: host.shadowRoot.textContent,
        live: live ? live.textContent : '',
        keys: [...host.shadowRoot.querySelectorAll('[data-k]')].map((e) => e.getAttribute('data-k')),
        pressed: [...host.shadowRoot.querySelectorAll('[data-k^="period-"][aria-pressed="true"]')].map((e) => e.getAttribute('data-k')),
      };
    });

  const inlineBadges = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-dcc="inline"]')].map((b) => ({
        key: b.getAttribute('data-dcc-key'),
        kind: b.getAttribute('data-dcc-kind'),
        text: b.textContent,
        aria: b.getAttribute('aria-label') || '',
        run: (b.closest('[data-fx-run]') || { getAttribute: () => null }).getAttribute('data-fx-run'),
        row: (b.closest('[data-fx-row]') || { getAttribute: () => null }).getAttribute('data-fx-row'),
      }))
    );

  async function launch(variant) {
    const profile = fs.mkdtempSync(path.join(tmp, 'profile-'));
    const opts = {
      headless: true,
      viewport: { width: 1280, height: 900 },
      colorScheme: 'light',
      args: ['--disable-extensions-except=' + path.join(tmp, 'ext'), '--load-extension=' + path.join(tmp, 'ext')],
    };
    // E2E_CHANNEL=msedge (npm run test:edge) runs the same suite in an installed Microsoft Edge.
    if (process.env.E2E_CHANNEL) opts.channel = process.env.E2E_CHANNEL;
    else if (variant === 'chromium') opts.channel = 'chromium';
    const c = await chromium.launchPersistentContext(profile, opts);
    let sw = c.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
    // The default headless build (headless shell) may not load extensions; that attempt gives up fast.
    if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: variant === 'chromium' ? 20000 : 8000 }).catch(() => null);
    if (!sw) {
      await c.close().catch(() => {});
      return null;
    }
    return { c, sw };
  }

  before(async () => {
    fixtureData = await import('../fixture-data.mjs');
    const { startFixtureServer } = await import('../fixture-server.mjs');
    if (!(await portFree(PORT))) throw new Error('Port ' + PORT + ' is busy. The e2e suite needs the fixture origin ' + ORIGIN + ' (the extension only accepts that exact origin): stop `npm run fixture` / `node local/server.mjs --fixture-only` and retry.');
    fx = await startFixtureServer({ port: PORT, log: () => {}, onApiRequest: (r) => api.push(r) });
    assert.equal(fx.origin, ORIGIN);

    // Expected amounts, computed twice before the browser sends anything: independently from the
    // synthetic rows, and through summary.build/parse on the fixture's own DuckDB engine.
    cost = makeCost(fx.dataset, fixtureData);
    const conn = { origin: ORIGIN, workspaceId: WS, priceTable: 'system.billing.list_prices', usageSource: 'system.billing.usage', historySource: 'system.query.history', currency: 'USD', cloud: 'fixture' };
    const viaEngine = async (days) => {
      const q = summaryQ.build(conn, { periodDays: days }, fx.dataset.nowMs);
      const res = await fx.engine.execute({ statement: q.statement, parameters: q.parameters, row_limit: q.rowLimit });
      return summaryQ.parse(resultMod.parseResult(res, { maxRows: q.maxRows }).rows, q);
    };
    const s30 = await viaEngine(30);
    const s7 = await viaEngine(7);
    const i30 = cost.period(periods.completePeriod(30, fx.dataset.nowMs));
    const i7 = cost.period(periods.completePeriod(7, fx.dataset.nowMs));
    assert.ok(Math.abs(s30.currentAmount - i30.total) < 1e-6 && i30.unpriced === 3 && s30.current.coverage === 'partial', '30d: engine ' + s30.currentAmount + ' vs independent ' + i30.total);
    assert.ok(Math.abs(s7.currentAmount - i7.total) < 1e-6 && i7.unpriced === 0 && s7.current.coverage === 'complete', '7d: engine ' + s7.currentAmount + ' vs independent ' + i7.total);
    expect30 = s30.currentAmount;
    expect7 = s7.currentAmount;

    // TEST-ONLY extension copy with the fixture host permission granted at install.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcc-e2e-'));
    fs.cpSync(EXT_SRC, path.join(tmp, 'ext'), { recursive: true });
    const manifestFile = path.join(tmp, 'ext', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.host_permissions = [ORIGIN + '/*'];
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

    let got = await launch('default');
    launchVariant = 'headless (default channel)';
    if (!got) {
      got = await launch('chromium');
      launchVariant = "headless, channel 'chromium'";
    }
    assert.ok(got, 'the extension service worker never started in headless Chromium (tried the default and the chromium channel)');
    ctx = got.c;
    extId = new URL(got.sw.url()).host;
    const ua = await got.sw.evaluate(() => navigator.userAgent).catch(() => '');
    notes.push('launch: ' + (process.env.E2E_CHANNEL ? "channel '" + process.env.E2E_CHANNEL + "'" : launchVariant) + '; ' + ((/Edg\/[\d.]+/.exec(ua) || /(HeadlessChrome|Chrome)\/[\d.]+/.exec(ua) || ['unknown browser'])[0]));
  });

  after(async () => {
    if (ctx) await ctx.close().catch(() => {});
    if (fx) await fx.close().catch(() => {});
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('loads the test copy with the stable extension ID and registers content scripts for the fixture origin', { timeout: 60000 }, async () => {
    assert.equal(extId, fs.readFileSync(path.join(EXT_SRC, 'EXTENSION_ID'), 'utf8').trim());
    const sw = ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://' + extId));
    const scripts = await poll(async () => {
      const list = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
      return list.find((s) => s.id === 'dcc-main' && s.matches.includes('http://127.0.0.1:8765/*')) || null;
    }, { label: 'dcc-main content script registration' });
    assert.equal(scripts.runAt, 'document_idle');
    assert.ok(scripts.js.at(-1).endsWith('content-main.js'));
    const granted = await sw.evaluate(() => chrome.permissions.getAll());
    assert.ok(granted.origins.includes('http://127.0.0.1:8765/*'));
  });

  it('CSP connect-src: the service worker reaches the test workspace but never an unlisted host', { timeout: 30000 }, async () => {
    const sw = ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://' + extId));
    let hits = 0;
    const other = http.createServer((req, res) => {
      hits++;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end('{}');
    });
    await new Promise((r) => other.listen(0, '127.0.0.1', r));
    try {
      const unlisted = 'http://127.0.0.1:' + other.address().port + '/';
      const out = await sw.evaluate(async (urls) => {
        const attempt = (u) => fetch(u, { cache: 'no-store', credentials: 'omit' }).then((r) => 'reached ' + r.status, () => 'refused');
        return { workspace: await attempt(urls.workspace), unlisted: await attempt(urls.unlisted) };
      }, { workspace: ORIGIN + '/', unlisted });
      assert.match(out.workspace, /^reached /, 'the allowlisted test workspace is reachable');
      assert.equal(out.unlisted, 'refused');
      assert.equal(hits, 0, 'the request never left the browser');
    } finally {
      other.close();
    }
  });

  it('connects through the real router from the options page: PAT, warehouse listing, Automatic picks the RUNNING one', { timeout: 60000 }, async () => {
    opt = await ctx.newPage();
    await opt.goto('chrome-extension://' + extId + '/ui/options.html');
    await opt.waitForLoadState('load');
    await shot(opt, '01-options-light');
    const settings = await sendOk({ type: 'page:updateSettings', patch: { mode: 'connected', periodDays: 30 } });
    assert.equal(settings.mode, 'connected');
    assert.equal(settings.periodDays, 30);
    // Listing before a token is saved fails with a classified error (no secret in it).
    const early = await send({ type: 'admin:listWarehouses', origin: ORIGIN, authMode: 'pat' });
    assert.equal(early.ok, false);
    assert.ok(!JSON.stringify(early).includes('dapi-fixture'));
    const { FIXTURE_TOKEN } = await import('../fixture-server.mjs');
    assert.deepEqual(await sendOk({ type: 'admin:setPat', origin: ORIGIN, token: FIXTURE_TOKEN }), { saved: true });
    const listed = await sendOk({ type: 'admin:listWarehouses', origin: ORIGIN, authMode: 'pat' });
    assert.deepEqual(listed.warehouses.map((w) => w.id).sort(), fixtureData.WAREHOUSES.map((w) => w.id).sort());
    const running = fixtureData.WAREHOUSES.find((w) => w.state === 'RUNNING');
    assert.equal(listed.automatic.id, running.id);
    const saved = await sendOk({ type: 'admin:saveConnection', connection: { origin: ORIGIN, workspaceId: WS, authMode: 'pat', priceTable: 'system.billing.list_prices', warehouse: { mode: 'auto' } } });
    assert.equal(saved.workspaceId, WS);
    assert.deepEqual([saved.warehouse.mode, saved.warehouse.resolvedId], ['auto', running.id]);
    const state = await sendOk({ type: 'page:state' });
    assert.ok(state.connections[ORIGIN]);
    assert.ok(!JSON.stringify(state).includes(FIXTURE_TOKEN), 'page:state never returns the token');
    // Only read-only GETs so far: no SQL was sent while connecting.
    assert.equal(statements().length, 0);
  });

  it('Remember on this computer keeps the token in the extension\'s IndexedDB, never in chrome.storage.local', { timeout: 30000 }, async () => {
    const { FIXTURE_TOKEN } = await import('../fixture-server.mjs');
    assert.deepEqual(await sendOk({ type: 'admin:setPat', origin: ORIGIN, token: FIXTURE_TOKEN, remember: true }), { saved: true });
    const localKeys = await opt.evaluate(async () => Object.keys(await chrome.storage.local.get(null)));
    assert.deepEqual(localKeys.filter((k) => k.startsWith('dcc.secrets')), [], 'content scripts can read storage.local, so no secret goes there');
    // The extension origin's IndexedDB (shared by the service worker and extension pages).
    const stored = await opt.evaluate(
      ({ origin, token }) =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('lakeline-secrets');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const get = req.result.transaction('kv').objectStore('kv').get('dcc.secrets.patRemembered');
            get.onsuccess = () => resolve({ found: Boolean(get.result), matches: Boolean(get.result) && get.result[origin] === token });
            get.onerror = () => reject(get.error);
          };
        }),
      { origin: ORIGIN, token: FIXTURE_TOKEN }
    );
    assert.deepEqual(stored, { found: true, matches: true });
    const state = await sendOk({ type: 'page:state' });
    assert.equal(state.connections[ORIGIN].secrets.patRemembered, true);
    // Back to a session-only token so the rest of the suite runs as before.
    await sendOk({ type: 'admin:setPat', origin: ORIGIN, token: FIXTURE_TOKEN, remember: false });
    assert.equal((await sendOk({ type: 'page:state' })).connections[ORIGIN].secrets.patRemembered, false);
  });

  it('jobs page: one banner, first child of main, connected 30d priced subtotal equals the expected amount', { timeout: SQL_WAIT + 30000 }, async () => {
    page = await ctx.newPage();
    await page.goto(ORIGIN + '/jobs' + O);
    const info = await poll(async () => {
      const b = await bannerInfo();
      return b.count === 1 && amountIn(b.live) !== null && /30 days/.test(b.live) ? b : null;
    }, { timeout: SQL_WAIT, label: 'banner with the 30-day amount' });
    assert.equal(info.first, true, 'banner is the first element child of <main>');
    assert.ok(info.text.includes(DISCLAIMER), 'disclaimer');
    assert.ok(info.text.includes(labels.BASIS.list.short), 'list-price basis label');
    assert.ok(!/DEMO/.test(info.text));
    assert.deepEqual(info.pressed, ['period-30']);
    const shown = amountIn(info.live);
    assert.ok(closeTo(shown, expect30), 'banner ' + shown + ' vs expected priced subtotal ' + expect30.toFixed(4));
    assert.match(info.live, /subtotal/i, 'the 30-day period has unpriced usage (synthetic SKU), so the banner says priced subtotal');
    assert.ok(statements().length >= 1);
    // Jobs list badges: job 101 and 102 period totals; job 102 includes its triggered pipeline.
    const v = fx.templateValues;
    const badges = await poll(async () => {
      const b = await inlineBadges();
      const want = ['job:' + v.JOB_101, 'job:' + v.JOB_102, 'pipeline:' + v.PIPELINE_P1];
      return want.every((k) => b.some((x) => x.key === k && /\$/.test(x.text))) ? b : null;
    }, { timeout: SQL_WAIT, label: 'job and pipeline badges on the jobs list' });
    const w30 = periods.completePeriod(30, fx.dataset.nowMs);
    const j101 = badges.find((b) => b.key === 'job:' + v.JOB_101);
    assert.ok(closeTo(amountIn(j101.text), cost.jobPeriod(v.JOB_101, w30).total), 'job 101: ' + j101.text);
    const j102 = badges.find((b) => b.key === 'job:' + v.JOB_102);
    assert.match(j102.aria, /pipeline updates it triggered/, 'job 102 attribution includes triggered pipeline updates');
    assert.ok(amountIn(j102.text) > cost.jobPeriod(v.JOB_102, w30).total + 1, 'job 102 total (' + j102.text + ') is more than its direct billing');
    assert.equal(badges.filter((b) => b.row === 'other-workspace').length, 0, 'no badge for another workspace');
    await shot(page, '02-jobs-banner-30d');
  });

  it('in-page surfaces get the shared design tokens (core/theme.js is loaded in the real content-script world)', { timeout: 30000 }, async (t) => {
    if (!fs.existsSync(path.join(EXT_SRC, 'src/core/theme.js'))) return t.skip('no shared theme module in this build');
    // jsdom suites load their own file list; only a real registration shows what Chrome injects.
    const theme = load('core/theme.js');
    const firstVar = (decls) => decls.split(';')[0].split(':')[0].trim();
    const hostVar = firstVar(theme.cssVars('light'));
    const badgeVar = firstVar(theme.cssVars('light', 'dcc-'));
    const got = await page.evaluate(([hv, bv]) => {
      const host = document.querySelector('[data-dcc="banner"]');
      const badge = document.querySelector('[data-dcc="inline"]');
      return { host: host ? getComputedStyle(host).getPropertyValue(hv).trim() : null, badge: badge ? getComputedStyle(badge).getPropertyValue(bv).trim() : null };
    }, [hostVar, badgeVar]);
    const registered = load('background/registration.js').CONTENT_JS.includes('src/core/theme.js');
    assert.ok(
      got.host && got.badge,
      'design tokens missing in the page: banner ' + hostVar + '=' + JSON.stringify(got.host) + ', inline badge ' + badgeVar + '=' + JSON.stringify(got.badge) +
        ' (registration.js CONTENT_JS includes src/core/theme.js: ' + registered + ')'
    );
  });

  it('job runs page: badges on job 101 runs only (never the Launched workflow), title total present', { timeout: SQL_WAIT + 30000 }, async () => {
    const v = fx.templateValues;
    // SPA navigation (pushState in the page), like a click in the native app.
    await page.evaluate((href) => window.__fixture.navigate(href), '/jobs/' + v.JOB_101 + '/runs' + O);
    const runIds = [1, 2, 3, 4].map((k) => v['JOB_101_RUN_D' + k]);
    const badges = await poll(async () => {
      const b = await inlineBadges();
      const title = b.find((x) => x.kind === 'title' && x.key === 'job:101' && /\$/.test(x.text));
      const rows = runIds.map((id) => b.find((x) => x.key === 'job_run:101:' + id && /\$/.test(x.text)));
      return title && rows.every(Boolean) ? b : null;
    }, { timeout: SQL_WAIT, label: 'title total and four run badges' });
    for (const id of runIds) {
      const mine = badges.filter((b) => b.run === id);
      assert.equal(mine.length, 1, 'exactly one badge in run row ' + id);
      assert.equal(mine[0].key, 'job_run:101:' + id);
      const exp = cost.runDirect('101', id);
      assert.ok(closeTo(amountIn(mine[0].text), exp), 'run ' + id + ': ' + mine[0].text + ' vs ' + exp.toFixed(4));
    }
    assert.equal(badges.filter((b) => b.run === 'launcher-only').length, 0, 'launcher-only row: no badge');
    assert.ok(badges.every((b) => !/:777\b|^job:777$/.test(b.key)), 'never the Launched workflow (job 777)');
    assert.ok(badges.every((b) => b.key === 'job:101' || b.key.startsWith('job_run:101:')), 'only job 101 and its runs: ' + badges.map((b) => b.key).join(', '));
    const title = badges.find((b) => b.kind === 'title');
    assert.ok(closeTo(amountIn(title.text), cost.jobPeriod('101', periods.completePeriod(30, fx.dataset.nowMs)).total), 'title: ' + title.text);
    assert.match(title.text, /30d/);
    const banner = await bannerInfo();
    assert.equal(banner.count, 1);
    assert.equal(banner.first, true);
    await shot(page, '03-job-101-runs');
  });

  it('job 102 run that triggered pipeline P1: run cost includes the triggered pipeline update', { timeout: SQL_WAIT + 30000 }, async () => {
    const v = fx.templateValues;
    const runId = v.JOB_102_RUN_D1;
    await page.goto(ORIGIN + '/jobs/102/runs/' + runId + O);
    const badge = await poll(async () => (await inlineBadges()).find((b) => b.kind === 'title' && b.key === 'job_run:102:' + runId && /\$/.test(b.text)), { timeout: SQL_WAIT, label: 'job 102 run title badge' });
    const direct = cost.runDirect('102', runId);
    const withPipes = cost.runWithPipelines('102', runId);
    assert.ok(withPipes > direct + 0.5, 'fixture sanity: the triggered update is billed');
    assert.ok(closeTo(amountIn(badge.text), withPipes), badge.text + ' vs expected ' + withPipes.toFixed(4) + ' (direct only ' + direct.toFixed(4) + ')');
    assert.match(badge.aria, /plus pipeline updates it triggered/);
    assert.match(badge.aria, /Includes \$[\d,.]+ from triggered pipeline updates/);
    await shot(page, '04-job-102-run-with-pipeline');
  });

  it('period change 30 → 7 through the banner buttons updates the banner', { timeout: SQL_WAIT + 30000 }, async () => {
    await page.goto(ORIGIN + '/jobs' + O);
    await poll(async () => amountIn((await bannerInfo()).live) !== null, { timeout: SQL_WAIT, label: 'banner loaded' });
    await page.locator('[data-dcc="banner"] [data-k="period-7"]').click();
    const info = await poll(async () => {
      const b = await bannerInfo();
      return /7 days/.test(b.live) && amountIn(b.live) !== null ? b : null;
    }, { timeout: SQL_WAIT, label: 'banner with the 7-day amount' });
    assert.deepEqual(info.pressed, ['period-7']);
    assert.ok(closeTo(amountIn(info.live), expect7), 'banner ' + info.live + ' vs expected ' + expect7.toFixed(4));
    assert.ok(!/subtotal/i.test(info.live), 'the last 7 days are fully priced');
    const st = await sendOk({ type: 'page:state' });
    assert.equal(st.settings.periodDays, 7, 'the banner choice is saved');
    await shot(page, '05-jobs-banner-7d');
  });

  it('query history: one estimate per row (amounts or documented labels), explanatory note, SQL text never sent', { timeout: SQL_WAIT + 30000 }, async () => {
    const before = statements().length;
    await page.goto(ORIGIN + '/sql/history' + O);
    const rows = await poll(async () => {
      const r = await page.evaluate(() =>
        [...document.querySelectorAll('tbody tr[data-fx-row]')].map((tr) => {
          const b = [...tr.querySelectorAll('[data-dcc="estimates"][data-dcc-key]')];
          return { row: tr.getAttribute('data-fx-row'), n: b.length, status: b[0] && b[0].getAttribute('data-dcc-status'), text: b[0] && b[0].textContent, key: b[0] && b[0].getAttribute('data-dcc-key') };
        })
      );
      return r.length === 6 && r.every((x) => x.n === 1 && x.status !== 'loading') ? r : null;
    }, { timeout: SQL_WAIT, label: 'six settled query-history estimates' });
    const by = Object.fromEntries(rows.map((r) => [r.row, r]));
    const v = fx.templateValues;
    assert.deepEqual(rows.map((r) => r.status), ['ok', 'ok', 'pending', 'cached', 'row_unavailable', 'compute_unsupported'], JSON.stringify(rows));
    assert.equal(by['1'].key, 'statement:' + v.STMT_FINISHED);
    assert.match(by['2'].key, new RegExp('^meta:' + fixtureData.WAREHOUSES[0].id + ':'));
    for (const r of [by['1'], by['2']]) assert.ok(amountIn(r.text) > 0, 'allocated amount: ' + r.text);
    const L = load('core/allocation.js').LABELS;
    assert.equal(by['3'].text, L.pending);
    assert.equal(by['4'].text, L.cached);
    assert.equal(by['5'].text, L.row_unavailable);
    assert.equal(by['6'].text, L.compute_unsupported);
    const note = await page.evaluate(() => {
      const n = document.querySelectorAll('[data-dcc="estimates"][role="note"]');
      return { n: n.length, text: n[0] ? n[0].textContent : '' };
    });
    assert.equal(note.n, 1, 'one explanatory note');
    assert.ok(note.text.includes(DISCLAIMER));
    assert.equal(await page.locator('[data-dcc="inline"]').count(), 0, 'no warehouse-total badges on Query History');
    assert.ok(statements().length > before, 'estimates were computed through the mock statement API');
    // SENTINEL cells are still on the page, but nothing the extension sent contains them.
    assert.equal(await page.locator('code', { hasText: SENTINEL }).count(), 6);
    for (const r of api) assert.ok(!r.body.includes(SENTINEL), 'request body to ' + r.path + ' contains the SQL-text sentinel');
    for (const r of statements()) assert.ok(!/statement_text/i.test(JSON.parse(r.body).statement || ''), 'a statement referenced statement_text');
    assert.equal(fx.state.sentinelReads, 0);
    await shot(page, '06-query-history-estimates');
  });

  it('Explorer: expands with six tabs; Top drivers loads through SQL', { timeout: SQL_WAIT + 30000 }, async () => {
    await page.goto(ORIGIN + '/jobs' + O);
    await poll(async () => amountIn((await bannerInfo()).live) !== null, { timeout: SQL_WAIT, label: 'banner loaded' });
    await page.locator('[data-dcc="banner"] [data-k="toggle"]').click();
    const tabs = page.locator('[data-dcc="banner"] #dcc-panel [role="tab"]');
    await poll(async () => (await tabs.count()) === 6, { timeout: 20000, label: 'six explorer tabs' });
    assert.deepEqual(await tabs.evaluateAll((els) => els.map((e) => e.getAttribute('data-fk'))), ['tab:products', 'tab:drivers', 'tab:runs', 'tab:calendar', 'tab:skus', 'tab:daily']);
    await page.locator('[data-dcc="banner"] [data-fk="tab:drivers"]').click();
    const before = statements().length;
    await page.locator('[data-dcc="banner"] [data-fk="load:exploreEntities"]').click();
    await poll(async () => (await page.locator('[data-dcc="banner"] [data-fk="reload:exploreEntities"]').count()) === 1, { timeout: SQL_WAIT, label: 'Top drivers loaded' });
    assert.equal(await page.locator('[data-dcc="banner"] #dcc-panel [role="alert"]').count(), 0, 'no error box');
    assert.ok(statements().length > before, 'Load ran SQL');
    const text = await page.evaluate(() => document.querySelector('[data-dcc="banner"]').shadowRoot.querySelector('#dcc-panel').textContent);
    assert.ok(/\$/.test(text), 'drivers show amounts');
    await shot(page, '07-explorer-top-drivers');
  });

  it('demo mode: banner shows DEMO and no new SQL statements are sent', { timeout: 90000 }, async () => {
    // Let in-flight connected work finish, then count.
    let n = statements().length;
    await poll(async () => {
      await sleep(1500);
      const now = statements().length;
      const quiet = now === n;
      n = now;
      return quiet;
    }, { timeout: 60000, label: 'statement traffic to settle' });
    const baseline = statements().length;
    await sendOk({ type: 'page:updateSettings', patch: { mode: 'demo' } });
    await poll(async () => /DEMO/.test((await bannerInfo()).text || ''), { timeout: 20000, label: 'live switch to DEMO' });
    await page.goto(ORIGIN + '/jobs/101/runs' + O);
    await poll(async () => {
      const b = await bannerInfo();
      return /DEMO/.test(b.text || '') && amountIn(b.live) !== null;
    }, { timeout: 20000, label: 'DEMO banner after navigation' });
    await poll(async () => (await inlineBadges()).some((b) => /DEMO/.test(b.text)), { timeout: 20000, label: 'demo badges' });
    await sleep(2500);
    assert.equal(statements().length, baseline, 'no /api/2.0/sql/statements calls in demo mode');
    await shot(page, '08-demo-mode');
  });

  it('pause removes badges and pauses the banner; a saved workspace color still tints the top nav', { timeout: 60000 }, async () => {
    assert.ok((await inlineBadges()).length > 0, 'badges present before pausing');
    await sendOk({ type: 'page:updateSettings', patch: { showCosts: false } });
    await poll(async () => (await bannerInfo()).keys.includes('resume'), { timeout: 20000, label: 'paused banner (Resume control)' });
    await poll(async () => (await inlineBadges()).length === 0, { timeout: 20000, label: 'badges removed' });
    const appearance = { version: 1, entries: { [ORIGIN + '|' + WS]: { color: '#1D4ED8', savedAt: Date.now() } } };
    await opt.evaluate((a) => chrome.storage.local.set({ 'dcc.appearance': a }), appearance);
    const nav = await poll(
      async () =>
        page.evaluate(() => {
          const n = document.querySelector('nav[aria-label="Top Navigation"]');
          if (!n || !n.hasAttribute('data-dcc-themed')) return null;
          return { bg: getComputedStyle(n).backgroundColor, style: document.querySelectorAll('style[data-dcc="theme"]').length };
        }),
      { timeout: 20000, label: 'tinted top navigation' }
    );
    assert.equal(nav.bg, 'rgb(29, 78, 216)');
    assert.equal(nav.style, 1);
    assert.equal((await inlineBadges()).length, 0, 'still no badges while paused');
    await shot(page, '09-paused-with-workspace-color');
  });

  it('monitor page: enabled for the fixture origin, refresh lists runs including the failed one; Float (PiP) is reported', { timeout: 90000 }, async () => {
    await sendOk({ type: 'page:updateSettings', patch: { mode: 'connected' } });
    const mon = await ctx.newPage();
    await mon.goto('chrome-extension://' + extId + '/ui/monitor.html');
    await mon.waitForLoadState('load');
    await sendOk({ type: 'page:updateSettings', patch: { monitor: { enabled: true, origin: ORIGIN } } }, mon);
    const st = await poll(async () => {
      const r = await send({ type: 'monitor:refresh' }, mon);
      return r.ok && r.data.state && r.data.state.status === 'ok' ? r.data : null;
    }, { timeout: 40000, interval: 1500, label: 'monitor state ok' });
    const runsJson = JSON.stringify(st.state.runs);
    // Job 101's failed re-run, three hours before now: inside the 24-hour window at any time of day.
    const failedRunId = String(fixtureData.RECENT_FAILED_RUN_ID);
    assert.ok(runsJson.includes(failedRunId), 'the recent failed run is listed');
    assert.ok(/"outcome":"failed"/.test(runsJson), 'a run with outcome failed');
    assert.ok(api.some((r) => r.method === 'GET' && r.path === '/api/2.2/jobs/runs/list'), 'monitor used the runs REST API');
    await mon.reload();
    await poll(async () => (await mon.locator('#runs a[href*="/jobs/101/runs/' + failedRunId + '"]').count()) >= 1, { timeout: 20000, label: 'failed run link rendered in #runs' });
    assert.ok((await mon.locator('#runs a[href^="' + ORIGIN + '/jobs/"]').count()) >= 3, 'several run links');
    await shot(mon, '10-monitor-light');
    await mon.emulateMedia({ colorScheme: 'dark' });
    await shot(mon, '11-monitor-dark');
    await mon.emulateMedia({ colorScheme: 'light' });

    // Document Picture-in-Picture from a real click (user activation). Headless support varies;
    // the result is reported, not asserted.
    const pagesBefore = ctx.pages().length;
    await mon.click('#float');
    await sleep(2000);
    const pip = await mon.evaluate(() => {
      const dpip = window.documentPictureInPicture;
      const win = dpip && dpip.window;
      // When the float works, the whole app (Float button included) moves into the PiP document.
      const find = (id) => document.getElementById(id) || (win && win.document.getElementById(id));
      const note = find('float-note');
      const placeholder = document.getElementById('pip-placeholder');
      return {
        api: typeof dpip === 'object' && dpip !== null,
        window: Boolean(win),
        appInPip: Boolean(win && win.document.getElementById('app')),
        pressed: find('float') ? find('float').getAttribute('aria-pressed') : null,
        placeholderShown: Boolean(placeholder && !placeholder.hidden),
        note: note && !note.hidden ? note.textContent.trim() : null,
      };
    });
    notes.push('Document PiP in headless: API ' + (pip.api ? 'present' : 'absent') + '; window opened: ' + pip.window + '; app moved into it: ' + pip.appInPip + '; Float aria-pressed=' + pip.pressed + '; placeholder shown: ' + pip.placeholderShown + (pip.note ? '; fallback note: "' + pip.note.slice(0, 120) + '"' : '') + '; Playwright pages before/after click: ' + pagesBefore + '/' + ctx.pages().length);
    assert.ok((pip.window && pip.appInPip && pip.pressed === 'true') || pip.note, 'either the app floated into a PiP window or the documented fallback note is shown');
    await shot(mon, '12-monitor-after-float');
    if (pip.window) {
      // Closing the PiP window brings the app back into the page.
      await mon.evaluate(() => window.documentPictureInPicture.window.close());
      await poll(async () => mon.evaluate(() => Boolean(document.getElementById('app') && document.getElementById('float').getAttribute('aria-pressed') === 'false')), { timeout: 10000, label: 'app back from PiP' });
    }
    await mon.close();
  });

  it('extension pages in dark color scheme (screenshots)', { timeout: 60000 }, async () => {
    await opt.emulateMedia({ colorScheme: 'dark' });
    await opt.reload();
    await opt.waitForLoadState('load');
    await sleep(500);
    await shot(opt, '13-options-dark');
    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 420, height: 640 });
    await popup.goto('chrome-extension://' + extId + '/ui/popup.html');
    await popup.waitForLoadState('load');
    await sleep(500);
    await shot(popup, '14-popup-light');
    await popup.emulateMedia({ colorScheme: 'dark' });
    await sleep(300);
    await shot(popup, '15-popup-dark');
    await popup.close();
    const errors = [];
    const guide = await ctx.newPage();
    guide.on('pageerror', (e) => errors.push(String(e && e.message)));
    await guide.emulateMedia({ colorScheme: 'dark' });
    await guide.goto('chrome-extension://' + extId + '/docs/calculation-guide.html');
    await guide.waitForLoadState('load');
    await shot(guide, '16-guide-dark');
    await guide.close();
    assert.deepEqual(errors, []);
  });

  it('privacy: no request body ever contained the SQL-text sentinel; no statement selected statement_text', (t) => {
    assert.ok(statements().length > 0);
    for (const r of api) assert.ok(!r.body.includes(SENTINEL), r.path);
    for (const r of statements()) assert.ok(!/statement_text/i.test(JSON.parse(r.body).statement || ''));
    assert.equal(fx.state.sentinelReads, 0);
    notes.push('API requests seen by the fixture: ' + api.length + ' (' + statements().length + ' SQL statements)');
    for (const n of notes) t.diagnostic(n);
    t.diagnostic('screenshots in ' + SHOTS + ': ' + shots.map((s) => path.basename(s)).join(', '));
  });
});
