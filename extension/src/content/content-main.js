/*
 * Content bootstrap for a supported workspace tab. Resolves workspace identity through the
 * service worker, mounts the banner, and runs registered feature modules (badges, estimates,
 * colors) on a bounded scheduler driven by DOM mutations, SPA route changes and settings.
 *
 * Consistency model: the summary shown always matches the newest identity and settings. Every
 * hello is sequenced (only the newest response applies), and after each one `sync()` compares
 * the desired summary key with the key last requested, so overlapping triggers (route change,
 * storage change, period click) converge on one request instead of racing.
 */
(function (root) {
  'use strict';
  const DCC = root.DCC;
  if (!DCC || root.__dccMainLoaded) return;
  if (root.top !== root.self) return;
  root.__dccMainLoaded = true;

  const doc = root.document;
  const V = DCC.validate;
  const cls = DCC.ids.classifyOrigin(root.location.href);
  if (!cls.ok) return;

  const chromeApi = root.chrome;
  const TICK = { minInterval: 250, maxWait: 1200 };
  // Fallback route detection for history.pushState calls made by the page (invisible to the
  // isolated world) that change no DOM: a string compare, no work unless the URL changed.
  const HREF_POLL_MS = 1000;
  const MODES = ['demo', 'import', 'connected'];
  const MISMATCH_ERROR = Object.freeze({
    code: 'WORKSPACE_MISMATCH',
    title: 'This page belongs to a different workspace',
    steps: ['The cost connection for this site is saved for another workspace ID. Open Connection preferences to choose which workspace to connect.'],
  });
  const HELLO_ERROR = Object.freeze({
    code: 'UNKNOWN',
    title: 'Lakeline could not start on this page',
    steps: ['Reload this page. If the extension was just updated or reloaded, this is expected.'],
  });

  const state = {
    origin: cls.origin,
    workspaceId: null,
    pageWorkspaceId: null,
    idConflict: false,
    mismatch: false,
    identified: false, // first hello answered
    helloError: null,
    settings: { mode: 'connected', periodDays: 30, showCosts: true },
    connection: null,
    summaryRes: null,
    loadedKey: null, // summary key of the last request (or deliberate non-request)
    seen: null, // settings/period last announced to features
    notice: null,
    href: root.location.href,
    epochs: { connection: 0, import: 0 },
    period: { writes: 0, acked: 0 },
    ticks: 0,
    started: false,
    stopped: false,
  };

  /* ------------------------------------------------------------------ messaging */

  function orphaned() {
    try {
      return !chromeApi || !chromeApi.runtime || !chromeApi.runtime.id;
    } catch (_) {
      return true;
    }
  }

  /** After an extension reload/update this world is orphaned: stop everything, remove our UI. */
  function checkOrphaned() {
    if (!state.stopped && orphaned()) teardown();
    return state.stopped;
  }

  function sendMessage(msg) {
    if (state.stopped) return Promise.reject(new Error('Lakeline stopped'));
    try {
      return Promise.resolve(chromeApi.runtime.sendMessage(msg)).catch((e) => {
        checkOrphaned();
        throw e;
      });
    } catch (e) {
      // An orphaned context throws synchronously ("Extension context invalidated").
      checkOrphaned();
      return Promise.reject(e);
    }
  }

  const data = DCC.workspaceData.create({ sendMessage, getContext: () => (state.workspaceId ? { origin: state.origin, workspaceId: state.workspaceId } : null) });

  /* ------------------------------------------------------------------ features */

  // First registration per name wins: re-injection into an open tab re-runs feature files in the
  // same world and may push a second instance.
  const activeFeatures = new Map();

  function features() {
    const list = Array.isArray(DCC.features) ? DCC.features : [];
    for (const f of list) {
      if (!f || typeof f !== 'object') continue;
      const key = typeof f.name === 'string' && f.name ? 'name:' + f.name : f;
      if (activeFeatures.has(key)) continue;
      activeFeatures.set(key, f);
      if (state.started) call(f, 'onStart');
    }
    return [...activeFeatures.values()];
  }

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

  function call(f, hook) {
    if (typeof f[hook] !== 'function') return;
    try {
      const r = f[hook](featureContext());
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (_) {
      /* a failing feature must not break the banner */
    }
  }

  function notify(hook) {
    if (state.stopped || !state.started) return;
    for (const f of features()) call(f, hook);
  }

  /* ------------------------------------------------------------------ banner */

  const banner = DCC.workspaceUi.createBanner(doc, {
    onPeriod: setPeriod,
    onRefresh: () => loadSummary(true),
    onSettings: () => openPage('options'),
    onGuide: () => openPage('guide'),
    onConnect: () => openPage('options', 'connect'),
    onResume: resume,
    onToggle: () => {},
    renderPanel: (panel, bannerState) => {
      if (DCC.explorer && typeof DCC.explorer.mount === 'function') return DCC.explorer.mount(panel, featureContext(), bannerState);
      renderBreakdown(panel, bannerState.summary);
      return null;
    },
  });

  function bannerState() {
    const base = { periodDays: state.settings.periodDays, nowMs: Date.now(), mode: state.settings.mode, notice: state.notice };
    if (!state.identified) return Object.assign(base, { status: 'loading' });
    if (state.settings.showCosts === false) return Object.assign(base, { status: 'paused' });
    if (state.mismatch) {
      return Object.assign(base, {
        status: 'mismatch',
        error: MISMATCH_ERROR,
        pageWorkspaceId: state.pageWorkspaceId,
        connectedWorkspaceId: state.connection && state.connection.workspaceId,
      });
    }
    if (!state.workspaceId) {
      if (state.helloError) return Object.assign(base, { status: 'error', error: state.helloError });
      return Object.assign(base, { status: 'unidentified', conflict: state.idConflict });
    }
    return Object.assign(base, DCC.workspaceUi.statusFor(state.summaryRes));
  }

  function render() {
    if (!state.stopped) banner.render(bannerState());
  }

  function showNotice(text) {
    state.notice = text;
    render();
  }

  function openPage(page, anchor) {
    const msg = { type: 'dcc:open', page, origin: state.origin, workspaceId: state.workspaceId };
    if (anchor) msg.anchor = anchor;
    sendMessage(msg).then(
      (res) => {
        if (!res || !res.ok) showNotice('Open the Lakeline popup from the browser toolbar to change settings.');
      },
      () => showNotice('Open the Lakeline popup from the browser toolbar to change settings.')
    );
  }

  /* ------------------------------------------------------------------ identity and settings */

  function connectionKey(c) {
    return c ? [c.workspaceId, c.authMode, c.priceTable, c.currency] : null;
  }

  /** Everything the banner summary depends on. A change means a new request. */
  function summaryKey() {
    const s = state.settings;
    return JSON.stringify([
      state.workspaceId,
      state.mismatch,
      s.mode,
      s.periodDays,
      s.showCosts !== false,
      connectionKey(state.connection),
      state.epochs.connection,
      s.mode === 'import' ? state.epochs.import : 0,
    ]);
  }

  function settingsKey() {
    const s = state.settings;
    return JSON.stringify([s.mode, s.showCosts !== false, connectionKey(state.connection), state.epochs.connection, state.epochs.import]);
  }

  function cleanSettings(raw, prev) {
    const r = raw && typeof raw === 'object' ? raw : {};
    return {
      mode: MODES.includes(r.mode) ? r.mode : prev.mode,
      periodDays: V.isPeriodDays(r.periodDays) ? r.periodDays : prev.periodDays,
      showCosts: r.showCosts !== false,
      revision: Number.isInteger(r.revision) ? r.revision : prev.revision,
    };
  }

  let helloSeq = 0;
  let helloLatest = Promise.resolve();

  /**
   * Ask the service worker who we are. Calls may overlap (route change, storage change); only
   * the newest response is applied, and every caller resolves once the newest has applied.
   */
  function hello() {
    const seq = ++helloSeq;
    // A period the user just picked wins over a hello that may have read storage before the
    // setPeriod write landed.
    const periodAtSend = { writes: state.period.writes, pending: state.period.writes !== state.period.acked };
    const p = sendMessage({ type: 'dcc:hello', origin: state.origin, href: root.location.href })
      .then(
        (res) => res,
        () => null
      )
      .then((res) => {
        if (seq !== helloSeq || state.stopped) return;
        applyHello(res, periodAtSend);
      });
    helloLatest = p;
    return settled();
  }

  async function settled() {
    let p;
    do {
      p = helloLatest;
      await p;
    } while (p !== helloLatest);
  }

  function applyHello(res, periodAtSend) {
    state.identified = true;
    if (!res || !res.ok || !res.data || typeof res.data !== 'object') {
      state.helloError = (res && res.error) || HELLO_ERROR;
      return;
    }
    state.helloError = null;
    const d = res.data;
    const settings = cleanSettings(d.settings, state.settings);
    if (periodAtSend.pending || periodAtSend.writes !== state.period.writes) settings.periodDays = state.settings.periodDays;
    state.settings = settings;
    state.connection = d.connection && typeof d.connection === 'object' ? d.connection : null;
    state.idConflict = Boolean(d.idConflict);
    state.pageWorkspaceId = V.isWorkspaceId(d.workspaceId) ? d.workspaceId : null;
    state.mismatch = Boolean(d.connectionMismatch);
    state.workspaceId = state.mismatch ? null : state.pageWorkspaceId;
  }

  /**
   * Reconcile after any identity/settings/period change: request the summary when what it
   * depends on changed (otherwise just re-render), and tell features what changed.
   */
  function sync() {
    if (state.stopped) return;
    const prev = state.seen;
    const seen = { period: state.settings.periodDays, settings: settingsKey() };
    state.seen = seen;
    if (summaryKey() !== state.loadedKey) loadSummary(false);
    else render();
    if (prev && prev.period !== seen.period) notify('onPeriod');
    if (prev && prev.settings !== seen.settings) notify('onSettings');
  }

  function setPeriod(days) {
    if (!V.isPeriodDays(days) || state.stopped) return;
    const seq = ++state.period.writes;
    state.settings = Object.assign({}, state.settings, { periodDays: days });
    const ack = () => {
      state.period.acked = Math.max(state.period.acked, seq);
    };
    sendMessage({ type: 'dcc:setPeriod', origin: state.origin, workspaceId: state.workspaceId, periodDays: days }).then(ack, ack);
    sync();
  }

  function resume() {
    const failed = () => showNotice('Resume from the Lakeline popup in the browser toolbar.');
    sendMessage({ type: 'dcc:resume', origin: state.origin, workspaceId: state.workspaceId }).then((res) => {
      if (!res || !res.ok) return failed();
      state.notice = null;
      state.settings = Object.assign({}, state.settings, { showCosts: true });
      sync();
    }, failed);
  }

  /* ------------------------------------------------------------------ summary */

  async function loadSummary(force) {
    if (state.stopped) return;
    state.loadedKey = summaryKey();
    state.notice = null;
    if (!state.workspaceId || state.mismatch || state.settings.showCosts === false) {
      // Paused or unidentified: no request, and drop any response still in flight.
      data.invalidate('summary');
      state.summaryRes = null;
      render();
      return;
    }
    const periodDays = state.settings.periodDays;
    state.summaryRes = null;
    render();
    const res = await data.summary(periodDays, force === true);
    if (state.stopped || !res || res.stale) return;
    if (periodDays !== state.settings.periodDays || state.settings.showCosts === false) return;
    state.summaryRes = res;
    render();
    notify('onSummary');
  }

  /** Fallback breakdown when the Explorer module is not loaded. */
  function renderBreakdown(panel, s) {
    const h = (t, a, c) => DCC.dom.h(doc, t, a, c);
    const currency = (s && s.currency) || 'USD';
    const fmt = (v) => {
      try {
        return DCC.labels.formatAmount(v, currency) || 'n/a';
      } catch (_) {
        return 'n/a';
      }
    };
    const cur = new Map();
    const prev = new Map();
    for (const r of (s && s.daily) || []) {
      const m = r.period === 'prev' ? prev : cur;
      if (typeof r.cost === 'number' && Number.isFinite(r.cost)) m.set(r.product, (m.get(r.product) || 0) + r.cost);
    }
    if (!cur.size) {
      panel.appendChild(h('p', { class: 'note' }, 'No priced usage to break down for this period.'));
      return;
    }
    const rowsOut = [...cur.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([p, v]) => h('tr', {}, [h('td', {}, String(p)), h('td', { class: 'num' }, fmt(v)), h('td', { class: 'num' }, prev.has(p) ? fmt(prev.get(p)) : 'No data')]));
    panel.appendChild(
      h('table', {}, [
        h('caption', {}, 'Cost by product (selected vs prior period)'),
        h('thead', {}, h('tr', {}, [h('th', {}, 'Product'), h('th', { class: 'num' }, 'Selected'), h('th', { class: 'num' }, 'Prior')])),
        h('tbody', {}, rowsOut),
      ])
    );
  }

  /* ------------------------------------------------------------------ placement and ticks */

  let retryTimer = null;

  function place() {
    const current = banner.host.parentNode;
    banner.ensurePlaced(DCC.native.findBannerContainer(doc, { prefer: current && current.nodeType === 1 ? current : null }));
    const wait = banner.backoffRemaining();
    if (wait > 0 && retryTimer === null) {
      retryTimer = root.setTimeout(() => {
        retryTimer = null;
        scheduler.request();
      }, wait + 50);
    }
  }

  async function tick() {
    if (checkOrphaned() || !state.started) return;
    state.ticks++;
    if (root.location.href !== state.href) {
      state.href = root.location.href;
      await hello();
      if (state.stopped) return;
      sync();
      notify('onRoute');
    }
    place();
    notify('onTick');
  }

  const scheduler = DCC.dom.createScheduler(tick, TICK);

  const observer = new root.MutationObserver((records) => {
    if (state.stopped) return;
    for (const m of records) {
      if (!DCC.dom.isOwnMutation(m)) {
        scheduler.request();
        return;
      }
    }
    // Only our own nodes changed; still react if the page evicted the banner.
    if (!banner.host.isConnected) scheduler.request();
  });
  const OBSERVE = {
    childList: true,
    subtree: true,
    // Recycled virtual rows often change only text and link targets.
    characterData: true,
    attributes: true,
    attributeFilter: ['href', 'hidden', 'style', 'class'],
  };

  const onRouteEvent = () => scheduler.request();
  const onVisibility = () => {
    if (doc.visibilityState === 'visible') scheduler.request();
  };
  let pollTimer = null;

  function connectionChanged(change) {
    const pick = (v) => (v && typeof v === 'object' ? v[state.origin] : undefined);
    const oldIsObj = change.oldValue === undefined || (change.oldValue && typeof change.oldValue === 'object');
    const newIsObj = change.newValue === undefined || (change.newValue && typeof change.newValue === 'object');
    if (!oldIsObj || !newIsObj) return true;
    return JSON.stringify(pick(change.oldValue) || null) !== JSON.stringify(pick(change.newValue) || null);
  }

  const onStorage = (changes, area) => {
    if (state.stopped || area !== 'local' || !changes) return;
    if (checkOrphaned()) return;
    let relevant = false;
    if (changes['dcc.connections']) {
      if (connectionChanged(changes['dcc.connections'])) state.epochs.connection++;
      relevant = true;
    }
    if (changes['dcc.import']) {
      state.epochs.import++;
      relevant = true;
    }
    if (changes['dcc.settings']) relevant = true;
    if (relevant) hello().then(sync);
    if (changes['dcc.appearance']) notify('onAppearance');
  };

  function teardown() {
    if (state.stopped) return;
    for (const f of activeFeatures.values()) call(f, 'onStop');
    state.stopped = true;
    observer.disconnect();
    scheduler.stop();
    if (pollTimer !== null) root.clearInterval(pollTimer);
    if (retryTimer !== null) root.clearTimeout(retryTimer);
    root.removeEventListener('popstate', onRouteEvent);
    root.removeEventListener('hashchange', onRouteEvent);
    if (root.navigation && typeof root.navigation.removeEventListener === 'function') root.navigation.removeEventListener('currententrychange', onRouteEvent);
    doc.removeEventListener('visibilitychange', onVisibility);
    try {
      if (chromeApi && chromeApi.storage && chromeApi.storage.onChanged && typeof chromeApi.storage.onChanged.removeListener === 'function') chromeApi.storage.onChanged.removeListener(onStorage);
    } catch (_) {
      /* orphaned contexts may throw on any chrome.* access */
    }
    data.invalidate('summary');
    banner.destroy();
  }

  /* ------------------------------------------------------------------ start */

  (async function start() {
    render();
    banner.ensurePlaced(DCC.native.findBannerContainer(doc));
    try {
      // Before the first hello, so a settings change that lands meanwhile isn't lost.
      chromeApi.storage.onChanged.addListener(onStorage);
    } catch (_) {
      /* storage events unavailable: settings apply on the next route change */
    }
    await hello();
    if (state.stopped) return;
    state.seen = { period: state.settings.periodDays, settings: settingsKey() };
    place();
    sync(); // first summary request (or the paused / unidentified state)
    observer.observe(doc.documentElement, OBSERVE);
    root.addEventListener('popstate', onRouteEvent);
    root.addEventListener('hashchange', onRouteEvent);
    if (root.navigation && typeof root.navigation.addEventListener === 'function') root.navigation.addEventListener('currententrychange', onRouteEvent);
    doc.addEventListener('visibilitychange', onVisibility);
    pollTimer = root.setInterval(() => {
      if (!state.stopped && root.location.href !== state.href) scheduler.request();
    }, HREF_POLL_MS);
    state.started = true;
    features(); // registers and starts every feature (onStart)
    scheduler.request();
  })();

  root.__dccTest = { state, banner, scheduler, loadSummary, sync, teardown, features: () => features() };
})(typeof globalThis !== 'undefined' ? globalThis : this);
