#!/usr/bin/env node
/*
 * Launch-video captures: the REAL extension (Chrome Web Store build, test copy) in headless
 * Chromium against the SYNTHETIC Northpeak Retail workspaces (local/video/video-server.mjs).
 * Every product pixel is the real UI; numbers come from the DOM at capture time.
 *
 *   node local/video/capture.mjs [--only 03,04,...] [--out dist/video/captures]
 *
 * Output: dist/video/captures/<scene>/<theme>/<state>.png (device scale factor 2) with a
 * manifest.json per scene/theme (states, viewports, element boxes in CSS px, exact visible texts)
 * and dist/video/captures/index.json (scenes, states, story numbers, environment, checks).
 * See local/video/README.md for what is real, what is synthetic and what is a capture shim.
 */
import fs from 'node:fs';
import path from 'node:path';
import { startVideoServer, VIDEO_OAUTH_CLIENT_ID, OTHER_HOSTS } from './video-server.mjs';
import { WORKSPACES, QUESTIONS, COMPANY, RESOURCES } from './story-data.mjs';
import { ROOT, buildTestCopy, launchBrowser, sendOk, poll, sleep, tempDir } from './browser.mjs';

const argv = process.argv.slice(2);
const argOf = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const OUT = path.resolve(ROOT, argOf('--out') || 'dist/video/captures');
const ONLY = argOf('--only') ? new Set(argOf('--only').split(',').map((s) => s.trim())) : null;
const want = (id) => !ONLY || ONLY.has(id);
const P = WORKSPACES.prod;
const A = WORKSPACES.analytics;
const DEV = WORKSPACES.dev;
const STAGE = WORKSPACES.stage;
// Framing (notes/VIDEO.md): 16:9 pages; in side-panel scenes page 1180 + panel 420 = 1600, as Chrome lays them out.
const PAGE_VP = { width: 1600, height: 900 };
const DOCKED_VP = { width: 1180, height: 900 };
const PANEL_VP = { width: 420, height: 900 };
const MONITOR_VP = { width: 380, height: 600 };
const SQL_WAIT = 120000;
const log = (...a) => process.stdout.write('[capture] ' + a.join(' ') + '\n');

/* ------------------------------------------------------------------ manifests */

const scenes = new Map(); // id → {id, title, storyboard, themes: {light: [], dark: []}, notes: []}
const story = {}; // numbers and labels read from the UI, for index.json
const checks = []; // {name, ok, detail}

function scene(id, title, storyboard) {
  if (!scenes.has(id)) {
    fs.rmSync(path.join(OUT, id), { recursive: true, force: true });
    scenes.set(id, { id, title, storyboard, themes: {}, notes: [], extra: {} });
  }
  return scenes.get(id);
}

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  log((ok ? 'CHECK ok   ' : 'CHECK FAIL ') + name + (detail ? ' · ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 200) : ''));
}

function fileFor(sceneId, theme, stateId) {
  const dir = path.join(OUT, sceneId, theme);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, stateId + '.png');
}

/*
 * Primary focus box per state (for the composer's push-ins) and an ordered focus path (pan
 * targets). First rule whose pattern matches "<scene>/<state>" wins; the first candidate that
 * exists in the state's boxes becomes `focus`.
 */
const FOCUS_RULES = [
  [/^03-connect\/0[12]/, ['connectButton'], ['tabStatus', 'connectButton']],
  [/^03-connect\/03/, ['connectedLine'], ['connectedLine', 'askGenie']],
  [/^04-banner\/.*-7d/, ['amount'], ['amount', 'meta', 'period7']],
  [/^04-banner\/.*-30d/, ['amount'], ['amount', 'meta', 'period30', 'badgeNightly']],
  [/^04-banner\/.*-90d/, ['amount'], ['amount', 'meta', 'period90']],
  [/^05-run-costs\/01/, ['spikeRow'], ['titleBadge', 'spikeRow', 'spikeBadge']],
  [/^05-run-costs\/0[23]/, ['titleBadge'], ['pageTitle', 'titleBadge', 'tasks', 'firstRunBadge']],
  [/^06-queries-sizing\/01/, ['heavyEstimate'], ['note', 'heavyRow', 'heavyEstimate']],
  [/^06-queries-sizing\/02/, ['tooltip'], ['heavyEstimate', 'tooltip']],
  [/^06-queries-sizing\/03/, ['listbox'], ['triggerPreview', 'listbox', 'previewLarge', 'previewXLarge']],
  [/\/0[12]-products-hover|\/05-calendar-spike-hover/, ['hoveredMark', 'tooltip'], ['hoveredMark', 'tooltip', 'inspect']],
  [/\/01-products/, ['chart'], ['tabs', 'chart']],
  [/\/03-top-drivers/, ['firstRow', 'chart'], ['tabs', 'firstRow', 'chart']],
  [/\/04-calendar/, ['spikeCell', 'chart'], ['chart', 'spikeCell']],
  [/^09-genie\/page-prod/, ['banner'], ['topNav', 'banner', 'pageTitle']],
  [/^09-genie\/page-analytics/, ['topNav'], ['topNav', 'banner']],
  [/^09-genie\/page-video/, ['player'], ['player', 'progress']],
  [/^09-genie\/page-doc-0/, ['notes'], ['paper', 'notes']],
  [/^09-genie\/page-doc-1/, ['paste1'], ['notes', 'paste1']],
  [/^09-genie\/page-doc-2/, ['paste2'], ['appendix', 'paste2']],
  [/^09-genie\/popup/, ['askGenie'], ['tabStatus', 'askGenie']],
  [/panel-01/, ['emptyState'], ['agentSelect', 'workspaceSelect', 'emptyState']],
  [/panel-0?2-|panel-12-/, ['composer'], ['agentSelect', 'composer']],
  [/panel-03-|panel-04-|panel-15-/, ['lastChip'], ['lastTurn', 'lastChip']],
  [/panel-05-|panel-07b-/, ['lastChart'], ['lastAnswerText', 'lastChart']],
  [/panel-05b-/, ['tooltip'], ['firstBar', 'tooltip']],
  [/panel-06-/, ['lastTable'], ['lastSegmented', 'lastTable']],
  [/panel-07-/, ['sqlCode'], ['lastSql', 'sqlCode']],
  [/panel-08-/, ['lastMenuList'], ['lastMenu', 'lastMenuList']],
  [/panel-09-/, ['copyAnswer', 'lastMenuList'], ['lastMenu', 'copyAnswer']],
  [/panel-10-/, ['copyTable', 'lastMenuList'], ['lastMenu', 'copyTable']],
  [/panel-11-/, ['agentSelect'], ['agentSelect', 'emptyState']],
  [/panel-13-/, ['kpis'], ['lastAnswerText', 'kpis']],
  [/panel-14-/, ['workspaceSelect'], ['workspaceSelect', 'agentSelect', 'emptyState']],
  [/panel-16-/, ['lastChart'], ['lastAnswerText', 'lastChart']],
  [/^10-monitor\/01/, ['runs'], ['header', 'runs']],
  [/^10-monitor\/0[24]/, ['failedRun'], ['header', 'failedRun']],
  [/^10-monitor\/03/, ['warehouses'], ['warehouses', 'clusters']],
  [/^11-colors\/.*(default|colored)/, ['topNav'], ['topNav', 'switcher']],
  [/^11-colors\/.*-open/, ['url'], ['panel', 'url', 'preview']],
  [/^11-colors\/.*-chosen/, ['preview'], ['presets', 'hex', 'preview', 'contrast']],
  [/^11-colors\/.*-saved/, ['status'], ['save', 'status']],
];

function record(sceneId, theme, state) {
  const s = scenes.get(sceneId);
  const key = sceneId + '/' + state.id;
  const rule = FOCUS_RULES.find(([re]) => re.test(key));
  const boxes = state.boxes || {};
  if (rule) {
    state.focus = rule[1].find((b) => boxes[b]) || null;
    state.focusPath = rule[2].filter((b) => boxes[b]);
  }
  if (!state.focus) check('focus box present for ' + key, false, Object.keys(boxes));
  (s.themes[theme] || (s.themes[theme] = [])).push(Object.assign({ dpr: 2, theme }, state));
}

/** Bounding boxes (CSS px, viewport-relative) of named selectors that exist and are visible. */
async function boxesOf(page, named) {
  const out = {};
  for (const [name, sel] of Object.entries(named)) {
    try {
      const loc = page.locator(sel).first();
      if (!(await loc.count())) continue;
      const b = await loc.boundingBox();
      if (b && b.width > 0 && b.height > 0) out[name] = { x: round1(b.x), y: round1(b.y), width: round1(b.width), height: round1(b.height) };
    } catch (_) {
      /* not on this page */
    }
  }
  return out;
}

/** Visible texts (innerText, as rendered) of named selectors (first match). */
async function textsOf(page, named) {
  const out = {};
  for (const [name, sel] of Object.entries(named)) {
    try {
      const loc = page.locator(sel).first();
      if (!(await loc.count())) continue;
      out[name] = clean(await loc.innerText());
    } catch (_) {
      /* not on this page */
    }
  }
  return out;
}

const round1 = (n) => Math.round(n * 10) / 10;
/** First dollar amount in a label ('$1,480.61 est.' → 1480.61), or NaN. */
const dollars = (t) => {
  const m = /\$([\d,]+(?:\.\d+)?)/.exec(String(t || ''));
  return m ? Number(m[1].replace(/,/g, '')) : NaN;
};
const clean = (t) => String(t == null ? '' : t).replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').trim();

async function snap(page, sceneId, theme, stateId, o) {
  const file = fileFor(sceneId, theme, stateId);
  await page.screenshot({ path: file, fullPage: false, animations: 'disabled', caret: o.caret || 'hide' });
  const vp = page.viewportSize();
  const boxes = o.boxes ? await boxesOf(page, o.boxes) : {};
  const texts = o.texts ? await textsOf(page, o.texts) : {};
  record(sceneId, theme, Object.assign({ id: stateId, file: path.relative(path.join(OUT, sceneId, theme), file), kind: o.kind || 'page', viewport: vp, description: o.description, boxes: Object.assign(boxes, o.extraBoxes || {}), texts: Object.assign(texts, o.extraTexts || {}) }, o.meta || {}));
  log('shot', sceneId + '/' + theme + '/' + stateId);
  return { boxes, texts };
}

/* ------------------------------------------------------------------ page helpers */

const wsUrl = (W, p, theme) => W.origin + p + (p.includes('?') ? '&' : '?') + 'o=' + W.workspaceId + (theme ? '&np_theme=' + theme : '');

async function gotoWs(page, W, p, theme = 'light') {
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(wsUrl(W, p, theme));
  await page.waitForFunction(() => window.__fixture && document.querySelector('main [data-fx-page]:not([data-fx-page="boot"])'), null, { timeout: 20000 });
}

const BANNER = '[data-dcc="banner"]';

/** Banner settled for `days`: amount shown, no skeleton, meta names the period. */
async function bannerReady(page, days) {
  return poll(
    async () =>
      page.evaluate((d) => {
        const host = document.querySelector('[data-dcc="banner"]');
        const r = host && host.shadowRoot;
        if (!r) return null;
        const amount = r.querySelector('.amount.num');
        const meta = r.querySelector('.meta');
        if (!amount || r.querySelector('.skeleton') || !meta || !new RegExp('Last ' + d + ' days').test(meta.textContent)) return null;
        return { amount: amount.textContent, meta: meta.textContent, theme: host.getAttribute('data-dcc-theme') };
      }, days),
    { timeout: SQL_WAIT, label: 'banner at ' + days + ' days' }
  );
}

/** Banner texts as displayed (innerText applies the meta's uppercase transform). */
async function bannerTexts(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-dcc="banner"]');
    const r = host.shadowRoot;
    const q = (s) => r.querySelector(s);
    const t = (el) => (el ? el.innerText.replace(/ /g, ' ').trim() : null);
    const raw = (el) => (el ? el.textContent.replace(/ /g, ' ').trim() : null);
    const notes = [...r.querySelectorAll('.note, .disclaimer')].map((n) => n.innerText.trim());
    return {
      amount: t(q('.amount.num')),
      qualifier: t(q('.qual')),
      meta: t(q('.meta')),
      metaSource: raw(q('.meta')),
      periodPressed: t(q('[data-k^="period-"][aria-pressed="true"]')),
      notes,
      theme: host.getAttribute('data-dcc-theme'),
    };
  });
}

/** All inline badges settled (no pending), at least `min` with amounts. */
async function badgesReady(page, min, extra) {
  return poll(
    async () =>
      page.evaluate(
        ([m, sel]) => {
          const b = [...document.querySelectorAll('[data-dcc="inline"]')];
          if (b.some((x) => /pending/.test(x.className))) return null;
          const priced = b.filter((x) => /\$/.test(x.textContent));
          if (priced.length < m) return null;
          if (sel && !document.querySelector(sel)) return null;
          return b.map((x) => ({ key: x.getAttribute('data-dcc-key'), kind: x.getAttribute('data-dcc-kind'), text: x.textContent, aria: x.getAttribute('aria-label') || '' }));
        },
        [min, extra || null]
      ),
    { timeout: SQL_WAIT, label: min + ' priced badges' }
  );
}

async function topNavInfo(page) {
  return page.evaluate(() => {
    const n = document.querySelector('nav[aria-label="Top Navigation"]');
    const cs = getComputedStyle(n);
    return { themed: n.hasAttribute('data-dcc-themed'), background: cs.backgroundColor, color: cs.color };
  });
}

/** Wait until no SQL statement has been sent for `quietMs`. */
async function sqlQuiet(api, quietMs = 1500, timeout = 60000) {
  const n = () => api.filter((r) => r.method === 'POST' && r.path === '/api/2.0/sql/statements').length;
  let last = n();
  let since = Date.now();
  const t0 = Date.now();
  while (Date.now() - since < quietMs) {
    await sleep(250);
    if (n() !== last) {
      last = n();
      since = Date.now();
    }
    if (Date.now() - t0 > timeout) break;
  }
}

/** Popup at 360 px wide and its natural content height. */
async function fitPopup(popup) {
  await popup.setViewportSize({ width: 360, height: 200 });
  await sleep(100);
  const h = await popup.evaluate(() => Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)));
  await popup.setViewportSize({ width: 360, height: h });
  await sleep(150);
  return h;
}

/* ------------------------------------------------------------------ real side panel (CDP) */

/**
 * The browser's real side panel page (ui/sidepanel.html opened by chrome.sidePanel.open from the
 * popup's real "Ask Genie" click) driven over the Chrome DevTools Protocol: trusted mouse and
 * keyboard input, screenshots at 420×900 with device scale factor 2 (Emulation override).
 */
async function attachRealPanel(ctx, anyPage) {
  const cdp = await ctx.newCDPSession(anyPage);
  const target = await poll(async () => (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && /\/ui\/sidepanel\.html/.test(t.url)), { timeout: 15000, label: 'side panel target' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let id = 0;
  const pending = new Map();
  cdp.on('Target.receivedMessageFromTarget', (e) => {
    if (e.sessionId !== sessionId) return;
    const m = JSON.parse(e.message);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      const timer = setTimeout(() => {
        pending.delete(i);
        reject(new Error('CDP ' + method + ' timed out'));
      }, 30000);
      pending.set(i, (m) => {
        clearTimeout(timer);
        if (m.error) reject(new Error('CDP ' + method + ': ' + m.error.message));
        else resolve(m.result);
      });
      cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: i, method, params }) }).catch(reject);
    });
  const evaluate = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('panel eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  };
  const fn = (f, ...args) => evaluate('(' + f.toString() + ')(...' + JSON.stringify(args) + ')');
  const panel = {
    targetId: target.targetId,
    call,
    evaluate,
    fn,
    async setup(theme) {
      await call('Page.enable');
      await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: PANEL_VP.width, height: PANEL_VP.height, deviceScaleFactor: 2, mobile: false });
      await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await call('Emulation.setFocusEmulationEnabled', { enabled: true });
      await sleep(300);
    },
    async center(sel) {
      return fn((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        el.scrollIntoView({ block: 'nearest' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, sel);
    },
    async click(sel) {
      const c = await poll(() => panel.center(sel), { timeout: 15000, label: 'panel element ' + sel });
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
      await sleep(150);
    },
    /** Trusted mouse-wheel scroll over the conversation (deltaY < 0 scrolls up). */
    async wheel(deltaY) {
      const c = await panel.center('#thread');
      await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: Math.min(c.y, PANEL_VP.height / 2), deltaX: 0, deltaY });
      await sleep(350);
    },
    async hover(sel) {
      const c = await panel.center(sel);
      if (c) await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
      await sleep(150);
    },
    async type(text) {
      await call('Input.insertText', { text });
      await sleep(100);
    },
    async press(key) {
      const codes = { Enter: 13, Escape: 27 };
      const base = { key, code: key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key] };
      await call('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
      if (key === 'Enter') await call('Input.dispatchKeyEvent', Object.assign({ type: 'char', text: '\r' }, base));
      await call('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
      await sleep(100);
      // Like moving on to other work: the composer keeps no text caret in later frames.
      if (key === 'Enter') await fn(() => document.activeElement && document.activeElement.blur());
    },
    /** Pick an option of a native <select> (the dropdown itself is OS UI and is never drawn). */
    async select(sel, label) {
      await fn((s) => document.querySelector(s).focus(), sel);
      const ok = await fn(
        (s, l) => {
          const el = document.querySelector(s);
          const opt = [...el.options].find((o) => o.textContent === l || o.value === l);
          if (!opt) return false;
          el.value = opt.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        },
        sel,
        label
      );
      if (!ok) throw new Error('no option ' + label + ' in ' + sel);
      await fn((s) => document.querySelector(s).blur(), sel);
      await sleep(300);
    },
    async screenshot(file) {
      const r = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    async boxes(named) {
      return fn((n) => {
        const out = {};
        for (const [k, s] of Object.entries(n)) {
          const el = document.querySelector(s);
          if (!el || el.closest('[hidden]')) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) out[k] = { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
        }
        return out;
      }, named);
    },
    async texts(named) {
      return fn((n) => {
        const out = {};
        for (const [k, s] of Object.entries(n)) {
          const el = document.querySelector(s);
          if (el) out[k] = el.innerText.replace(/ /g, ' ').trim();
        }
        return out;
      }, named);
    },
    turns: () =>
      fn(() =>
        [...document.querySelectorAll('article.gp-turn')].map((a) => ({
          phase: a.getAttribute('data-phase'),
          chip: (a.querySelector('.gp-chip') || {}).textContent || '',
          question: (a.querySelector('.gp-q') || {}).textContent || '',
          chart: a.querySelector('.gp-kpis') ? 'kpi' : a.querySelector('.gp-fig') ? a.querySelector('.gp-fig').getAttribute('data-chart') : null,
          kpis: [...a.querySelectorAll('.gp-kpi-value')].map((x) => x.textContent),
        }))
      ),
    close: () => cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}),
  };
  return panel;
}

async function panelSnap(panel, sceneId, theme, stateId, o) {
  const file = fileFor(sceneId, theme, stateId);
  await sleep(o.settle || 250);
  await panel.screenshot(file);
  const boxes = o.boxes ? await panel.boxes(o.boxes) : {};
  const texts = o.texts ? await panel.texts(o.texts) : {};
  record(sceneId, theme, Object.assign({ id: stateId, file: path.basename(file), kind: 'sidepanel', source: 'real side panel (chrome.sidePanel), driven over CDP', viewport: PANEL_VP, description: o.description, boxes, texts: Object.assign(texts, o.extraTexts || {}) }, o.meta || {}));
  log('shot', sceneId + '/' + theme + '/' + stateId + ' (real side panel)');
  return { boxes, texts };
}

const PANEL_BOXES = {
  workspaceSelect: '#ws',
  agentSelect: '#space',
  composer: '#composer',
  question: '#question',
  send: '#send',
  lastTurn: 'article.gp-turn:last-of-type',
  lastChip: 'article.gp-turn:last-of-type .gp-chip',
  lastAnswerText: 'article.gp-turn:last-of-type .gp-md',
  lastChart: 'article.gp-turn:last-of-type .gp-view[data-view="chart"]:not([hidden])',
  lastTable: 'article.gp-turn:last-of-type .gp-view[data-view="table"]:not([hidden])',
  lastSegmented: 'article.gp-turn:last-of-type .gp-seg',
  lastSql: 'article.gp-turn:last-of-type details.gp-sql',
  lastMenu: 'article.gp-turn:last-of-type details.gp-menu',
  lastMenuList: 'article.gp-turn:last-of-type details.gp-menu[open] .gp-menu-list',
  copyAnswer: 'article.gp-turn:last-of-type details.gp-menu[open] [data-copy]',
  copyTable: 'article.gp-turn:last-of-type details.gp-menu[open] [data-copy-table]',
  sqlCode: 'article.gp-turn:last-of-type details.gp-sql[open] pre',
  firstBar: 'article.gp-turn:last-of-type .gp-marks [tabindex]',
  tooltip: '.gp-tip:not([hidden])',
  kpis: 'article.gp-turn:last-of-type .gp-kpis',
  emptyState: '.gp-empty',
};
const PANEL_TEXTS = {
  workspace: '#ws option:checked',
  agent: '#space option:checked',
  agentDescription: '#space-desc',
  question: 'article.gp-turn:last-of-type .gp-q',
  chip: 'article.gp-turn:last-of-type .gp-chip',
  step: 'article.gp-turn:last-of-type .gp-step',
  answer: 'article.gp-turn:last-of-type .gp-md',
  resultTitle: 'article.gp-turn:last-of-type .gp-result-title',
  resultDescription: 'article.gp-turn:last-of-type .gp-result-desc',
  rowCount: 'article.gp-turn:last-of-type .gp-count',
  emptyTitle: '#empty-title',
};

/* ------------------------------------------------------------------ main */

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const api = [];
  const server = await startVideoServer({ genieStepPolls: 2, onApiRequest: (r) => api.push(r), log: (l) => log('server: ' + l) });
  const tmp = tempDir('lakeline-video-capture-');
  const extDir = path.join(tmp, 'ext');
  fs.mkdirSync(extDir);
  const { manifest } = await buildTestCopy(extDir, Object.values(WORKSPACES).map((w) => w.origin));
  const { ctx, sw, extId, ua } = await launchBrowser({ extDir, resolverRules: server.resolverRules(), tmp });
  const ext = (p) => 'chrome-extension://' + extId + '/' + p;
  log('browser', (/(HeadlessChrome|Chrome)\/[\d.]+/.exec(ua) || ['?'])[0], 'extension', extId, 'server port', server.port);
  const env = {
    browser: (/(HeadlessChrome|Chrome)\/[\d.]+/.exec(ua) || [ua])[0],
    playwright: JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/playwright/package.json'), 'utf8')).version,
    extensionBuild: 'Chrome Web Store build (scripts/package.mjs storeEntries: no key, store flags) + capture-only manifest host_permissions/notifications and ui/capture-shim.js',
    extensionVersion: manifest.version,
    hostResolverRules: server.resolverRules().replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>'),
    datasetToday: server.apps.prod.dataset.today,
    capturedAt: new Date().toISOString(),
  };
  try {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);

    /* ---------------------------------------------------------------- network proof */
    const prodTab = await ctx.newPage();
    await gotoWs(prodTab, P, '/jobs', 'light');
    const before = api.length;
    const swFetch = await sw.evaluate(async (o) => {
      const r = await fetch(o.origin + '/api/2.0/sql/warehouses', { headers: { Authorization: 'Bearer ' + o.token } });
      return { status: r.status, body: (await r.text()).slice(0, 60) };
    }, { origin: P.origin, token: P.token });
    check('page load reaches the local server via --host-resolver-rules', /Jobs & Pipelines/.test(await prodTab.locator('main h1').first().innerText()), prodTab.url());
    check('service-worker fetch reaches the local server via --host-resolver-rules', swFetch.status === 200 && api.length > before, swFetch);
    env.network = { pageUrl: prodTab.url(), serviceWorkerFetch: swFetch.status };

    const opt = await ctx.newPage();
    await opt.goto(ext('ui/options.html'));
    await sendOk(opt, { type: 'page:updateSettings', patch: { mode: 'connected', periodDays: 30, showCosts: true } });

    // One-time admin setup: the account's OAuth app connection (client ID) is saved by the first
    // Sign in with Databricks (here on northpeak-dev, through the mock OIDC provider).
    const dev1 = await sendOk(opt, { type: 'connect:oneClick', url: wsUrl(DEV, '/'), clientId: VIDEO_OAUTH_CLIENT_ID });
    check('admin one-time OAuth setup (mock OIDC) on northpeak-dev', dev1.connected === true, dev1);
    // analytics, dev and stage use the fake per-workspace tokens (PAT) through the real router.
    for (const W of [A, DEV, STAGE]) {
      await sendOk(opt, { type: 'admin:setPat', origin: W.origin, token: W.token });
      const saved = await sendOk(opt, { type: 'admin:saveConnection', connection: { origin: W.origin, workspaceId: W.workspaceId, authMode: 'pat', priceTable: 'system.billing.list_prices', warehouse: { mode: 'auto' } } });
      log('connected', W.name, 'warehouse', saved.warehouse.resolvedName || saved.warehouse.resolvedId);
    }
    // Workspace colors through the real appearance storage: prod red, analytics blue.
    const setColors = async (entries) => {
      const value = { version: 1, entries: {} };
      for (const [W, color] of entries) value.entries[W.origin + '|' + W.workspaceId] = { color, savedAt: Date.now() };
      await opt.evaluate((v) => chrome.storage.local.set({ 'dcc.appearance': v }), value);
    };
    await setColors([[P, P.color], [A, A.color]]);

    /* ---------------------------------------------------------------- 03 connect */
    if (want('03')) {
      const S = '03-connect';
      scene(S, 'One-click connect', 'Popup on a prod workspace tab: "Connect this workspace", click, then Connected (workspace · warehouse).');
      await gotoWs(prodTab, P, '/jobs', 'light');
      const popup = await ctx.newPage();
      await popup.emulateMedia({ colorScheme: 'light' });
      await popup.goto(ext('ui/popup.html?captureTab=' + encodeURIComponent(P.origin)));
      await poll(async () => /Connect this workspace/.test(await popup.locator('#connect-btn').innerText()), { label: 'Connect this workspace' });
      await fitPopup(popup);
      const PB = { header: '.pp-header', tabStatus: '#tab-status', connectButton: '#connect-btn', askGenie: '#genie-open', otherSignIn: '#signin-alt' };
      const PT = { summary: '#mode-summary', host: '#tab-status .pp-host', status: '#tab-status .pp-line', connectButton: '#connect-btn', askGenie: '#genie-open' };
      await snap(popup, S, 'light', '01-popup-not-connected', { kind: 'popup', description: 'Popup on the northpeak-prod tab before connecting: "Not connected yet." and the primary "Connect this workspace" button.', boxes: PB, texts: PT });
      await popup.hover('#connect-btn');
      await snap(popup, S, 'light', '02-popup-connect-hover', { kind: 'popup', description: 'Same, pointer over "Connect this workspace" (hover state) just before the click.', boxes: PB, texts: PT });
      await popup.click('#connect-btn');
      await poll(async () => /Costs now show/.test(await popup.locator('#tab-status').innerText()), { timeout: 60000, label: 'connected line' });
      await popup.mouse.move(5, 5);
      await fitPopup(popup);
      const connected = await snap(popup, S, 'light', '03-popup-connected', {
        kind: 'popup',
        description: 'After one click (Sign in with Databricks, already set up for the account): "Connected · workspace … · BI Serverless. Costs now show on the page." Ask Genie becomes the primary action.',
        boxes: Object.assign({}, PB, { connectedLine: '#tab-status [data-connect-line]' }),
        texts: Object.assign({}, PT, { connectedLine: '#tab-status [data-connect-line]', status: '#tab-status .pp-line:not([data-connect-line])' }),
      });
      story.connectedLine = connected.texts.connectedLine;
      check('popup connected line names workspace and warehouse', /Connected · workspace 2208417036951642 · BI Serverless/.test(connected.texts.connectedLine || ''), connected.texts.connectedLine);
      scene(S).notes.push('The click runs the real one-click flow (connect:oneClick → chrome.identity.launchWebAuthFlow, authorization code + PKCE) against the video server\'s mock OIDC endpoint, which redirects straight back like an already signed-in user. The OAuth client ID was saved once before (account setup). After this scene the capture switches the prod connection to the fake personal access token so Genie and the monitor need no second consent.');
      scene(S).extra.oauth = server.oauthLog.slice();
      await popup.close();
    } else {
      await sendOk(opt, { type: 'connect:oneClick', url: wsUrl(P, '/'), clientId: VIDEO_OAUTH_CLIENT_ID });
    }
    // From here on: prod uses its fake PAT as well (Genie and monitor work without a second sign-in).
    await sendOk(opt, { type: 'admin:setPat', origin: P.origin, token: P.token });
    await sendOk(opt, { type: 'admin:saveConnection', connection: { origin: P.origin, workspaceId: P.workspaceId, authMode: 'pat', priceTable: 'system.billing.list_prices', warehouse: { mode: 'auto' } } });

    const BANNER_BOXES = {
      banner: BANNER + ' .bar',
      amount: BANNER + ' .amount',
      meta: BANNER + ' .meta',
      period7: BANNER + ' [data-k="period-7"]',
      period30: BANNER + ' [data-k="period-30"]',
      period90: BANNER + ' [data-k="period-90"]',
      exploreToggle: BANNER + ' [data-k="toggle"]',
      topNav: 'nav[aria-label="Top Navigation"]',
      pageTitle: 'main h1',
    };

    /* ---------------------------------------------------------------- 04 banner */
    if (want('04')) {
      const S = '04-banner';
      scene(S, 'Cost banner', 'Prod workspace (red top bar), banner with amount, change vs prior, freshness and basis; period 7 → 30 → 90.');
      await prodTab.bringToFront();
      await gotoWs(prodTab, P, '/jobs', 'light');
      await bannerReady(prodTab, 30);
      await badgesReady(prodTab, 7);
      const nav = await topNavInfo(prodTab);
      check('prod top bar is tinted red', nav.themed && nav.background === 'rgb(180, 35, 24)', nav);
      story.banner = {};
      let n = 1;
      for (const days of [7, 30, 90]) {
        await prodTab.locator(BANNER + ' [data-k="period-' + days + '"]').click();
        await bannerReady(prodTab, days);
        await badgesReady(prodTab, 7);
        await sqlQuiet(api);
        await prodTab.mouse.move(800, 895);
        const bt = await bannerTexts(prodTab);
        story.banner[days] = bt;
        const badges = await prodTab.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-dcc="inline"]')].map((b) => [b.closest('[role="row"]').querySelector('a').textContent, b.textContent])));
        await snap(prodTab, S, 'light', '0' + n++ + '-banner-' + days + 'd', {
          description: 'Jobs & Pipelines on northpeak-prod with the banner at ' + days + ' days: amount, change vs the prior ' + days + ' days, freshness, basis. Every job and pipeline has a ' + days + '-day badge.',
          boxes: Object.assign({}, BANNER_BOXES, { badgeNightly: '[data-fx-row="job-412"] [data-dcc="inline"]', badgeCustomer360: '[data-fx-row="job-418"] [data-dcc="inline"]' }),
          extraTexts: { amount: bt.amount, qualifier: bt.qualifier, meta: bt.meta, metaSource: bt.metaSource, periodPressed: bt.periodPressed, notes: bt.notes, badges },
          meta: { bannerTheme: bt.theme, topNav: nav },
        });
      }
      check('30-day change is +10–15 %', /\+1[0-5]% vs prior/i.test(story.banner[30].metaSource), story.banner[30].metaSource);
      await prodTab.locator(BANNER + ' [data-k="period-30"]').click();
      await bannerReady(prodTab, 30);
    }
    await sendOk(opt, { type: 'page:updateSettings', patch: { periodDays: 30 } });

    /* ---------------------------------------------------------------- 05 run costs */
    if (want('05')) {
      const S = '05-run-costs';
      scene(S, 'Run costs', 'nightly_sales_etl runs with a badge on every run (spike = the backfill), then customer_360_refresh with a job total that includes its pipeline.');
      const tv = server.apps.prod.templateValues;
      await prodTab.bringToFront();
      await gotoWs(prodTab, P, '/jobs/412/runs', 'light');
      await bannerReady(prodTab, 30);
      const badges = await badgesReady(prodTab, 10, '[data-dcc-kind="title"]');
      await sqlQuiet(api);
      const rows = await prodTab.evaluate(() => [...document.querySelectorAll('tr[data-fx-run]')].map((tr) => ({ run: tr.getAttribute('data-fx-run'), start: tr.cells[0].querySelector('a').textContent, launched: tr.cells[2].textContent, duration: tr.cells[3].textContent, badge: (tr.querySelector('[data-dcc="inline"]') || {}).textContent || null })));
      const spike = rows.find((r) => r.run === tv.BACKFILL_RUN);
      story.runs = { job: 'nightly_sales_etl', rows, spikeRun: spike, titleBadge: badges.find((b) => b.kind === 'title') };
      check('every nightly_sales_etl run row has a priced badge', rows.length === 9 && rows.every((r) => /\$/.test(r.badge || '')), rows.map((r) => r.badge));
      const amounts = rows.map((r) => dollars(r.badge));
      check('the backfill run is the most expensive run', spike && dollars(spike.badge) === Math.max(...amounts), spike);
      await prodTab.mouse.move(800, 895);
      const runBoxes = { pageTitle: 'main h1', titleBadge: 'main [data-dcc-kind="title"]', runsTable: 'table[aria-label="Job runs"]', runChart: '.np-runchart', spikeRow: 'tr[data-fx-run="' + tv.BACKFILL_RUN + '"]', spikeBadge: 'tr[data-fx-run="' + tv.BACKFILL_RUN + '"] [data-dcc="inline"]', spikeDuration: 'tr[data-fx-run="' + tv.BACKFILL_RUN + '"] td:nth-child(4)', banner: BANNER + ' .bar', topNav: 'nav[aria-label="Top Navigation"]' };
      for (const r of rows) runBoxes['badge_' + r.run] = 'tr[data-fx-run="' + r.run + '"] [data-dcc="inline"]';
      await snap(prodTab, S, 'light', '01-runs-list', {
        description: 'nightly_sales_etl, Runs tab: a cost badge on every run and the 30-day job total by the title. The manually launched backfill run (spike) costs far more than a nightly run.',
        boxes: runBoxes,
        extraTexts: { titleBadge: story.runs.titleBadge.text, titleBadgeAria: story.runs.titleBadge.aria, rows, spikeRun: spike },
        meta: { spikeRunId: tv.BACKFILL_RUN },
      });
      // customer_360_refresh detail: job total includes the triggered pipeline.
      await gotoWs(prodTab, P, '/jobs/418/runs', 'light');
      await bannerReady(prodTab, 30);
      const b2 = await badgesReady(prodTab, 7, '[data-dcc-kind="title"]');
      await sqlQuiet(api);
      const title = b2.find((b) => b.kind === 'title');
      const rows2 = await prodTab.evaluate(() => [...document.querySelectorAll('tr[data-fx-run]')].map((tr) => ({ run: tr.getAttribute('data-fx-run'), start: tr.cells[0].querySelector('a').textContent, badge: (tr.querySelector('[data-dcc="inline"]') || {}).textContent || null, aria: (tr.querySelector('[data-dcc="inline"]') || { getAttribute: () => '' }).getAttribute('aria-label') })));
      story.customer360 = { titleBadge: title.text, titleBadgeAria: title.aria, rows: rows2 };
      check('customer_360_refresh title total includes triggered pipeline updates', /pipeline updates it triggered/.test(title.aria), title.aria);
      await prodTab.mouse.move(800, 895);
      await snap(prodTab, S, 'light', '02-customer-360-detail', {
        description: 'customer_360_refresh: the title total (30 days) includes the cust360_dlt pipeline updates its refresh_cust360 task triggered; each run badge includes its triggered update.',
        boxes: { pageTitle: 'main h1', titleBadge: 'main [data-dcc-kind="title"]', tasks: '.np-tasks', runsTable: 'table[aria-label="Job runs"]', firstRunBadge: 'tr[data-fx-run] [data-dcc="inline"]', banner: BANNER + ' .bar', topNav: 'nav[aria-label="Top Navigation"]' },
        extraTexts: { titleBadge: title.text, titleBadgeAria: title.aria, rows: rows2 },
      });
      // Focus ring on the title badge (keyboard): shows it is a tooltip target (native title is not drawn headless).
      await prodTab.locator('main [data-dcc-kind="title"]').focus().catch(() => {});
      await snap(prodTab, S, 'light', '03-customer-360-title-focus', {
        description: 'Same page with keyboard focus on the title total badge (its tooltip text is in texts.titleBadgeAria; native tooltips are not drawn in headless captures).',
        boxes: { titleBadge: 'main [data-dcc-kind="title"]' },
        extraTexts: { titleBadge: title.text, titleBadgeAria: title.aria },
      });
    }

    /* ---------------------------------------------------------------- 06 queries and sizing */
    if (want('06')) {
      const S = '06-queries-sizing';
      scene(S, 'Queries and sizing', 'Query History with per-query estimates and the note; warehouse size picker with "≈ $X/h per cluster · DBU only".');
      await prodTab.bringToFront();
      await gotoWs(prodTab, P, '/sql/history', 'light');
      await bannerReady(prodTab, 30);
      const est = await poll(
        async () =>
          prodTab.evaluate(() => {
            const rows = [...document.querySelectorAll('tbody tr[data-fx-row]')].map((tr) => {
              const b = tr.querySelector('[data-dcc="estimates"][data-dcc-key]');
              return { row: tr.getAttribute('data-fx-row'), heavy: tr.hasAttribute('data-np-heavy'), status: b && b.getAttribute('data-dcc-status'), text: b && b.textContent, duration: tr.cells[2].firstChild && tr.cells[2].firstChild.textContent, user: tr.cells[5].textContent, warehouse: tr.cells[4].textContent };
            });
            return rows.length === 7 && rows.every((r) => r.status && r.status !== 'loading') ? rows : null;
          }),
        { timeout: SQL_WAIT, label: 'query estimates' }
      );
      await sqlQuiet(api);
      const note = await prodTab.evaluate(() => {
        const n = document.querySelector('[data-dcc="estimates"][role="note"]');
        return n ? n.innerText.trim() : null;
      });
      const heavy = est.find((r) => r.heavy);
      story.queries = { rows: est, heavy, note };
      check('every Query History row has an amount estimate', est.every((r) => r.status === 'ok' && /\$/.test(r.text)), est.map((r) => r.status + ' ' + r.text));
      check('the heavy BI query has the largest estimate', dollars(heavy.text) === Math.max(...est.map((r) => dollars(r.text))), heavy.text);
      await prodTab.mouse.move(800, 895);
      const qb = { note: '[data-dcc="estimates"][role="note"]', table: 'table[aria-label="Query history"]', heavyRow: 'tr[data-np-heavy]', heavyEstimate: 'tr[data-np-heavy] [data-dcc="estimates"][data-dcc-key]', heavyDuration: 'tr[data-np-heavy] td:nth-child(3)', banner: BANNER + ' .bar' };
      await snap(prodTab, S, 'light', '01-query-history', { description: 'Query History: one per-execution estimate in each Duration cell and the explanatory note under the heading. The heavy BI dashboard query (12m 48s) has the clear, largest estimate.', boxes: qb, extraTexts: { note, rows: est, heavyEstimate: heavy.text, heavyDuration: heavy.duration } });
      // At 900 px the tooltip under the heavy row would be cut off: scroll the page (the banner is sticky).
      await prodTab.evaluate(() => {
        const main = document.querySelector('main');
        const row = document.querySelector('tr[data-np-heavy]');
        main.scrollTop += row.getBoundingClientRect().top - 330;
      });
      await sleep(300);
      await prodTab.locator('tr[data-np-heavy] [data-dcc="estimates"][data-dcc-key]').hover();
      await sleep(400);
      const tip = await poll(async () => prodTab.evaluate(() => {
        const t = document.getElementById('dcc-est-tip');
        return t && !t.hidden ? t.innerText.trim() : null;
      }), { timeout: 5000, label: 'estimate tooltip' }).catch(() => null);
      check('estimate tooltip shows on hover', Boolean(tip), tip && tip.slice(0, 80));
      await snap(prodTab, S, 'light', '02-query-history-tooltip', { meta: { scrolledMainBy: await prodTab.evaluate(() => document.querySelector('main').scrollTop) }, description: 'Pointer over the heavy query\'s estimate: the estimate tooltip (allocated estimate, assumptions, basis).', boxes: Object.assign({}, qb, { tooltip: '#dcc-est-tip' }), extraTexts: { tooltip: tip, heavyEstimate: heavy.text } });
      await prodTab.mouse.move(800, 895);
      // Size picker.
      await gotoWs(prodTab, P, '/sql/warehouses/' + RESOURCES.prod.warehouses[0].id + '/edit', 'light');
      await bannerReady(prodTab, 30);
      const previews = await poll(
        async () =>
          prodTab.evaluate(() => {
            const opts = [...document.querySelectorAll('[role="option"]')].map((o) => ({ size: o.querySelector('span').textContent, hint: (o.querySelector('.np-hint') || {}).textContent, preview: (o.querySelector('[data-dcc]') || {}).textContent || null }));
            const trigger = document.querySelector('[role="combobox"]');
            const next = trigger && trigger.nextElementSibling;
            const tp = next && next.matches('[data-dcc]') ? next : null;
            return opts.length && opts.every((o) => o.preview && /\$/.test(o.preview)) ? { options: opts, trigger: tp ? tp.textContent : null } : null;
          }),
        { timeout: SQL_WAIT, label: 'size previews' }
      );
      await sqlQuiet(api);
      story.sizing = previews;
      await prodTab.mouse.move(1500, 895);
      await snap(prodTab, S, 'light', '03-size-picker', {
        description: 'Editing BI Serverless: the open cluster-size list shows "≈ $X/h per cluster · DBU only" for each size, from its DBU/h and the warehouse\'s current list price.',
        boxes: { listbox: '[role="listbox"]', trigger: '[role="combobox"]', optionLarge: '[role="option"][aria-selected="true"]', previewLarge: '[role="option"][aria-selected="true"] [data-dcc]', triggerPreview: '[role="combobox"] + [data-dcc]', optionXLarge: '[role="option"]:nth-child(5)', previewXLarge: '[role="option"]:nth-child(5) [data-dcc]', banner: BANNER + ' .bar' },
        extraTexts: previews,
      });
    }

    /* ---------------------------------------------------------------- 07 explorer + 08 theme flip */
    const explorerFlow = async (theme) => {
      const S = '07-explorer';
      scene(S, 'Cost Explorer', 'Explorer expanded: Products stacked bars → Top drivers (after Load) → Calendar heatmap with the spike flag. Light and dark.');
      await prodTab.bringToFront();
      await gotoWs(prodTab, P, '/jobs', theme);
      const bt = await bannerReady(prodTab, 30);
      check('banner picks ' + theme + ' tokens on the ' + theme + ' page', bt.theme === theme, bt.theme);
      await prodTab.locator(BANNER + ' [data-k="toggle"]').click();
      const tab = (id) => BANNER + ' [data-fk="tab:' + id + '"]';
      await poll(async () => (await prodTab.locator(BANNER + ' #dcc-panel [role="tab"]').count()) === 6, { timeout: 30000, label: 'explorer tabs' });
      await poll(async () => prodTab.evaluate(() => {
        const p = document.querySelector('[data-dcc="banner"]').shadowRoot.querySelector('#dcc-panel');
        return p && p.querySelector('svg') && !/Loading/.test(p.innerText);
      }), { timeout: SQL_WAIT, label: 'products chart' });
      await sqlQuiet(api);
      await prodTab.mouse.move(5, 895);
      const panelBoxes = { banner: BANNER + ' .bar', panel: BANNER + ' #dcc-panel', tabs: BANNER + ' #dcc-panel [role="tablist"]', chart: BANNER + ' #dcc-panel svg', inspect: BANNER + ' #dcc-panel .inspect', tooltip: BANNER + ' .tip:not([hidden])', topNav: 'nav[aria-label="Top Navigation"]' };
      const markBox = async (i) => {
        const b = await prodTab.locator(BANNER + ' #dcc-panel svg [tabindex]').nth(i).boundingBox();
        return b ? { hoveredMark: { x: round1(b.x), y: round1(b.y), width: round1(b.width), height: round1(b.height) } } : {};
      };
      const panelText = async () => prodTab.evaluate(() => document.querySelector('[data-dcc="banner"]').shadowRoot.querySelector('#dcc-panel').innerText.replace(/ /g, ' ').trim());
      await snap(prodTab, S, theme, '01-products', { description: 'Explorer, Products: stacked bars of daily cost by product for the 30-day period.', boxes: panelBoxes, extraTexts: { panel: await panelText() }, meta: { explorerTheme: bt.theme } });
      // Hover one bar (the backfill day) for the inspect line.
      const hovered = await prodTab.evaluate(() => {
        const r = document.querySelector('[data-dcc="banner"]').shadowRoot;
        const marks = [...r.querySelectorAll('#dcc-panel svg [tabindex]')];
        return marks.length;
      });
      if (hovered) {
        const marks = prodTab.locator(BANNER + ' #dcc-panel svg [tabindex]');
        // The day with the highest cost (from each mark's accessible label): the backfill day.
        const idx = await prodTab.evaluate(() => {
          const r = document.querySelector('[data-dcc="banner"]').shadowRoot;
          const m = [...r.querySelectorAll('#dcc-panel svg [tabindex]')];
          let best = 0;
          let bestCost = -1;
          m.forEach((el, i) => {
            const mm = /Cost: \$([\d,]+(?:\.\d+)?)/.exec(el.getAttribute('aria-label') || '');
            const c = mm ? Number(mm[1].replace(/,/g, '')) : -1;
            if (c > bestCost) (bestCost = c), (best = i);
          });
          return best;
        });
        await marks.nth(idx).hover();
        await sleep(300);
        await snap(prodTab, S, theme, '02-products-hover', { description: 'Pointer on the highest-cost day (the backfill day): the Explorer tooltip and inspect line show that day\'s cost by product, its prior-period comparison and the spike flag.', boxes: panelBoxes, extraBoxes: await markBox(idx), extraTexts: { inspect: await prodTab.evaluate(() => (document.querySelector('[data-dcc="banner"]').shadowRoot.querySelector('#dcc-panel .inspect') || {}).innerText || null) } });
        await prodTab.mouse.move(5, 895);
      }
      await prodTab.locator(tab('drivers')).click();
      await prodTab.locator(BANNER + ' [data-fk="load:exploreEntities"]').click();
      await poll(async () => (await prodTab.locator(BANNER + ' [data-fk="reload:exploreEntities"]').count()) === 1, { timeout: SQL_WAIT, label: 'Top drivers loaded' });
      await sqlQuiet(api);
      await prodTab.mouse.move(5, 895);
      const drivers = await panelText();
      await snap(prodTab, S, theme, '03-top-drivers', { description: 'Explorer, Top drivers (after Load): the jobs, pipelines and warehouses that drove the period\'s cost, with change vs prior.', boxes: Object.assign({}, panelBoxes, { firstRow: BANNER + ' #dcc-panel [data-fk^="row:"]' }), extraTexts: { panel: drivers } });
      await prodTab.locator(tab('calendar')).click();
      await sleep(600);
      const cal = await panelText();
      check('calendar flags a spike (' + theme + ')', /flagged as a positive spike/.test(cal), cal.slice(0, 300));
      const flaggedIdx = await prodTab.evaluate(() => [...document.querySelector('[data-dcc="banner"]').shadowRoot.querySelectorAll('#dcc-panel svg [tabindex]')].findIndex((el) => /spike/i.test(el.getAttribute('aria-label') || '')));
      const spikeCell = flaggedIdx >= 0 ? await prodTab.locator(BANNER + ' #dcc-panel svg [tabindex]').nth(flaggedIdx).boundingBox() : null;
      await snap(prodTab, S, theme, '04-calendar', { description: 'Explorer, Calendar: daily cost heatmap; the backfill day carries the ◆ spike flag (heuristic).', boxes: panelBoxes, extraBoxes: spikeCell ? { spikeCell: { x: round1(spikeCell.x), y: round1(spikeCell.y), width: round1(spikeCell.width), height: round1(spikeCell.height) } } : {}, extraTexts: { panel: cal } });
      const flagged = await prodTab.evaluate(() => {
        const r = document.querySelector('[data-dcc="banner"]').shadowRoot;
        const m = [...r.querySelectorAll('#dcc-panel svg [tabindex]')];
        const i = m.findIndex((el) => /spike/i.test(el.getAttribute('aria-label') || ''));
        return i;
      });
      if (flagged >= 0) {
        await prodTab.locator(BANNER + ' #dcc-panel svg [tabindex]').nth(flagged).hover();
        await sleep(300);
        const inspect = await prodTab.evaluate(() => (document.querySelector('[data-dcc="banner"]').shadowRoot.querySelector('#dcc-panel .inspect') || {}).innerText || null);
        await snap(prodTab, S, theme, '05-calendar-spike-hover', { description: 'Pointer on the flagged day: the tooltip and inspect line name the day, its cost and the spike threshold.', boxes: panelBoxes, extraBoxes: await markBox(flagged), extraTexts: { inspect } });
        if (theme === 'light') story.spikeDay = inspect;
        await prodTab.mouse.move(5, 895);
      }
      if (theme === 'light') story.explorer = { drivers, calendar: cal };
      // Scene 08 uses the same calendar view in both themes.
      const S8 = '08-theme-flip';
      scene(S8, 'Theme flip', 'The same Explorer view (Calendar) in light and dark; crossfade light → dark.');
      fs.mkdirSync(path.join(OUT, S8, theme), { recursive: true });
      for (const id of ['04-calendar', '01-products']) {
        const st = scenes.get(S).themes[theme].find((x) => x.id === id);
        fs.copyFileSync(path.join(OUT, S, theme, id + '.png'), path.join(OUT, S8, theme, id + '.png'));
        record(S8, theme, Object.assign({}, st, { description: st.description + ' (copy of 07-explorer/' + theme + '/' + id + '.png; same state as the other theme for the crossfade)' }));
      }
    };
    if (want('07')) {
      await explorerFlow('light');
      await explorerFlow('dark');
    }

    /* ---------------------------------------------------------------- 09 Genie (dark) */
    if (want('09')) await genieScene({ ctx, sw, ext, opt, prodTab, server, api });

    /* ---------------------------------------------------------------- 10 monitor (dark) */
    if (want('10')) await monitorScene({ ctx, sw, ext, opt, server });

    /* ---------------------------------------------------------------- 11 colors (light) */
    if (want('11')) await colorsScene({ ctx, ext, opt, setColors });

    /* ---------------------------------------------------------------- privacy checks */
    const SENT = 'SENTINEL_SQL_TEXT_MUST_NEVER_BE_READ';
    check('no request body contained the SQL-text sentinel', api.every((r) => !String(r.body || '').includes(SENT)), api.length + ' requests');
    check('no statement selected statement_text', api.filter((r) => r.path === '/api/2.0/sql/statements').every((r) => !/statement_text/i.test(r.body)), null);
    env.apiRequests = api.length;
    env.sqlStatements = api.filter((r) => r.method === 'POST' && r.path === '/api/2.0/sql/statements').length;
  } finally {
    writeManifests(env);
    await ctx.close().catch(() => {});
    await server.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ scene 09 */

async function genieScene({ ctx, sw, ext, opt, prodTab, server, api }) {
  const S = '09-genie';
  const T = 'dark';
  scene(S, 'Ask Genie: work while you wait', 'Real side panel next to the dark prod workspace; ask, switch to a video tab while Genie works, the answer lands; copy answer and table into a doc; switch agent and workspace.');
  const sc = scene(S);
  sc.extra.pairing = [];
  const pair = (panelState, pageState, note) => sc.extra.pairing.push({ panel: panelState, page: pageState, note });

  // Main pages, dark: prod (red top bar) at full and docked width.
  await prodTab.bringToFront();
  await gotoWs(prodTab, P, '/jobs', T);
  await bannerReady(prodTab, 30);
  await badgesReady(prodTab, 7);
  await sqlQuiet(api);
  const pageBoxes = { banner: BANNER + ' .bar', topNav: 'nav[aria-label="Top Navigation"]', pageTitle: 'main h1' };
  await prodTab.mouse.move(5, 895);
  for (const [vp, suffix] of [[PAGE_VP, ''], [DOCKED_VP, '-docked']]) {
    await prodTab.setViewportSize(vp);
    await sleep(500);
    await snap(prodTab, S, T, 'page-prod-jobs' + suffix, { description: 'northpeak-prod Jobs & Pipelines in dark mode (red top bar), ' + (suffix ? 'docked width (the side panel takes the other 420 px)' : 'full width') + '.', boxes: pageBoxes, extraTexts: { banner: await bannerTexts(prodTab) } });
  }
  await prodTab.setViewportSize(PAGE_VP);

  // The other tabs live in the same browser window as the prod tab (tab switches, not windows).
  const prodInfo = await sw.evaluate(async (origin) => (await chrome.tabs.query({ url: origin + '/*' })).map((t) => ({ id: t.id, windowId: t.windowId }))[0], P.origin);
  const openTab = async (url) => {
    const pagePromise = ctx.waitForEvent('page', { timeout: 20000 });
    const tabId = await sw.evaluate(async ([u, w]) => (await chrome.tabs.create({ url: u, windowId: w, active: false })).id, [url, prodInfo.windowId]);
    const page = await pagePromise;
    await page.waitForLoadState('load');
    await page.emulateMedia({ colorScheme: T });
    return { page, tabId };
  };
  const activate = async (tabId) => {
    await sw.evaluate(async (id) => chrome.tabs.update(id, { active: true }), tabId);
    await sleep(400);
  };
  // The service worker sees tab IDs (not URLs) of non-workspace tabs, so compare IDs.
  const activeTabId = async () => sw.evaluate(async (w) => ((await chrome.tabs.query({ active: true, windowId: w }))[0] || {}).id, prodInfo.windowId);
  const video = await openTab('https://' + OTHER_HOSTS.videos + '/watch/incremental-pipelines?t=768&d=2472&state=playing');
  const doc = await openTab('https://' + OTHER_HOSTS.docs + '/d/weekly-cost-review');
  const noExtension = await video.page.evaluate(() => !document.querySelector('[data-dcc]'));
  check('the extension does not run on the video page (not a workspace)', noExtension, video.page.url());

  // Real side panel: the popup's "Ask Genie" (real click) opens it for this window.
  await activate(prodInfo.id);
  const popup = await ctx.newPage();
  await popup.emulateMedia({ colorScheme: T });
  await popup.goto(ext('ui/popup.html?captureTab=' + encodeURIComponent(P.origin)));
  await poll(async () => /Ask Genie/.test(await popup.locator('#genie-open').innerText()), { label: 'Ask Genie' });
  await fitPopup(popup);
  await snap(popup, S, T, 'popup-ask-genie', { kind: 'popup', description: 'Popup on the prod tab (dark): Ask Genie is the primary action once connected.', boxes: { askGenie: '#genie-open', tabStatus: '#tab-status' }, texts: { askGenie: '#genie-open', status: '#tab-status .pp-line' } });
  await popup.click('#genie-open');
  await sleep(1500);
  const contexts = await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length);
  check('chrome.sidePanel.open from the popup click opened the real side panel', contexts === 1, { sidePanelContexts: contexts });
  await activate(prodInfo.id);
  const panel = await attachRealPanel(ctx, prodTab);
  await panel.setup(T);
  await poll(() => panel.fn(() => document.getElementById('ws').value && !document.getElementById('question').disabled && document.querySelector('.gp-empty')), { timeout: 30000, label: 'panel ready' });
  const init = await panel.texts(PANEL_TEXTS);
  if (init.workspace !== P.host) await panel.select('#ws', P.origin);
  if ((await panel.texts(PANEL_TEXTS)).agent !== 'Platform ops') await panel.select('#space', 'Platform ops');
  await poll(() => panel.fn(() => document.querySelector('.gp-empty') && !document.getElementById('question').disabled), { label: 'empty state' });
  await panelSnap(panel, S, T, 'panel-01-empty-prod', { description: 'Real side panel, dark: workspace northpeak-prod, Genie Agent "Platform ops", new conversation.', boxes: PANEL_BOXES, texts: PANEL_TEXTS });
  pair('panel-01-empty-prod', 'page-prod-jobs-docked');

  // Ask: type, send, Genie is working.
  await panel.click('#question');
  await panel.type(QUESTIONS.jobsIncrease);
  await panelSnap(panel, S, T, 'panel-02-typed', { description: 'The question typed in the composer: "' + QUESTIONS.jobsIncrease + '"', boxes: PANEL_BOXES, texts: Object.assign({ typed: '#question' }, PANEL_TEXTS), extraTexts: { typed: QUESTIONS.jobsIncrease } });
  pair('panel-02-typed', 'page-prod-jobs-docked');
  await panel.press('Enter');
  await poll(async () => {
    const t = await panel.turns();
    return t.length === 1 && t[0].phase === 'working' ? t : null;
  }, { timeout: 20000, interval: 100, label: 'Genie is working' });
  await panelSnap(panel, S, T, 'panel-03-working', { description: 'Sent: the turn shows "Genie is working" with the live step and elapsed time.', boxes: PANEL_BOXES, texts: PANEL_TEXTS, settle: 50 });
  pair('panel-03-working', 'page-prod-jobs-docked', 'Asked from the prod tab.');

  // Switch to the video tab while Genie works.
  await activate(video.tabId);
  const afterSwitch = { activeTabIsVideo: (await activeTabId()) === video.tabId, sidePanelContexts: await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length), panelPhase: (await panel.turns())[0].phase };
  check('side panel stays open after switching to the video tab', afterSwitch.sidePanelContexts === 1 && afterSwitch.activeTabIsVideo, afterSwitch);
  for (const [vp, suffix] of [[PAGE_VP, ''], [DOCKED_VP, '-docked']]) {
    await video.page.setViewportSize(vp);
    await sleep(200);
    await snap(video.page, S, T, 'page-video-1' + suffix, { description: 'The user switched to another tab: a synthetic recorded tech talk playing at 12:48 (' + (suffix ? 'docked width' : 'full width') + '). Neutral player, no brand UI.', boxes: { player: '.player', progress: '.bar', title: 'h1' }, texts: { title: 'h1', time: '#time' } });
  }
  const phaseOnVideo = await panel.turns();
  await panelSnap(panel, S, T, 'panel-04-working-other-tab', { description: 'The real side panel, still open beside the video tab, while Genie keeps working (' + (phaseOnVideo[0].chip || '') + ').', boxes: PANEL_BOXES, texts: PANEL_TEXTS, settle: 50, meta: { activeTabIsVideo: afterSwitch.activeTabIsVideo } });
  pair('panel-04-working-other-tab', 'page-video-1-docked', 'Panel still working while the video tab is active.');

  // The answer lands while the video tab is active.
  const t0 = Date.now();
  await poll(async () => {
    const t = await panel.turns();
    return t[0] && t[0].phase === 'done' && t[0].chart ? t : null;
  }, { timeout: 90000, interval: 200, label: 'answer' });
  const landed = { activeTabIsVideo: (await activeTabId()) === video.tabId, sidePanelContexts: await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length), badge: await sw.evaluate(() => chrome.action.getBadgeText({})), waitedMs: Date.now() - t0 };
  check('the answer arrived in the real side panel while the video tab was active', landed.activeTabIsVideo && landed.sidePanelContexts === 1, landed);
  sc.extra.sidePanelVerification = { afterSwitch, landed, note: 'Verified in the capture browser: chrome.runtime.getContexts reports one SIDE_PANEL context after chrome.tabs.update switched the window to the video tab, and the answer rendered in that same real side panel (read over CDP) while the video tab stayed active. The toolbar badge stays empty because the open panel already shows the answer.' };
  await video.page.goto('https://' + OTHER_HOSTS.videos + '/watch/incremental-pipelines?t=842&d=2472&state=playing');
  await video.page.emulateMedia({ colorScheme: T });
  for (const [vp, suffix] of [[PAGE_VP, ''], [DOCKED_VP, '-docked']]) {
    await video.page.setViewportSize(vp);
    await sleep(200);
    await snap(video.page, S, T, 'page-video-2' + suffix, { description: 'The talk has moved on (14:02) when the answer lands (' + (suffix ? 'docked width' : 'full width') + ').', boxes: { player: '.player', progress: '.bar', title: 'h1' }, texts: { title: 'h1', time: '#time' } });
  }
  await panel.wheel(-6000); // back to the top of the turn, as the user would
  const ans = await panelSnap(panel, S, T, 'panel-05-answer-bars', {
    description: 'The answer landed in the side panel while the video tab was active: Markdown text and a bar chart of the cost change by job and pipeline (last 7 days vs the 7 before).',
    boxes: Object.assign({ firstBar: 'article.gp-turn:last-of-type .gp-marks [tabindex]' }, PANEL_BOXES),
    texts: PANEL_TEXTS,
  });
  pair('panel-05-answer-bars', 'page-video-2-docked', 'Answer lands while the video tab is active.');
  story.genie = { jobsIncrease: { answer: ans.texts.answer, title: ans.texts.resultTitle } };
  // Hover the first (largest) bar: chart tooltip.
  await panel.hover('article.gp-turn:last-of-type .gp-marks [tabindex]');
  await panelSnap(panel, S, T, 'panel-05b-bar-tooltip', { description: 'Pointer on the largest bar: the chart tooltip with the exact value.', boxes: Object.assign({ tooltip: '.gp-tip:not([hidden])' }, PANEL_BOXES), texts: Object.assign({ tooltip: '.gp-tip:not([hidden])' }, PANEL_TEXTS) });
  await panel.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 895 });
  // Table, then Show SQL.
  await panel.click('article.gp-turn:last-of-type label[for$="-table"]');
  const table = await panel.fn(() => {
    const a = [...document.querySelectorAll('article.gp-turn')].pop();
    return { headers: [...a.querySelectorAll('thead th')].map((t) => t.textContent), rows: [...a.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)) };
  });
  story.genie.jobsIncrease.table = table;
  await panelSnap(panel, S, T, 'panel-06-table', { description: 'Same answer, Table view: formatted result rows.', boxes: PANEL_BOXES, texts: PANEL_TEXTS, extraTexts: { table } });
  pair('panel-06-table', 'page-video-2-docked');
  await panel.click('article.gp-turn:last-of-type details.gp-sql > summary');
  await panel.fn(() => document.querySelector('article.gp-turn:last-of-type details.gp-sql').scrollIntoView({ block: 'center' }));
  const sql = await panel.fn(() => document.querySelector('article.gp-turn:last-of-type details.gp-sql pre code').textContent);
  await panelSnap(panel, S, T, 'panel-07-show-sql', { description: 'Show SQL opened: the generated SQL over system.billing.usage and list prices (the same SQL computed these rows).', boxes: Object.assign({ sqlCode: 'article.gp-turn:last-of-type details.gp-sql pre' }, PANEL_BOXES), texts: PANEL_TEXTS, extraTexts: { sql } });
  pair('panel-07-show-sql', 'page-video-2-docked');
  await panel.click('article.gp-turn:last-of-type details.gp-sql > summary');
  await panel.click('article.gp-turn:last-of-type label[for$="-chart"]');
  // A follow-up from the suggested questions (real chip click): daily compute cost, line chart.
  await panel.click('article.gp-turn:last-of-type ~ .gp-suggest .gp-suggest-list button, .gp-suggest-list button');
  await poll(async () => {
    const t = await panel.turns();
    return t.length === 2 && t[1].phase === 'done' && t[1].chart ? t : null;
  }, { timeout: 90000, label: 'follow-up answer' });
  await panel.fn(() => document.querySelectorAll('article.gp-turn')[1].scrollIntoView({ block: 'start' }));
  const daily = await panelSnap(panel, S, T, 'panel-07b-followup-daily-line', { description: 'Follow-up from a suggested question, "' + QUESTIONS.dailyCost + '": a line chart of daily compute cost; the backfill day stands out.', boxes: PANEL_BOXES, texts: PANEL_TEXTS });
  pair('panel-07b-followup-daily-line', 'page-video-2-docked');
  story.genie.dailyCost = { answer: daily.texts.answer };
  await panel.wheel(-8000);

  // The doc tab: copy answer, then copy table, through the real ⋯ menu.
  await activate(doc.tabId);
  await doc.page.setViewportSize(PAGE_VP);
  const docShot = async (id, description, extraTexts) => {
    for (const theme of ['dark', 'light']) {
      await doc.page.emulateMedia({ colorScheme: theme });
      for (const [vp, suffix] of [[PAGE_VP, ''], [DOCKED_VP, '-docked']]) {
        await doc.page.setViewportSize(vp);
        await sleep(150);
        await snap(doc.page, S, theme, id + suffix, { description: description + ' (' + (suffix ? 'docked width' : 'full width') + ')', boxes: { paper: '.paper', notes: '#answer-here', appendix: '#table-here', paste1: '[data-paste="1"]', paste2: '[data-paste="2"]' }, extraTexts });
      }
    }
    await doc.page.emulateMedia({ colorScheme: T });
    await doc.page.setViewportSize(PAGE_VP);
  };
  await docShot('page-doc-0-before', 'Another tab: the user\'s own doc "Weekly cost review" (neutral synthetic editor) before pasting.', {});
  const FIRST = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.replace(/:last-of-type/g, ':first-of-type')]));
  await panel.click('article.gp-turn:first-of-type details.gp-menu > summary');
  await poll(() => panel.fn(() => Boolean(document.querySelector('article.gp-turn:first-of-type details.gp-menu[open]'))), { label: 'menu open' });
  await panelSnap(panel, S, T, 'panel-08-menu-open', { description: 'The first answer\'s ⋯ menu open: Copy answer, Copy table, Download CSV.', boxes: FIRST(PANEL_BOXES), texts: Object.assign(FIRST({ copyAnswer: 'article.gp-turn:last-of-type [data-copy]', copyTable: 'article.gp-turn:last-of-type [data-copy-table]', download: 'article.gp-turn:last-of-type [data-download]' }), FIRST(PANEL_TEXTS)) });
  pair('panel-08-menu-open', 'page-doc-0-before-docked');
  await panel.click('article.gp-turn:first-of-type [data-copy]');
  await poll(() => panel.fn(() => /Copied/.test((document.querySelector('article.gp-turn:first-of-type [data-copy]') || {}).textContent || '')), { timeout: 5000, label: 'Copied' });
  await panelSnap(panel, S, T, 'panel-09-copied-answer', { description: 'Copy answer selected: the menu item confirms "Copied".', boxes: FIRST(PANEL_BOXES), texts: Object.assign({ copyAnswer: 'article.gp-turn:first-of-type [data-copy]' }, FIRST(PANEL_TEXTS)), settle: 50 });
  pair('panel-09-copied-answer', 'page-doc-0-before-docked');
  const clipAnswer = await doc.page.evaluate(() => navigator.clipboard.readText());
  await doc.page.bringToFront();
  await activate(doc.tabId);
  await doc.page.click('#answer-here');
  await doc.page.keyboard.press('ControlOrMeta+V');
  await poll(async () => (await doc.page.evaluate(() => window.__pastes.length)) === 1, { timeout: 5000, label: 'answer pasted' });
  const pasted1 = await doc.page.evaluate(() => window.__pastes[0]);
  check('pasted answer equals the clipboard text produced by Copy answer', pasted1 === clipAnswer && /drove most of last week's increase/.test(pasted1), pasted1.slice(0, 120));
  await doc.page.mouse.move(1590, 895);
  await docShot('page-doc-1-answer', 'The doc after pasting the copied answer (Markdown text plus the result table, exactly as Copy answer produced it).', { clipboard: clipAnswer });
  pair('panel-09-copied-answer', 'page-doc-1-answer-docked', 'Paste with Cmd/Ctrl+V into the doc tab.');
  await panel.fn(() => [...document.querySelectorAll('article.gp-turn')].pop().scrollIntoView({ block: 'start' }));
  await sleep(200);
  await panel.click('article.gp-turn:last-of-type details.gp-menu > summary');
  await poll(() => panel.fn(() => Boolean(document.querySelector('article.gp-turn:last-of-type details.gp-menu[open]'))), { label: 'menu open again' });
  await panel.click('article.gp-turn:last-of-type [data-copy-table]');
  await poll(() => panel.fn(() => /Copied/.test((document.querySelector('article.gp-turn:last-of-type [data-copy-table]') || {}).textContent || '')), { timeout: 5000, label: 'Copied table' });
  await panelSnap(panel, S, T, 'panel-10-copied-table', { description: 'On the follow-up answer (daily compute cost), Copy table selected: "Copied" (tab-separated rows with a header).', boxes: PANEL_BOXES, texts: Object.assign({ copyTable: 'article.gp-turn:last-of-type [data-copy-table]' }, PANEL_TEXTS), settle: 50 });
  const clipTable = await doc.page.evaluate(() => navigator.clipboard.readText());
  await doc.page.click('#table-here');
  await doc.page.keyboard.press('ControlOrMeta+V');
  await poll(async () => (await doc.page.evaluate(() => window.__pastes.length)) === 2, { timeout: 5000, label: 'table pasted' });
  const pasted2 = await doc.page.evaluate(() => window.__pastes[1]);
  check('pasted table equals the clipboard text produced by Copy table', pasted2 === clipTable && pasted2.split('\n')[0].includes('\t'), pasted2.slice(0, 120));
  await doc.page.evaluate(() => document.querySelector('[data-paste="2"]').scrollIntoView({ block: 'center' }));
  await doc.page.mouse.move(1590, 895);
  await docShot('page-doc-2-table', 'The doc after also pasting the copied daily-cost table under "Appendix: daily compute cost" (scrolled to it).', { clipboard: clipTable });
  pair('panel-10-copied-table', 'page-doc-2-table-docked', 'Paste with Cmd/Ctrl+V under Appendix.');
  sc.extra.clipboard = { copyAnswer: clipAnswer, copyTable: clipTable, note: 'Exact text/plain the real Copy answer and Copy table actions wrote (navigator.clipboard.writeText in the side panel), read back with navigator.clipboard.readText in the doc tab; the doc received the same strings through a real keyboard paste (headless Chromium\'s own clipboard, isolated from the OS clipboard).' };

  // Agent switch: Platform ops → Revenue analytics; ask; KPI tiles.
  await panel.select('#space', 'Revenue analytics');
  await poll(() => panel.fn(() => Boolean(document.querySelector('.gp-empty')) && !document.getElementById('question').disabled), { label: 'revenue empty' });
  await panelSnap(panel, S, T, 'panel-11-agent-revenue', { description: 'Genie Agent switched from "Platform ops" to "Revenue analytics" (same workspace): a fresh conversation for that agent.', boxes: PANEL_BOXES, texts: PANEL_TEXTS });
  pair('panel-11-agent-revenue', 'page-doc-2-table-docked');
  await panel.click('#question');
  await panel.type(QUESTIONS.revenueHeadline);
  await panelSnap(panel, S, T, 'panel-12-revenue-typed', { description: 'Question typed for Revenue analytics: "' + QUESTIONS.revenueHeadline + '"', boxes: PANEL_BOXES, texts: PANEL_TEXTS, extraTexts: { typed: QUESTIONS.revenueHeadline } });
  await panel.press('Enter');
  await poll(async () => {
    const t = await panel.turns();
    return t[0] && t[0].phase === 'done' && t[0].chart ? t : null;
  }, { timeout: 90000, label: 'revenue answer' });
  await panel.wheel(-6000);
  const kpi = await panelSnap(panel, S, T, 'panel-13-revenue-kpi', { description: 'Revenue analytics answer: Markdown text and KPI tiles (one-row result).', boxes: Object.assign({ kpis: 'article.gp-turn:last-of-type .gp-kpis' }, PANEL_BOXES), texts: PANEL_TEXTS, extraTexts: { kpis: (await panel.turns()).pop().kpis } });
  story.genie.revenueHeadline = { answer: kpi.texts.answer, kpis: (await panel.turns()).pop().kpis };

  // Workspace switch: prod → analytics. The agent list changes; ask; line chart.
  const analyticsTab = await ctx.newPage();
  await gotoWs(analyticsTab, A, '/jobs', T);
  await bannerReady(analyticsTab, 30);
  await badgesReady(analyticsTab, 3);
  await sqlQuiet(api);
  const navA = await topNavInfo(analyticsTab);
  check('analytics top bar is tinted blue', navA.themed && navA.background === 'rgb(29, 78, 216)', navA);
  await analyticsTab.mouse.move(5, 895);
  for (const [vp, suffix] of [[PAGE_VP, ''], [DOCKED_VP, '-docked']]) {
    await analyticsTab.setViewportSize(vp);
    await sleep(400);
    await snap(analyticsTab, S, T, 'page-analytics-jobs' + suffix, { description: 'northpeak-analytics Jobs & Pipelines in dark mode (blue top bar), ' + (suffix ? 'docked width' : 'full width') + '.', boxes: pageBoxes, extraTexts: { banner: await bannerTexts(analyticsTab) }, meta: { topNav: navA } });
  }
  await analyticsTab.close();
  await panel.select('#ws', A.origin);
  await poll(() => panel.fn(() => document.getElementById('space').options.length > 0 && !document.getElementById('space').disabled && document.querySelector('.gp-empty')), { timeout: 20000, label: 'analytics agents' });
  const agents = await panel.fn(() => [...document.getElementById('space').options].map((o) => o.textContent));
  await panelSnap(panel, S, T, 'panel-14-workspace-analytics', { description: 'Workspace switched to northpeak-analytics: its own Genie Agents (' + agents.join(', ') + ').', boxes: PANEL_BOXES, texts: PANEL_TEXTS, extraTexts: { agents } });
  pair('panel-14-workspace-analytics', 'page-analytics-jobs-docked');
  await panel.click('#question');
  await panel.type(QUESTIONS.sessionsDaily);
  await panel.press('Enter');
  await poll(async () => {
    const t = await panel.turns();
    return t[0] && t[0].phase === 'working' ? t : null;
  }, { timeout: 20000, interval: 100, label: 'analytics working' });
  await panelSnap(panel, S, T, 'panel-15-analytics-working', { description: 'Asked Marketing insights: "' + QUESTIONS.sessionsDaily + '"; Genie is working.', boxes: PANEL_BOXES, texts: PANEL_TEXTS, settle: 50 });
  await poll(async () => {
    const t = await panel.turns();
    return t[0] && t[0].phase === 'done' && t[0].chart ? t : null;
  }, { timeout: 90000, label: 'analytics answer' });
  await panel.wheel(-6000);
  const line = await panelSnap(panel, S, T, 'panel-16-analytics-line', { description: 'Marketing insights answer: text and a line chart (sessions and conversions per day, last 14 days).', boxes: PANEL_BOXES, texts: PANEL_TEXTS, extraTexts: { chart: (await panel.turns()).pop().chart } });
  pair('panel-16-analytics-line', 'page-analytics-jobs-docked');
  story.genie.sessionsDaily = { answer: line.texts.answer, chart: (await panel.turns()).pop().chart };
  await panel.close();
}

/* ------------------------------------------------------------------ scene 10 */

async function monitorScene({ ctx, sw, ext, opt, server }) {
  const S = '10-monitor';
  const T = 'dark';
  scene(S, 'Run monitor', 'Monitor window: running and failed runs, warehouses, clusters; a failed customer_360_refresh run and its desktop notification.');
  // Record what the extension passes to chrome.notifications.create (pass-through wrapper).
  const wrap = () =>
    sw.evaluate(() => {
      if (globalThis.__captureNotes) return true;
      globalThis.__captureNotes = [];
      const n = chrome.notifications;
      const original = n.create.bind(n);
      n.create = (id, options, ...rest) => {
        globalThis.__captureNotes.push({ id, options });
        return original(id, options, ...rest);
      };
      return true;
    });
  await wrap();
  const mon = await ctx.newPage();
  await mon.emulateMedia({ colorScheme: T });
  await mon.setViewportSize(MONITOR_VP);
  await mon.goto(ext('ui/monitor.html'));
  await sendOk(mon, { type: 'page:updateSettings', patch: { monitor: { enabled: true, origin: P.origin, notifyFailures: true } } });
  await poll(async () => {
    const r = await mon.evaluate(() => chrome.runtime.sendMessage({ type: 'monitor:refresh' }));
    return r.ok && r.data.state && r.data.state.status === 'ok' ? r.data : null;
  }, { timeout: 60000, interval: 1500, label: 'first monitor poll' });
  await mon.reload();
  await sleep(1500);
  const MB = { header: 'header', runs: '#runs', warehouses: '#warehouses', clusters: '#clusters' };
  await snap(mon, S, T, '01-monitor-running', { kind: 'monitor', description: 'Monitor (dark) before the failure: active runs (customer_360_refresh, marketing_attribution, inventory_snapshot running; demand_forecast_weekly queued), recent runs, warehouses and clusters.', boxes: MB, extraTexts: { page: clean(await mon.evaluate(() => document.body.innerText)) } });
  // customer_360_refresh fails now (after the monitor's baseline), then the next poll notifies.
  server.live.prod.c360FailedAt = Date.now();
  await sleep(5500);
  await wrap();
  const st = await poll(async () => {
    const r = await mon.evaluate(() => chrome.runtime.sendMessage({ type: 'monitor:refresh' }));
    return r.ok && r.data.state && JSON.stringify(r.data.state.runs).includes('"outcome":"failed"') ? r.data : null;
  }, { timeout: 60000, interval: 2000, label: 'failed run in monitor state' });
  const notes = await poll(async () => {
    const n = await sw.evaluate(() => globalThis.__captureNotes || []);
    return n.length ? n : null;
  }, { timeout: 20000, label: 'notification' });
  const ids = await sw.evaluate(async () => Object.keys(await chrome.notifications.getAll()));
  const note = notes.find((n) => /^dcc-run-/.test(n.id));
  check('the real failure notification was created', Boolean(note) && ids.includes(note.id), { notes, ids });
  scene(S).extra.notification = { id: note && note.id, title: note && note.options.title, message: note && note.options.message, contextMessage: note && note.options.contextMessage, iconUrl: 'icons/icon-128.png (extension icon)', allIds: ids, source: 'Arguments the extension passed to chrome.notifications.create (recorded by a pass-through wrapper in the capture browser\'s service worker; the notification itself was created by Chrome).' };
  story.notification = scene(S).extra.notification;
  await mon.reload();
  await poll(async () => /failed/i.test(await mon.evaluate(() => document.getElementById('runs').innerText)), { timeout: 20000, label: 'failed run row' });
  await sleep(800);
  const failedBox = await mon.evaluate(() => {
    const a = [...document.querySelectorAll('#runs a')].find((x) => /customer_360_refresh/.test(x.textContent));
    const row = a && (a.closest('li') || a.parentElement);
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  await snap(mon, S, T, '02-monitor-failed', { kind: 'monitor', description: 'Monitor (dark) after the next poll: customer_360_refresh failed (status shown in text and color), counts updated.', boxes: MB, extraBoxes: failedBox ? { failedRun: failedBox } : {}, extraTexts: { page: clean(await mon.evaluate(() => document.body.innerText)), notification: scene(S).extra.notification }, meta: { badge: await sw.evaluate(() => chrome.action.getBadgeText({})), badgeTitle: await sw.evaluate(() => chrome.action.getTitle({})) } });
  // The rest of the monitor (pipelines, warehouses, clusters): scrolled state and one full-height capture.
  await mon.evaluate(() => {
    const el = document.getElementById('warehouses') || document.getElementById('clusters');
    if (el) el.scrollIntoView({ block: 'start' });
  });
  await sleep(300);
  await snap(mon, S, T, '03-monitor-compute', { kind: 'monitor', description: 'Same monitor scrolled to SQL warehouses and clusters (BI Serverless running, job clusters, shared-analytics).', boxes: MB, extraTexts: { page: clean(await mon.evaluate(() => document.body.innerText)) } });
  await mon.evaluate(() => window.scrollTo(0, 0));
  {
    const full = await mon.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
    await mon.setViewportSize({ width: MONITOR_VP.width, height: full });
    await sleep(300);
    await snap(mon, S, T, '04-monitor-failed-full', { kind: 'monitor', description: 'The whole monitor after the failure at 380 px wide and full height (for panning): runs, pipelines, warehouses, clusters.', boxes: MB, extraBoxes: failedBox ? { failedRun: failedBox } : {} });
    await mon.setViewportSize(MONITOR_VP);
  }
  await mon.emulateMedia({ colorScheme: 'light' });
  await sleep(300);
  await snap(mon, S, 'light', '02-monitor-failed', { kind: 'monitor', description: 'Same monitor state in light mode (extra).', boxes: MB, extraBoxes: failedBox ? { failedRun: failedBox } : {} });
  await mon.close();
  await sendOk(opt, { type: 'page:updateSettings', patch: { monitor: { enabled: false } } });
}

/* ------------------------------------------------------------------ scene 11 */

async function colorsScene({ ctx, ext, opt, setColors }) {
  const S = '11-colors';
  const T = 'light';
  scene(S, 'Workspace colors', 'Three tabs (dev, stage, prod) with identical default top bars; the popup\'s Workspace colors panel; then each top bar in its own color.');
  await setColors([[A, A.color]]); // dev, stage and prod: no color yet
  const pages = {};
  const navBoxes = { topNav: 'nav[aria-label="Top Navigation"]', switcher: '.np-switcher', banner: BANNER + ' .bar', pageTitle: 'main h1' };
  for (const W of [DEV, STAGE, P]) {
    const pg = await ctx.newPage();
    await gotoWs(pg, W, '/jobs', T);
    await bannerReady(pg, 30);
    await badgesReady(pg, 2);
    pages[W.key] = pg;
  }
  let n = 1;
  for (const W of [DEV, STAGE, P]) {
    const pg = pages[W.key];
    await pg.bringToFront();
    await pg.mouse.move(5, 895);
    const nav = await topNavInfo(pg);
    check(W.name + ' top bar has its native color', !nav.themed, nav);
    await snap(pg, S, T, '0' + n++ + '-default-' + W.key, { description: W.name + ' Jobs & Pipelines with the default (native) top bar: the three environments look the same.', boxes: navBoxes, texts: { switcher: '.np-switcher' }, extraTexts: { banner: await bannerTexts(pg) }, meta: { topNav: nav } });
  }
  // The popup's Workspace colors panel, once per workspace.
  const plan = [
    { W: DEV, how: 'preset', color: DEV.color, name: 'Green' },
    { W: STAGE, how: 'hex', color: '#F59E0B', name: 'custom amber' },
    { W: P, how: 'preset', color: P.color, name: 'Red' },
  ];
  for (const step of plan) {
    const { W } = step;
    await pages[W.key].bringToFront();
    const popup = await ctx.newPage();
    await popup.emulateMedia({ colorScheme: T });
    await popup.goto(ext('ui/popup.html?captureTab=' + encodeURIComponent(W.origin)));
    await popup.locator('#more > summary').click();
    await popup.locator('#colors-details > summary').click();
    await poll(async () => (await popup.locator('#dcc-ap-url').inputValue()).startsWith(W.origin), { label: 'prefilled workspace URL' });
    await fitPopup(popup);
    const AB = { panel: '#appearance-panel', url: '#dcc-ap-url', picker: '#dcc-ap-picker', hex: '#dcc-ap-hex', presets: '.dcc-ap-presets', preview: '#dcc-ap-preview', contrast: '#dcc-ap-contrast', applies: '#dcc-ap-applies', save: '#dcc-ap-save', status: '#dcc-ap-status' };
    const AT = { url: '#dcc-ap-url', applies: '#dcc-ap-applies', contrast: '#dcc-ap-contrast', status: '#dcc-ap-status', previewName: '.dcc-ap-pv-name' };
    const vals = async () => ({ url: await popup.locator('#dcc-ap-url').inputValue(), hex: await popup.locator('#dcc-ap-hex').inputValue() });
    await snap(popup, S, T, '1' + plan.indexOf(step) + 'a-popup-colors-' + W.key + '-open', { kind: 'popup', description: 'Popup → More → Workspace colors on the ' + W.name + ' tab: prefilled with this workspace; no color saved yet (the preview shows the panel\'s default suggestion).', boxes: AB, texts: AT, extraTexts: await vals() });
    if (step.how === 'preset') {
      await popup.locator('.dcc-ap-preset[data-color="' + step.color + '"]').click();
    } else {
      await popup.locator('#dcc-ap-hex').fill('');
      await popup.locator('#dcc-ap-hex').type(step.color.toLowerCase(), { delay: 40 });
      await popup.locator('#dcc-ap-hex').evaluate((el) => el.blur()); // commits the edit (change event)
    }
    await sleep(200);
    await snap(popup, S, T, '1' + plan.indexOf(step) + 'b-popup-colors-' + W.key + '-chosen', { kind: 'popup', description: (step.how === 'preset' ? 'Preset "' + step.name + '" chosen' : 'Custom color typed in the hex field (the color input shows it)') + ' for ' + W.name + ': live preview with the readable foreground and its contrast.', boxes: AB, texts: AT, extraTexts: await vals() });
    await popup.locator('#dcc-ap-save').click();
    await poll(async () => /Saved/.test(await popup.locator('#dcc-ap-status').innerText()), { label: 'saved' });
    await sleep(200);
    await snap(popup, S, T, '1' + plan.indexOf(step) + 'c-popup-colors-' + W.key + '-saved', { kind: 'popup', description: 'Saved for ' + W.name + ': "Open tabs on this workspace update automatically."', boxes: AB, texts: AT, extraTexts: await vals() });
    await popup.close();
  }
  n = 1;
  for (const step of plan) {
    const pg = pages[step.W.key];
    await pg.bringToFront();
    const nav = await poll(async () => {
      const i = await topNavInfo(pg);
      return i.themed ? i : null;
    }, { label: step.W.name + ' tinted' });
    await pg.mouse.move(5, 895);
    await snap(pg, S, T, '2' + n++ + '-colored-' + step.W.key, { description: step.W.name + ' with its own top-bar color (' + step.color + ', ' + step.name + '); foreground picked for contrast.', boxes: navBoxes, texts: { switcher: '.np-switcher' }, meta: { topNav: nav, color: step.color } });
  }
  // Extra: northpeak-analytics (blue, set earlier through the same storage) for a prod/analytics pair.
  const an = await ctx.newPage();
  await gotoWs(an, A, '/jobs', T);
  await bannerReady(an, 30);
  await badgesReady(an, 3);
  const navA = await poll(async () => {
    const i = await topNavInfo(an);
    return i.themed ? i : null;
  }, { label: 'analytics tinted' });
  await an.mouse.move(5, 895);
  await snap(an, S, T, '24-colored-analytics', { description: 'Extra: northpeak-analytics with its blue top bar (' + A.color + '), to pair with prod (red).', boxes: navBoxes, texts: { switcher: '.np-switcher' }, meta: { topNav: navA, color: A.color } });
  await an.close();
  for (const pg of Object.values(pages)) await pg.close();
}

/* ------------------------------------------------------------------ write manifests */

function writeManifests(env) {
  const index = { generatedBy: 'local/video/capture.mjs', company: COMPANY, environment: env, conventions: { dpr: 2, boxes: 'CSS px relative to the state\'s viewport (top-left origin)', texts: 'innerText as displayed (CSS text-transform applied); *Source fields are textContent' }, scenes: [], story, checks };
  for (const sc of scenes.values()) {
    const themes = Object.keys(sc.themes);
    for (const theme of themes) {
      const m = { scene: sc.id, title: sc.title, storyboard: sc.storyboard, theme, states: sc.themes[theme], notes: sc.notes, extra: sc.extra };
      const file = path.join(OUT, sc.id, theme, 'manifest.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
    }
    index.scenes.push({ id: sc.id, title: sc.title, themes: Object.fromEntries(themes.map((t) => [t, { manifest: path.join(sc.id, t, 'manifest.json'), states: sc.themes[t].map((s) => ({ id: s.id, file: path.join(sc.id, t, s.file), viewport: s.viewport, description: s.description })) }])) });
  }
  const indexFile = path.join(OUT, 'index.json');
  if (ONLY && fs.existsSync(indexFile)) {
    // Partial run: keep the scenes and story numbers of the previous full run that were not redone.
    const prev = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    const redone = new Set(index.scenes.map((x) => x.id));
    index.scenes = prev.scenes.filter((x) => !redone.has(x.id)).concat(index.scenes).sort((a, b) => a.id.localeCompare(b.id));
    index.story = Object.assign({}, prev.story, story);
    index.partialRun = { only: [...ONLY], previousChecks: prev.checks };
  }
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
  const failed = checks.filter((c) => !c.ok);
  log('wrote', path.relative(ROOT, path.join(OUT, 'index.json')), '·', checks.length, 'checks,', failed.length, 'failed');
}

main().catch((e) => {
  process.stderr.write('[capture] FAILED: ' + ((e && e.stack) || e) + '\n');
  process.exitCode = 1;
});
