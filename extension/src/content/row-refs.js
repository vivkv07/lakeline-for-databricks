/*
 * Native resource references for inline badges, read from real hrefs only
 * (ids.parseResourceLink bound to the page origin and workspace ID). Never from names, text or
 * application-private React state.
 *
 * Page policies (from the page URL):
 *   job detail       title = job (period); rows = runs of THIS job only (a row's "Launched"
 *                    column may link another workflow; that link is ignored, never substituted)
 *   job run detail   title = that run (execution); no rows (task runs are not job runs)
 *   pipeline detail  title = pipeline (period); rows = updates of THIS pipeline only
 *   runs list        rows = the row's run (first run link in DOM order)
 *   query history    nothing (per-query estimates are a separate feature; no warehouse totals)
 *   anything else    rows = the row's resource link (job, pipeline, warehouse, notebook, app),
 *                    else its run/update link
 * Rows are semantic table/grid rows or list items. Links inside navigation, menus, dialogs,
 * SVG/timeline graphics, aria-hidden regions or our own nodes are skipped, as are text-less or
 * tiny links (status dots, duration bars).
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const ids = dep('ids', '../core/ids.js');
  const dom = dep('dom', './dom.js');
  const native = dep('native', './native-adapter.js');

  const XHTML = 'http://www.w3.org/1999/xhtml';
  const ROW_SEL = '[role="row"], tr, [role="listitem"]';
  const HEADER_ROW_SEL = 'thead';
  const SKIP_SEL = [
    '[data-dcc]',
    'nav',
    'aside',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="menu"]',
    '[role="menubar"]',
    '[role="tablist"]',
    '[role="tooltip"]',
    '[role="dialog"]',
    '[role="img"]',
    '[role="progressbar"]',
    '[aria-hidden="true"]',
    'svg',
  ].join(', ');
  const RESOURCE_TYPES = ['job', 'pipeline', 'warehouse', 'notebook', 'app'];
  const EXECUTION_TYPES = ['job_run', 'pipeline_update'];
  const MIN_W = 8;
  const MIN_H = 6;

  function safeUrl(href) {
    try {
      return new URL(href);
    } catch (_) {
      return null;
    }
  }

  /** Which references this page shows, from its own URL. */
  function pageContext(href) {
    const url = safeUrl(href);
    if (!url) return { policy: 'none', title: null };
    const route = ids.parsePageRoute(href);
    const type = route && route.type;
    if (type === 'query_history') return { policy: 'none', title: null };
    if (type === 'job') return { policy: 'job', jobId: route.jobId, title: ids.sanitizeRef(route) };
    if (type === 'job_run') return { policy: 'job_run', jobId: route.jobId, title: ids.sanitizeRef(route) };
    if (type === 'pipeline' || type === 'pipeline_update') {
      return { policy: 'pipeline', pipelineId: route.pipelineId, title: ids.sanitizeRef({ type: 'pipeline', pipelineId: route.pipelineId }) };
    }
    if (/^\/jobs\/runs\/?$/.test(url.pathname) || /^#job\/?list\/runs\b/.test(url.hash)) return { policy: 'runs_list', title: null };
    return { policy: 'generic', title: null };
  }

  function rectOf(el) {
    try {
      return el.getBoundingClientRect();
    } catch (_) {
      return null;
    }
  }

  /** Layout-free environments report all-zero rects; treat those as "unknown", not hidden. */
  function hasLayout(rect) {
    return Boolean(rect && (rect.width || rect.height || rect.top || rect.left));
  }

  function textOf(a) {
    let t = '';
    for (const n of a.childNodes) {
      if (n.nodeType === 3) t += n.nodeValue;
      else if (n.nodeType === 1 && !n.hasAttribute('data-dcc')) t += n.textContent;
      if (t.trim()) return true;
    }
    return false;
  }

  /** A link that names a resource in a row: visible, has text, not a dot/bar/graphic/nav item. */
  function usableAnchor(a) {
    if (!a || a.namespaceURI !== XHTML || !a.isConnected) return false;
    if (a.closest(SKIP_SEL)) return false;
    if (!textOf(a)) return false;
    if (!dom.isVisible(a)) return false;
    if (typeof a.checkVisibility === 'function' && !a.checkVisibility()) return false;
    const rect = rectOf(a);
    if (hasLayout(rect) && (rect.width < MIN_W || rect.height < MIN_H)) return false;
    return true;
  }

  /** Near the viewport (one screen of margin). Unknown geometry counts as near. */
  function nearViewport(el) {
    const rect = rectOf(el);
    if (!hasLayout(rect)) return true;
    const win = el.ownerDocument.defaultView;
    const h = (win && win.innerHeight) || 800;
    return rect.bottom >= -h && rect.top <= 2 * h;
  }

  function isHeaderRow(row) {
    if (row.closest(HEADER_ROW_SEL)) return true;
    return Boolean(row.querySelector('[role="columnheader"], th[scope="col"]')) && !row.querySelector('[role="gridcell"], [role="cell"], td');
  }

  /** Per-anchor parse cache, keyed by the href attribute and the page identity. */
  function createScanner() {
    const cache = new WeakMap();

    function refFor(a, origin, workspaceId) {
      const href = a.getAttribute('href') || '';
      const ctxKey = origin + '|' + workspaceId + '|' + href;
      const hit = cache.get(a);
      if (hit && hit.ctxKey === ctxKey) return hit.ref;
      const parsed = ids.parseResourceLink(href, origin, workspaceId);
      const ref = parsed && parsed.type !== 'statement' ? ids.sanitizeRef(parsed) : null;
      cache.set(a, { ctxKey, ref });
      return ref;
    }

    function choose(cands, ctx) {
      switch (ctx.policy) {
        case 'job':
          return cands.find((c) => c.ref.type === 'job_run' && c.ref.jobId === ctx.jobId) || null;
        case 'pipeline':
          return cands.find((c) => c.ref.type === 'pipeline_update' && c.ref.pipelineId === ctx.pipelineId) || null;
        case 'runs_list':
          return cands.find((c) => EXECUTION_TYPES.includes(c.ref.type)) || null;
        case 'generic':
          return cands.find((c) => RESOURCE_TYPES.includes(c.ref.type)) || cands.find((c) => EXECUTION_TYPES.includes(c.ref.type)) || null;
        default:
          return null;
      }
    }

    /**
     * @param {Document} doc
     * @param {{origin, workspaceId, href}} page
     * @returns {{context, title: {ref, key, heading}|null, rows: [{row, anchor, ref, key}]}}
     */
    function scan(doc, page) {
      const context = pageContext(page.href);
      const out = { context, title: null, rows: [] };
      if (context.policy === 'none' || !page.workspaceId) return out;
      if (context.title) {
        const heading = native.findPageTitle(doc);
        if (heading) out.title = { ref: context.title, key: ids.refKey(context.title), heading };
      }
      if (context.policy === 'job_run') return out;
      const byRow = new Map();
      for (const a of doc.querySelectorAll('a[href]')) {
        const row = a.closest(ROW_SEL);
        if (!row) continue;
        const ref = refFor(a, page.origin, page.workspaceId);
        if (!ref || !usableAnchor(a)) continue;
        if (!byRow.has(row)) byRow.set(row, []);
        byRow.get(row).push({ anchor: a, ref });
      }
      for (const [row, cands] of byRow) {
        if (isHeaderRow(row)) continue;
        const pick = choose(cands, context);
        if (pick) out.rows.push({ row, anchor: pick.anchor, ref: pick.ref, key: ids.refKey(pick.ref) });
      }
      return out;
    }

    return { scan, refFor };
  }

  const api = Object.freeze({ ROW_SEL, SKIP_SEL, pageContext, usableAnchor, nearViewport, createScanner });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).rowRefs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
