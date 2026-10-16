/*
 * jsdom harness for content-script tests. Loads extension classic scripts into a JSDOM window
 * with a fake `chrome` (runtime.sendMessage routed to the test, storage.local + onChanged).
 * This is a SIMULATED browser environment, not proof of behavior in a real Databricks tab.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../extension');

export const BASE_CONTENT_FILES = [
  'src/core/validate.js',
  'src/core/ids.js',
  'src/core/periods.js',
  'src/core/labels.js',
  'src/core/theme.js',
  'src/content/dom.js',
  'src/content/native-adapter.js',
  'src/content/workspace-data.js',
  'src/content/workspace-ui.js',
];

export const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {string} o.url        page URL (e.g. https://dbc-1.cloud.databricks.com/jobs?o=42)
 * @param {string} o.html       page HTML
 * @param {string[]} o.files    extension-relative script paths, loaded in order
 * @param {(msg)=>any} o.onMessage  service-worker stand-in; return the {ok,data}|{ok,error} response
 * @param {object} [o.storage]  initial chrome.storage.local contents
 */
export function createContentEnv({ url, html, files, onMessage, storage = {} }) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const data = structuredClone(storage);
  const changeListeners = [];
  const messages = [];
  w.chrome = {
    runtime: {
      id: 'testextensionid',
      async sendMessage(msg) {
        messages.push(structuredClone(msg));
        return onMessage ? structuredClone(await onMessage(msg)) : { ok: false, error: { code: 'UNKNOWN' } };
      },
      getURL: (p) => 'chrome-extension://testextensionid/' + p,
      onMessage: { addListener() {} },
    },
    storage: {
      local: {
        async get(key) {
          if (key == null) return structuredClone(data);
          const out = {};
          for (const k of [].concat(key)) if (k in data) out[k] = structuredClone(data[k]);
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: data[k], newValue: v };
            data[k] = structuredClone(v);
          }
          for (const fn of changeListeners) fn(changes, 'local');
        },
      },
      onChanged: { addListener: (fn) => changeListeners.push(fn) },
    },
  };
  for (const f of files) w.eval(readFileSync(path.join(EXT, f), 'utf8') + '\n//# sourceURL=' + f);
  return {
    dom,
    window: w,
    document: w.document,
    messages,
    storage: data,
    /** Simulate chrome.storage.local.set from elsewhere (popup/options/service worker). */
    async setStorage(obj) {
      await w.chrome.storage.local.set(obj);
    },
    /** Navigate within the SPA (pushState) without reloading scripts. */
    navigate(href) {
      w.history.pushState({}, '', href);
    },
    close() {
      w.close();
    },
  };
}
