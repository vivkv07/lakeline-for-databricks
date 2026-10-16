// Service-worker wiring for the monitor. SIMULATED: runs the real src/background/service-worker.js in
// a Node VM with a fake `chrome`, inserting the two monitor modules into importScripts exactly where
// the integration note says (after data-service.js, before router.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension/src/background');
const MONITOR_FILES = ['../databricks/monitor-api.js', './monitor.js'];

function event() {
  const fns = [];
  return { addListener: (fn) => fns.push(fn), fire: (...a) => fns.map((fn) => fn(...a)), fns };
}

function area() {
  const data = {};
  return {
    data,
    async get(k) {
      const out = {};
      for (const key of [].concat(k)) if (key in data) out[key] = structuredClone(data[key]);
      return out;
    },
    async set(o) {
      Object.assign(data, structuredClone(o));
    },
    async remove(k) {
      for (const key of [].concat(k)) delete data[key];
    },
  };
}

function loadServiceWorker() {
  const alarms = new Map();
  const chrome = {
    runtime: { id: 'testext', getURL: (p) => 'chrome-extension://testext/' + p, onMessage: event(), onMessageExternal: event(), onInstalled: event(), onStartup: event() },
    storage: { local: area(), session: area(), onChanged: event() },
    alarms: { onAlarm: event(), create: async (n, i) => alarms.set(n, i), get: async (n) => alarms.get(n), clear: async (n) => alarms.delete(n) },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setBadgeTextColor: async () => {}, setTitle: async () => {} },
    permissions: { onAdded: event(), onRemoved: event(), contains: async () => false },
    windows: { onRemoved: event(), create: async (o) => ({ id: 7, type: o.type }), get: async () => { throw new Error('none'); }, update: async () => ({}) },
    tabs: { create: async () => ({}), query: async () => [] },
    scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {} },
  };
  const loaded = [];
  const ctx = vm.createContext({ chrome, console, URL, URLSearchParams, Intl, structuredClone, setTimeout, clearTimeout, TextEncoder, fetch: async () => { throw new Error('no network in this test'); } });
  ctx.globalThis = ctx;
  ctx.importScripts = (...files) => {
    const list = [];
    for (const f of files) {
      // Integrated service workers already import the monitor; only inject when absent.
      if (f === './router.js' && !files.includes(MONITOR_FILES[1])) list.push(...MONITOR_FILES);
      list.push(f);
    }
    for (const f of list) {
      loaded.push(f);
      vm.runInContext(readFileSync(path.join(BG, f), 'utf8'), ctx, { filename: f });
    }
  };
  vm.runInContext(readFileSync(path.join(BG, 'service-worker.js'), 'utf8'), ctx, { filename: 'service-worker.js' });
  return { chrome, ctx, loaded };
}

test('service worker registers monitor handlers and synchronous listeners through the add-on hooks', async () => {
  const { chrome, ctx, loaded } = loadServiceWorker();
  assert.ok(loaded.indexOf('./monitor.js') > loaded.indexOf('./data-service.js'));
  assert.ok(loaded.indexOf('./monitor.js') < loaded.indexOf('./router.js'));
  assert.equal(typeof ctx.DCC.monitorApi.normalizeRun, 'function');
  assert.equal(ctx.DCC.handlerFactories.length >= 1, true);
  assert.equal(ctx.DCC.backgroundInits.length >= 1, true);
  // Listeners exist right after evaluation (no await), so alarms and startup can wake the worker.
  // One alarm listener for the monitor and one for the Genie side panel (it resumes in-flight questions).
  assert.equal(chrome.alarms.onAlarm.fns.length, 2);
  assert.equal(typeof ctx.DCC.genie.create, 'function');
  assert.ok(chrome.runtime.onStartup.fns.length >= 2, 'bootstrap + monitor');
  assert.equal(chrome.windows.onRemoved.fns.length, 1);
  assert.equal(chrome.storage.onChanged.fns.length, 1);

  // A message from the monitor page reaches the monitor handler through the router.
  const sender = { id: 'testext', url: 'chrome-extension://testext/ui/monitor.html' };
  const reply = await new Promise((resolve) => chrome.runtime.onMessage.fns[0]({ type: 'monitor:state' }, sender, resolve));
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.data.settings.enabled, false);
  assert.equal(JSON.stringify(reply.data.connections), '[]');

  const open = await new Promise((resolve) => chrome.runtime.onMessage.fns[0]({ type: 'monitor:open' }, sender, resolve));
  assert.equal(open.ok, true);
  assert.equal(open.data.windowId, 7);

  // Content scripts may not use page handlers.
  const denied = await new Promise((resolve) => chrome.runtime.onMessage.fns[0]({ type: 'monitor:open' }, { id: 'testext', url: 'https://dbc-1.cloud.databricks.com/', tab: { id: 1 }, frameId: 0 }, resolve));
  assert.equal(denied.ok, false);
});
