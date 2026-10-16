// SIMULATED: the helper setup page (local/setup.html + setup.js) in jsdom with a fake chrome.runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(HERE, 'setup.html'), 'utf8');
const JS = fs.readFileSync(path.join(HERE, 'setup.js'), 'utf8');
const EXT_ID = fs.readFileSync(path.join(HERE, '..', 'extension', 'EXTENSION_ID'), 'utf8').trim();
const KEY = '0123456789abcdef01234567';

/**
 * Load the page; `chrome` is installed before setup.js runs (as externally_connectable does).
 * setup.js runs from <head> while the document is still loading (like a browser), so the UI is
 * wired on DOMContentLoaded. `onEval` sees the window right after the script ran.
 */
async function page(url, chrome, onEval) {
  const dom = new JSDOM(HTML, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  if (chrome) w.chrome = chrome;
  assert.equal(w.document.readyState, 'loading');
  w.eval(JS);
  if (onEval) onEval(w);
  await new Promise((r) => (w.document.readyState === 'loading' ? w.document.addEventListener('DOMContentLoaded', () => r()) : r()));
  return w;
}

const $ = (w, id) => w.document.getElementById(id);
const visible = (w, id) => !$(w, id).hidden;
const settle = () => new Promise((r) => setTimeout(r, 10));

test('the key is read from the fragment and removed from the address bar immediately', async () => {
  let atEval = null;
  const w = await page('http://127.0.0.1:8766/setup#k=' + KEY, null, (win) => (atEval = win.location.href));
  assert.equal(atEval, 'http://127.0.0.1:8766/setup', 'removed before the DOM is even ready');
  assert.equal(w.location.href, 'http://127.0.0.1:8766/setup');
  assert.equal(w.location.hash, '');
  assert.ok(!w.document.documentElement.outerHTML.includes(KEY), 'key not in the DOM');
  assert.ok(visible(w, 'state-ready'));
  assert.ok(!visible(w, 'state-missing'));
});

test('Connect workspace sends setup:pair with the key to the extension ID; success is shown', async () => {
  const sent = [];
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(id, msg, cb) {
        sent.push({ id, msg });
        setTimeout(() => cb({ ok: true, data: { paired: true, rotated: false, helperVersion: '0.1.0' } }), 0);
      },
    },
  };
  const w = await page('http://127.0.0.1:8766/setup#k=' + KEY, chrome);
  assert.ok(!visible(w, 'state-no-extension'));
  $(w, 'connect').click();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ id: EXT_ID, msg: { type: 'setup:pair', key: KEY } }]); // cross-realm objects
  assert.match($(w, 'status').textContent, /Paired \(helper 0\.1\.0\)\. The extension opened Connection preferences/);
  assert.equal($(w, 'connect').disabled, true);
  // After pairing, the manual fallback has nothing to reveal.
  $(w, 'reveal').click();
  assert.equal($(w, 'manual-key').textContent, '');
  assert.ok(!w.document.documentElement.outerHTML.includes(KEY));
});

test('an error response shows the classified title and steps as text', async () => {
  const chrome = {
    runtime: {
      sendMessage(id, msg, cb) {
        setTimeout(() => cb({ ok: false, error: { code: 'HELPER_UNREACHABLE', title: 'The local helper is not running', steps: ['Run the start script again <b>now</b>.'] } }), 0);
      },
    },
  };
  const w = await page('http://127.0.0.1:8766/setup#k=' + KEY, chrome);
  $(w, 'connect').click();
  await settle();
  assert.match($(w, 'status').textContent, /The local helper is not running/);
  assert.equal($(w, 'status').querySelector('b'), null, 'steps rendered as text, not HTML');
  assert.match($(w, 'status').textContent, /<b>now<\/b>/);
  assert.equal($(w, 'connect').disabled, false);
});

test('extension missing (lastError or no chrome.runtime): instructions plus client-side manual key reveal', async () => {
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(id, msg, cb) {
        chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
        setTimeout(() => {
          cb(undefined);
          chrome.runtime.lastError = null;
        }, 0);
      },
    },
  };
  const w = await page('http://127.0.0.1:8766/setup#k=' + KEY, chrome);
  $(w, 'connect').click();
  await settle();
  assert.ok(visible(w, 'state-no-extension'));
  assert.match($(w, 'status').textContent, /not installed in this browser/);

  const bare = await page('http://127.0.0.1:8766/setup#k=' + KEY, null);
  assert.ok(visible(bare, 'state-no-extension'));
  assert.ok(!visible(bare, 'manual'));
  assert.equal($(bare, 'manual-key').textContent, '');
  $(bare, 'reveal').click();
  assert.ok(visible(bare, 'manual'));
  assert.equal($(bare, 'manual-key').textContent, KEY);
  assert.equal($(bare, 'reveal').getAttribute('aria-expanded'), 'true');
  $(bare, 'reveal').click();
  assert.equal($(bare, 'manual-key').textContent, '');
});

test('without a fragment (reload) the page asks to open setup again from the start script', async () => {
  const sent = [];
  const w = await page('http://127.0.0.1:8766/setup', { runtime: { sendMessage: (...a) => sent.push(a) } });
  assert.ok(visible(w, 'state-missing'));
  assert.ok(!visible(w, 'state-ready'));
  assert.match($(w, 'state-missing').textContent, /start-helper\.command/);
  $(w, 'connect').click();
  assert.equal(sent.length, 0);
  const bad = await page('http://127.0.0.1:8766/setup#k=not-a-key', null);
  assert.equal(bad.location.hash, '');
  assert.ok(visible(bad, 'state-missing'));
  assert.equal($(bad, 'missing-title').textContent, 'This setup link is not valid');
});
