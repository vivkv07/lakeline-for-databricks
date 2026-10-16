/*
 * MV3 service worker: loads shared modules, wires trusted message routing, keeps dynamic
 * content-script registration in sync with granted site access, and migrates settings.
 */
'use strict';

importScripts(
  '../core/validate.js',
  '../core/ids.js',
  '../core/periods.js',
  '../core/labels.js',
  '../core/demo-data.js',
  '../core/import-data.js',
  '../core/allocation.js',
  '../errors.js',
  '../databricks/pricing.js',
  '../databricks/config.js',
  '../databricks/result.js',
  '../databricks/http.js',
  '../databricks/warehouses.js',
  '../databricks/queries/summary.js',
  '../databricks/queries/row-data.js',
  '../databricks/queries/query-history.js',
  '../databricks/queries/compute-rates.js',
  '../databricks/queries/explore.js',
  '../databricks/queries/index.js',
  './sender.js',
  './secrets.js',
  './store.js',
  './cache.js',
  './helper-client.js',
  './registration.js',
  './appearance-handlers.js',
  './data-service.js',
  './ui-handlers.js',
  '../databricks/monitor-api.js',
  './monitor.js',
  './router.js'
);

const DCC = globalThis.DCC;
const HELPER_PORT = 8766;
const EXTENSION_ORIGIN = 'chrome-extension://' + chrome.runtime.id;

const store = DCC.store.create(chrome.storage.local);
const secrets = DCC.secrets.create(chrome.storage.session);
const fetchImpl = (...args) => fetch(...args);
const helperFactory = (o) => DCC.helperClient.create({ fetch: fetchImpl, getBridge: o.getBridge });
const helper = helperFactory({ getBridge: () => secrets.getBridge() });
const data = DCC.dataService.create({ store, secrets, helper, fetch: fetchImpl });

async function openPage(path) {
  const url = chrome.runtime.getURL(path);
  // Reuse an open copy of the page when the browser lets us see it; otherwise open a new tab.
  try {
    const existing = await chrome.tabs.query({ url: url.split('#')[0] + '*' });
    if (existing.length) {
      await chrome.tabs.update(existing[0].id, { active: true, url });
      await chrome.windows.update(existing[0].windowId, { focused: true });
      return;
    }
  } catch (_) {
    /* fall through */
  }
  await chrome.tabs.create({ url });
}

const router = DCC.router.create({
  store,
  secrets,
  data,
  helper,
  helperFactory,
  chromeApi: chrome,
  registration: DCC.registration,
  extensionId: chrome.runtime.id,
  extensionOrigin: EXTENSION_ORIGIN,
  helperPort: HELPER_PORT,
  openPage,
  // Add-on modules (e.g. monitor) register handler factories: DCC.handlerFactories.push(deps => ({...})).
  extra: (DCC.handlerFactories || []).reduce((acc, make) => Object.assign(acc, make({ store, secrets, data, helper, openPage, chromeApi: chrome })), {}),
});
(DCC.backgroundInits || []).forEach((init) => {
  try {
    init({ store, secrets, data, helper, openPage, chromeApi: chrome });
  } catch (e) {
    console.warn('DCC init', DCC.errors.redact(e && e.message));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  router.dispatch(msg, sender).then(sendResponse);
  return true;
});

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  router.dispatch(msg, sender, { external: true }).then(sendResponse);
  return true;
});

async function bootstrap() {
  await store.migrate();
  await DCC.registration.sync(chrome);
}

chrome.runtime.onInstalled.addListener(() => {
  bootstrap().catch((e) => console.warn('DCC bootstrap', DCC.errors.redact(e && e.message)));
});
chrome.runtime.onStartup.addListener(() => {
  bootstrap().catch((e) => console.warn('DCC bootstrap', DCC.errors.redact(e && e.message)));
});
chrome.permissions.onAdded.addListener(() => DCC.registration.sync(chrome).catch(() => {}));
chrome.permissions.onRemoved.addListener(() => DCC.registration.sync(chrome).catch(() => {}));
