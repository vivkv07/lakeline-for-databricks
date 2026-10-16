/*
 * SYNTHETIC FIXTURE SPA for Databricks Cost Companion tests. Not Databricks; made-up data only.
 *
 * - Routes with history.pushState under the fixture origin (deep links work because the server
 *   serves workspace.html for any non-file path; every asset URL here is root-relative).
 * - Each route renders a body fragment fetched from /fixture/<name>.html into <main>. A missing
 *   fragment renders a friendly placeholder. Fragment <script>s never run. The fixture server
 *   has already replaced the fragments' {{…}} ID placeholders (local/fixture-data.mjs).
 * - The toolbar (outside <main>) can replace <main> entirely, replace the top nav, run a
 *   continuous DOM mutation storm (clock updated every 50 ms) and simulate virtualized row
 *   recycling (row elements reused in place with new content and IDs on scroll).
 * - window.__fixture exposes the same controls for browser tests, and a `fixture:rendered`
 *   event fires on document after every route render.
 *
 * Fixture code only: fragments are same-origin static files written for tests, so they are
 * parsed as HTML through an inert <template>. Variable text is always set with textContent.
 */
(function () {
  'use strict';

  const WORKSPACE_ID = '1234567890';
  const IDS = Object.freeze({
    workspaceId: WORKSPACE_ID,
    // Synthetic IDs that exist in the fixture billing data (local/fixture-data.mjs). The fixture
    // server fills the fragments' {{…}} placeholders with the same IDs (job 101, pipeline P1,
    // warehouse W1), so connected mode shows simulated amounts on these routes.
    jobId: '101',
    // Yesterday's (UTC) run of job 101: job ID × 1,000,000 + UTC epoch day, as fixture-data.mjs
    // builds it (this page's clock; the server's own values are in its rendered fragments).
    runId: String(101 * 1000000 + Math.floor(Date.now() / 86400000) - 1),
    pipelineId: '5e1f0c2a-7b3d-4e8f-9a01-0000000000a1',
    warehouseId: '0a1b2c3d4e5f6071',
    folderId: '2001',
    notebookId: '3001',
    appName: 'cost-dashboard',
  });
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const UUID_RE = new RegExp('^' + UUID + '$', 'i');

  // Ordered: most specific first. `nav` marks the side-nav link to highlight.
  const ROUTES = [
    { name: 'home', re: /^\/(home\/?)?$/, fragment: 'shell-home.html', title: 'Home', nav: 'home' },
    { name: 'jobs', re: /^\/jobs\/?$/, fragment: 'jobs.html', title: 'Jobs', nav: 'jobs' },
    { name: 'job-run', re: /^\/jobs\/\d+\/runs\/\d+\/?$/, fragment: 'job-run.html', title: 'Job run', nav: 'job-runs' },
    { name: 'job-runs', re: /^\/jobs\/\d+(\/runs)?\/?$/, fragment: 'job-runs.html', title: 'Job runs', nav: 'job-runs' },
    { name: 'pipelines', re: /^\/pipelines\/?$/, fragment: 'pipelines.html', title: 'Pipelines', nav: 'pipeline-updates' },
    { name: 'pipeline-updates', re: new RegExp('^/pipelines/' + UUID + '(/updates(/' + UUID + ')?)?/?$', 'i'), fragment: 'pipeline-updates.html', title: 'Pipeline updates', nav: 'pipeline-updates' },
    { name: 'query-history', re: /^\/sql\/history(\/.*)?$/, fragment: 'query-history.html', title: 'Query history', nav: 'query-history' },
    { name: 'warehouses', re: /^\/sql\/warehouses\/?$/, fragment: 'warehouses-list.html', title: 'SQL warehouses', nav: 'warehouses' },
    { name: 'warehouse-size', re: /^\/sql\/warehouses\/([0-9a-f]{16}(\/edit)?|create)\/?$/, fragment: 'warehouse-size.html', title: 'SQL warehouse', nav: 'warehouse-size' },
    { name: 'compute-create', re: /^\/compute\/(create|clusters\/create|clusters\/[^/]+\/(edit|configuration))\/?$/, fragment: 'compute-create.html', title: 'Create compute', nav: 'compute-create' },
    { name: 'compute', re: /^\/compute(\/.*)?$/, fragment: 'compute.html', title: 'Compute', nav: 'compute-create' },
    { name: 'apps', re: /^\/apps(\/[a-z0-9-]+)?\/?$/, fragment: 'apps.html', title: 'Apps', nav: 'apps' },
    { name: 'notebooks', re: /^\/(workspace(\/.*)?|browse(\/.*)?|editor\/notebooks\/\d+\/?)$/, fragment: 'notebooks.html', title: 'Workspace', nav: 'notebooks' },
  ];
  // Legacy hash routes (`/#job/1/run/2`, `/#joblist/pipelines/<uuid>`, `/#notebook/<id>`).
  const HASH_ROUTES = [
    { name: 'legacy-job-run', re: /^#job\/\d+\/run\/\d+/, fragment: 'job-runs.html', title: 'Job run (legacy route)', nav: 'legacy-job-run' },
    { name: 'legacy-job', re: /^#job\/\d+/, fragment: 'job-runs.html', title: 'Job (legacy route)', nav: 'job-runs' },
    { name: 'legacy-pipeline', re: /^#joblist\/pipelines\//, fragment: 'pipeline-updates.html', title: 'Pipeline (legacy route)', nav: 'pipeline-updates' },
    { name: 'legacy-notebook', re: /^#notebook\/\d+/, fragment: 'notebooks.html', title: 'Notebook (legacy route)', nav: 'notebooks' },
  ];
  const UNKNOWN = { name: 'unknown', fragment: null, title: 'Unknown synthetic page', nav: null };
  const STORM_MS = 50;
  const VIRTUAL_CYCLES = 6; // virtual dataset = fragment rows × cycles
  const TABLES = 'table, [role="grid"], [role="table"], [role="treegrid"]';

  const state = {
    route: null,
    fragments: new Map(), // name → text | null (missing); cached per page load
    renderSeq: 0,
    renders: 0,
    mainReplacements: 0,
    navReplacements: 0,
    navTemplate: null,
    storm: null, // {timer, ticks}
    virtual: null, // {offset, total, rows, templates, scroller, onWheel}
  };

  /* ------------------------------------------------------------------ helpers */

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) node.setAttribute(k, String(v));
    for (const c of [].concat(children === undefined ? [] : children)) {
      if (c === null || c === undefined) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function currentMain() {
    return document.querySelector('main');
  }

  function currentNav() {
    return document.querySelector('nav[aria-label="Top Navigation"]');
  }

  /** Clone without anything the extension added (data-dcc nodes and data-dcc-* attributes). */
  function cleanClone(node) {
    const copy = node.cloneNode(true);
    for (const n of copy.querySelectorAll('[data-dcc]')) n.remove();
    for (const n of [copy, ...copy.querySelectorAll('*')]) {
      for (const a of [...n.attributes]) if (a.name === 'data-dcc' || a.name.startsWith('data-dcc-')) n.removeAttribute(a.name);
    }
    return copy;
  }

  function withO(path) {
    return path + (path.includes('?') ? '&' : '?') + 'o=' + WORKSPACE_ID;
  }

  function resolveRoute(loc) {
    const hash = loc.hash || '';
    if (hash.length > 1) for (const r of HASH_ROUTES) if (r.re.test(hash)) return r;
    for (const r of ROUTES) if (r.re.test(loc.pathname)) return r;
    return UNKNOWN;
  }

  /* ------------------------------------------------------------------ fragments */

  async function loadFragment(name) {
    if (state.fragments.has(name)) return state.fragments.get(name);
    let text = null;
    try {
      const res = await fetch('/fixture/' + name, { cache: 'no-store' });
      if (res.ok) text = await res.text();
    } catch (_) {
      text = null; // offline, file://, or no server: placeholder
    }
    state.fragments.set(name, text);
    return text;
  }

  /** Parse a body fragment inertly. Scripts are dropped; a stray <main> or top nav is unwrapped. */
  function parseFragment(text) {
    const tpl = document.createElement('template');
    tpl.innerHTML = text; // same-origin synthetic fixture file (see header)
    const frag = tpl.content;
    for (const s of frag.querySelectorAll('script')) s.remove();
    for (const nav of frag.querySelectorAll('nav[aria-label="Top Navigation"]')) nav.remove();
    for (const m of frag.querySelectorAll('main')) m.replaceWith(...m.childNodes);
    return document.importNode(frag, true);
  }

  function routeLinks() {
    const items = [
      ['Jobs', '/jobs'],
      ['Job ' + IDS.jobId + ' runs', '/jobs/' + IDS.jobId + '/runs'],
      ['Pipeline updates', '/pipelines/' + IDS.pipelineId],
      ['Query history', '/sql/history'],
      ['SQL warehouses', '/sql/warehouses'],
      ['Edit SQL warehouse', '/sql/warehouses/' + IDS.warehouseId + '/edit'],
      ['Create compute', '/compute/clusters/create'],
      ['Apps', '/apps'],
      ['Workspace', '/browse/folders/' + IDS.folderId],
    ];
    return el('ul', {}, items.map(([label, path]) => el('li', {}, el('a', { href: withO(path) }, label))));
  }

  function placeholder(route) {
    return el('section', { class: 'ws-placeholder', 'data-fx-placeholder': route.fragment || 'unknown-route' }, [
      el('h1', {}, route.title),
      route.fragment
        ? el('p', {}, ['This synthetic page has no fixture fragment yet. Add ', el('code', {}, 'local/fixture/' + route.fragment), ' to fill it in.'])
        : el('p', {}, ['No synthetic page is defined for ', el('code', {}, location.pathname), '.']),
      el('p', { class: 'ws-muted' }, 'Other synthetic pages:'),
      routeLinks(),
    ]);
  }

  function buildPage(route, text) {
    const page = el('div', { class: 'ws-page', 'data-fx-page': route.name });
    page.appendChild(typeof text === 'string' ? parseFragment(text) : placeholder(route));
    return page;
  }

  /* ------------------------------------------------------------------ routing */

  function markActiveNav(route) {
    for (const a of document.querySelectorAll('[data-fx-nav]')) {
      if (route.nav && a.getAttribute('data-fx-nav') === route.nav) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  async function render() {
    const seq = ++state.renderSeq;
    const route = resolveRoute(location);
    state.route = route;
    document.title = route.title + ' · Synthetic Workspace Fixture';
    markActiveNav(route);
    const text = route.fragment ? await loadFragment(route.fragment) : null;
    if (seq !== state.renderSeq) return; // a newer navigation won
    const main = currentMain();
    // Like an SPA route change: swap the page content, keep <main> (and whatever the extension
    // put at its top).
    const page = buildPage(route, text);
    const old = main.querySelector(':scope > [data-fx-page]');
    if (old) old.replaceWith(page);
    else main.appendChild(page);
    main.scrollTop = 0;
    state.renders++;
    if (state.virtual) attachVirtual();
    updateStatus();
    document.dispatchEvent(new CustomEvent('fixture:rendered', { detail: { route: route.name, fragment: route.fragment, missing: typeof text !== 'string' } }));
  }

  /** SPA navigation to a same-origin path (adds nothing; pass ?o= yourself, as native links do). */
  function navigate(href) {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) throw new Error('Fixture navigation stays on the fixture origin');
    const next = url.pathname + url.search + url.hash;
    if (next !== location.pathname + location.search + location.hash) history.pushState({ fixture: true }, '', next);
    return render();
  }

  function onClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download') || a.closest('[data-dcc]')) return;
    const url = new URL(a.getAttribute('href'), location.href);
    if (url.origin !== location.origin || url.pathname.startsWith('/fixture/')) return;
    e.preventDefault();
    navigate(url.href);
  }

  /* ------------------------------------------------------------------ replacement toggles */

  /** Replace <main> with a new element rendered from scratch (no extension nodes survive). */
  function replaceMain() {
    const old = currentMain();
    const fresh = document.createElement('main');
    for (const a of old.attributes) if (!a.name.startsWith('data-dcc')) fresh.setAttribute(a.name, a.value);
    const route = state.route || resolveRoute(location);
    const text = route.fragment ? state.fragments.get(route.fragment) : null;
    fresh.appendChild(buildPage(route, text));
    old.replaceWith(fresh);
    state.mainReplacements++;
    if (state.storm) stormNode();
    if (state.virtual) attachVirtual();
    updateStatus();
    return fresh;
  }

  /** Replace the top nav with a fresh copy of its template (extension marks don't survive). */
  function replaceNav() {
    const old = currentNav();
    if (!old || !state.navTemplate) return null;
    const fresh = state.navTemplate.cloneNode(true);
    old.replaceWith(fresh);
    state.navReplacements++;
    updateStatus();
    return fresh;
  }

  /** Use the shared /fixture/topbar.html top bar (and its styles) when that fragment exists. */
  async function upgradeTopNav() {
    const text = await loadFragment('topbar.html');
    if (typeof text !== 'string') return false;
    const tpl = document.createElement('template');
    tpl.innerHTML = text;
    const nav = tpl.content.querySelector('nav[aria-label="Top Navigation"]');
    if (!nav) return false;
    for (const style of tpl.content.querySelectorAll('style')) {
      const key = style.getAttribute('data-fixture') || 'topbar';
      if (!document.head.querySelector('style[data-fixture="' + key + '"]')) {
        const copy = document.importNode(style, true);
        copy.setAttribute('data-fixture', key);
        document.head.appendChild(copy);
      }
    }
    state.navTemplate = cleanClone(document.importNode(nav, true));
    replaceNav();
    return true;
  }

  /* ------------------------------------------------------------------ mutation storm */

  function stormNode() {
    const main = currentMain();
    let node = main.querySelector(':scope > [data-fx-storm]');
    if (!node) {
      node = el('p', { class: 'ws-storm', 'data-fx-storm': '', 'aria-hidden': 'true' });
      main.appendChild(node);
    }
    return node;
  }

  function setStorm(on) {
    if (on && !state.storm) {
      const storm = { ticks: 0, timer: null };
      storm.timer = setInterval(() => {
        storm.ticks++;
        stormNode().textContent = 'Synthetic clock ' + new Date().toISOString().slice(11, 23) + ' · tick ' + storm.ticks;
      }, STORM_MS);
      state.storm = storm;
    } else if (!on && state.storm) {
      clearInterval(state.storm.timer);
      state.storm = null;
      const node = currentMain().querySelector(':scope > [data-fx-storm]');
      if (node) node.remove();
    }
    updateStatus();
    return Boolean(state.storm);
  }

  /* ------------------------------------------------------------------ virtualized rows */

  function findRows(scope) {
    for (const table of scope.querySelectorAll(TABLES)) {
      const rows = [...table.querySelectorAll('tr, [role="row"]')].filter(
        (r) => r.closest(TABLES) === table && !r.closest('thead, [data-dcc]') && !r.querySelector('th, [role="columnheader"]')
      );
      if (rows.length) return { table, rows };
    }
    return null;
  }

  function shiftHex(id, cycle) {
    const tail = id.slice(-4);
    const next = ((parseInt(tail, 16) + cycle * 0x0101) & 0xffff).toString(16).padStart(4, '0');
    return id.slice(0, -4) + (tail === tail.toUpperCase() && /[A-F]/.test(tail) ? next.toUpperCase() : next);
  }

  /** IDs a recycled row should change: the last ID-like path segment of each link, plus UUID query values (never o=). */
  function rowIdMap(node, cycle) {
    const map = new Map();
    for (const a of [node, ...node.querySelectorAll('[href]')]) {
      if (!a.hasAttribute || !a.hasAttribute('href')) continue;
      let url;
      try {
        url = new URL(a.getAttribute('href'), location.origin);
      } catch (_) {
        continue;
      }
      const segs = url.pathname.split('/').filter(Boolean);
      for (let i = segs.length - 1; i >= 0; i--) {
        const s = segs[i];
        if (/^\d{1,15}$/.test(s)) map.set(s, String(Number(s) + cycle * 100000));
        else if (/^[0-9a-f]{16}$/i.test(s) || UUID_RE.test(s)) map.set(s, shiftHex(s, cycle));
        else continue;
        break;
      }
      for (const [k, v] of url.searchParams) if (k !== 'o' && UUID_RE.test(v)) map.set(v, shiftHex(v, cycle));
    }
    return map;
  }

  function rewriteIds(node, cycle) {
    if (!cycle) return;
    const map = rowIdMap(node, cycle);
    if (!map.size) return;
    const swap = (text) => {
      let out = text;
      for (const [from, to] of map) out = out.replace(new RegExp('(?<![0-9A-Za-z])' + from.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + '(?![0-9A-Za-z])', 'g'), to);
      return out;
    };
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = node; n; n = walker.nextNode()) {
      if (n.nodeType === 3) n.nodeValue = swap(n.nodeValue);
      else for (const a of [...n.attributes]) if (a.value) n.setAttribute(a.name, swap(a.value));
    }
  }

  /**
   * Update `target` in place to match `source`, the way a virtualized list reuses row elements:
   * same nodes, new text and attributes. Extension nodes (data-dcc) and data-dcc-* attributes
   * are left where they are, so stale badges stay unless the extension removes them.
   */
  function patch(target, source) {
    for (const a of [...target.attributes]) if (!a.name.startsWith('data-dcc') && !source.hasAttribute(a.name)) target.removeAttribute(a.name);
    for (const a of [...source.attributes]) if (target.getAttribute(a.name) !== a.value) target.setAttribute(a.name, a.value);
    const tKids = [...target.childNodes].filter((n) => !(n.nodeType === 1 && n.hasAttribute('data-dcc')));
    const sKids = [...source.childNodes];
    sKids.forEach((s, i) => {
      const t = tKids[i];
      if (t && t.nodeType === s.nodeType && t.nodeName === s.nodeName) {
        if (s.nodeType === 1) patch(t, s);
        else if (t.nodeValue !== s.nodeValue) t.nodeValue = s.nodeValue;
      } else if (t) t.replaceWith(s);
      else target.appendChild(s);
    });
    for (let i = sKids.length; i < tKids.length; i++) tKids[i].remove();
  }

  function detachVirtual() {
    const v = state.virtual;
    if (v && v.scroller && v.onWheel) {
      v.scroller.removeEventListener('wheel', v.onWheel);
      v.scroller.removeAttribute('data-fx-virtual');
    }
  }

  function attachVirtual() {
    const v = state.virtual;
    if (!v) return;
    detachVirtual();
    const page = currentMain().querySelector(':scope > [data-fx-page]');
    const found = page ? findRows(page) : null;
    Object.assign(v, { offset: 0, total: 0, rows: [], templates: [], scroller: null, onWheel: null });
    if (!found) return;
    v.rows = found.rows;
    v.templates = found.rows.map(cleanClone);
    v.total = v.templates.length * VIRTUAL_CYCLES;
    v.scroller = found.table;
    v.onWheel = (e) => {
      if (!e.deltaY) return;
      e.preventDefault();
      scrollRows(e.deltaY > 0 ? 1 : -1);
    };
    v.scroller.addEventListener('wheel', v.onWheel, { passive: false });
    v.scroller.setAttribute('data-fx-virtual', '');
  }

  function setVirtual(on) {
    if (on && !state.virtual) {
      state.virtual = {};
      attachVirtual();
    } else if (!on && state.virtual) {
      detachVirtual();
      state.virtual = null;
    }
    updateStatus();
    return Boolean(state.virtual);
  }

  /** Recycle the visible rows by `delta` virtual positions. Returns false at either end. */
  function scrollRows(delta) {
    const v = state.virtual;
    if (!v || !v.rows || !v.rows.length) return false;
    const next = Math.max(0, Math.min(v.total - v.rows.length, v.offset + delta));
    if (next === v.offset) return false;
    v.offset = next;
    v.rows.forEach((row, j) => {
      const index = v.offset + j;
      const template = v.templates[index % v.templates.length];
      const src = template.cloneNode(true);
      rewriteIds(src, Math.floor(index / v.templates.length));
      src.setAttribute('data-fx-virtual-index', String(index));
      if (template.hasAttribute('aria-rowindex')) src.setAttribute('aria-rowindex', String(index + 2));
      patch(row, src);
    });
    updateStatus();
    return true;
  }

  /* ------------------------------------------------------------------ toolbar */

  function updateStatus() {
    const out = document.querySelector('[data-fx-status]');
    const route = state.route || UNKNOWN;
    const v = state.virtual;
    const missing = route.fragment && state.fragments.get(route.fragment) === null;
    const bits = [
      'route ' + route.name + (route.fragment ? ' (' + route.fragment + (missing ? ', missing' : '') + ')' : ''),
      'main replaced ' + state.mainReplacements + '×',
      state.storm ? 'storm on' : null,
      v ? (v.rows && v.rows.length ? 'virtual rows ' + (v.offset + 1) + '–' + (v.offset + v.rows.length) + ' of ' + v.total : 'virtual rows: no table') : null,
    ].filter(Boolean);
    const text = bits.join(' · ');
    if (out && out.textContent !== text) out.textContent = text;
    for (const b of document.querySelectorAll('[data-fx-action="storm"]')) b.setAttribute('aria-pressed', String(Boolean(state.storm)));
    for (const b of document.querySelectorAll('[data-fx-action="virtualize"]')) b.setAttribute('aria-pressed', String(Boolean(v)));
    for (const b of document.querySelectorAll('[data-fx-action="rows-up"], [data-fx-action="rows-down"]')) b.disabled = !(v && v.rows && v.rows.length);
  }

  const ACTIONS = {
    'replace-main': () => replaceMain(),
    'replace-nav': () => replaceNav(),
    storm: () => setStorm(!state.storm),
    virtualize: () => setVirtual(!state.virtual),
    'rows-up': () => scrollRows(-3),
    'rows-down': () => scrollRows(3),
  };

  function onToolbarClick(e) {
    const b = e.target && e.target.closest ? e.target.closest('[data-fx-action]') : null;
    if (!b || !ACTIONS[b.getAttribute('data-fx-action')]) return;
    ACTIONS[b.getAttribute('data-fx-action')]();
  }

  /* ------------------------------------------------------------------ boot */

  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));

  function boot() {
    const nav = currentNav();
    state.navTemplate = nav ? cleanClone(nav) : null;
    document.addEventListener('click', onClick);
    const bar = document.querySelector('[data-fixture-toolbar]');
    if (bar) bar.addEventListener('click', onToolbarClick);
    window.addEventListener('popstate', () => render());
    window.addEventListener('hashchange', () => render());
    Promise.all([upgradeTopNav(), render()]).then(() => resolveReady());
  }

  // Available immediately; `ready` resolves after the first route render and top-bar upgrade.
  window.__fixture = Object.freeze({
    WORKSPACE_ID,
    IDS,
    routes: ROUTES.concat(HASH_ROUTES).map((r) => ({ name: r.name, fragment: r.fragment, title: r.title })),
    ready,
    navigate,
    render,
    replaceMain,
    replaceNav,
    setStorm,
    setVirtual,
    scrollRows,
    info: () => ({
      route: state.route && state.route.name,
      fragment: state.route && state.route.fragment,
      renders: state.renders,
      mainReplacements: state.mainReplacements,
      navReplacements: state.navReplacements,
      storm: state.storm ? state.storm.ticks : null,
      virtual: state.virtual ? { offset: state.virtual.offset, total: state.virtual.total, rows: (state.virtual.rows || []).length } : null,
    }),
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
