/*
 * Cost Explorer inside the expandable banner (shadow DOM). DCC.explorer.mount(panel, ctx,
 * bannerState) renders six views (Products, Top drivers, Runs, Calendar, SKUs, Daily detail)
 * with keyboard-operable tabs, drilldowns (product, resource, run, SKU, day), breadcrumbs,
 * removable filter chips, search, sort, share of total where valid, reset, compact/expanded
 * layouts, exact values on hover/tap/focus, and CSV export of the current table.
 *
 * Products, SKUs, Calendar and Daily use the banner summary (demo, import and connected).
 * Top drivers, Runs and the ownership breakdown need an explicit Load (never automatic SQL).
 * View state lives in a per-workspace session so a re-mounted panel keeps its place.
 * All page and billing text is inserted as text nodes; links are validated native routes only.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const dom = dep('dom', '../content/dom.js');
  const labels = dep('labels', '../core/labels.js');
  const periods = dep('periods', '../core/periods.js');
  const M = dep('exploreModel', './explore-model.js');
  const D = dep('exploreData', './explore-data.js');
  const C = dep('exploreCharts', './charts.js');
  const CSV = dep('exploreCsv', './csv.js');
  const STYLE = dep('explorerCss', './explorer.css.js').CSS;
  const theme = dep('theme', '../core/theme.js');

  const VIEWS = Object.freeze([
    { id: 'products', label: 'Products' },
    { id: 'drivers', label: 'Top drivers' },
    { id: 'runs', label: 'Runs' },
    { id: 'calendar', label: 'Calendar' },
    { id: 'skus', label: 'SKUs' },
    { id: 'daily', label: 'Daily detail' },
  ]);
  const SORTS = Object.freeze([
    ['cost', 'desc', 'Cost: high to low'],
    ['cost', 'asc', 'Cost: low to high'],
    ['change', 'desc', 'Change: largest increase first'],
    ['change', 'asc', 'Change: largest decrease first'],
    ['name', 'asc', 'Name: A to Z'],
    ['name', 'desc', 'Name: Z to A'],
  ]);
  const FILTER_NAMES = Object.freeze({ owner: 'Owner type', product: 'Product', sku: 'SKU', resource: 'Resource', run: 'Run', day: 'Day' });
  // Calendar intensity: one blue hue, index 0 = no cost; light steps darken, dark steps brighten.
  const RAMPS = Object.freeze({
    light: Object.freeze(['#F6F6F7', '#DCE5FF', '#B9C8FA', '#8DA6F4', '#5F80EF', '#2F5BEA']),
    dark: Object.freeze(['#141416', '#132447', '#1E3A7A', '#2F5BC2', '#4677F0', '#8FB0FF']),
  });
  const COMPACT_BELOW_PX = 700;
  const OWNERSHIP_NOTE =
    'Explorer ownership is exclusive: each billing record counts once, for the first of job → pipeline → SQL warehouse → notebook → app → cluster → unattributed. Native badges can show broader related-workload attribution (for example, a job badge can include pipelines that job triggered), so Explorer and badge amounts can differ. Badge amounts are never added into workspace totals.';
  const HEURISTIC_NOTE = 'Flags are explanatory heuristics, not confirmed anomalies or causes.';

  const sessions = new Map();

  function sessionFor(ctx, mode) {
    const c = ctx.connection || {};
    const k = [ctx.origin, ctx.workspaceId, mode, c.priceTable || '', c.currency || ''].join('|');
    if (!sessions.has(k)) {
      sessions.set(k, { view: 'products', layout: 'auto', filters: {}, order: [], search: '', sort: { key: 'cost', dir: 'desc' }, dimension: 'product', loads: new Map(), periodKey: null, overlap: null, app: null });
    }
    return sessions.get(k);
  }

  /* ------------------------------------------------------------------ formatting */

  function fmtDate(date, withWeekday = true, withYear = true) {
    const o = { month: 'short', day: 'numeric', timeZone: 'UTC' };
    if (withWeekday) o.weekday = 'short';
    if (withYear) o.year = 'numeric';
    return new Date(periods.dateToMs(date)).toLocaleDateString('en-US', o);
  }

  function statusText(status) {
    return { complete: 'complete', partial: 'priced subtotal (some usage unpriced)', unpriced: 'no priced usage', unavailable: 'unavailable', 'no-usage': 'no usage recorded' }[status] || status || '';
  }

  function pct(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0) + '%';
  }

  function makeFmt(currency) {
    const money = (v) => labels.formatAmount(v, currency);
    const axis = (v) => {
      if (!Number.isFinite(v)) return '';
      if (v !== 0 && Math.abs(v) < 1) return labels.formatAmount(v, currency);
      return new Intl.NumberFormat('en-US', { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(v);
    };
    // Amount with its status, never rendering missing as zero.
    const amount = (cost, status) => {
      if (status === 'unavailable') return 'unavailable';
      if (status === 'no-usage') return 'no usage';
      if (status === 'unpriced' || cost === null || cost === undefined) return 'unpriced';
      return money(cost) + (status === 'partial' ? ' (priced subtotal)' : '');
    };
    const change = (ch) => {
      if (!ch) return null;
      const p = pct(ch.pct);
      return (ch.abs > 0 ? '+' : '') + money(ch.abs) + (p ? ' (' + p + ')' : ' (no prior spend)');
    };
    const share = (v) => (v === null || v === undefined ? null : (v * 100).toFixed(v * 100 < 10 ? 1 : 0) + '%');
    return { money, axis, amount, change, share };
  }

  function durationMinutesLabel(min) {
    if (!Number.isFinite(min)) return '';
    if (min < 60) return Math.round(min) + 'm';
    const hrs = min / 60;
    return (Number.isInteger(hrs) ? String(hrs) : hrs.toFixed(hrs < 10 ? 1 : 0)) + 'h';
  }

  /**
   * Light or dark, matching the Databricks page behind the banner: the banner's own pick when it
   * sets one on its host, otherwise the luminance rule on the element the banner sits in.
   */
  function themeOf(panel, doc) {
    if (!theme) return 'light';
    const rootNode = panel && panel.getRootNode ? panel.getRootNode() : null;
    const host = rootNode && rootNode.host;
    if (host) {
      const picked = host.getAttribute('data-dcc-theme');
      if (picked === 'dark' || picked === 'light') return picked;
      return theme.pickForElement(host.parentElement || doc.body);
    }
    return theme.pickForPage(doc);
  }

  /* ------------------------------------------------------------------ mount */

  /**
   * @param {HTMLElement} panel  element inside the banner's shadow root
   * @param {object} ctx         feature context {doc, origin, workspaceId, settings, connection, data}
   * @param {object} bannerState {status, summary, periodDays, nowMs}
   * @returns {{destroy(), rerender()}}
   */
  function mount(panel, ctx, bannerState) {
    const doc = panel.ownerDocument;
    const summary = (bannerState && bannerState.summary) || null;
    const nowMs = (bannerState && bannerState.nowMs) || Date.now();
    const model = M.normalize(summary, { periodDays: bannerState && bannerState.periodDays, nowMs, mode: ctx.settings && ctx.settings.mode });
    const sess = sessionFor(ctx, model.mode);
    const periodKey = model.period.start + '|' + model.period.days;
    if (sess.periodKey !== periodKey) {
      if (sess.filters.day && !model.dates.includes(sess.filters.day)) removeFilter(sess, 'day');
      removeFilter(sess, 'run');
      sess.overlap = null;
      sess.periodKey = periodKey;
    }
    const style = doc.createElement('style');
    style.setAttribute('data-dcc', 'explorer');
    style.textContent = STYLE;
    const rootEl = doc.createElement('div');
    rootEl.className = 'dcc-x';
    rootEl.setAttribute('data-dcc', 'explorer');
    panel.append(style, rootEl);
    const app = {
      doc,
      panel,
      root: rootEl,
      ctx,
      bannerState,
      summary,
      model,
      sess,
      fmt: makeFmt(model.currency),
      tip: null,
      inspectEl: null,
      table: null,
      pendingFocus: null,
      destroyed: false,
    };
    sess.app = app;
    render(app);
    // Auto layout: re-render only when the panel crosses the compact threshold.
    let ro = null;
    const check = () => {
      if (!app.destroyed && app.root.isConnected && isCompact(app) !== app.compact) render(app);
    };
    const win = doc.defaultView;
    if (win && typeof win.ResizeObserver === 'function') {
      ro = new win.ResizeObserver(check);
      ro.observe(panel);
    } else if (win) win.setTimeout(check, 0);
    // Follow the banner when the page switches between light and dark.
    let mo = null;
    const host = panel.getRootNode && panel.getRootNode().host;
    if (host && win && typeof win.MutationObserver === 'function') {
      mo = new win.MutationObserver(() => {
        if (!app.destroyed && app.root.isConnected && themeOf(app.panel, app.doc) !== app.theme) render(app);
      });
      mo.observe(host, { attributes: true, attributeFilter: ['data-dcc-theme'] });
    }
    return {
      destroy() {
        app.destroyed = true;
        if (ro) ro.disconnect();
        if (mo) mo.disconnect();
        if (sess.app === app) sess.app = null;
        rootEl.remove();
        style.remove();
      },
      rerender: () => render(app),
      app,
    };
  }

  /* ------------------------------------------------------------------ state helpers */

  function setFilter(sess, name, value) {
    sess.order = sess.order.filter((n) => n !== name);
    if (value === null || value === undefined || value === '') {
      delete sess.filters[name];
      return;
    }
    sess.filters[name] = value;
    sess.order.push(name);
  }

  function removeFilter(sess, name) {
    setFilter(sess, name, null);
    if (name === 'resource') {
      setFilter(sess, 'run', null);
      sess.overlap = null;
    }
  }

  function filterText(name, v) {
    if (name === 'resource') return M.entityLabel(v) + (v.ownerType !== 'unattributed' && v.name ? ' (' + M.OWNER_LABELS[v.ownerType] + ')' : '');
    if (name === 'run') return v.runId + (v.jobName ? ' of ' + v.jobName : '');
    if (name === 'day') return fmtDate(v, true, false);
    if (name === 'owner') return M.OWNER_LABELS[v] || v;
    return String(v);
  }

  function summaryFilters(app, includeOwner) {
    const f = app.sess.filters;
    const out = {};
    if (f.product) out.product = f.product;
    if (f.sku) out.sku = f.sku;
    if (includeOwner && f.owner) out.owner = f.owner;
    return out;
  }

  function loadKey(kind, args, scope) {
    return kind + '|' + args.periodDays + '|' + (scope || '');
  }

  function loadState(app, kind, args, scope) {
    const key = loadKey(kind, args, scope);
    let st = app.sess.loads.get(key);
    if (!st) {
      const hit = D.shared.peek(app.ctx, kind, args, scope, app.summary);
      if (hit) {
        st = Object.assign({ at: Date.now() }, hit);
        app.sess.loads.set(key, st);
      }
    }
    return st || null;
  }

  function startLoad(app, kind, args, scope, force) {
    const sess = app.sess;
    const key = loadKey(kind, args, scope);
    sess.loads.set(key, { status: 'loading' });
    app.pendingFocus = 'view';
    render(app);
    D.shared.load(app.ctx, kind, args, scope, { summary: app.summary, force: Boolean(force) }).then((res) => {
      if (res.status === 'stale') sess.loads.delete(key);
      else sess.loads.set(key, Object.assign({ at: Date.now() }, res));
      const cur = sess.app;
      if (cur && !cur.destroyed && cur.root.isConnected) render(cur);
    });
  }

  function isCompact(app) {
    if (app.sess.layout === 'compact') return true;
    if (app.sess.layout === 'expanded') return false;
    const w = app.panel.clientWidth || 0;
    return w > 0 && w < COMPACT_BELOW_PX;
  }

  /* ------------------------------------------------------------------ rendering */

  function h(app, tag, attrs, children) {
    return dom.h(app.doc, tag, attrs, children);
  }

  function captureFocus(app) {
    if (app.pendingFocus) {
      const fk = app.pendingFocus;
      app.pendingFocus = null;
      return { fk, force: true };
    }
    const rootNode = app.root.getRootNode ? app.root.getRootNode() : app.doc;
    const a = rootNode && rootNode.activeElement;
    if (!a || !app.root.contains(a)) return null;
    return { fk: a.getAttribute('data-fk'), sel: typeof a.selectionStart === 'number' ? a.selectionStart : null };
  }

  function restoreFocus(app, f) {
    if (!f) return;
    let target = null;
    if (f.fk) for (const el of app.root.querySelectorAll('[data-fk]')) if (el.getAttribute('data-fk') === f.fk) target = target || el;
    if (!target) target = app.root.querySelector('.x-view');
    if (!target) return;
    try {
      target.focus({ preventScroll: true });
      if (f.sel !== null && f.sel !== undefined && typeof target.setSelectionRange === 'function') target.setSelectionRange(f.sel, f.sel);
    } catch (_) {
      /* best effort */
    }
  }

  function render(app) {
    if (app.destroyed) return;
    const focus = captureFocus(app);
    const compact = isCompact(app);
    app.compact = compact;
    app.table = null;
    app.root.className = 'dcc-x ' + (compact ? 'compact' : 'expanded');
    app.theme = themeOf(app.panel, app.doc);
    if (app.root.getAttribute('data-theme') !== app.theme) app.root.setAttribute('data-theme', app.theme);
    app.colors = C.colors(app.theme);
    app.root.textContent = '';
    app.tip = h(app, 'div', { class: 'tip', 'aria-hidden': 'true', hidden: true });
    app.inspectEl = null;
    const view = h(app, 'div', { class: 'x-view', role: 'tabpanel', id: 'dcc-x-view', 'aria-labelledby': 'dcc-x-tab-' + app.sess.view, tabindex: '-1', 'data-fk': 'view' });
    try {
      VIEW_RENDERERS[app.sess.view](app, view);
    } catch (e) {
      view.textContent = '';
      view.appendChild(h(app, 'p', { class: 'x-err' }, 'This view could not be shown. Reset to workspace or choose another view.'));
    }
    app.root.append(header(app), crumbs(app), chips(app), tabs(app), tools(app), view, about(app), app.tip);
    restoreFocus(app, focus);
  }

  function rerender(app, focusKey) {
    if (focusKey) app.pendingFocus = focusKey;
    render(app);
  }

  function basisPill(app) {
    const m = app.model;
    const b = labels.BASIS[m.pricingBasis] || null;
    return h(app, 'span', { class: 'pill', title: b ? b.note : null }, b ? b.short : 'Estimate');
  }

  function header(app) {
    const m = app.model;
    const p = m.period;
    const meta = [
      periods.periodLabel(p.start, p.endExclusive),
      'compared with ' + periods.periodLabel(p.prevStart, p.prevEndExclusive),
      periods.ageLabel(m.latestUsageMs, m.nowMs),
    ];
    return h(app, 'div', { class: 'x-head' }, [
      h(app, 'h3', { id: 'dcc-x-title' }, 'Cost Explorer'),
      basisPill(app),
      h(app, 'span', { class: 'x-meta' }, meta.join(' · ')),
      h(app, 'span', { class: 'spacer' }),
      h(app, 'button', { type: 'button', 'aria-pressed': String(app.compact), 'data-fk': 'layout', onclick: () => {
        app.sess.layout = app.compact ? 'expanded' : 'compact';
        rerender(app, 'layout');
      } }, 'Compact layout'),
      h(app, 'button', { type: 'button', 'data-fk': 'csv', onclick: () => exportCsv(app) }, 'Export CSV'),
      h(app, 'button', { type: 'button', 'data-fk': 'reset', onclick: () => resetToWorkspace(app) }, 'Reset to workspace'),
    ]);
  }

  function resetToWorkspace(app) {
    const s = app.sess;
    s.filters = {};
    s.order = [];
    s.search = '';
    s.overlap = null;
    rerender(app, 'reset');
  }

  function crumbs(app) {
    const s = app.sess;
    const items = [];
    const all = ['workspace'].concat(s.order);
    all.forEach((name, i) => {
      const last = i === all.length - 1;
      const label = name === 'workspace' ? 'Workspace ' + app.ctx.workspaceId : FILTER_NAMES[name] + ': ' + filterText(name, s.filters[name]);
      if (last) items.push(h(app, 'li', {}, h(app, 'span', { 'aria-current': 'location' }, label)));
      else {
        items.push(h(app, 'li', {}, h(app, 'button', { type: 'button', 'data-fk': 'crumb:' + name, onclick: () => {
          // Going back up the trail removes every filter applied after this level.
          for (const n of s.order.slice(i)) removeFilter(s, n);
          s.overlap = null;
          rerender(app, 'crumb:' + name);
        } }, label)));
      }
    });
    return h(app, 'nav', { class: 'x-crumbs', 'aria-label': 'Explorer drilldown' }, h(app, 'ol', {}, items));
  }

  function chips(app) {
    const s = app.sess;
    const list = [];
    const names = s.order.slice();
    names.forEach((name, i) => {
      const text = FILTER_NAMES[name] + ': ' + filterText(name, s.filters[name]);
      list.push(
        h(app, 'span', { class: 'chip' }, [
          h(app, 'span', {}, text),
          h(app, 'button', { type: 'button', 'aria-label': 'Remove filter ' + text, 'data-fk': 'chip:' + name, onclick: () => {
            removeFilter(s, name);
            const next = s.order[i] || s.order[i - 1];
            rerender(app, next ? 'chip:' + next : s.search ? 'chip:search' : 'search');
          } }, '×'),
        ])
      );
    });
    if (s.search) {
      const text = 'Search: “' + s.search + '”';
      list.push(
        h(app, 'span', { class: 'chip' }, [
          h(app, 'span', {}, text),
          h(app, 'button', { type: 'button', 'aria-label': 'Remove ' + text, 'data-fk': 'chip:search', onclick: () => {
            s.search = '';
            rerender(app, 'search');
          } }, '×'),
        ])
      );
    }
    return h(app, 'div', { class: 'x-chips', role: 'group', 'aria-label': 'Active filters' }, list.length ? list : h(app, 'span', { class: 'muted' }, 'No filters: whole workspace.'));
  }

  function tabs(app) {
    const s = app.sess;
    const select = (id) => {
      s.view = id;
      s.overlap = null;
      rerender(app, 'tab:' + id);
    };
    const buttons = VIEWS.map((v, i) =>
      h(app, 'button', {
        type: 'button',
        role: 'tab',
        id: 'dcc-x-tab-' + v.id,
        'aria-selected': String(s.view === v.id),
        'aria-controls': 'dcc-x-view',
        tabindex: s.view === v.id ? '0' : '-1',
        'data-fk': 'tab:' + v.id,
        onclick: () => select(v.id),
        onkeydown: (e) => {
          const map = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: VIEWS.length - 1 };
          if (!(e.key in map)) return;
          e.preventDefault();
          const j = (map[e.key] + VIEWS.length) % VIEWS.length;
          select(VIEWS[j].id);
        },
      }, v.label)
    );
    return h(app, 'div', { class: 'x-tabs', role: 'tablist', 'aria-label': 'Explorer views' }, buttons);
  }

  function tools(app) {
    const s = app.sess;
    const v = s.view;
    const kids = [];
    if (v !== 'calendar') {
      const what = { products: 'products', drivers: 'resources', runs: 'jobs or runs', skus: 'SKUs or products', daily: 'dates' }[v];
      kids.push(
        h(app, 'label', {}, [
          'Search',
          h(app, 'input', { type: 'search', value: s.search, placeholder: 'Filter ' + what, 'aria-label': 'Search ' + what, 'data-fk': 'search', oninput: (e) => {
            s.search = String(e.target.value || '').slice(0, 120);
            rerender(app);
          } }),
        ])
      );
      const sel = h(app, 'select', { 'aria-label': 'Sort', 'data-fk': 'sort', onchange: (e) => {
        const [key, dir] = String(e.target.value).split(':');
        s.sort = { key, dir };
        rerender(app, 'sort');
      } }, SORTS.map(([k, d, label]) => h(app, 'option', { value: k + ':' + d }, v === 'daily' && k === 'name' ? label.replace('Name', 'Date').replace('A to Z', 'oldest first').replace('Z to A', 'newest first') : label)));
      sel.value = s.sort.key + ':' + s.sort.dir;
      if (!SORTS.some(([k, d]) => k === s.sort.key && d === s.sort.dir)) sel.value = 'cost:desc';
      kids.push(h(app, 'label', {}, ['Sort', sel]));
    }
    if (v === 'products') {
      kids.push(
        h(app, 'div', { class: 'seg', role: 'group', 'aria-label': 'Group bars by' }, [
          h(app, 'button', { type: 'button', 'aria-pressed': String(s.dimension === 'product'), 'data-fk': 'dim:product', onclick: () => {
            s.dimension = 'product';
            rerender(app, 'dim:product');
          } }, 'By product'),
          h(app, 'button', { type: 'button', 'aria-pressed': String(s.dimension === 'owner'), 'data-fk': 'dim:owner', onclick: () => {
            s.dimension = 'owner';
            rerender(app, 'dim:owner');
          } }, 'By ownership'),
        ])
      );
    }
    return h(app, 'div', { class: 'x-tools' }, kids);
  }

  function about(app) {
    const d = h(app, 'details', { class: 'x-about', ontoggle: (e) => {
      app.sess.aboutOpen = e.target.open;
    } }, [
      h(app, 'summary', { 'data-fk': 'about' }, 'About Explorer amounts'),
      h(app, 'ul', {}, [
        h(app, 'li', {}, OWNERSHIP_NOTE),
        h(app, 'li', {}, 'Dates without billing data are shown as unavailable, not zero. Days with usage that has no matching price show a priced subtotal (dashed outline).'),
        h(app, 'li', {}, 'Share of total is shown only when every record in the scope is priced and the total is positive; otherwise shares of a subtotal would mislead.'),
        h(app, 'li', {}, 'Day spike flags: need ≥14 fully priced comparison-period days and billing observed in the last 48 hours; the baseline is same-weekday prior days when there are ≥3, else all prior days; a day is flagged above MAX(median × 1.5, median + 3 × MAD). ' + HEURISTIC_NOTE),
        h(app, 'li', {}, 'High-cost run flags: need ≥8 priced, completed runs with a positive duration from the same job; a run is flagged above Q3 + 1.5 × IQR of that job\'s run costs. ' + HEURISTIC_NOTE),
        h(app, 'li', {}, 'Run amounts cover only billing recorded in the selected period, not a run\'s lifetime cost. Links open native Databricks pages only for validated routes.'),
        h(app, 'li', {}, labels.DISCLAIMER),
      ]),
    ]);
    if (app.sess.aboutOpen) d.open = true;
    return d;
  }

  /* ------------------------------------------------------------------ inspection (exact values) */

  function inspector(app) {
    const el = h(app, 'p', { class: 'inspect', 'data-dcc': 'explorer' });
    app.inspectEl = el;
    return el;
  }

  function inspect(app, info, el, extra) {
    let text = info.tip || info.label;
    if (extra && typeof extra.member === 'number' && info.memberTip) text = info.memberTip(extra.member);
    if (info.segment && info.segmentTip) text = info.segmentTip(info.segment) + '\n' + text;
    if (app.inspectEl) app.inspectEl.textContent = text.split('\n').join(' · ');
    const tip = app.tip;
    if (!tip) return;
    tip.textContent = text;
    try {
      const r = el.getBoundingClientRect();
      const base = app.root.getBoundingClientRect();
      const width = base.width || 0;
      let left = r.left - base.left + r.width / 2;
      if (width) left = Math.max(150, Math.min(width - 150, left));
      tip.style.left = left + 'px';
      tip.style.top = Math.max(0, r.top - base.top) + 'px';
    } catch (_) {
      /* jsdom / detached */
    }
    tip.hidden = false;
  }

  function leave(app) {
    if (app.tip) app.tip.hidden = true;
  }

  function chartHandlers(app) {
    return {
      theme: app.theme,
      onInspect: (info, el, extra) => inspect(app, info, el, extra),
      onLeave: () => leave(app),
      onActivate: (info, el) => {
        leave(app);
        if (info.activate) info.activate(el);
      },
    };
  }

  /* ------------------------------------------------------------------ shared pieces */

  function note(app, text, cls = 'x-note') {
    return h(app, 'p', { class: cls }, text);
  }

  function errorBox(app, err, retry) {
    const e = err || {};
    const d = e.details || {};
    return h(app, 'div', { class: 'x-err', role: 'alert' }, [
      h(app, 'strong', {}, e.title || 'Something went wrong'),
      e.steps && e.steps.length ? h(app, 'ul', {}, e.steps.map((st) => h(app, 'li', {}, st))) : null,
      h(app, 'details', {}, [
        h(app, 'summary', {}, 'Technical details'),
        h(app, 'ul', {}, [
          h(app, 'li', {}, 'Code: ' + (e.code || 'UNKNOWN')),
          d.errorCode ? h(app, 'li', {}, 'SQL error: ' + d.errorCode) : null,
          d.statementId ? h(app, 'li', {}, 'Statement ID: ' + d.statementId) : null,
        ]),
      ]),
      retry ? h(app, 'button', { type: 'button', 'data-fk': 'retry', onclick: retry }, 'Try again') : null,
    ]);
  }

  /**
   * Sortable table. Columns: {label, sortKey?, num?, opt?, type ('number'|'text'), csv(row), cell(row) → node|string}
   * Also records the table for CSV export.
   */
  function table(app, o) {
    const s = app.sess;
    const shown = o.columns.filter((c) => !c.csvOnly);
    const head = shown.map((c) => {
      const attrs = { class: (c.num ? 'num ' : '') + (c.opt ? 'opt' : ''), scope: 'col' };
      if (c.sortKey) {
        const active = s.sort.key === c.sortKey;
        attrs['aria-sort'] = active ? (s.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
        return h(app, 'th', attrs, h(app, 'button', { type: 'button', 'data-fk': 'th:' + c.sortKey, onclick: () => {
          s.sort = { key: c.sortKey, dir: active ? (s.sort.dir === 'asc' ? 'desc' : 'asc') : c.sortKey === 'name' ? 'asc' : 'desc' };
          rerender(app, 'th:' + c.sortKey);
        } }, c.label + (active ? (s.sort.dir === 'asc' ? ' ▲' : ' ▼') : '')));
      }
      return h(app, 'th', attrs, c.label);
    });
    const body = o.rows.map((r) =>
      h(app, 'tr', { class: o.isSelected && o.isSelected(r) ? 'selected' : null }, shown.map((c) => {
        const v = c.cell(r);
        return h(app, c.rowHeader ? 'th' : 'td', { class: (c.num ? 'num ' : '') + (c.opt ? 'opt' : ''), scope: c.rowHeader ? 'row' : null }, v === null || v === undefined ? 'n/a' : v);
      }))
    );
    app.table = { title: o.caption, columns: o.columns.map((c) => ({ label: c.csvLabel || c.label, type: c.type || 'text', value: c.csv })), rows: o.rows, scope: o.scope || null, limit: o.limit || null };
    return h(app, 'div', { class: 'tbl-wrap' }, h(app, 'table', {}, [h(app, 'caption', {}, o.caption), h(app, 'thead', {}, h(app, 'tr', {}, head)), h(app, 'tbody', {}, body.length ? body : h(app, 'tr', {}, h(app, 'td', { colspan: shown.length }, o.empty || 'Nothing matches the current filters.')))]));
  }

  function shareCell(app, value, validity) {
    if (!validity || !validity.valid) return h(app, 'span', { class: 'muted', title: validity ? validity.reason : '' }, 'n/a');
    return app.fmt.share(value);
  }

  function amountCell(app, cost, status) {
    const text = app.fmt.amount(cost, status);
    return h(app, 'span', { class: 'status-' + (status || 'complete') }, text);
  }

  function nativeLink(app, ref, label) {
    const href = ref ? M.nativeHref(ref, app.ctx.origin, app.ctx.workspaceId) : null;
    if (!href) return h(app, 'span', { class: 'muted', title: 'No validated native route for this item; links are never guessed from IDs.' }, 'No link');
    return h(app, 'a', { href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': label + ' (opens in a new tab)' }, 'Open ↗');
  }

  function legendKeys(app, extra) {
    const out = [];
    for (const k of extra) out.push(h(app, 'span', { class: 'key' }, [C.swatch(app.doc, k.color || app.colors.ink, { kind: k.kind, dashed: k.dashed, theme: app.theme }), k.label]));
    return out;
  }

  function coverageNotes(app, series) {
    const partial = series.filter((d) => d.status === 'partial' || d.status === 'unpriced').length;
    const missing = series.filter((d) => d.status === 'unavailable').length;
    const out = [];
    if (app.model.mode === 'import') out.push(note(app, 'Imported summary: contains only what was imported (one daily series, no SKU, prior-period daily, resource or run detail).'));
    if (partial) out.push(note(app, partial + ' day(s) include usage without a matching price: their amounts are priced subtotals (dashed outline).', 'x-warn'));
    if (missing) out.push(note(app, missing + ' date(s) have no billing data and are shown as unavailable, not zero.'));
    if (!app.model.hasPrior) out.push(note(app, 'No prior-period daily data is available, so prior comparisons are unavailable.'));
    return out;
  }

  /** Note naming active filters that the current view cannot apply. */
  function ignoredNote(app, names, why) {
    const active = names.filter((n) => app.sess.filters[n]);
    if (!active.length) return null;
    return note(app, active.map((n) => FILTER_NAMES[n]).join(', ') + ' selection' + (active.length > 1 ? 's do' : ' does') + ' not apply here: ' + why);
  }

  function dayTip(app, d, extraLines = []) {
    const f = app.fmt;
    const lines = [fmtDate(d.date) + ' (UTC)', 'Cost: ' + f.amount(d.cost, d.status)];
    for (const l of extraLines) lines.push(l);
    lines.push('Aligned prior day ' + fmtDate(d.priorDate, true, false) + ': ' + f.amount(d.prior.cost, d.prior.status));
    const ch = f.change(d.change);
    if (ch) lines.push('Change: ' + ch);
    return lines;
  }

  function selectDay(app, date, fk) {
    setFilter(app.sess, 'day', app.sess.filters.day === date ? null : date);
    rerender(app, fk || 'mark:' + date);
  }

  function spikeNote(app, spikes) {
    if (spikes.status === 'suppressed') return note(app, 'Spike flags suppressed: ' + spikes.detail + ' ' + HEURISTIC_NOTE);
    const n = spikes.flags.size;
    return note(app, (n ? n + ' day(s) flagged as a positive spike versus comparable prior-period days (◆).' : 'No day exceeds the spike threshold.') + ' ' + HEURISTIC_NOTE);
  }

  function dayDetailCard(app, model, dimension, filters) {
    const date = app.sess.filters.day;
    if (!date || !model.dates.includes(date)) return null;
    const f = app.fmt;
    const dd = M.dayDetail(model, date, filters, dimension);
    const items = M.sortItems(dd.items, { key: 'cost', dir: 'desc' });
    const ch = f.change(dd.change);
    return h(app, 'section', { class: 'card', 'aria-label': 'Selected day detail' }, [
      h(app, 'h4', {}, fmtDate(date) + ' (UTC) vs aligned prior day ' + fmtDate(dd.priorDate) ),
      h(app, 'div', { class: 'row' }, [
        h(app, 'span', { class: 'big' }, f.amount(dd.current.cost, dd.current.status)),
        h(app, 'span', {}, 'Prior day: ' + f.amount(dd.prior.cost, dd.prior.status)),
        h(app, 'span', {}, 'Change: ' + (ch || 'no comparison')),
      ]),
      h(app, 'div', { class: 'tbl-wrap' }, h(app, 'table', {}, [
        h(app, 'caption', { class: 'sr-only' }, 'Breakdown for ' + fmtDate(date)),
        h(app, 'thead', {}, h(app, 'tr', {}, [h(app, 'th', { scope: 'col' }, dimension === 'owner' ? 'Owner type' : dimension === 'sku' ? 'SKU' : 'Product'), h(app, 'th', { class: 'num', scope: 'col' }, 'Day'), h(app, 'th', { class: 'num', scope: 'col' }, 'Prior day'), h(app, 'th', { class: 'num', scope: 'col' }, 'Change'), h(app, 'th', { class: 'num opt', scope: 'col' }, 'Share of day')])),
        h(app, 'tbody', {}, items.map((it) => h(app, 'tr', {}, [h(app, 'th', { scope: 'row' }, it.name), h(app, 'td', { class: 'num' }, amountCell(app, it.cost, it.status)), h(app, 'td', { class: 'num' }, amountCell(app, it.prevCost, it.prevStatus)), h(app, 'td', { class: 'num' }, f.change(it.change) || 'n/a'), h(app, 'td', { class: 'num opt' }, shareCell(app, it.share, dd.validity))]))),
      ])),
      dd.validity.valid ? null : note(app, 'Share of day not shown: ' + dd.validity.reason),
      h(app, 'button', { type: 'button', 'data-fk': 'clear-day', onclick: () => {
        removeFilter(app.sess, 'day');
        rerender(app, 'view');
      } }, 'Clear day'),
    ]);
  }

  function chartWidth(app) {
    return app.compact ? 420 : 760;
  }

  function loadCard(app, o) {
    const mode = app.model.mode;
    if (mode === 'import') return h(app, 'div', { class: 'x-loadcard' }, h(app, 'p', {}, o.what + ' are not available for imported summaries. An import contains only the summaries that were imported, without resource, ownership or run detail.'));
    const st = o.state;
    if (st && st.status === 'loading') return h(app, 'p', { class: 'x-note', role: 'status' }, 'Loading ' + o.what.toLowerCase() + '…');
    if (st && st.status === 'error') return errorBox(app, st.error, () => startLoad(app, o.kind, o.args, o.scope, true));
    if (st && st.status === 'paused') return note(app, 'Cost display is paused. Resume it from the banner to load ' + o.what.toLowerCase() + '.');
    if (st && st.status === 'unavailable') return h(app, 'div', { class: 'x-loadcard' }, h(app, 'p', {}, o.what + ' are not available in ' + (st.mode === 'import' ? 'Local import' : st.mode) + ' mode.'));
    const desc = mode === 'demo' ? 'Shows synthetic DEMO data. No Databricks request is made.' : 'Runs one read-only SQL query on your selected SQL warehouse (a stopped warehouse may start). Results are cached for 5 minutes.';
    return h(app, 'div', { class: 'x-loadcard' }, [
      h(app, 'p', {}, o.intro),
      h(app, 'p', { class: 'muted' }, desc),
      h(app, 'button', { type: 'button', class: 'btn-primary', 'data-fk': 'load:' + o.kind, onclick: () => startLoad(app, o.kind, o.args, o.scope, false) }, o.button),
    ]);
  }

  function loadedMeta(app, st, o) {
    const v = st.value;
    const bits = [];
    if (st.synthetic || v.synthetic) bits.push(h(app, 'span', { class: 'pill' }, 'DEMO'));
    bits.push(h(app, 'span', { class: 'muted' }, (st.cached ? 'Loaded from the 5-minute cache' : 'Loaded') + ' · ' + periods.ageLabel(v.latestUsageMs, app.model.nowMs) + ' in this result'));
    bits.push(h(app, 'button', { type: 'button', 'data-fk': 'reload:' + o.kind, onclick: () => startLoad(app, o.kind, o.args, o.scope, true) }, 'Reload'));
    return h(app, 'div', { class: 'x-head' }, bits);
  }

  /* ================================================================== views */

  /** Products: stacked daily bars by product (or exclusive owner type), trend and prior overlay. */
  function viewProducts(app, view) {
    const s = app.sess;
    const f = app.fmt;
    let model = app.model;
    const dim = s.dimension;
    if (dim === 'owner') {
      const args = { periodDays: model.period.days };
      const st = loadState(app, 'exploreSummary', args, 'owners');
      if (!st || st.status !== 'ok') {
        view.appendChild(loadCard(app, { kind: 'exploreSummary', args, scope: 'owners', state: st, what: 'Ownership breakdowns', button: 'Load ownership breakdown', intro: 'Splits daily cost by exclusive owner type (job, pipeline, SQL warehouse, notebook, app, cluster, unattributed).' }));
        view.appendChild(note(app, OWNERSHIP_NOTE));
        return;
      }
      view.appendChild(loadedMeta(app, st, { kind: 'exploreSummary', args, scope: 'owners' }));
      model = M.normalize(st.value, { periodDays: model.period.days, nowMs: model.nowMs, mode: app.model.mode });
    }
    const filters = summaryFilters(app, dim === 'owner');
    const all = M.groupTotals(model, dim, filters);
    const allKeys = M.groupTotals(model, dim, {}).items;
    const weights = new Map(allKeys.map((it) => [it.key, it.cost || 0]));
    const colors = M.colorMap(allKeys.map((it) => it.key), weights, dim === 'owner' ? M.OWNER_TYPES : null, M.paletteFor(app.theme));
    const searched = M.search(all.items, s.search, ['name', 'key']);
    const keySet = new Set(searched.map((it) => it.key));
    const rows = model.rows.filter((r) => {
      if (filters.product && r.product !== filters.product) return false;
      if (filters.sku && r.sku !== filters.sku) return false;
      if (filters.owner && r.owner !== filters.owner) return false;
      return keySet.has(dim === 'owner' ? r.owner || 'unattributed' : r.product);
    });
    const scoped = Object.assign({}, model, { rows });
    const series = M.dailySeries(scoped, {}, dim);
    const spikes = M.spikeFlags(series, M.priorDailySeries(scoped, {}), { latestUsageMs: model.latestUsageMs, nowMs: model.nowMs });
    // Stack/legend order: ownership priority for owner types, names for products; "Other" last.
    const orderOf = (k) => (dim === 'owner' ? M.OWNER_TYPES.indexOf(k) : 0);
    const visibleKeys = [...keySet].sort((a, b) => (colors.groupOf(a) === M.OTHER_KEY) - (colors.groupOf(b) === M.OTHER_KEY) || orderOf(a) - orderOf(b) || String(a).localeCompare(String(b)));
    const nameOf = (k) => (k === M.OTHER_KEY ? 'Other' : dim === 'owner' ? M.OWNER_LABELS[k] || k : k);
    const days = series.map((d) => {
      const segs = new Map();
      for (const k of visibleKeys) {
        const g = colors.groupOf(k);
        const a = d.segments.get(k);
        if (!a || a.cost === null) continue;
        const cur = segs.get(g) || { key: g, label: nameOf(g), color: g === M.OTHER_KEY ? M.OTHER_COLOR : colors.colorOf(k), cost: 0 };
        cur.cost += a.cost;
        segs.set(g, cur);
      }
      const segments = [...segs.values()];
      const segLines = segments.slice().sort((a, b) => b.cost - a.cost).slice(0, 6).map((sg) => sg.label + ': ' + f.money(sg.cost));
      const lines = dayTip(app, d, segLines);
      if (spikes.flags.has(d.date)) lines.push('◆ Spike flag (heuristic): above ' + f.money(spikes.flags.get(d.date).threshold));
      return {
        date: d.date,
        axisLabel: fmtDate(d.date, false, false),
        cost: d.cost,
        status: d.status,
        prior: d.prior,
        segments,
        flagged: spikes.flags.has(d.date),
        selected: s.filters.day === d.date,
        info: {
          key: d.date,
          label: lines.join('. ') + '. Press Enter to ' + (s.filters.day === d.date ? 'clear the day selection.' : 'select this day.'),
          tip: lines.join('\n'),
          segmentTip: (sg) => sg.label + ': ' + f.money(sg.cost),
          activate: () => selectDay(app, d.date),
        },
      };
    });
    const totals = M.aggregate(rows.filter((r) => r.period === 'cur'));
    const title = 'Daily cost by ' + (dim === 'owner' ? 'owner type' : 'product');
    const summaryText = title + ', ' + periods.periodLabel(model.period.start, model.period.endExclusive) + '. Period ' + f.amount(totals.cost, totals.status) + '. ' + days.filter((d) => d.status === 'unavailable').length + ' unavailable date(s). Solid line: daily total; dashed line: aligned prior period.';
    const legend = h(app, 'div', { class: 'legend', role: 'group', 'aria-label': 'Legend: select to drill down' }, []);
    const legendKeysList = [...new Set(visibleKeys.map((k) => colors.groupOf(k)))];
    for (const g of legendKeysList) {
      if (g === M.OTHER_KEY) {
        legend.appendChild(h(app, 'span', { class: 'key' }, [C.swatch(app.doc, M.OTHER_COLOR, { theme: app.theme }), 'Other (' + colors.folded.length + ' smaller)']));
        continue;
      }
      const filterName = dim === 'owner' ? 'owner' : 'product';
      const pressed = s.filters[filterName] === g;
      legend.appendChild(h(app, 'button', { type: 'button', 'aria-pressed': String(pressed), 'data-fk': 'legend:' + g, onclick: () => {
        setFilter(s, filterName, pressed ? null : g);
        rerender(app, 'legend:' + g);
      } }, [C.swatch(app.doc, colors.colorOf(g), { theme: app.theme }), nameOf(g)]));
    }
    for (const k of legendKeys(app, [{ label: 'Daily total', kind: 'line' }, { label: 'Aligned prior period', kind: 'line', color: app.colors.warm, dashed: true }, { label: 'Unavailable', kind: 'hatch' }, { label: 'Partial (priced subtotal)', kind: 'dashed' }, { label: 'Spike flag (heuristic)', kind: 'diamond' }])) legend.appendChild(k);
    const chart = C.stackedBars(app.doc, Object.assign({ width: chartWidth(app), height: app.compact ? 210 : 240, title, summary: summaryText, days, showPrior: model.hasPrior, formatAxis: f.axis }, chartHandlers(app)));
    view.append(legend, h(app, 'div', { class: 'chart-wrap' }, chart), inspector(app));
    for (const n of coverageNotes(app, series)) view.appendChild(n);
    view.appendChild(spikeNote(app, spikes));
    const ign = ignoredNote(app, dim === 'owner' ? ['resource', 'run'] : ['owner', 'resource', 'run'], dim === 'owner' ? 'resource and run selections apply to Top drivers and Runs.' : 'owner types need the ownership breakdown; resources and runs apply to Top drivers and Runs.');
    if (ign) view.appendChild(ign);
    const card = dayDetailCard(app, scoped, dim, {});
    if (card) view.appendChild(card);
    // Totals table for the chart's keys (also the CSV for this view).
    const validity = M.shareValidity(totals);
    const items = M.sortItems(searched.map((it) => Object.assign({}, it, { share: M.shareOf(it.cost, validity) })), s.sort);
    const keyLabel = dim === 'owner' ? 'Owner type' : 'Product';
    view.appendChild(table(app, {
      caption: (dim === 'owner' ? 'Owner types' : 'Products') + ': selected vs prior period',
      rows: items,
      isSelected: (it) => s.filters[dim === 'owner' ? 'owner' : 'product'] === it.key,
      columns: [
        { label: keyLabel, rowHeader: true, sortKey: 'name', csv: (it) => it.name, cell: (it) => h(app, 'button', { type: 'button', class: 'linkish', 'data-fk': 'row:' + it.key, onclick: () => {
          setFilter(s, dim === 'owner' ? 'owner' : 'product', it.key);
          rerender(app, 'row:' + it.key);
        } }, it.name) },
        { label: 'Selected period', num: true, sortKey: 'cost', type: 'number', csv: (it) => it.cost, cell: (it) => amountCell(app, it.cost, it.status) },
        { label: 'Status', type: 'text', opt: true, csv: (it) => it.status, cell: (it) => statusText(it.status) },
        { label: 'Prior period', num: true, type: 'number', csv: (it) => it.prevCost, cell: (it) => amountCell(app, it.prevCost, it.prevStatus) },
        { label: 'Change', num: true, sortKey: 'change', type: 'number', csv: (it) => (it.change ? it.change.abs : null), cell: (it) => f.change(it.change) },
        { label: 'Share', num: true, opt: true, type: 'number', csvLabel: 'Share of scope total (fraction)', csv: (it) => it.share, cell: (it) => shareCell(app, it.share, validity) },
      ],
    }));
    if (!validity.valid) view.appendChild(note(app, 'Share of total not shown: ' + validity.reason));
  }

  /** Top drivers: ranked resources by exclusive ownership (explicit load). */
  function viewDrivers(app, view) {
    const s = app.sess;
    const f = app.fmt;
    const args = { periodDays: app.model.period.days };
    const st = loadState(app, 'exploreEntities', args, 'entities');
    view.appendChild(note(app, OWNERSHIP_NOTE));
    if (!st || st.status !== 'ok') {
      view.appendChild(loadCard(app, { kind: 'exploreEntities', args, scope: 'entities', state: st, what: 'Top drivers', button: 'Load top drivers', intro: 'Ranks jobs, pipelines, SQL warehouses, notebooks, apps and clusters by their exclusive cost in ' + periods.periodLabel(app.model.period.start, app.model.period.endExclusive) + ', with the prior period for comparison (top 200).' }));
      return;
    }
    const v = st.value;
    view.appendChild(loadedMeta(app, st, { kind: 'exploreEntities', args, scope: 'entities' }));
    const limitText = 'Showing the top ' + v.items.length + ' of ' + v.candidateCount + ' resources with usage in the period' + (v.limited ? '. Results are limited to ' + v.limit + '; the remaining ' + (v.candidateCount - v.items.length) + ' are not listed.' : '.');
    view.appendChild(note(app, limitText, v.limited ? 'x-warn' : 'x-note'));
    const ignored = ['product', 'sku', 'day'].filter((n) => s.filters[n]);
    if (ignored.length) view.appendChild(note(app, ignored.map((n) => FILTER_NAMES[n]).join(', ') + ' filter(s) do not apply to Top drivers: a resource can span several products, SKUs and days.'));
    const typesPresent = M.OWNER_TYPES.filter((t) => v.items.some((it) => it.ownerType === t));
    const typeSel = h(app, 'select', { 'aria-label': 'Owner type', 'data-fk': 'ownerType', onchange: (e) => {
      setFilter(s, 'owner', e.target.value || null);
      rerender(app, 'ownerType');
    } }, [h(app, 'option', { value: '' }, 'All owner types')].concat(typesPresent.map((t) => h(app, 'option', { value: t }, M.OWNER_LABELS[t]))));
    typeSel.value = s.filters.owner && typesPresent.includes(s.filters.owner) ? s.filters.owner : '';
    view.appendChild(h(app, 'div', { class: 'x-tools' }, h(app, 'label', {}, ['Owner type', typeSel])));
    const validity = v.totals && v.totals.coverage === 'complete' && v.totals.amount > 0 ? { valid: true, total: v.totals.amount } : { valid: false, reason: v.totals && v.totals.coverage !== 'complete' ? 'Some usage in the period has no matching price, so the workspace total is a priced subtotal and shares would mislead.' : 'No positive priced total for the period.' };
    const withCalc = v.items.map((it, i) => Object.assign({}, it, { rank: i + 1, cost: it.amount, change: M.change(it.amount, it.prevAmount), share: M.shareOf(it.amount, validity), label: M.entityLabel(it) }));
    let list = withCalc.filter((it) => !s.filters.owner || it.ownerType === s.filters.owner);
    list = M.search(list, s.search, ['label', 'id', (it) => M.OWNER_LABELS[it.ownerType]]);
    const sorted = M.sortItems(list, s.sort, { name: (it) => it.label });
    const selKey = s.filters.resource && s.filters.resource.key;
    const ranked = list.slice().sort((a, b) => a.rank - b.rank).slice(0, app.compact ? 10 : 15);
    const ownerColors = M.colorMap(M.OWNER_TYPES, new Map(), M.OWNER_TYPES, M.paletteFor(app.theme));
    const drill = (it) => {
      setFilter(s, 'resource', { key: it.key, ownerType: it.ownerType, id: it.id, name: it.name });
      setFilter(s, 'run', null);
      rerender(app, 'mark:' + it.key);
    };
    const resTip = (it) => [it.label + ' (' + M.OWNER_LABELS[it.ownerType] + (it.id && it.name ? ', ID ' + it.id : '') + ')', 'Selected period: ' + f.amount(it.amount, it.status === 'ok' ? 'complete' : it.status), 'Prior period: ' + f.amount(it.prevAmount, it.prevStatus === 'ok' ? 'complete' : it.prevStatus), it.change ? 'Change: ' + f.change(it.change) : 'Change: no comparison', it.share !== null ? 'Share of workspace total: ' + f.share(it.share) : null, 'Rank ' + it.rank + ' of ' + v.candidateCount].filter(Boolean);
    if (ranked.length) {
      const chart = C.hBars(app.doc, Object.assign({
        width: chartWidth(app),
        labelWidth: app.compact ? 130 : 210,
        title: 'Top drivers by selected-period cost',
        summary: 'Horizontal bars of the ' + ranked.length + ' highest-cost resources' + (s.filters.owner ? ' of type ' + M.OWNER_LABELS[s.filters.owner] : '') + '. Ticks mark prior-period cost. Highest: ' + ranked[0].label + ' ' + (f.money(ranked[0].amount) || 'unpriced') + '.',
        formatAxis: f.axis,
        formatValue: f.money,
        items: ranked.map((it) => ({ key: it.key, label: it.label, truncateStart: it.ownerType === 'notebook' && Boolean(it.name), value: it.amount, prior: it.prevAmount, color: ownerColors.colorOf(it.ownerType), selected: it.key === selKey, valueLabel: it.amount === null ? 'unpriced' : f.money(it.amount) + (it.status === 'partial' ? '*' : ''), info: { key: it.key, label: resTip(it).join('. ') + '. Press Enter to drill down.', tip: resTip(it).join('\n'), activate: () => drill(it) } })),
      }, chartHandlers(app)));
      const legend = h(app, 'div', { class: 'legend', 'aria-label': 'Owner type colors' }, legendKeys(app, typesPresent.map((t) => ({ label: M.OWNER_LABELS[t], color: ownerColors.colorOf(t) })).concat([{ label: 'Prior period', kind: 'line', color: app.colors.warm }])));
      view.append(legend, h(app, 'div', { class: 'chart-wrap' }, chart), inspector(app));
    }
    const sel = selKey ? withCalc.find((it) => it.key === selKey) : null;
    if (s.filters.resource && !sel) view.appendChild(note(app, 'The selected resource is not among the loaded top ' + v.items.length + '.', 'x-warn'));
    if (sel) {
      view.appendChild(h(app, 'section', { class: 'card', 'aria-label': 'Selected resource' }, [
        h(app, 'h4', {}, sel.label),
        h(app, 'div', { class: 'row' }, [
          h(app, 'span', { class: 'big' }, f.amount(sel.amount, sel.status === 'ok' ? 'complete' : sel.status)),
          h(app, 'span', {}, M.OWNER_LABELS[sel.ownerType] + (sel.id ? ' · ID ' + sel.id : '')),
          h(app, 'span', {}, 'Prior: ' + f.amount(sel.prevAmount, sel.prevStatus === 'ok' ? 'complete' : sel.prevStatus)),
          h(app, 'span', {}, 'Change: ' + (f.change(sel.change) || 'no comparison')),
          h(app, 'span', {}, 'Share: ' + (sel.share !== null ? f.share(sel.share) : 'n/a')),
          h(app, 'span', {}, 'Active days: ' + sel.activeDays),
          nativeLink(app, M.entityRef(sel), 'Open ' + sel.label),
        ]),
        sel.warnings.length ? h(app, 'ul', {}, sel.warnings.map((w) => h(app, 'li', {}, w.text))) : null,
        sel.ownerType === 'job' ? h(app, 'button', { type: 'button', 'data-fk': 'show-runs', onclick: () => {
          s.view = 'runs';
          rerender(app, 'tab:runs');
        } }, 'Show runs of this job') : null,
      ]));
    }
    view.appendChild(table(app, {
      caption: 'Resources ranked by exclusive selected-period cost',
      rows: sorted,
      isSelected: (it) => it.key === selKey,
      scope: s.filters.owner ? 'Owner type ' + M.OWNER_LABELS[s.filters.owner] : null,
      limit: limitText,
      columns: [
        { label: '#', num: true, opt: true, type: 'number', csvLabel: 'Rank', csv: (it) => it.rank, cell: (it) => String(it.rank) },
        { label: 'Resource', rowHeader: true, sortKey: 'name', csv: (it) => it.label, cell: (it) => h(app, 'span', {}, [h(app, 'button', { type: 'button', class: 'linkish', 'data-fk': 'row:' + it.key, onclick: () => drill(it) }, it.label), it.name && it.id ? h(app, 'div', { class: 'id' }, 'ID ' + it.id) : null]) },
        { label: 'Type', csvLabel: 'Owner type', csv: (it) => M.OWNER_LABELS[it.ownerType], cell: (it) => M.OWNER_LABELS[it.ownerType] },
        { label: 'Resource ID', csvOnly: true, csv: (it) => it.id },
        { label: 'Selected period', num: true, sortKey: 'cost', type: 'number', csv: (it) => it.amount, cell: (it) => amountCell(app, it.amount, it.status === 'ok' ? 'complete' : it.status) },
        { label: 'Prior period', num: true, type: 'number', csv: (it) => it.prevAmount, cell: (it) => amountCell(app, it.prevAmount, it.prevStatus === 'ok' ? 'complete' : it.prevStatus) },
        { label: 'Change', num: true, sortKey: 'change', type: 'number', csv: (it) => (it.change ? it.change.abs : null), cell: (it) => f.change(it.change) },
        { label: 'Share', num: true, opt: true, type: 'number', csvLabel: 'Share of workspace total (fraction)', csv: (it) => it.share, cell: (it) => shareCell(app, it.share, validity) },
        { label: 'Native page', csvLabel: 'Native link', csv: (it) => M.nativeHref(M.entityRef(it), app.ctx.origin, app.ctx.workspaceId), cell: (it) => nativeLink(app, M.entityRef(it), 'Open ' + it.label) },
      ],
    }));
    if (!validity.valid) view.appendChild(note(app, 'Share of total not shown: ' + validity.reason));
  }

  /** Runs: per-run selected-period cost vs duration scatter (explicit load). */
  function viewRuns(app, view) {
    const s = app.sess;
    const f = app.fmt;
    const res = s.filters.resource;
    const jobId = res && res.ownerType === 'job' && res.id ? res.id : null;
    const args = { periodDays: app.model.period.days };
    if (jobId) args.jobId = jobId;
    const scope = jobId ? 'runs:job:' + jobId : 'runs';
    if (res && !jobId) view.appendChild(note(app, 'Runs exist only for jobs; the selected ' + M.OWNER_LABELS[res.ownerType].toLowerCase() + ' is ignored here.'));
    const st = loadState(app, 'exploreRuns', args, scope);
    if (!st || st.status !== 'ok') {
      view.appendChild(loadCard(app, { kind: 'exploreRuns', args, scope, state: st, what: 'Runs', button: jobId ? 'Load runs of ' + M.entityLabel(res) : 'Load runs', intro: 'Lists job runs by their cost inside the selected period, with durations from the job run timeline when readable. A run\'s selected-period cost is not its lifetime cost.' }));
      return;
    }
    const v = st.value;
    view.appendChild(loadedMeta(app, st, { kind: 'exploreRuns', args, scope }));
    for (const w of v.warnings || []) view.appendChild(note(app, w.text, w.code === 'DURATION_UNAVAILABLE' ? 'x-warn' : 'x-note'));
    const limitText = 'Showing the ' + v.items.length + ' highest-cost of ' + v.candidateCount + ' runs' + (jobId ? ' of this job' : '') + (v.limited ? ' (limited to ' + v.limit + ').' : '.');
    view.appendChild(note(app, limitText, v.limited ? 'x-warn' : 'x-note'));
    const heur = M.highCostRuns(v.items);
    const runLabel = (r) => (r.jobName || 'Job ' + r.jobId) + ' · run ' + r.runId;
    let list = M.search(v.items.map((r) => Object.assign({}, r, { cost: r.amount, name: runLabel(r) })), s.search, ['name', 'jobId', 'runId']);
    const sortKey = s.sort.key === 'change' ? 'cost' : s.sort.key;
    const sorted = M.sortItems(list, { key: sortKey, dir: s.sort.dir }, { duration: (r) => r.durationMs });
    const selRun = s.filters.run ? v.items.find((r) => r.key === s.filters.run.key) : null;
    const selectRun = (r) => {
      setFilter(s, 'run', s.filters.run && s.filters.run.key === r.key ? null : { key: r.key, jobId: r.jobId, runId: r.runId, jobName: r.jobName });
      rerender(app, 'row:' + r.key);
    };
    const runLines = (r) => [runLabel(r), 'Selected-period cost: ' + f.amount(r.amount, r.status === 'ok' ? 'complete' : r.status), 'Duration: ' + (r.durationMs ? labels.formatDuration(r.durationMs) : r.durationStatus === 'running' ? 'not final (run not finished)' : 'unavailable'), r.resultState ? 'Result: ' + r.resultState : null, heur.flags.has(r.key) ? '● High cost vs this job\'s runs (heuristic): above ' + f.money(heur.flags.get(r.key).fence) : null].filter(Boolean);
    const points = list.filter((r) => r.durationStatus === 'ok' && Number.isFinite(r.durationMs) && r.durationMs > 0 && Number.isFinite(r.amount)).map((r) => ({ key: r.key, x: r.durationMs / 60000, y: r.amount, flagged: heur.flags.has(r.key), selected: Boolean(selRun && selRun.key === r.key), run: r }));
    const omitted = list.length - points.length;
    if (points.length) {
      const chart = C.scatter(app.doc, Object.assign({
        width: chartWidth(app),
        height: app.compact ? 230 : 260,
        title: 'Run cost versus duration',
        summary: 'Scatter of ' + points.length + ' runs: duration on the horizontal axis, selected-period cost on the vertical axis. ' + heur.flags.size + ' run(s) flagged as high cost (heuristic). Points at the same spot are grouped and show a count.',
        points,
        xLabel: 'Duration',
        timeAxis: true,
        yLabel: 'Cost',
        formatX: durationMinutesLabel,
        formatY: f.axis,
        groupInfo: (gr) => {
          const members = gr.members.map((p) => p.run);
          if (members.length === 1) {
            const r = members[0];
            return { key: r.key, members: gr.members, label: runLines(r).join('. ') + '. Press Enter to select.', tip: runLines(r).join('\n'), activate: () => selectRun(r) };
          }
          const lines = [members.length + ' runs at about ' + durationMinutesLabel(gr.members[0].x) + ' and ' + f.money(gr.members[0].y)];
          return {
            key: gr.key,
            members: gr.members,
            label: lines[0] + '. Use Up and Down arrows to cycle through them, Enter to list them.',
            tip: lines[0] + '\n' + members.slice(0, 4).map((r) => runLabel(r) + ': ' + f.money(r.amount)).join('\n') + (members.length > 4 ? '\n…' : '') + '\nEnter or tap again to list',
            memberTip: (i) => 'Run ' + (i + 1) + ' of ' + members.length + ' here\n' + runLines(members[i]).join('\n'),
            activate: () => {
              s.overlap = { key: gr.key, runs: members.map((r) => r.key) };
              rerender(app, 'overlap-list');
            },
          };
        },
      }, chartHandlers(app)));
      view.append(
        h(app, 'div', { class: 'legend' }, legendKeys(app, [{ label: 'Run (number = runs at the same spot)', color: app.colors.accent, kind: 'dot' }, { label: 'High cost vs the job\'s runs (heuristic)', kind: 'ring' }])),
        h(app, 'div', { class: 'chart-wrap' }, chart),
        inspector(app)
      );
    } else {
      view.appendChild(note(app, 'No run has a usable duration and priced cost, so the scatter is empty.'));
    }
    if (omitted > 0) view.appendChild(note(app, omitted + ' run(s) are left out of the scatter: duration unavailable or not final, or no priced cost. Missing durations are never treated as zero.'));
    const suppressed = [...heur.cohorts.values()].filter((c) => c.status !== 'ok').length;
    view.appendChild(note(app, 'High-cost run flags: ' + heur.flags.size + ' flagged across ' + [...heur.cohorts.values()].filter((c) => c.status === 'ok').length + ' job(s) with enough comparable runs' + (suppressed ? '; ' + suppressed + ' job(s) have too few comparable runs or an incomplete list' : '') + '. ' + HEURISTIC_NOTE));
    if (s.overlap) {
      const runs = s.overlap.runs.map((k) => v.items.find((r) => r.key === k)).filter(Boolean);
      view.appendChild(h(app, 'section', { class: 'overlap', 'aria-label': 'Runs at the same spot' }, [
        h(app, 'h4', { tabindex: '-1', 'data-fk': 'overlap-list' }, runs.length + ' runs at the same spot'),
        h(app, 'ul', {}, runs.map((r) => h(app, 'li', {}, [h(app, 'button', { type: 'button', class: 'linkish', 'data-fk': 'ov:' + r.key, onclick: () => {
          s.overlap = null;
          selectRun(r);
        } }, runLabel(r)), ': ' + f.amount(r.amount, r.status === 'ok' ? 'complete' : r.status) + ', ' + (r.durationMs ? labels.formatDuration(r.durationMs) : 'duration unavailable') + ' ', nativeLink(app, M.runRef(r), 'Open run ' + r.runId)]))),
        h(app, 'button', { type: 'button', 'data-fk': 'ov-close', onclick: () => {
          s.overlap = null;
          rerender(app, 'view');
        } }, 'Close list'),
      ]));
    }
    if (selRun) {
      view.appendChild(h(app, 'section', { class: 'card', 'aria-label': 'Selected run' }, [
        h(app, 'h4', {}, runLabel(selRun)),
        h(app, 'div', { class: 'row' }, runLines(selRun).slice(1).map((t) => h(app, 'span', {}, t)).concat([nativeLink(app, M.runRef(selRun), 'Open run ' + selRun.runId)])),
        selRun.warnings.length ? h(app, 'ul', {}, selRun.warnings.map((w) => h(app, 'li', {}, w.text))) : null,
        note(app, 'Selected-period cost only; billing for this run outside ' + periods.periodLabel(v.period.start, v.period.endExclusive) + ' is not included.'),
      ]));
    }
    if (s.sort.key === 'change') view.appendChild(note(app, 'Runs have no prior-period comparison; sorted by cost instead.'));
    view.appendChild(table(app, {
      caption: 'Job runs by selected-period cost',
      rows: sorted,
      isSelected: (r) => Boolean(selRun && selRun.key === r.key),
      scope: jobId ? 'Job ' + jobId : null,
      limit: limitText,
      columns: [
        { label: 'Run', rowHeader: true, sortKey: 'name', csvLabel: 'Job / run', csv: (r) => r.name, cell: (r) => h(app, 'button', { type: 'button', class: 'linkish', 'data-fk': 'row:' + r.key, onclick: () => selectRun(r) }, r.name) },
        { label: 'Job ID', opt: true, csv: (r) => r.jobId, cell: (r) => r.jobId },
        { label: 'Run ID', opt: true, csv: (r) => r.runId, cell: (r) => r.runId },
        { label: 'Selected-period cost', num: true, sortKey: 'cost', type: 'number', csv: (r) => r.amount, cell: (r) => amountCell(app, r.amount, r.status === 'ok' ? 'complete' : r.status) },
        { label: 'Duration', num: true, sortKey: 'duration', type: 'number', csvLabel: 'Duration (seconds)', csv: (r) => (r.durationMs ? r.durationMs / 1000 : null), cell: (r) => (r.durationMs ? labels.formatDuration(r.durationMs) : h(app, 'span', { class: 'status-unavailable' }, r.durationStatus === 'running' ? 'not final' : 'unavailable')) },
        { label: 'Result', opt: true, csv: (r) => r.resultState, cell: (r) => r.resultState },
        { label: 'Flag', csvLabel: 'High-cost flag (heuristic)', csv: (r) => (heur.flags.has(r.key) ? 'high cost vs job runs' : ''), cell: (r) => (heur.flags.has(r.key) ? h(app, 'span', { class: 'flagtxt', title: HEURISTIC_NOTE }, '● High vs job (heuristic)') : '') },
        { label: 'Native page', csvLabel: 'Native link', csv: (r) => M.nativeHref(M.runRef(r), app.ctx.origin, app.ctx.workspaceId), cell: (r) => nativeLink(app, M.runRef(r), 'Open run ' + r.runId) },
      ],
    }));
  }

  /** Calendar: Monday-first UTC heatmap; missing dates unavailable, not zero. */
  function viewCalendar(app, view) {
    const s = app.sess;
    const f = app.fmt;
    const model = app.model;
    const filters = summaryFilters(app, false);
    const series = M.dailySeries(model, filters);
    const spikes = M.spikeFlags(series, M.priorDailySeries(model, filters), { latestUsageMs: model.latestUsageMs, nowMs: model.nowMs });
    const cal = M.calendar(model, series);
    const ramp = RAMPS[app.theme] || RAMPS.light;
    const fillFor = (c) => ramp[M.intensity(c.cost, cal.max, 5)];
    const chart = C.heatmap(app.doc, Object.assign({
      title: 'Calendar of daily cost (UTC, weeks start Monday)',
      summary: 'Calendar heatmap, ' + periods.periodLabel(model.period.start, model.period.endExclusive) + '. Darker is higher cost' + (cal.max !== null ? ', up to ' + f.money(cal.max) : '') + '. Hatched days are unavailable.',
      weeks: cal.weeks,
      weekdayLabels: cal.weekdayLabels,
      weekLabel: (week) => fmtDate((week.find((c) => c.inPeriod) || week[0]).date, false, false),
      fillFor,
      selectedDate: s.filters.day || null,
      flagged: new Set(spikes.flags.keys()),
      cellSize: app.compact ? 20 : 26,
      cellInfo: (c) => {
        const lines = dayTip(app, c.day || { date: c.date, cost: null, status: 'unavailable', priorDate: periods.alignedPriorDate(c.date, model.period), prior: { cost: null, status: 'unavailable' }, change: null });
        if (spikes.flags.has(c.date)) lines.push('Spike flag (heuristic): above ' + f.money(spikes.flags.get(c.date).threshold));
        return { key: c.date, label: lines.join('. ') + '. Press Enter to ' + (s.filters.day === c.date ? 'clear the selection.' : 'select this day.'), tip: lines.join('\n'), activate: () => selectDay(app, c.date) };
      },
    }, chartHandlers(app)));
    const rampKey = h(app, 'span', { class: 'ramp', 'aria-hidden': 'true' }, ramp.slice(1).map((c) => h(app, 'span', { style: { background: c } })));
    view.append(
      h(app, 'div', { class: 'legend' }, [h(app, 'span', { class: 'key' }, ['Lower', rampKey, 'Higher' + (cal.max !== null ? ' (max ' + f.money(cal.max) + ')' : '')])].concat(legendKeys(app, [{ label: 'Unavailable', kind: 'hatch' }, { label: 'Partial (priced subtotal)', kind: 'dashed' }, { label: 'Spike flag (heuristic)', kind: 'diamond' }]))),
      h(app, 'div', { class: 'chart-wrap' }, chart),
      inspector(app)
    );
    for (const n of coverageNotes(app, series)) view.appendChild(n);
    view.appendChild(spikeNote(app, spikes));
    const ign = ignoredNote(app, ['owner', 'resource', 'run'], 'the calendar uses the product/SKU summary.');
    if (ign) view.appendChild(ign);
    const card = dayDetailCard(app, model, 'product', filters);
    if (card) view.appendChild(card);
    // CSV for the calendar: one row per in-period date.
    const totals = M.periodTotals(model, filters);
    app.table = {
      title: 'Calendar (daily cost)',
      columns: [
        { label: 'Date (UTC)', type: 'text', value: (d) => d.date },
        { label: 'Weekday', type: 'text', value: (d) => cal.weekdayLabels[d.weekday] },
        { label: 'Cost', type: 'number', value: (d) => d.cost },
        { label: 'Status', type: 'text', value: (d) => d.status },
        { label: 'Spike flag (heuristic)', type: 'text', value: (d) => (spikes.flags.has(d.date) ? 'flag' : '') },
      ],
      rows: series,
      scope: null,
      limit: null,
      totals,
    };
  }

  /** SKUs: current vs prior with daily drilldown. */
  function viewSkus(app, view) {
    const s = app.sess;
    const f = app.fmt;
    const model = app.model;
    const filters = { product: s.filters.product || undefined };
    const g = M.groupTotals(model, 'sku', filters);
    const list = M.search(g.items, s.search, ['key', 'product']);
    const sorted = M.sortItems(list, s.sort);
    if (model.mode === 'import') view.appendChild(note(app, 'Imported summaries have no SKU detail; the single series is shown as IMPORTED.'));
    const ign = ignoredNote(app, ['owner', 'resource', 'run', 'day'], 'SKU totals cover the whole period; use Daily detail for a day.');
    if (ign) view.appendChild(ign);
    const sel = s.filters.sku || null;
    const drill = (it) => {
      setFilter(s, 'sku', sel === it.key ? null : it.key);
      rerender(app, 'mark:' + it.key);
    };
    const tipLines = (it) => [it.key, 'Product: ' + it.product, 'Selected period: ' + f.amount(it.cost, it.status), 'Prior period: ' + f.amount(it.prevCost, it.prevStatus), 'Change: ' + (f.change(it.change) || 'no comparison'), it.share !== null ? 'Share: ' + f.share(it.share) : null].filter(Boolean);
    const top = M.sortItems(list, { key: 'cost', dir: 'desc' }).slice(0, app.compact ? 8 : 12);
    if (top.length) {
      const productColors = M.colorMap(M.groupTotals(model, 'product', {}).items.map((it) => it.key), new Map(), null, M.paletteFor(app.theme));
      const chart = C.hBars(app.doc, Object.assign({
        width: chartWidth(app),
        labelWidth: app.compact ? 150 : 260,
        title: 'SKUs: selected vs prior period',
        summary: 'Bars of the ' + top.length + ' highest-cost SKUs' + (filters.product ? ' for ' + filters.product : '') + '; ticks mark prior-period cost.',
        formatAxis: f.axis,
        formatValue: f.money,
        items: top.map((it) => ({ key: it.key, label: it.key, value: it.cost, prior: it.prevCost, color: productColors.colorOf(it.product), selected: it.key === sel, valueLabel: f.amount(it.cost, it.status).replace(' (priced subtotal)', '*'), info: { key: it.key, label: tipLines(it).join('. ') + '. Press Enter to ' + (it.key === sel ? 'clear the SKU.' : 'show its daily cost.'), tip: tipLines(it).join('\n'), activate: () => drill(it) } })),
      }, chartHandlers(app)));
      view.append(h(app, 'div', { class: 'legend' }, legendKeys(app, [{ label: 'Selected period (colored by product)', color: app.colors.accent }, { label: 'Prior period', kind: 'line', color: app.colors.warm }])), h(app, 'div', { class: 'chart-wrap' }, chart), inspector(app));
    }
    if (sel) {
      const skuModelFilters = { sku: sel };
      const series = M.dailySeries(model, skuModelFilters, 'sku');
      const days = series.map((d) => {
        const lines = dayTip(app, d);
        return { date: d.date, axisLabel: fmtDate(d.date, false, false), cost: d.cost, status: d.status, prior: d.prior, segments: d.cost === null ? [] : [{ key: sel, label: sel, color: app.colors.accent, cost: d.cost }], flagged: false, selected: s.filters.day === d.date, info: { key: 'sku-day:' + d.date, label: lines.join('. ') + '. Press Enter to select this day.', tip: lines.join('\n'), activate: () => selectDay(app, d.date, 'mark:sku-day:' + d.date) } };
      });
      const tt = M.periodTotals(model, skuModelFilters);
      view.appendChild(h(app, 'section', { class: 'card', 'aria-label': 'SKU daily drilldown' }, [
        h(app, 'h4', {}, 'Daily cost of ' + sel),
        h(app, 'div', { class: 'row' }, [h(app, 'span', { class: 'big' }, f.amount(tt.current.cost, tt.current.status)), h(app, 'span', {}, 'Prior: ' + f.amount(tt.previous.cost, tt.previous.status)), h(app, 'span', {}, 'Change: ' + (f.change(tt.change) || 'no comparison'))]),
        h(app, 'div', { class: 'chart-wrap' }, C.stackedBars(app.doc, Object.assign({ width: chartWidth(app), height: 180, title: 'Daily cost of SKU ' + sel, summary: 'Daily bars for ' + sel + ' with the aligned prior period as a dashed line.', days, showPrior: model.hasPrior, showTrend: false, formatAxis: f.axis }, chartHandlers(app)))),
      ]));
    }
    view.appendChild(table(app, {
      caption: 'SKUs: selected vs prior period' + (filters.product ? ' (' + filters.product + ')' : ''),
      rows: sorted,
      isSelected: (it) => it.key === sel,
      columns: [
        { label: 'SKU', rowHeader: true, sortKey: 'name', csv: (it) => it.key, cell: (it) => h(app, 'button', { type: 'button', class: 'linkish', 'data-fk': 'row:' + it.key, onclick: () => drill(it) }, it.key) },
        { label: 'Product', opt: true, csv: (it) => it.product, cell: (it) => it.product },
        { label: 'Selected period', num: true, sortKey: 'cost', type: 'number', csv: (it) => it.cost, cell: (it) => amountCell(app, it.cost, it.status) },
        { label: 'Prior period', num: true, type: 'number', csv: (it) => it.prevCost, cell: (it) => amountCell(app, it.prevCost, it.prevStatus) },
        { label: 'Change', num: true, sortKey: 'change', type: 'number', csv: (it) => (it.change ? it.change.abs : null), cell: (it) => f.change(it.change) },
        { label: 'Share', num: true, opt: true, type: 'number', csvLabel: 'Share of scope total (fraction)', csv: (it) => it.share, cell: (it) => shareCell(app, it.share, g.validity) },
      ],
    }));
    if (!g.validity.valid) view.appendChild(note(app, 'Share of total not shown: ' + g.validity.reason));
  }

  /** Daily detail: sortable day-level table with aligned prior-period comparisons. */
  function viewDaily(app, view) {
    const s = app.sess;
    const f = app.fmt;
    const model = app.model;
    const filters = summaryFilters(app, false);
    const series = M.dailySeries(model, filters);
    const spikes = M.spikeFlags(series, M.priorDailySeries(model, filters), { latestUsageMs: model.latestUsageMs, nowMs: model.nowMs });
    const totals = M.periodTotals(model, filters);
    const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const rows = series.map((d) => Object.assign({}, d, { name: d.date, label: d.date + ' ' + weekday[d.weekday], share: M.shareOf(d.cost, totals.share) }));
    const list = M.search(rows, s.search, ['label', (d) => fmtDate(d.date)]);
    const sorted = M.sortItems(list, s.sort, { name: (d) => d.date });
    view.appendChild(h(app, 'div', { class: 'card' }, h(app, 'div', { class: 'row' }, [
      h(app, 'span', { class: 'big' }, 'Period: ' + f.amount(totals.current.cost, totals.current.status)),
      h(app, 'span', {}, 'Prior period: ' + f.amount(totals.previous.cost, totals.previous.status)),
      h(app, 'span', {}, 'Change: ' + (f.change(totals.change) || 'no comparison')),
      totals.missingDates ? h(app, 'span', { class: 'muted' }, totals.missingDates + ' date(s) unavailable') : null,
    ])));
    const card = dayDetailCard(app, model, 'product', filters);
    if (card) view.appendChild(card);
    for (const n of coverageNotes(app, series)) view.appendChild(n);
    view.appendChild(spikeNote(app, spikes));
    const ign = ignoredNote(app, ['owner', 'resource', 'run'], 'daily detail uses the product/SKU summary.');
    if (ign) view.appendChild(ign);
    view.appendChild(table(app, {
      caption: 'Daily cost with aligned prior-period days',
      rows: sorted,
      isSelected: (d) => s.filters.day === d.date,
      columns: [
        { label: 'Date (UTC)', rowHeader: true, sortKey: 'name', csv: (d) => d.date, cell: (d) => h(app, 'button', { type: 'button', class: 'linkish', 'data-fk': 'row:' + d.date, 'aria-pressed': String(s.filters.day === d.date), onclick: () => selectDay(app, d.date, 'row:' + d.date) }, fmtDate(d.date)) },
        { label: 'Cost', num: true, sortKey: 'cost', type: 'number', csv: (d) => d.cost, cell: (d) => amountCell(app, d.cost, d.status) },
        { label: 'Status', opt: true, csv: (d) => d.status, cell: (d) => statusText(d.status) },
        { label: 'Aligned prior day', opt: true, csv: (d) => d.priorDate, cell: (d) => fmtDate(d.priorDate, true, false) },
        { label: 'Prior cost', num: true, type: 'number', csv: (d) => d.prior.cost, cell: (d) => amountCell(app, d.prior.cost, d.prior.status) },
        { label: 'Change', num: true, sortKey: 'change', type: 'number', csv: (d) => (d.change ? d.change.abs : null), cell: (d) => f.change(d.change) },
        { label: 'Share', num: true, opt: true, type: 'number', csvLabel: 'Share of period (fraction)', csv: (d) => d.share, cell: (d) => shareCell(app, d.share, totals.share) },
        { label: 'Flag', csvLabel: 'Spike flag (heuristic)', csv: (d) => (spikes.flags.has(d.date) ? 'flag' : ''), cell: (d) => (spikes.flags.has(d.date) ? h(app, 'span', { class: 'flagtxt', title: HEURISTIC_NOTE }, '◆ Spike (heuristic)') : '') },
      ],
    }));
    if (!totals.share.valid) view.appendChild(note(app, 'Share of period not shown: ' + totals.share.reason));
  }

  const VIEW_RENDERERS = Object.freeze({ products: viewProducts, drivers: viewDrivers, runs: viewRuns, calendar: viewCalendar, skus: viewSkus, daily: viewDaily });

  /* ------------------------------------------------------------------ CSV */

  function csvMeta(app) {
    const m = app.model;
    const s = app.sess;
    const t = app.table || {};
    const viewLabel = VIEWS.find((v) => v.id === s.view).label;
    const dataLabel = m.mode === 'demo' ? 'Synthetic DEMO data (not from Databricks)' : m.mode === 'import' ? 'Imported summary (local costs.json)' : 'Connected Databricks (read-only SQL)';
    const basis = labels.BASIS[m.pricingBasis];
    const scope = ['Workspace ' + app.ctx.workspaceId + ' (' + app.ctx.origin + ')'];
    for (const n of s.order) scope.push(FILTER_NAMES[n] + ' = ' + filterText(n, s.filters[n]));
    if (s.search) scope.push('Search = "' + s.search + '"');
    if (t.scope) scope.push(t.scope);
    return [
      ['Source', 'Lakeline for Databricks · Cost Explorer: ' + viewLabel + (t.title ? ' · ' + t.title : '')],
      ['Data', dataLabel],
      ['Pricing basis', basis ? basis.short + ': ' + basis.note : m.pricingBasis || 'unknown'],
      ['Price table', m.priceTable || 'n/a'],
      ['Currency', m.currency],
      ['Period start (UTC, inclusive)', m.period.start],
      ['Period end (UTC, exclusive)', m.period.endExclusive],
      ['Prior period (UTC)', m.period.prevStart + ' to ' + m.period.prevEndExclusive + ' (exclusive)'],
      ['Freshness', m.latestUsageMs ? 'Latest usage ' + new Date(m.latestUsageMs).toISOString() : 'No usage observed'],
      ['Scope', scope.join('; ')],
      ['Limit', t.limit || 'None (all rows in scope)'],
      ['Ownership', s.view === 'drivers' || s.view === 'runs' || s.dimension === 'owner' ? 'Exclusive per billing record (job > pipeline > warehouse > notebook > app > cluster > unattributed)' : 'Not applicable (product/SKU totals)'],
      ['Missing values', 'Empty cells are unavailable or unpriced, never zero'],
      ['Notice', labels.DISCLAIMER],
    ];
  }

  function buildCsv(app) {
    if (!app.table) return null;
    return CSV.toCsv({ meta: csvMeta(app), columns: app.table.columns, rows: app.table.rows });
  }

  function exportCsv(app) {
    const text = buildCsv(app);
    if (!text) return false;
    const name = ['dcc-explorer', app.sess.view, app.ctx.workspaceId, app.model.period.start, app.model.period.endExclusive].join('_');
    return CSV.download(app.doc, app.root, name, text);
  }

  const api = Object.freeze({ mount, VIEWS, buildCsv: (handle) => buildCsv(handle.app), _sessions: sessions });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).explorer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
