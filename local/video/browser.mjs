/*
 * Capture browser for the launch video: the REAL extension in Playwright's cached Chrome for
 * Testing (channel 'chromium', headless, extensions enabled), disposable profile.
 *
 * TEST-ONLY extension copy (never extension/ itself), built in a temp dir:
 *   1. The Chrome Web Store build's files, exactly as `node scripts/package.mjs --store` produces
 *      them (storeEntries(): no manifest key, store feature flags), so the video shows what users
 *      install.
 *   2. manifest.host_permissions = the synthetic Northpeak workspace origins, because the optional
 *      host-permission prompt can't be clicked in headless Chromium (the e2e suites do the same).
 *   3. manifest.permissions += "notifications" (optional permission, granted at install for the
 *      same reason) so the run monitor's real failure notification can fire.
 *   4. ui/capture-shim.js, loaded first by ui/popup.html and ui/sidepanel.html: when the page URL
 *      has ?captureTab=<workspace origin>, chrome.tabs.query({active: true, ...}) answers with that
 *      real open workspace tab. Opened in a normal tab for screenshots, the popup and side panel
 *      would otherwise see themselves as the active tab. Nothing else is changed; without the
 *      parameter (e.g. the real side panel) the shim does nothing. All UI code is the real code.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');

export const SHIM_JS = `/*
 * CAPTURE-ONLY shim (launch-video test copy; not part of the extension). With ?captureTab=<origin>
 * in this page's URL, chrome.tabs.query({active: true, ...}) returns the real open tab of that
 * workspace origin, as if it were the active tab. Without the parameter it does nothing.
 */
(function () {
  'use strict';
  var want = null;
  try {
    want = new URLSearchParams(location.search).get('captureTab');
  } catch (_) {
    want = null;
  }
  if (!want || !/^https:\\/\\/[a-z0-9.-]+$/.test(want) || !self.chrome || !chrome.tabs) return;
  var original = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = function (q) {
    if (!q || q.active !== true) return original(q);
    return original({ url: want + '/*' }).then(function (tabs) {
      return tabs.length ? [tabs[0]] : original(q);
    });
  };
})();
`;

/** Build the test copy into `dir`; returns {dir, manifest, origins}. */
export async function buildTestCopy(dir, origins) {
  const { storeEntries } = await import(pathToFileURL(path.join(ROOT, 'scripts/package.mjs')).href);
  for (const e of storeEntries()) {
    const file = path.join(dir, e.name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, e.data);
  }
  const mf = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  manifest.host_permissions = origins.map((o) => o + '/*');
  manifest.permissions = manifest.permissions.concat('notifications');
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'ui', 'capture-shim.js'), SHIM_JS);
  for (const page of ['popup.html', 'sidepanel.html']) {
    const file = path.join(dir, 'ui', page);
    const html = fs.readFileSync(file, 'utf8');
    const i = html.indexOf('<script');
    if (i < 0) throw new Error(page + ' has no script tag');
    fs.writeFileSync(file, html.slice(0, i) + '<script src="capture-shim.js"></script>\n  ' + html.slice(i));
  }
  return { dir, manifest };
}

/**
 * Launch the capture browser.
 * @returns {{ctx, sw, extId, ua, profile}}
 */
export async function launchBrowser({ extDir, resolverRules, tmp }) {
  const { chromium } = await import(pathToFileURL(path.join(ROOT, 'node_modules/playwright/index.mjs')).href);
  const exe = chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) throw new Error('Playwright Chromium is not installed (' + exe + '). This script never downloads browsers.');
  const profile = fs.mkdtempSync(path.join(tmp, 'profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    ignoreHTTPSErrors: true,
    locale: 'en-US',
    timezoneId: 'UTC',
    args: ['--disable-extensions-except=' + extDir, '--load-extension=' + extDir, '--host-resolver-rules=' + resolverRules, '--ignore-certificate-errors', '--hide-scrollbars', '--font-render-hinting=none'],
  });
  let sw = ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  if (!sw) {
    await ctx.close().catch(() => {});
    throw new Error('The extension service worker never started in headless Chromium.');
  }
  const extId = new URL(sw.url()).host;
  const ua = await sw.evaluate(() => navigator.userAgent).catch(() => '');
  return { ctx, sw, extId, ua, profile, chromium };
}

/** chrome.runtime.sendMessage from an extension page; throws unless {ok:true}. */
export async function sendOk(page, msg) {
  const res = await page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  if (!res || res.ok !== true) throw new Error(msg.type + ' failed: ' + JSON.stringify(res && res.error));
  return res.data;
}

export async function poll(fn, { timeout = 30000, interval = 200, label = 'condition' } = {}) {
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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
