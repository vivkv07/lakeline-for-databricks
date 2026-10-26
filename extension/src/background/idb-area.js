/*
 * A small key-value area on the extension origin's own IndexedDB, with the slice of the
 * chrome.storage area API that secrets.js uses: get(key) → { [key]: value } or {}, set({ k: v }),
 * remove(key).
 *
 * Why: tokens saved with "Remember on this computer" must survive a browser restart, but
 * chrome.storage.local is readable and writable by every content script, and Chrome offers no
 * access level for it (setAccessLevel only covers storage.session). IndexedDB is per origin:
 * content scripts get the page's database, never the extension's, so only the service worker and
 * extension pages can open this one. Uninstalling the extension deletes it.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;

  const DB_NAME = 'lakeline-secrets';
  const STORE = 'kv';

  /** @param {{indexedDB?: IDBFactory, name?: string}} [o] */
  function create({ indexedDB: idb = root.indexedDB, name = DB_NAME } = {}) {
    let opening = null;

    function open() {
      if (!idb) return Promise.reject(new Error('IndexedDB is not available here'));
      if (!opening) {
        opening = new Promise((resolve, reject) => {
          const req = idb.open(name, 1);
          req.onupgradeneeded = () => req.result.createObjectStore(STORE);
          req.onsuccess = () => {
            const db = req.result;
            // A closed connection (service worker shutdown, version change) reopens next time.
            db.onclose = () => {
              opening = null;
            };
            db.onversionchange = () => {
              db.close();
              opening = null;
            };
            resolve(db);
          };
          req.onerror = () => {
            opening = null;
            reject(req.error);
          };
        });
      }
      return opening;
    }

    /** Run fn(objectStore) in one transaction; resolves with the request's result, if any. */
    async function run(mode, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      });
    }

    return {
      async get(key) {
        const value = await run('readonly', (os) => os.get(key));
        return value === undefined ? {} : { [key]: value };
      },
      async set(items) {
        await run('readwrite', (os) => {
          for (const [k, v] of Object.entries(items)) os.put(v, k);
          return null;
        });
      },
      async remove(key) {
        await run('readwrite', (os) => os.delete(key));
      },
    };
  }

  const api = Object.freeze({ create, DB_NAME, STORE });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).idbArea = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
