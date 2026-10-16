/*
 * Content scripts are registered dynamically, only for workspace origins the user granted
 * through optional host permissions. Nothing runs on a site before that grant.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const ids = NODE ? require('../core/ids.js') : root.DCC.ids;

  const SCRIPT_ID = 'dcc-main';
  // Load order matters: shared core first, bootstrap last.
  const CONTENT_JS = Object.freeze([
    'src/core/validate.js',
    'src/core/ids.js',
    'src/core/periods.js',
    'src/core/labels.js',
    'src/core/allocation.js',
    'src/content/dom.js',
    'src/content/native-adapter.js',
    'src/content/workspace-data.js',
    'src/content/workspace-ui.js',
    'src/content/workspace-color.js',
    'src/content/workspace-theme.js',
    'src/content/row-refs.js',
    'src/content/row-data.js',
    'src/content/inline.js',
    'src/content/native-cost-data.js',
    'src/content/native-estimates-ui.js',
    'src/content/warehouse-ui.js',
    'src/explorer/explore-model.js',
    'src/explorer/explore-demo.js',
    'src/explorer/explore-data.js',
    'src/explorer/csv.js',
    'src/explorer/charts.js',
    'src/explorer/explorer.css.js',
    'src/explorer/explorer.js',
    'src/content/content-main.js',
  ]);
  const EXCLUDE = Object.freeze([
    'https://accounts.cloud.databricks.com/*',
    'https://accounts.azuredatabricks.net/*',
    'https://accounts.gcp.databricks.com/*',
  ]);
  const FIXTURE_PATTERN = ids.FIXTURE_ORIGIN + '/*';

  /** Only supported workspace patterns (wildcard families or exact hosts) and the fixture. */
  function isSupportedPattern(p) {
    if (ids.HOST_PATTERNS.includes(p) || p === FIXTURE_PATTERN) return true;
    const m = /^https:\/\/([a-z0-9.-]+)\/\*$/.exec(p);
    return Boolean(m && ids.classifyOrigin('https://' + m[1] + '/').ok);
  }

  function patternForOrigin(origin) {
    const cls = ids.classifyOrigin(origin);
    return cls.ok ? cls.origin + '/*' : null;
  }

  // A grant fires permissions.onAdded while the page that asked for it also requests a sync, so
  // calls are serialized: two interleaved "nothing registered yet → register" passes would fail
  // with "Duplicate script ID".
  let queue = Promise.resolve();

  function sync(chromeApi) {
    const run = queue.then(() => syncNow(chromeApi));
    queue = run.catch(() => {});
    return run;
  }

  async function syncNow(chromeApi) {
    const perms = await chromeApi.permissions.getAll();
    const matches = (perms.origins || []).filter(isSupportedPattern).sort();
    const existing = await chromeApi.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    if (!matches.length) {
      if (existing.length) await chromeApi.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      return [];
    }
    const def = { id: SCRIPT_ID, matches, excludeMatches: EXCLUDE.slice(), js: CONTENT_JS.slice(), runAt: 'document_idle', allFrames: false, persistAcrossSessions: true };
    if (existing.length) {
      await chromeApi.scripting.updateContentScripts([def]);
      return matches;
    }
    try {
      await chromeApi.scripting.registerContentScripts([def]);
    } catch (e) {
      // Registered by another extension context (e.g. an older service worker) in the meantime.
      if (!/Duplicate script ID/i.test(String(e && e.message))) throw e;
      await chromeApi.scripting.updateContentScripts([def]);
    }
    return matches;
  }

  /** After a grant, inject into tabs that are already open on that origin (guarded against double load). */
  async function injectIntoOpenTabs(chromeApi, origin) {
    const pattern = patternForOrigin(origin);
    if (!pattern) return 0;
    const tabs = await chromeApi.tabs.query({ url: pattern });
    let n = 0;
    for (const t of tabs) {
      try {
        await chromeApi.scripting.executeScript({ target: { tabId: t.id }, files: CONTENT_JS.slice() });
        n++;
      } catch (_) {
        /* tab may be discarded or navigating */
      }
    }
    return n;
  }

  const api = Object.freeze({ SCRIPT_ID, CONTENT_JS, EXCLUDE, isSupportedPattern, patternForOrigin, sync, injectIntoOpenTabs });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).registration = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
