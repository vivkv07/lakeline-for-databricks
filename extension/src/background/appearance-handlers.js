/*
 * Background add-on for workspace colors. Colors themselves live in chrome.storage.local
 * ('dcc.appearance') and are written by the popup; the service worker only has to make sure
 * the content scripts run on a workspace the user just granted from the Workspace colors panel.
 *
 *   appearance:applyAccess {origin} (trust: page) → {granted, registered, injected}
 *
 * Registered through DCC.handlerFactories, so router.js needs no edit. No sign-in, helper or
 * SQL is involved, and billing state is never read or written here.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const errors = dep('errors', '../errors.js');
  const ids = dep('ids', '../core/ids.js');
  const registration = dep('registration', './registration.js');

  /** @param deps {store, secrets, data, helper, openPage, chromeApi} */
  function createHandlers(deps) {
    return {
      'appearance:applyAccess': {
        trust: 'page',
        async handle(msg) {
          const origin = msg && msg.origin;
          const cls = ids.classifyOrigin(typeof origin === 'string' ? origin : '');
          if (!cls.ok || cls.origin !== origin) throw new errors.DccError({ code: 'UNKNOWN', message: 'Not a supported Databricks workspace origin' });
          const pattern = registration.patternForOrigin(cls.origin);
          // Only act on access the user actually granted (exact origin or a wildcard family).
          const granted = Boolean(await deps.chromeApi.permissions.contains({ origins: [pattern] }));
          if (!granted) return { origin: cls.origin, granted: false, registered: false, injected: 0 };
          let matches;
          try {
            matches = await registration.sync(deps.chromeApi);
          } catch (_) {
            // permissions.onAdded runs its own sync for the same grant; if it registered first,
            // our register call fails as a duplicate. A second pass sees it and updates instead.
            matches = await registration.sync(deps.chromeApi);
          }
          const injected = await registration.injectIntoOpenTabs(deps.chromeApi, cls.origin);
          return { origin: cls.origin, granted: true, registered: matches.length > 0, injected };
        },
      },
    };
  }

  const api = Object.freeze({ createHandlers });
  if (NODE) module.exports = api;
  else {
    const DCC = root.DCC || (root.DCC = {});
    DCC.appearanceHandlers = api;
    (DCC.handlerFactories || (DCC.handlerFactories = [])).push(createHandlers);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
