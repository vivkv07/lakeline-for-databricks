/*
 * Secrets: PATs (per origin) and the helper bridge pairing. Stored in chrome.storage.session,
 * which is memory-only and, by default, readable only from trusted extension contexts (not
 * content scripts). A PAT survives browser restarts only when the user explicitly picks
 * "Remember on this computer"; it is then also kept in the extension's own IndexedDB
 * (idb-area.js), which content scripts cannot open. Never returned in settings responses.
 *
 * Versions up to 0.1.1 kept remembered tokens in chrome.storage.local, which content scripts can
 * read. Those are moved over once, on first use, and the old key is deleted.
 *
 * Remembered tokens are encrypted at rest with AES-GCM. The key is a non-extractable CryptoKey kept
 * in the same extension-only database, so no script, not even the extension's own, can read the raw
 * key; only this module can decrypt.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const V = NODE ? require('../core/validate.js') : root.DCC.validate;

  const PAT_KEY = 'dcc.secrets.pat';
  const BRIDGE_KEY = 'dcc.secrets.bridge';
  const REMEMBERED_PAT_KEY = 'dcc.secrets.patRemembered';
  const ENC_KEY = 'dcc.secrets.encKey';

  /**
   * @param area chrome.storage.session
   * @param [persistArea] the extension-only IndexedDB area, used only for tokens the user chose
   *   to remember
   * @param [opts.legacyArea] chrome.storage.local, read once to move tokens remembered by older
   *   versions into persistArea; never written except to delete that key
   */
  function create(area, persistArea, { legacyArea = null, cryptoApi = root.crypto } = {}) {
    async function read(key, fallback, from = area) {
      const got = await from.get(key);
      return got && got[key] !== undefined ? got[key] : fallback;
    }

    const subtle = cryptoApi && cryptoApi.subtle;
    let keyPromise = null;
    function encKey() {
      if (!keyPromise) {
        keyPromise = (async () => {
          const existing = await read(ENC_KEY, null, persistArea);
          if (existing) return existing;
          const k = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
          await persistArea.set({ [ENC_KEY]: k });
          return k;
        })().catch((e) => {
          keyPromise = null;
          throw e;
        });
      }
      return keyPromise;
    }

    /** Remembered tokens as a plain {origin: token} map, decrypted. Unreadable data counts as empty. */
    async function readKeptRaw() {
      const stored = await read(REMEMBERED_PAT_KEY, null, persistArea);
      if (!stored || typeof stored !== 'object') return {};
      if (stored.v !== 1) return Object.assign({}, stored); // written before encryption existed
      try {
        const plain = await subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(stored.iv) }, await encKey(), stored.data);
        const map = JSON.parse(new TextDecoder().decode(plain));
        return map && typeof map === 'object' ? map : {};
      } catch (_) {
        return {};
      }
    }

    async function writeKept(map) {
      if (!subtle) throw new Error('Encryption is not available to remember a token');
      const iv = cryptoApi.getRandomValues(new Uint8Array(12));
      const data = await subtle.encrypt({ name: 'AES-GCM', iv }, await encKey(), new TextEncoder().encode(JSON.stringify(map)));
      await persistArea.set({ [REMEMBERED_PAT_KEY]: { v: 1, iv: Array.from(iv), data: new Uint8Array(data) } });
    }

    let migrating = null;
    /** One-time move of remembered tokens out of the legacy area; retried if it fails. */
    function migrate() {
      if (!legacyArea || !persistArea) return Promise.resolve();
      if (!migrating) {
        migrating = (async () => {
          const got = await legacyArea.get(REMEMBERED_PAT_KEY);
          if (!got || !Object.prototype.hasOwnProperty.call(got, REMEMBERED_PAT_KEY)) return;
          const old = got[REMEMBERED_PAT_KEY];
          if (old && typeof old === 'object') {
            const kept = await readKeptRaw();
            for (const [origin, token] of Object.entries(old)) {
              if (!kept[origin] && V.isPlausiblePat(token)) kept[origin] = token;
            }
            await writeKept(kept);
          }
          await legacyArea.remove(REMEMBERED_PAT_KEY);
        })().catch((e) => {
          migrating = null;
          throw e;
        });
      }
      return migrating;
    }

    async function readKept() {
      await migrate();
      return readKeptRaw();
    }

    return {
      async setPat(origin, token, { remember = false } = {}) {
        if (!V.isPlausiblePat(token)) throw new Error('Token format not accepted');
        const all = await read(PAT_KEY, {});
        all[origin] = token;
        await area.set({ [PAT_KEY]: all });
        if (persistArea) {
          const kept = await readKept();
          if (remember) kept[origin] = token;
          else delete kept[origin];
          await writeKept(kept);
        }
      },
      async getPat(origin) {
        const all = await read(PAT_KEY, {});
        if (all[origin]) return all[origin];
        if (!persistArea) return null;
        const kept = await readKept();
        if (!kept[origin]) return null;
        all[origin] = kept[origin]; // warm the session copy after a browser restart
        await area.set({ [PAT_KEY]: all });
        return kept[origin];
      },
      async hasPat(origin) {
        return Boolean(await this.getPat(origin));
      },
      async isPatRemembered(origin) {
        if (!persistArea) return false;
        const kept = await readKept();
        return Boolean(kept[origin]);
      },
      async clearPat(origin) {
        const all = await read(PAT_KEY, {});
        delete all[origin];
        await area.set({ [PAT_KEY]: all });
        if (persistArea) {
          const kept = await readKept();
          delete kept[origin];
          await writeKept(kept);
        }
      },

      /**
       * Store a verified bridge pairing. A different key means the helper restarted (key
       * rotation): any previous bridge session is replaced wholesale, never merged.
       */
      async setBridge({ key, port, helperVersion, capabilities }) {
        if (!V.isPairingKey(key)) throw new Error('Pairing key format not accepted');
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid helper port');
        const previous = await read(BRIDGE_KEY, null);
        const rotated = Boolean(previous && previous.key !== key);
        await area.set({
          [BRIDGE_KEY]: {
            key,
            port,
            helperVersion: V.safeText(helperVersion, 40),
            capabilities: sanitizeCapabilities(capabilities),
            pairedAt: Date.now(),
          },
        });
        return { rotated };
      },
      async getBridge() {
        return read(BRIDGE_KEY, null);
      },
      async clearBridge() {
        await area.remove(BRIDGE_KEY);
      },

      /** Move tokens remembered by older versions out of chrome.storage.local now. */
      migrate,

      /** Non-secret view for UI: which secrets exist, never their values. */
      async describe(origin) {
        const bridge = await read(BRIDGE_KEY, null);
        return {
          hasPat: Boolean(origin && (await this.getPat(origin))),
          patRemembered: Boolean(origin && (await this.isPatRemembered(origin))),
          bridgePaired: Boolean(bridge),
          helperVersion: bridge ? bridge.helperVersion : null,
          capabilities: bridge ? bridge.capabilities : null,
        };
      },
    };
  }

  function sanitizeCapabilities(c) {
    const src = c && typeof c === 'object' ? c : {};
    return {
      accountPrices: src.accountPrices === true,
      priceAdapterVersion: Number.isInteger(src.priceAdapterVersion) ? src.priceAdapterVersion : 0,
      jobPipelineAttribution: src.jobPipelineAttribution === true,
      monitor: src.monitor === true,
      protocol: Number.isInteger(src.protocol) ? src.protocol : 0,
    };
  }

  const api = Object.freeze({ create, sanitizeCapabilities, PAT_KEY, BRIDGE_KEY, REMEMBERED_PAT_KEY });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).secrets = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
