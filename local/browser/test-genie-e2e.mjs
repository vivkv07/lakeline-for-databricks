// Genie side panel end to end: the real extension in REAL headless Chromium (Playwright,
// disposable profile) against the SIMULATED fixture backend (local/fixture-server.mjs, whose
// Genie endpoints imitate the documented Conversation API). Real browser, real MV3 service
// worker, real side-panel page and messaging; the Genie API is an imitation, so this is not proof
// of compatibility with real Databricks Genie.
//
//   npm run test:browser      (screenshots: $DCC_GENIE_SHOTS, default <tmpdir>/dcc-genie-shots)
//
// - The browser's side panel UI can't be driven headless, so ui/sidepanel.html is opened in a
//   normal tab (same page, same code). Whether chrome.sidePanel.open() works from the popup's
//   click in headless Chromium is reported as a diagnostic, not asserted.
// - TEST-ONLY extension copy in a temp dir with host_permissions for the fixture origin and the
//   `notifications` permission granted at install (prompts can't be clicked headless). extension/
//   itself is never modified. Profile and copy are deleted at the end.
// - Connects the fixture with the documented FAKE token through the real router.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const EXT_SRC = path.join(ROOT, 'extension');
const PORT = 8765;
const ORIGIN = 'http://127.0.0.1:' + PORT;
const WS = '1234567890';
const SHOTS = process.env.DCC_GENIE_SHOTS || path.join(os.tmpdir(), 'dcc-genie-shots');
const QUESTION = 'What was revenue by region last month?';

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

describe('browser e2e: Genie side panel in real Chromium against the SIMULATED fixture Genie API', { skip }, () => {
  let fx;
  let fixtureData;
  let tmp;
  let ctx;
  let sw;
  let extId;
  let opt;
  const api = [];
  const shots = [];
  const notes = [];
  const panelUrl = () => 'chrome-extension://' + extId + '/ui/sidepanel.html';

  async function shot(p, name) {
    fs.mkdirSync(SHOTS, { recursive: true });
    const file = path.join(SHOTS, name + '.png');
    await p.screenshot({ path: file, fullPage: false });
    shots.push(file);
  }

  async function sendOk(msg, from = opt) {
    const res = await from.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    assert.equal(res && res.ok, true, msg.type + ' failed: ' + JSON.stringify(res && res.error));
    return res.data;
  }

  async function launch(variant, dir) {
    const profile = fs.mkdtempSync(path.join(tmp, 'profile-'));
    const opts = { headless: true, viewport: { width: 1280, height: 900 }, colorScheme: 'light', args: ['--disable-extensions-except=' + dir, '--load-extension=' + dir] };
    // E2E_CHANNEL=msedge (npm run test:edge) runs the same suite in an installed Microsoft Edge.
    if (process.env.E2E_CHANNEL) opts.channel = process.env.E2E_CHANNEL;
    else if (variant === 'chromium') opts.channel = 'chromium';
    const c = await chromium.launchPersistentContext(profile, opts);
    let worker = c.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
    if (!worker) worker = await c.waitForEvent('serviceworker', { timeout: variant === 'chromium' ? 20000 : 8000 }).catch(() => null);
    if (!worker) {
      await c.close().catch(() => {});
      return null;
    }
    return { c, worker };
  }

  async function openPanel({ dark = false } = {}) {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 400, height: 820 });
    if (dark) await p.emulateMedia({ colorScheme: 'dark' });
    await p.goto(panelUrl());
    await p.waitForLoadState('load');
    return p;
  }

  const genieRequests = () => api.filter((r) => r.path.startsWith('/api/2.0/genie/'));
  const turns = (p) =>
    p.evaluate(() =>
      [...document.querySelectorAll('article.gp-turn')].map((a) => ({
        phase: a.getAttribute('data-phase'),
        chip: (a.querySelector('.gp-chip') || {}).textContent || '',
        question: (a.querySelector('.gp-q') || {}).textContent || '',
        text: [...a.querySelectorAll('.gp-md')].map((x) => x.textContent).join('\n'),
        strong: [...a.querySelectorAll('.gp-md strong')].map((x) => x.textContent),
        listItems: a.querySelectorAll('.gp-md li').length,
        headers: [...a.querySelectorAll('thead th')].map((th) => th.textContent),
        rawHeaders: [...a.querySelectorAll('thead th')].map((th) => th.getAttribute('data-col')),
        rows: [...a.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)),
        meta: (a.querySelector('.gp-count') || {}).textContent || '',
        views: [...a.querySelectorAll('.gp-seg label')].map((l) => l.textContent),
        chart: a.querySelector('.gp-kpis') ? 'kpi' : a.querySelector('.gp-fig') ? a.querySelector('.gp-fig').getAttribute('data-chart') : null,
        marks: a.querySelectorAll('.gp-marks [tabindex]').length,
        summary: (a.querySelector('.gp-svg [role="img"]') || { getAttribute: () => '' }).getAttribute('aria-label') || '',
        note: (a.querySelector('.gp-fig-note') || {}).textContent || '',
        kpis: [...a.querySelectorAll('.gp-kpi-value')].map((x) => x.textContent),
        sqlOpen: a.querySelector('details.gp-sql') ? a.querySelector('details.gp-sql').open : null,
        error: (a.querySelector('.dcc-alert__title') || {}).textContent || '',
        suggested: [...a.querySelectorAll('.gp-suggest-list button')].map((b) => b.textContent),
      }))
    );

  /** Layout facts the screenshots showed going wrong before: nothing may overflow the panel. */
  const layout = (p) =>
    p.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const over = [];
      for (const el of document.querySelectorAll('.gp-answer, .gp-answer *:not(.gp-table *):not(.gp-code *):not(.gp-tip):not(.gp-tip *)')) {
        if (el.closest('[hidden]') || el.closest('.gp-table-wrap') || el.closest('pre')) continue;
        const r = el.getBoundingClientRect();
        if (r.width && (r.right > vw + 0.5 || r.left < -0.5)) over.push(el.className || el.tagName);
      }
      return { docScroll: document.documentElement.scrollWidth - vw, bodyScrollTop: document.scrollingElement.scrollTop, over: [...new Set(over)].slice(0, 5) };
    });

  /** The CSV a Download CSV click would save, captured in the page (no file is written). */
  const downloadCsv = (p, turnIndex) =>
    p.evaluate(async (k) => {
      const blobs = [];
      const orig = URL.createObjectURL;
      URL.createObjectURL = (b) => (blobs.push(b), orig.call(URL, b));
      HTMLAnchorElement.prototype.click = function () {};
      document.querySelectorAll('article.gp-turn')[k].querySelector('[data-download]').click();
      URL.createObjectURL = orig;
      return blobs.length ? await blobs[0].text() : null;
    }, turnIndex);

  async function pickSpace(p, title) {
    await poll(async () => p.evaluate(() => !document.getElementById('space').disabled && document.getElementById('space').options.length > 0), { label: 'agents listed' });
    const value = await p.evaluate((t) => [...document.getElementById('space').options].find((o) => o.textContent === t).value, title);
    await p.selectOption('#space', value);
    await poll(async () => p.evaluate(() => !document.getElementById('question').disabled), { label: 'question box enabled' });
    return value;
  }

  async function ask(p, text) {
    await p.fill('#question', text);
    await p.focus('#question');
    await p.keyboard.press('Enter');
  }

  before(async () => {
    fixtureData = await import('../fixture-data.mjs');
    const { startFixtureServer } = await import('../fixture-server.mjs');
    if (!(await portFree(PORT))) throw new Error('Port ' + PORT + ' is busy. Stop `npm run fixture` and other browser suites (npm run test:browser runs them one at a time) and retry.');
    fx = await startFixtureServer({ port: PORT, log: () => {}, onApiRequest: (r) => api.push(r) });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcc-genie-e2e-'));
    const dir = path.join(tmp, 'ext');
    fs.cpSync(EXT_SRC, dir, { recursive: true });
    const manifestFile = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.host_permissions = [ORIGIN + '/*'];
    manifest.permissions = manifest.permissions.concat('notifications');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    let got = await launch('default', dir);
    if (!got) got = await launch('chromium', dir);
    assert.ok(got, 'the extension service worker never started in headless Chromium');
    ctx = got.c;
    sw = got.worker;
    extId = new URL(sw.url()).host;
    const ua = await sw.evaluate(() => navigator.userAgent).catch(() => '');
    notes.push('browser: ' + ((/(HeadlessChrome|Chrome)\/[\d.]+/.exec(ua) || ['unknown'])[0]));
  });

  after(async () => {
    if (ctx) await ctx.close().catch(() => {});
    if (fx) await fx.close().catch(() => {});
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('manifest: sidePanel permission and default path are live in the loaded extension', async () => {
    const m = await sw.evaluate(() => chrome.runtime.getManifest());
    assert.ok(m.permissions.includes('sidePanel'));
    assert.equal(m.side_panel.default_path, 'ui/sidepanel.html');
    const opts = await sw.evaluate(() => chrome.sidePanel.getOptions({}));
    assert.equal(opts.path, 'ui/sidepanel.html');
    assert.equal(opts.enabled, true);
  });

  it('connects the fixture workspace with the fake PAT through the real router', { timeout: 60000 }, async () => {
    opt = await ctx.newPage();
    await opt.goto('chrome-extension://' + extId + '/ui/options.html');
    await opt.waitForLoadState('load');
    await sendOk({ type: 'page:updateSettings', patch: { mode: 'connected' } });
    const { FIXTURE_TOKEN } = await import('../fixture-server.mjs');
    await sendOk({ type: 'admin:setPat', origin: ORIGIN, token: FIXTURE_TOKEN });
    const saved = await sendOk({ type: 'admin:saveConnection', connection: { origin: ORIGIN, workspaceId: WS, authMode: 'pat', priceTable: 'system.billing.list_prices', warehouse: { mode: 'auto' } } });
    assert.equal(saved.workspaceId, WS);
    // Opt in to notifications (the test copy has the permission).
    assert.deepEqual(await sendOk({ type: 'genie:settings', notify: true }), { notify: true });
  });

  it('popup "Ask Genie": tries the real side panel (reported), the page loads in a tab either way', { timeout: 30000 }, async () => {
    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 400, height: 760 });
    await popup.goto('chrome-extension://' + extId + '/ui/popup.html');
    await popup.waitForLoadState('load');
    await sleep(300);
    await shot(popup, '01-popup-genie-light');
    const errors = [];
    popup.on('pageerror', (e) => errors.push(String(e && e.message)));
    await popup.click('#genie-open').catch(() => {});
    await sleep(800);
    const contexts = await sw.evaluate(async () => (chrome.runtime.getContexts ? (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length : -1)).catch(() => -2);
    const status = popup.isClosed() ? '(popup closed itself)' : await popup.evaluate(() => document.getElementById('genie-status').textContent.trim());
    notes.push('chrome.sidePanel.open from the popup click in headless: side-panel contexts=' + contexts + '; popup status: ' + (status || '(none)'));
    if (!popup.isClosed()) await popup.close();
    assert.deepEqual(errors, []);
    if (contexts > 0) {
      // A real side panel is open (and counts as "panel open"). Close it so the next steps can
      // test answers landing while no panel is open.
      const closed = await sw.evaluate(async () => {
        const w = await chrome.windows.getLastFocused();
        if (chrome.sidePanel.close) await chrome.sidePanel.close({ windowId: w.id });
        else {
          await chrome.sidePanel.setOptions({ enabled: false });
          await chrome.sidePanel.setOptions({ enabled: true, path: 'ui/sidepanel.html' });
        }
        for (let i = 0; i < 30; i++) {
          if (!(await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length) return 0;
          await new Promise((r) => setTimeout(r, 100));
        }
        return (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length;
      });
      notes.push('real side panel closed again: remaining side-panel contexts=' + closed);
    }
  });

  it('panel: picks the fixture workspace and agent, asks with Enter, shows live statuses', { timeout: 60000 }, async () => {
    const p = await openPanel();
    await poll(async () => p.evaluate((o) => document.getElementById('ws').value === o, ORIGIN), { label: 'fixture workspace selected' });
    await pickSpace(p, 'Sales analytics (fixture)');
    await shot(p, '02-fixture-empty-light');
    await ask(p, QUESTION);
    const t = await poll(async () => {
      const list = await turns(p);
      return list.length === 1 && ['sending', 'working', 'query'].includes(list[0].phase) ? list[0] : null;
    }, { label: 'in-flight status' });
    assert.match(t.chip, /Sending|Genie is working|Running query/);
    assert.equal(t.question, QUESTION);
    await shot(p, '03-fixture-working-light');
    // Close the panel while Genie is still working: the service worker keeps going.
    const msg = [...fx.state.genie.messages.values()].at(-1);
    notes.push('panel closed while the fixture message was ' + msg.status);
    assert.notEqual(msg.status, 'COMPLETED', 'closed before the answer landed');
    await p.close();
  });

  it('with the panel closed the answer lands: badge counts it, a data-free notification is created', { timeout: 60000 }, async () => {
    const msg = [...fx.state.genie.messages.values()].at(-1);
    await poll(async () => msg.status === 'COMPLETED' && fx.state.genie.resultReads >= 1, { timeout: 40000, label: 'fixture message COMPLETED and result read' });
    const badge = await poll(async () => {
      const b = await sw.evaluate(() => chrome.action.getBadgeText({}));
      return b === '1' ? b : null;
    }, { timeout: 10000, label: 'badge "1"' });
    assert.equal(badge, '1');
    const n = await sw.evaluate(async () => (chrome.notifications && chrome.notifications.getAll ? Object.keys(await chrome.notifications.getAll()) : null)).catch((e) => 'error: ' + e.message);
    notes.push('notifications after the answer (panel closed): ' + JSON.stringify(n));
    if (Array.isArray(n)) assert.ok(n.some((id) => id.startsWith('dcc-genie-')), 'a Genie notification exists');
    // The conversation is in session storage only.
    const local = await sw.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
    const session = await sw.evaluate(async () => JSON.stringify(await chrome.storage.session.get('dcc.genie.state')));
    assert.ok(!local.includes(QUESTION) && !local.includes('EMEA'), 'nothing from the conversation in local storage');
    assert.ok(session.includes(QUESTION) && session.includes('EMEA'));
  });

  it('reopening the panel shows the answer: Markdown, bar chart first, formatted table, SQL, CSV; the badge clears', { timeout: 90000 }, async () => {
    const p = await openPanel();
    const t = await poll(async () => {
      const list = await turns(p);
      return list.length === 1 && list[0].phase === 'done' ? list[0] : null;
    }, { label: 'completed turn after reopening' });
    const a = fixtureData.genieAnswer(fixtureData.GENIE_SPACES[0].space_id, QUESTION);
    assert.equal(t.chip, 'Answer ready');
    assert.match(t.text, /^Revenue last month was \$1\.24M across 4 regions\. \(fixture\)/);
    assert.deepEqual(t.strong, ['$1.24M', 'EMEA'], 'Markdown bold became <strong>');
    assert.equal(t.listItems, 2);
    assert.ok(!t.text.includes('**'), 'no raw Markdown markers');
    assert.deepEqual(t.views, ['Chart', 'Table']);
    assert.equal(t.chart, 'bar');
    assert.equal(t.marks, 4);
    assert.match(t.summary, /^Bar chart of Revenue \(USD\) by Region, 4 of 4 bars, largest first\. Highest EMEA \$412,300\./);
    assert.deepEqual(t.headers, ['Region', 'Revenue (USD)', 'Orders']);
    assert.deepEqual(t.rawHeaders, ['region', 'revenue_usd', 'orders']);
    assert.deepEqual(t.rows, [['EMEA', '$412,300', '3,120'], ['North America', '$398,900', '2,875'], ['APAC', '$301,750', '3,410'], ['LATAM', '$96,200', 'n/a']]);
    assert.equal(t.meta, 'Showing 4 of 4 rows');
    assert.equal(t.sqlOpen, false, 'SQL hidden behind Show SQL');
    assert.deepEqual(t.suggested, a.suggested);
    assert.deepEqual(await layout(p), { docScroll: 0, bodyScrollTop: 0, over: [] }, 'nothing overflows the 400 px panel');
    await poll(async () => (await sw.evaluate(() => chrome.action.getBadgeText({}))) === '', { timeout: 5000, label: 'badge cleared by the open panel' });
    await shot(p, '04-fixture-answer-light');
    // Keyboard on the chart: one Tab stop, arrows move, the tooltip follows focus.
    await p.focus('article.gp-turn .gp-marks [tabindex="0"]');
    await p.keyboard.press('ArrowDown');
    const focused = await p.evaluate(() => [document.activeElement.getAttribute('aria-label'), !document.querySelector('.gp-tip').hidden, document.querySelector('.gp-tip strong').textContent]);
    assert.deepEqual(focused, ['North America: $398,900', true, '$398,900']);
    // ResizeObserver: the chart redraws at the new width.
    const w0 = await p.evaluate(() => Number(document.querySelector('.gp-chart svg.gp-svg').getAttribute('width')));
    await p.setViewportSize({ width: 480, height: 820 });
    await poll(async () => p.evaluate((w) => Number(document.querySelector('.gp-chart svg.gp-svg').getAttribute('width')) > w + 40, w0), { timeout: 5000, label: 'chart redrawn wider' });
    assert.equal(await p.evaluate(() => Number(document.querySelector('.gp-chart svg.gp-svg').getAttribute('width')) === document.querySelector('.gp-chart').clientWidth), true);
    await p.setViewportSize({ width: 400, height: 820 });
    // Table view, CSV content (formula-safe escaping from explorer/csv.js), SQL with Copy SQL in view.
    await p.click('article.gp-turn label[for$="-table"]');
    assert.equal(await p.evaluate(() => document.querySelector('.gp-view[data-view="table"]').hidden), false);
    assert.equal(await downloadCsv(p, 0), 'region,revenue_usd,orders\r\nEMEA,412300,3120\r\nNorth America,398900,2875\r\nAPAC,301750,3410\r\nLATAM,96200,\r\n');
    await p.click('details.gp-sql > summary');
    assert.equal(await p.evaluate(() => document.querySelector('details.gp-sql pre code').textContent), a.sql);
    const sqlBox = await p.evaluate(() => {
      const b = document.querySelector('[data-copy-sql]').getBoundingClientRect();
      const card = document.querySelector('.gp-answer').getBoundingClientRect();
      const pre = document.querySelector('pre.gp-code');
      return { inCard: b.left >= card.left && b.right <= card.right, aboveCode: b.bottom <= pre.getBoundingClientRect().top, scrolls: pre.scrollWidth > pre.clientWidth, preFits: pre.getBoundingClientRect().right <= card.right };
    });
    assert.deepEqual(sqlBox, { inCard: true, aboveCode: true, scrolls: true, preFits: true }, 'Copy SQL is never clipped; long SQL scrolls inside its block');
    await p.evaluate(() => document.querySelector('details.gp-sql').scrollIntoView({ block: 'center' }));
    await shot(p, '05-fixture-answer-sql-light');
    // Follow-up from a suggested question ("Show revenue by week"), in the same Genie conversation.
    const before = fx.state.genie.followUps;
    await p.click('.gp-suggest-list button');
    const line = await poll(async () => {
      const list = await turns(p);
      return list.length === 2 && list[1].phase === 'done' ? list[1] : null;
    }, { timeout: 40000, label: 'follow-up answered' });
    assert.equal(fx.state.genie.followUps, before + 1);
    assert.equal(line.chart, 'line');
    assert.equal(line.note, '1 missing value shown as gaps');
    assert.equal(await p.evaluate(() => document.querySelectorAll('article.gp-turn')[1].querySelectorAll('polyline.gp-line').length), 2, 'the missing week splits the line');
    assert.deepEqual(line.rows[5], ['Sep 14, 2026', 'n/a']);
    // Then the KPI follow-up ("What were the headline numbers last month?").
    await p.click('.gp-suggest-list button');
    const kpi = await poll(async () => {
      const list = await turns(p);
      return list.length === 3 && list[2].phase === 'done' ? list[2] : null;
    }, { timeout: 40000, label: 'KPI follow-up answered' });
    assert.equal(kpi.chart, 'kpi');
    assert.deepEqual(kpi.views, ['Summary', 'Table']);
    assert.deepEqual(kpi.kpis, ['$1.24M', '10.8K', '4,212', '1.8%'], 'compact from 10,000; the exact value sits under each tile');
    assert.deepEqual(await layout(p), { docScroll: 0, bodyScrollTop: 0, over: [] });
    await p.emulateMedia({ colorScheme: 'dark' });
    await sleep(200);
    await shot(p, '06-fixture-answer-dark');
    await p.close();
  });

  it('job agent: scatter for two measures, a wide record table with a scroll cue and n/a cells', { timeout: 90000 }, async () => {
    const p = await openPanel();
    await pickSpace(p, 'Job operations (fixture)');
    await ask(p, 'How do run duration and DBUs relate?');
    const sc = await poll(async () => {
      const list = await turns(p);
      return list.length === 1 && list[0].phase === 'done' ? list[0] : null;
    }, { timeout: 40000, label: 'scatter answer' });
    assert.equal(sc.chart, 'scatter');
    assert.equal(sc.marks, 11, 'the run without DBUs is left out, not drawn at 0');
    assert.equal(sc.note, '1 row without both values not shown');
    await ask(p, 'Show the latest pipeline updates');
    const wide = await poll(async () => {
      const list = await turns(p);
      return list.length === 2 && list[1].phase === 'done' ? list[1] : null;
    }, { timeout: 40000, label: 'wide table answer' });
    assert.equal(wide.chart, null);
    assert.deepEqual(wide.views, [], 'records get the table only');
    assert.deepEqual(wide.headers, ['Update ID', 'Pipeline Name', 'State', 'Started at (UTC)', 'Duration (min)', 'Rows Written', 'Error Ratio', 'Cost (USD)', 'Cause']);
    assert.deepEqual(wide.rows[1].slice(3, 8), ['Oct 15, 2026, 05:40:51', '2.1', '0', '100.00%', '$0.88']);
    assert.equal(wide.rows[2][7], 'n/a');
    const cue = await p.evaluate(() => {
      const a = document.querySelectorAll('article.gp-turn')[1];
      const wrap = a.querySelector('.gp-table-wrap');
      return { scrolls: wrap.scrollWidth > wrap.clientWidth, right: a.querySelector('.gp-tablebox').hasAttribute('data-more-right'), left: a.querySelector('.gp-tablebox').hasAttribute('data-more-left'), sticky: getComputedStyle(a.querySelector('thead th')).position };
    });
    assert.deepEqual(cue, { scrolls: true, right: true, left: false, sticky: 'sticky' });
    await p.evaluate(() => {
      const w = document.querySelectorAll('article.gp-turn')[1].querySelector('.gp-table-wrap');
      w.scrollLeft = w.scrollWidth;
    });
    await poll(async () => p.evaluate(() => document.querySelectorAll('article.gp-turn')[1].querySelector('.gp-tablebox').hasAttribute('data-more-left')), { timeout: 3000, label: 'left cue after scrolling' });
    assert.deepEqual(await layout(p), { docScroll: 0, bodyScrollTop: 0, over: [] });
    await p.evaluate(() => document.querySelectorAll('article.gp-turn')[1].scrollIntoView());
    await shot(p, '06b-fixture-wide-table-light');
    await p.close();
  });

  it('a failing agent shows Failed with a plain reason', { timeout: 60000 }, async () => {
    const p = await openPanel();
    await pickSpace(p, 'Broken agent (fixture)');
    await ask(p, 'Anything at all?');
    const t = await poll(async () => {
      const list = await turns(p);
      return list.length === 1 && list[0].phase === 'failed' ? list[0] : null;
    }, { timeout: 40000, label: 'failed turn' });
    assert.equal(t.chip, 'Failed');
    assert.equal(t.error, "Genie couldn't answer");
    await shot(p, '07-fixture-failed-light');
    await p.close();
  });

  it('demo mode: DEMO agents and canned answers with a table, no Genie requests to the fixture', { timeout: 60000 }, async () => {
    await sendOk({ type: 'page:updateSettings', patch: { mode: 'demo' } });
    const before = genieRequests().length;
    for (const dark of [false, true]) {
      const p = await openPanel({ dark });
      await poll(async () => p.evaluate(() => !document.getElementById('demo-chip').hidden), { label: 'DEMO chip' });
      await pickSpace(p, 'Revenue analytics · DEMO');
      if (!dark) await shot(p, '08-demo-empty-light');
      const existing = (await turns(p)).length;
      if (!existing) {
        await p.click('.gp-starters button');
        await poll(async () => {
          const list = await turns(p);
          return list.length === 1 && list[0].phase === 'done';
        }, { timeout: 30000, label: 'demo answer' });
      }
      const t = (await turns(p))[0];
      assert.match(t.text, /DEMO answer \(synthetic\)/);
      assert.equal(t.strong[0], 'DEMO answer (synthetic).');
      assert.equal(t.chart, 'bar');
      assert.equal(t.rows.length, 5);
      assert.deepEqual(t.rows[4], ['Other', '$31,850', '402', 'n/a']);
      await shot(p, dark ? '10-demo-answer-dark' : '09-demo-answer-light');
      await p.close();
    }
    assert.equal(genieRequests().length, before, 'demo mode sent nothing to the workspace');
    await sendOk({ type: 'page:updateSettings', patch: { mode: 'connected' } });
  });

  it('privacy: Genie POST bodies carried only the question; only allowlisted Genie paths were called', (t) => {
    const posts = genieRequests().filter((r) => r.method === 'POST');
    assert.ok(posts.length >= 3);
    for (const r of posts) assert.deepEqual(Object.keys(JSON.parse(r.body)), ['content'], r.path);
    const shapes = new Set(genieRequests().map((r) => r.method + ' ' + r.path.replace(/[0-9a-f]{32}/g, ':id')));
    assert.deepEqual([...shapes].sort(), [
      'GET /api/2.0/genie/spaces',
      'GET /api/2.0/genie/spaces/:id/conversations/:id/messages/:id',
      'GET /api/2.0/genie/spaces/:id/conversations/:id/messages/:id/attachments/:id/query-result',
      'POST /api/2.0/genie/spaces/:id/conversations/:id/messages',
      'POST /api/2.0/genie/spaces/:id/start-conversation',
    ]);
    notes.push('Genie requests seen by the fixture: ' + genieRequests().length);
    for (const n of notes) t.diagnostic(n);
    t.diagnostic('screenshots in ' + SHOTS + ': ' + shots.map((s) => path.basename(s)).join(', '));
  });
});
