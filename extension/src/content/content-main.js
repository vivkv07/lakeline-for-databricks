/*
 * Content bootstrap for a supported workspace tab. Resolves workspace identity through the
 * service worker, mounts the banner, and runs registered feature modules (badges, estimates,
 * colors) on a bounded scheduler driven by DOM mutations, SPA route changes and settings.
 */
(function (root) {
  'use strict';
  const DCC = root.DCC;
  if (!DCC || root.__dccMainLoaded) return;
  if (root.top !== root.self) return;
  root.__dccMainLoaded = true;

  const doc = root.document;
  const ids = DCC.ids;
  const cls = ids.classifyOrigin(root.location.href);
  if (!cls.ok) return;

  const chromeApi = root.chrome;
  const sendMessage = (msg) => chromeApi.runtime.sendMessage(msg);
  const state = {
    origin: cls.origin,
    workspaceId: null,
    idConflict: false,
    settings: { mode: 'connected', periodDays: 30, showCosts: true },
    connection: null,
    summaryRes: null,
    href: root.location.href,
    nowMs: Date.now(),
  };
  const features = DCC.features || [];
  const data = DCC.workspaceData.create({ sendMessage, getContext: () => (state.workspaceId ? { origin: state.origin, workspaceId: state.workspaceId } : null) });

  const banner = DCC.workspaceUi.createBanner(doc, {
    onPeriod: (d) => {
      state.settings.periodDays = d;
      sendMessage({ type: 'dcc:setPeriod', origin: state.origin, workspaceId: state.workspaceId, periodDays: d }).catch(() => {});
      loadSummary(false);
      notify('onPeriod');
    },
    onRefresh: () => loadSummary(true),
    onSettings: () => sendMessage({ type: 'dcc:open', page: 'options', origin: state.origin, workspaceId: state.workspaceId }).catch(() => {}),
    onGuide: () => sendMessage({ type: 'dcc:open', page: 'guide', origin: state.origin, workspaceId: state.workspaceId }).catch(() => {}),
    onConnect: () => sendMessage({ type: 'dcc:open', page: 'options', anchor: 'connect', origin: state.origin, workspaceId: state.workspaceId }).catch(() => {}),
    onResume: () => sendMessage({ type: 'dcc:resume', origin: state.origin, workspaceId: state.workspaceId }).catch(() => {}),
    onToggle: () => {},
    renderPanel: (panel, bannerState) => {
      if (DCC.explorer && DCC.explorer.mount) DCC.explorer.mount(panel, featureContext(), bannerState);
      else renderBreakdown(panel, bannerState.summary);
    },
  });

  function featureContext() {
    return {
      doc,
      origin: state.origin,
      workspaceId: state.workspaceId,
      settings: state.settings,
      connection: state.connection,
      summary: state.summaryRes && state.summaryRes.ok ? state.summaryRes.data : null,
      data,
      sendMessage,
      requestTick: () => scheduler.request(),
    };
  }

  function notify(hook) {
    for (const f of features) {
      try {
        if (typeof f[hook] === 'function') f[hook](featureContext());
      } catch (e) {
        /* a failing feature must not break the banner */
      }
    }
  }

  function bannerState() {
    if (state.settings.showCosts === false) return { status: 'paused', periodDays: state.settings.periodDays };
    if (!state.workspaceId) return { status: 'unidentified', conflict: state.idConflict, periodDays: state.settings.periodDays };
    const st = DCC.workspaceUi.statusFor(state.summaryRes);
    return Object.assign(st, { periodDays: state.settings.periodDays, nowMs: Date.now() });
  }

  async function loadSummary(force) {
    if (!state.workspaceId || state.settings.showCosts === false) {
      banner.render(bannerState());
      return;
    }
    state.summaryRes = null;
    banner.render(bannerState());
    const res = await data.summary(state.settings.periodDays, force);
    if (res.stale) return;
    state.summaryRes = res;
    banner.render(bannerState());
    notify('onSummary');
  }

  async function hello() {
    const res = await sendMessage({ type: 'dcc:hello', origin: state.origin, href: root.location.href }).catch(() => null);
    if (!res || !res.ok) return false;
    const d = res.data;
    state.workspaceId = d.connectionMismatch ? null : d.workspaceId;
    state.idConflict = d.idConflict;
    state.settings = d.settings;
    state.connection = d.connection;
    if (d.connectionMismatch) state.summaryRes = { ok: false, error: { code: 'WORKSPACE_MISMATCH', title: 'This page belongs to a different workspace', steps: ['The cost connection for this site is saved for another workspace ID. Open Connection preferences to choose which workspace to connect.'] } };
    return true;
  }

  function renderBreakdown(panel, s) {
    const h = (t, a, c) => DCC.dom.h(doc, t, a, c);
    const cur = new Map();
    const prev = new Map();
    for (const r of s.daily || []) {
      const m = r.period === 'prev' ? prev : cur;
      if (r.cost !== null) m.set(r.product, (m.get(r.product) || 0) + r.cost);
    }
    const rowsOut = [...cur.entries()].sort((a, b) => b[1] - a[1]).map(([p, v]) =>
      h('tr', {}, [h('td', {}, p), h('td', { class: 'num' }, DCC.labels.formatAmount(v, s.currency)), h('td', { class: 'num' }, prev.has(p) ? DCC.labels.formatAmount(prev.get(p), s.currency) : '—')])
    );
    panel.appendChild(h('table', {}, [h('caption', {}, 'Cost by product (selected vs prior period)'), h('thead', {}, h('tr', {}, [h('th', {}, 'Product'), h('th', { class: 'num' }, 'Selected'), h('th', { class: 'num' }, 'Prior')])), h('tbody', {}, rowsOut)]));
  }

  const scheduler = DCC.dom.createScheduler(
    async () => {
      if (root.location.href !== state.href) {
        const prevWorkspace = state.workspaceId;
        state.href = root.location.href;
        await hello();
        if (state.workspaceId !== prevWorkspace) loadSummary(false);
        notify('onRoute');
      }
      banner.ensurePlaced(DCC.native.findBannerContainer(doc));
      notify('onTick');
    },
    { minInterval: 250, maxWait: 1200 }
  );

  const observer = new root.MutationObserver((mutations) => {
    // Ignore mutations caused only by our own nodes.
    for (const m of mutations) {
      const t = m.target;
      if (t && t.nodeType === 1 && t.closest && t.closest('[data-dcc]')) continue;
      scheduler.request();
      return;
    }
  });

  chromeApi.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes['dcc.settings'] || changes['dcc.connections'] || changes['dcc.import']) {
      const before = JSON.stringify([state.settings.mode, state.settings.periodDays, state.settings.showCosts, state.connection]);
      hello().then(() => {
        const after = JSON.stringify([state.settings.mode, state.settings.periodDays, state.settings.showCosts, state.connection]);
        if (before !== after || changes['dcc.import']) {
          loadSummary(false);
          notify('onSettings');
        }
      });
    }
    if (changes['dcc.appearance']) notify('onAppearance');
  });

  root.addEventListener('popstate', () => scheduler.request());
  root.addEventListener('hashchange', () => scheduler.request());
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') scheduler.request();
  });

  (async function start() {
    await hello();
    banner.ensurePlaced(DCC.native.findBannerContainer(doc));
    loadSummary(false);
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    notify('onStart');
    scheduler.request();
  })();

  root.__dccTest = { state, banner, scheduler, loadSummary };
})(typeof globalThis !== 'undefined' ? globalThis : this);
