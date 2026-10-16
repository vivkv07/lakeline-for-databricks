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
  if (!exe || !fs.existsSync(exe)) skip = 'Playwright Chromium is not installed (' + exe + '); this suite never downloads browsers';
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
    if (variant === 'chromium') opts.channel = 'chromium';
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
        text: [...a.querySelectorAll('.gp-text')].map((x) => x.textContent).join('\n'),
        headers: [...a.querySelectorAll('thead th')].map((th) => th.textContent),
        rows: [...a.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)),
        meta: (a.querySelector('.gp-table-meta') || {}).textContent || '',
        sqlOpen: a.querySelector('details.gp-sql') ? a.querySelector('details.gp-sql').open : null,
        error: (a.querySelector('.dcc-alert__title') || {}).textContent || '',
        suggested: [...a.querySelectorAll('.gp-suggest-list button')].map((b) => b.textContent),
      }))
    );

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

  it('reopening the panel shows the completed answer with a real table; the badge clears', { timeout: 60000 }, async () => {
    const p = await openPanel();
    const t = await poll(async () => {
      const list = await turns(p);
      return list.length === 1 && list[0].phase === 'done' ? list[0] : null;
    }, { label: 'completed turn after reopening' });
    const a = fixtureData.genieAnswer(fixtureData.GENIE_SPACES[0].space_id);
    assert.equal(t.chip, 'Answer ready');
    assert.equal(t.text, a.text);
    assert.deepEqual(t.headers, ['region', 'revenue_usd', 'orders']);
    assert.deepEqual(t.rows, a.rows.map((r) => r.map((v) => (v === null ? 'null' : v))));
    assert.match(t.meta, /4 rows/);
    assert.equal(t.sqlOpen, false, 'SQL hidden behind Show SQL');
    assert.deepEqual(t.suggested, a.suggested);
    await poll(async () => (await sw.evaluate(() => chrome.action.getBadgeText({}))) === '', { timeout: 5000, label: 'badge cleared by the open panel' });
    await shot(p, '04-fixture-answer-light');
    await p.click('details.gp-sql > summary');
    assert.equal(await p.evaluate(() => document.querySelector('details.gp-sql pre code').textContent), a.sql);
    await shot(p, '05-fixture-answer-sql-light');
    // Follow-up from a suggested question, in the same Genie conversation.
    const before = fx.state.genie.followUps;
    await p.click('.gp-suggest-list button');
    await poll(async () => {
      const list = await turns(p);
      return list.length === 2 && list[1].phase === 'done';
    }, { timeout: 40000, label: 'follow-up answered' });
    assert.equal(fx.state.genie.followUps, before + 1);
    await p.emulateMedia({ colorScheme: 'dark' });
    await sleep(200);
    await shot(p, '06-fixture-answer-dark');
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
      assert.equal(t.rows.length, 5);
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
