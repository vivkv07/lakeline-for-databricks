/*
 * Secrets: PATs (per origin) and the helper bridge pairing. Stored in chrome.storage.session,
 * which is memory-only and, by default, readable only from trusted extension contexts (not
 * content scripts). A PAT is kept in chrome.storage.local only when the user explicitly picks
 * "Remember on this computer" (so it survives browser restarts). Never returned in settings
 * responses.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const V = NODE ? require('../core/validate.js') : root.DCC.validate;

  const PAT_KEY = 'dcc.secrets.pat';
  const BRIDGE_KEY = 'dcc.secrets.bridge';
  const REMEMBERED_PAT_KEY = 'dcc.secrets.patRemembered';

  /**
   * @param area chrome.storage.session
   * @param [persistArea] chrome.storage.local, used only for tokens the user chose to remember
   */
  function create(area, persistArea) {
    async function read(key, fallback, from = area) {
      const got = await from.get(key);
      return got && got[key] !== undefined ? got[key] : fallback;
    }

    return {
      async setPat(origin, token, { remember = false } = {}) {
        if (!V.isPlausiblePat(token)) throw new Error('Token format not accepted');
        const all = await read(PAT_KEY, {});
        all[origin] = token;
        await area.set({ [PAT_KEY]: all });
        if (persistArea) {
          const kept = await read(REMEMBERED_PAT_KEY, {}, persistArea);
          if (remember) kept[origin] = token;
          else delete kept[origin];
          await persistArea.set({ [REMEMBERED_PAT_KEY]: kept });
        }
      },
      async getPat(origin) {
        const all = await read(PAT_KEY, {});
        if (all[origin]) return all[origin];
        if (!persistArea) return null;
        const kept = await read(REMEMBERED_PAT_KEY, {}, persistArea);
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
        const kept = await read(REMEMBERED_PAT_KEY, {}, persistArea);
        return Boolean(kept[origin]);
      },
      async clearPat(origin) {
        const all = await read(PAT_KEY, {});
        delete all[origin];
        await area.set({ [PAT_KEY]: all });
        if (persistArea) {
          const kept = await read(REMEMBERED_PAT_KEY, {}, persistArea);
          delete kept[origin];
          await persistArea.set({ [REMEMBERED_PAT_KEY]: kept });
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
