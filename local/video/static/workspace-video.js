/*
 * SYNTHETIC launch-video shell helpers (local/video/shell.html). Fixture code, not the extension.
 * After every route render of /workspace.js:
 *   - elements with data-np-path="<regex>" stay only when the page path matches it, so one
 *     fragment can describe several detail pages (e.g. two jobs on /jobs/<id>/runs);
 *   - the side-nav link for the route gets aria-current="page".
 */
(function () {
  'use strict';
  const NAV = { home: 'home', jobs: 'jobs', 'job-runs': 'jobs', 'job-run': 'jobs', 'pipeline-updates': 'jobs', pipelines: 'jobs', 'query-history': 'history', warehouses: 'warehouses', 'warehouse-size': 'warehouses', compute: 'compute', 'compute-create': 'compute' };

  function onRendered(ev) {
    const route = (ev.detail && ev.detail.route) || '';
    for (const el of document.querySelectorAll('main [data-np-path]')) {
      let keep = false;
      try {
        keep = new RegExp(el.getAttribute('data-np-path')).test(location.pathname);
      } catch (_) {
        keep = false;
      }
      if (!keep) el.remove();
      else el.removeAttribute('data-np-path');
    }
    const want = NAV[route] || null;
    for (const a of document.querySelectorAll('[data-np-nav]')) {
      if (want && a.getAttribute('data-np-nav') === want) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  document.addEventListener('fixture:rendered', onRendered);
})();
