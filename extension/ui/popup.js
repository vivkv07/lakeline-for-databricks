/*
 * Toolbar popup: data mode, connect hand-off, Genie side panel, cost visibility, period, monitor
 * preferences, diagnostics and links. Talks to the service worker only through sender-validated page:*
 * messages. All DOM is built with textContent, never innerHTML with variable data.
 *
 * Layout: one primary action for the active tab (Connect until it's connected, then Ask Genie),
 * the sign-in chooser only when needed or asked for, three essentials, and the rest under More.
 *
 * The active tab's URL is visible only while the popup is open (activeTab). It is used to offer
 * "Connect this workspace" and is handed to the options page through page:setPendingConnect,
 * which keeps only the origin and a numeric workspace ID.
 */
(function (root) {
  'use strict';
  const DCC = root.DCC || {};
  const doc = root.document;
  const chromeApi = root.chrome;
  const V = DCC.validate;
  const ids = DCC.ids;
  const errors = DCC.errors;
  const $ = (id) => doc.getElementById(id);

  const MODE_HINTS = {
    demo: 'Synthetic figures, labeled DEMO. No Databricks connection or requests.',
    import: 'Summaries from a costs.json file you import. No query history or run detail unless imported.',
    connected: 'Read-only SQL on your workspace\'s billing tables, using your own sign-in.',
  };
  const MODE_NAMES = { demo: 'Demo mode', import: 'Local import', connected: 'Connected' };
  const UNSUPPORTED_TAB = {
    'account-console': 'This is the account console. Open a workspace to connect it.',
    'not-https': 'Databricks workspaces use https:// URLs.',
  };

  let state = null; // page:state data
  let tab = null; // {supported, url, origin, host, workspaceId, conflict, granted} | {supported:false, reason}
  let windowId = null; // the popup's browser window, read at load so sidePanel.open stays in the click

  /** h('div', {class, onclick, ...}, [children]): text nodes only. */
  function h(tag, attrs, children) {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of [].concat(children === undefined ? [] : children)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? doc.createTextNode(String(c)) : c);
    }
    return el;
  }

  const clean = (t, max = 300) => (errors ? errors.redact(V.safeText(t, max)) : V.safeText(t, max));

  function backgroundError(message) {
    return {
      code: 'UNKNOWN',
      title: 'Could not reach the extension background',
      steps: ['Close and reopen this popup. If it keeps happening, reload the extension from the browser\'s extensions page.'],
      details: { message: message || null },
    };
  }

  /**
   * An error tagged with the request that failed (a message type such as 'connect:oneClick'), so
   * a generic "Something went wrong" still says what it was about under Technical details.
   */
  function failed(error, type) {
    const e = error && typeof error === 'object' ? error : {};
    const details = Object.assign({}, e.details && typeof e.details === 'object' ? e.details : {});
    if (typeof details.action !== 'string' && typeof type === 'string') details.action = type;
    return Object.assign({}, e, { details });
  }

  /** sendMessage that always resolves to {ok, data} | {ok:false, error}; errors name the request. */
  async function send(msg) {
    const type = msg && msg.type;
    try {
      const res = await chromeApi.runtime.sendMessage(msg);
      if (res && typeof res === 'object' && typeof res.ok === 'boolean') return res.ok ? res : { ok: false, error: failed(res.error, type) };
      return { ok: false, error: failed(backgroundError('No response'), type) };
    } catch (e) {
      return { ok: false, error: failed(backgroundError(e && e.message), type) };
    }
  }

  function closePopup() {
    try {
      root.close();
    } catch (_) {
      /* not closable in this context */
    }
  }

  /* ---------------------------------------------------------------- alerts */

  /** `tech`: [label, value] rows for a collapsed Technical details block (errors only). */
  function alertBox(kind, title, lines, tech) {
    const items = (lines || []).filter(Boolean);
    const rows = tech || [];
    return h('div', { class: 'dcc-alert dcc-alert--' + kind, role: kind === 'error' ? 'alert' : null }, [
      h('p', { class: 'dcc-alert__title' }, title),
      items.length === 1 ? h('p', { class: 'dcc-alert__body' }, items[0]) : null,
      items.length > 1 ? h('ul', { class: 'dcc-alert__steps' }, items.map((l) => h('li', {}, l))) : null,
      rows.length
        ? h('details', { class: 'dcc-tech-details' }, [
            h('summary', {}, 'Technical details'),
            h('dl', { class: 'dcc-tech' }, [].concat(...rows.map(([label, value]) => [h('dt', {}, label), h('dd', {}, h('code', {}, value))]))),
          ])
        : null,
    ]);
  }

  const ACTION_RE = /^[a-z]{1,20}:[A-Za-z]{1,40}$/;

  function errorParts(error) {
    const e = error && typeof error === 'object' ? error : {};
    const code = typeof e.code === 'string' && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : 'UNKNOWN';
    const cat = (errors && errors.CATALOG[code]) || { title: 'Something went wrong', steps: [] };
    const title = clean(e.title) || cat.title;
    const steps = (Array.isArray(e.steps) ? e.steps : cat.steps).map((s) => clean(s)).filter(Boolean).slice(0, 4);
    // Technical details: which request failed and what the background reported (already redacted
    // there; redacted again here). Shown only for failures that came from a request.
    const d = e.details && typeof e.details === 'object' ? e.details : {};
    const action = typeof d.action === 'string' && ACTION_RE.test(d.action) ? d.action : null;
    const message = d.message ? clean(d.message, 600) : '';
    const tech = [];
    if (action || message) {
      tech.push(['Code', code]);
      if (action) tech.push(['Request', action]);
      if (Number.isInteger(d.httpStatus)) tech.push(['HTTP status', String(d.httpStatus)]);
      if (d.errorCode) tech.push(['Error code', clean(d.errorCode, 80)]);
      if (V.isStatementId(String(d.statementId || '').toLowerCase())) tech.push(['Statement ID', String(d.statementId).toLowerCase()]);
      if (message) tech.push(['Message', message]);
    }
    return { code, title, steps, tech };
  }

  function showAlert(error) {
    const slot = $('page-alert');
    slot.textContent = '';
    if (!error) return;
    const p = errorParts(error);
    slot.appendChild(alertBox('error', p.title, p.steps, p.tech));
  }

  function setGenieStatus(kind, title, lines) {
    const slot = $('genie-status');
    slot.textContent = '';
    if (title) slot.appendChild(alertBox(kind, title, lines));
  }

  function setMonitorStatus(kind, title, lines) {
    const slot = $('monitor-status');
    slot.textContent = '';
    if (title) slot.appendChild(alertBox(kind, title, lines));
  }

  /* ---------------------------------------------------------------- active tab */

  async function readActiveTab() {
    try {
      const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
      const t = tabs && tabs[0];
      if (t && Number.isInteger(t.windowId)) windowId = t.windowId;
      if (!t || typeof t.url !== 'string' || !t.url) return null;
      const cls = ids.classifyOrigin(t.url);
      if (!cls.ok) return { supported: false, reason: cls.reason };
      const resolved = ids.resolveWorkspaceId(t.url, {});
      let granted = null;
      try {
        granted = await chromeApi.permissions.contains({ origins: [cls.origin + '/*'] });
      } catch (_) {
        granted = null;
      }
      return {
        supported: true,
        url: t.url,
        origin: cls.origin,
        host: cls.host,
        kind: cls.kind,
        workspaceId: V.isWorkspaceId(resolved.id) ? resolved.id : null,
        conflict: resolved.conflict === true,
        granted,
      };
    } catch (_) {
      return null;
    }
  }

  function connections() {
    return (state && state.connections) || {};
  }

  function renderTab() {
    const box = $('tab-status');
    const btn = $('connect-btn');
    box.textContent = '';
    const saved = Object.keys(connections()).length;
    let connectedHere = false;
    let canChoose = false;
    if (tab && tab.supported) {
      const conn = connections()[tab.origin] || null;
      box.appendChild(h('p', { class: 'pp-host' }, [h('span', {}, tab.host), tab.kind === 'fixture' ? h('span', { class: 'dcc-pill' }, 'Local test') : null]));
      if (conn) {
        const mismatch = tab.workspaceId && tab.workspaceId !== conn.workspaceId;
        if (mismatch) {
          box.appendChild(h('p', { class: 'pp-line pp-line--warn' }, 'This tab shows workspace ' + tab.workspaceId + ', but the saved connection is for workspace ' + conn.workspaceId + '. Costs stay hidden here until you choose.'));
          btn.textContent = 'Review connection';
        } else {
          box.appendChild(h('p', { class: 'pp-line pp-line--ok' }, 'Connected · workspace ' + conn.workspaceId));
          btn.textContent = conn.authMode === 'oauth' ? 'Reconnect' : 'Edit connection';
          connectedHere = true;
        }
      } else {
        box.appendChild(h('p', { class: 'pp-line pp-line--idle' }, tab.conflict ? 'Not connected. This URL has conflicting workspace IDs; you will choose one.' : 'Not connected yet.'));
        btn.textContent = 'Connect this workspace';
        canChoose = tab.kind === 'workspace';
      }
    } else {
      const reason = tab && UNSUPPORTED_TAB[tab.reason];
      box.appendChild(h('p', { class: 'pp-line' }, reason || 'Open a Databricks workspace tab to connect it from here, or set one up in Connection preferences.'));
      if (saved) box.appendChild(h('p', { class: 'pp-line' }, saved === 1 ? '1 workspace connected.' : saved + ' workspaces connected.'));
      btn.textContent = 'Connect Databricks';
    }
    placeActions(connectedHere, canChoose);
  }

  /**
   * One primary action per state: Connect until this tab's workspace is connected, then Ask Genie,
   * with the connection button demoted to a text link. Nodes are moved (not cloned), so their
   * listeners and IDs stay.
   */
  function placeActions(connectedHere, canChoose) {
    const btn = $('connect-btn');
    const genie = $('genie-open');
    const actions = $('ws-actions');
    const alt = $('ws-alt');
    if (connectedHere) {
      genie.className = 'dcc-btn dcc-btn--primary pp-main';
      btn.className = 'dcc-link pp-alt-link';
      actions.insertBefore(genie, actions.firstChild);
      alt.insertBefore(btn, alt.firstChild);
    } else {
      btn.className = 'dcc-btn dcc-btn--primary pp-main';
      genie.className = 'dcc-btn pp-genie';
      actions.insertBefore(btn, actions.firstChild);
      actions.appendChild(genie);
    }
    $('signin-alt').hidden = !canChoose;
    // Say what signing in shares before the first sign-in (store user-data disclosure).
    $('connect-note').hidden = connectedHere || !canChoose;
    syncSetupToggle();
  }

  function syncSetupToggle() {
    $('signin-alt').setAttribute('aria-expanded', String(!$('oauth-setup').hidden));
  }

  /* ---------------------------------------------------------------- one-click connect */

  const CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/;
  /** The built-in sign-in reads its redirect from the sign-in tab, so it also needs this origin. */
  const SIGNIN_REDIRECT_PATTERN = 'http://localhost:8020/*';
  const PRIVACY_URL = 'https://vivkv07.github.io/lakeline-for-databricks/privacy.html';
  /** Where Databricks lists a user's tokens (Settings, Developer, Access tokens). */
  const TOKEN_PAGE_PATH = '/settings/user/developer/access-tokens';
  /** Codes after which the token box is the natural next step. */
  const OFFER_TOKEN = ['BUILTIN_SIGNIN_BLOCKED', 'AUTH_CANCELLED'];

  const policy = () => (state && state.policy) || {};
  const customClientId = () => {
    const id = policy().oauthClientId || (state && state.settings && state.settings.oauth && state.settings.oauth.clientId);
    return CLIENT_ID_RE.test(id || '') ? id : null;
  };

  function setTabLine(kind, text) {
    const box = $('tab-status');
    box.querySelectorAll('[data-connect-line]').forEach((n) => n.remove());
    if (text) box.appendChild(h('p', { class: 'pp-line' + (kind ? ' pp-line--' + kind : ''), 'data-connect-line': '' }, text));
  }

  /** Open the other sign-in ways. `moveFocus: false` keeps focus on the toggle that opened it. */
  async function showSetup(redirectUrl, { moveFocus = true, focus = 'pat-input' } = {}) {
    const panel = $('oauth-setup');
    panel.hidden = false;
    syncSetupToggle();
    let url = redirectUrl;
    if (!url) {
      const r = await send({ type: 'connect:redirectUrl' });
      url = r.ok && r.data ? r.data.redirectUrl : '';
    }
    $('oauth-redirect').textContent = url || '';
    const saved = state && state.settings && state.settings.oauth && state.settings.oauth.clientId;
    if (saved && !$('oauth-client-id').value) $('oauth-client-id').value = saved;
    if (moveFocus) $(focus).focus();
  }

  function onToggleSetup() {
    if ($('oauth-setup').hidden) {
      showSetup(undefined, { moveFocus: false });
      return;
    }
    $('oauth-setup').hidden = true;
    syncSetupToggle();
  }

  /**
   * Site access must be requested synchronously inside the click (user gesture), before any
   * other await; everything after it runs in the background service worker.
   */
  function requestAccessThen(next, extra = []) {
    const pending = tab.granted === true && !extra.length ? Promise.resolve(true) : chromeApi.permissions.request({ origins: [tab.origin + '/*'].concat(extra) });
    pending
      .then((granted) => {
        if (!granted) {
          showAlert({ code: 'PERMISSION_NOT_GRANTED', title: 'Site access was not allowed', steps: ['Click Connect again and choose Allow. Access covers only ' + tab.host + '.'] });
          return;
        }
        tab.granted = true;
        return next();
      })
      .catch((e) => showAlert(backgroundError(e && e.message)));
  }

  const PROGRESS = {
    pat: 'Checking the token with Databricks…',
    builtin: 'Signing in with Databricks… finish in the tab that opens.',
    oauth: 'Signing in with Databricks… finish in the window that opens.',
  };

  async function oneClick(clientId, method, extra = {}) {
    const busy = [$('connect-btn'), $('oauth-save-connect'), $('pat-connect')];
    for (const b of busy) b.disabled = true;
    showAlert(null);
    setTabLine(null, PROGRESS[method] || (clientId || customClientId() ? PROGRESS.oauth : PROGRESS.builtin));
    const msg = Object.assign({ type: 'connect:oneClick', url: tab.url }, extra);
    if (clientId) msg.clientId = clientId;
    if (method) msg.method = method;
    const r = await send(msg);
    for (const b of busy) b.disabled = false;
    if (!r.ok) {
      setTabLine(null, '');
      showAlert(r.error);
      const code = r.error && r.error.code;
      if (/^OAUTH_CLIENT_/.test(code || '')) showSetup(undefined, { focus: 'oauth-client-id' });
      else if (OFFER_TOKEN.includes(code) || (method === 'pat' && code !== 'PERMISSION_NOT_GRANTED')) showSetup();
      return;
    }
    if (method === 'pat') $('pat-input').value = '';
    if (r.data && (r.data.needsChoice || r.data.needsClientId)) {
      setTabLine(null, '');
      showSetup(r.data.redirectUrl);
      return;
    }
    if (!r.data || r.data.connected !== true) {
      setTabLine(null, '');
      showAlert({ code: 'UNKNOWN', title: 'Not connected', steps: ['The extension did not confirm the connection. Reload the extension and the Databricks tab, then try again.'], details: { action: 'connect:oneClick', message: 'The reply did not confirm a connection' } });
      return;
    }
    $('oauth-setup').hidden = true;
    const fresh = await send({ type: 'page:state' });
    if (fresh.ok && fresh.data) state = fresh.data;
    renderSettings();
    renderTab();
    const how = r.data.method === 'pat' ? ' · access token' : '';
    setTabLine('ok', 'Connected · workspace ' + r.data.workspaceId + (r.data.warehouseName ? ' · ' + r.data.warehouseName : '') + how + '. Costs now show on the page.');
  }

  function onConnect() {
    showAlert(null);
    const conn = tab && tab.supported ? connections()[tab.origin] : null;
    const mismatch = conn && tab.workspaceId && tab.workspaceId !== conn.workspaceId;
    // One click on real workspaces; the local fixture and edits use Connection preferences.
    if (tab && tab.supported && tab.kind === 'workspace' && !mismatch && (!conn || conn.authMode === 'oauth') && !customClientId() && policy().disableBuiltInSignIn) {
      // The administrator turned off the CLI client's sign-in: offer the token box instead.
      showAlert({ code: 'BUILTIN_SIGNIN_POLICY', title: 'Your organization turned off this sign-in', steps: ['Use a personal access token below, or the app connection your organization registered.'] });
      showSetup();
      return;
    }
    if (tab && tab.supported && tab.kind === 'workspace' && !mismatch && (!conn || conn.authMode === 'oauth')) {
      // Without a registered app, sign-in goes through Databricks' built-in client, whose redirect
      // the extension reads on localhost:8020; both accesses are asked for in this one click.
      requestAccessThen(() => oneClick(), customClientId() ? [] : [SIGNIN_REDIRECT_PATTERN]);
      return;
    }
    openOptionsForConnect();
  }

  function onSaveAndConnect() {
    const value = $('oauth-client-id').value.trim();
    if (!CLIENT_ID_RE.test(value)) {
      showAlert({ code: 'OAUTH_CLIENT_MISSING', title: 'Enter the client ID from App connections', steps: ['It is shown after you add the connection in the account console.'] });
      return;
    }
    if (!tab || !tab.supported || tab.kind !== 'workspace') return;
    requestAccessThen(() => oneClick(value));
  }

  function onPatConnect() {
    const token = $('pat-input').value.trim();
    if (token.length < 20 || /\s/.test(token)) {
      showAlert({ code: 'PAT_FORMAT', title: 'Paste the whole access token', steps: ['Copy it from Databricks: Settings, Developer, Access tokens, Generate new token. It usually starts with dapi.'] });
      $('pat-input').focus();
      return;
    }
    if (!tab || !tab.supported || tab.kind !== 'workspace') return;
    const remember = $('pat-remember').checked;
    requestAccessThen(() => oneClick(undefined, 'pat', { token, remember }));
  }

  function onCreateToken() {
    if (!tab || !tab.supported || tab.kind !== 'workspace') return;
    chromeApi.tabs.create({ url: tab.origin + TOKEN_PAGE_PATH });
  }

  async function onCopyRedirect() {
    const text = $('oauth-redirect').textContent;
    try {
      await root.navigator.clipboard.writeText(text);
      $('oauth-copy').textContent = 'Copied';
    } catch (_) {
      $('oauth-copy').textContent = 'Select and copy';
    }
  }

  async function openOptionsForConnect() {
    const btn = $('connect-btn');
    btn.disabled = true;
    if (tab && tab.supported) {
      const r = await send({ type: 'page:setPendingConnect', url: tab.url });
      if (!r.ok) {
        showAlert(r.error);
        btn.disabled = false;
        return;
      }
    }
    const o = await send({ type: 'page:open', page: 'options', anchor: 'connect' });
    if (!o.ok) {
      showAlert(o.error);
      btn.disabled = false;
      return;
    }
    closePopup();
  }

  /** How long a one-click connect that ended while the popup was closed is still reported. */
  const OUTCOME_MAX_AGE_MS = 3 * 60 * 1000;

  /**
   * The last one-click connect (connect:status, mirrored in chrome.storage.session) when it still
   * describes this tab: the same workspace origin, recent, and not superseded by a connection
   * saved after it. A failure is not shown once this tab's workspace is connected (for example a
   * Reconnect that was cancelled, or an older attempt): the saved connection is what applies, and
   * the failure stays listed under Diagnostics. Entries without an origin come from an older
   * version and are never shown.
   */
  function recentConnectOutcome(st, nowMs) {
    if (!st || typeof st !== 'object' || !tab || !tab.supported) return null;
    if (!Number.isFinite(st.at) || nowMs - st.at > OUTCOME_MAX_AGE_MS || st.at - nowMs > 60 * 1000) return null;
    if (typeof st.origin !== 'string' || st.origin !== tab.origin) return null;
    const conn = connections()[tab.origin] || null;
    if (conn && Number.isFinite(conn.savedAt) && conn.savedAt >= st.at) return null;
    const connectedHere = Boolean(conn && !(tab.workspaceId && tab.workspaceId !== conn.workspaceId));
    if (st.state === 'error') return connectedHere || !st.error ? null : st;
    return st.state === 'signing-in' || st.state === 'configuring' ? st : null;
  }

  /** The popup may have closed while the sign-in window was open; show how it ended. */
  async function showRecentConnectOutcome() {
    const r = await send({ type: 'connect:status' });
    const st = r.ok ? recentConnectOutcome(r.data, Date.now()) : null;
    if (!st) return;
    if (st.state === 'error') showAlert(failed(st.error, 'connect:oneClick'));
    else setTabLine(null, 'Finishing sign-in…');
  }

  /* ---------------------------------------------------------------- settings */

  function renderSettings() {
    const s = (state && state.settings) || {};
    for (const input of doc.querySelectorAll('input[name="mode"]')) input.checked = input.value === s.mode;
    for (const input of doc.querySelectorAll('input[name="period"]')) input.checked = Number(input.value) === s.periodDays;
    $('show-costs').checked = s.showCosts !== false;
    const m = s.monitor || {};
    $('monitor-enabled').checked = m.enabled === true;
    $('monitor-autoopen').checked = m.autoOpen === true;
    $('monitor-notify').checked = m.notifyFailures === true;
    $('monitor-autoopen').disabled = m.enabled !== true;
    $('monitor-notify').disabled = m.enabled !== true;
    $('genie-notify').checked = Boolean(s.genie && s.genie.notify === true);
    renderModeHint();
    renderSummary();
  }

  function renderModeHint() {
    const s = (state && state.settings) || {};
    const hint = $('mode-hint');
    let text = MODE_HINTS[s.mode] || '';
    if (s.mode === 'connected' && !Object.keys(connections()).length) text += ' No workspace is connected yet. Select Connect.';
    if (s.mode === 'import') {
      const imp = state && state.importSummary;
      text += imp ? ' ' + imp.entries + (imp.entries === 1 ? ' summary' : ' summaries') + ' imported.' : ' Nothing imported yet. Import costs.json in Connection preferences.';
    }
    hint.textContent = text;
  }

  function renderSummary() {
    const s = (state && state.settings) || {};
    const parts = [MODE_NAMES[s.mode] || 'Mode unknown'];
    if (s.mode === 'connected') {
      const n = Object.keys(connections()).length;
      // A fresh install starts in connected mode with nothing connected yet; say so plainly.
      if (n === 0) parts[0] = 'Not connected';
      else parts.push(n === 1 ? '1 workspace' : n + ' workspaces');
    }
    if (V.isPeriodDays(s.periodDays)) parts.push(s.periodDays + ' days');
    if (s.showCosts === false) parts.push('Paused');
    $('mode-summary').textContent = parts.join(' · ');
    // The header dot repeats what the text says: connected (ok), needs attention (warn), or idle.
    const n = Object.keys(connections()).length;
    const dot = s.showCosts === false ? 'warn' : s.mode === 'connected' ? (n ? 'ok' : 'warn') : s.mode === 'demo' || s.mode === 'import' ? 'info' : 'idle';
    $('mode-summary').setAttribute('data-state', dot);
  }

  /** Patch settings; the response is the full saved settings. Out-of-order replies are ignored. */
  async function updateSettings(patch) {
    const r = await send({ type: 'page:updateSettings', patch });
    if (!r.ok) {
      showAlert(r.error);
      renderSettings(); // revert controls to the last saved state
      return false;
    }
    showAlert(null);
    const next = r.data;
    if (next && (!state.settings || !Number.isInteger(state.settings.revision) || next.revision >= state.settings.revision)) state.settings = next;
    renderSettings();
    return true;
  }

  function onNotifyChange(ev) {
    const el = ev.currentTarget;
    if (!el.checked) {
      updateSettings({ monitor: { notifyFailures: false } });
      return;
    }
    // Request the optional permission first, synchronously inside the user gesture.
    let req;
    try {
      req = chromeApi.permissions.request({ permissions: ['notifications'] });
    } catch (e) {
      req = Promise.reject(e);
    }
    Promise.resolve(req).then(
      (granted) => {
        if (!granted) {
          el.checked = false;
          setMonitorStatus('warn', 'Notifications were not allowed', ['Failure alerts stay off. You can try again at any time.']);
          return null;
        }
        setMonitorStatus(null);
        return updateSettings({ monitor: { notifyFailures: true } });
      },
      () => {
        el.checked = false;
        setMonitorStatus('warn', 'Could not ask for notification permission', ['Failure alerts stay off.']);
      }
    );
  }

  /* ---------------------------------------------------------------- Genie */

  /**
   * Open the Genie side panel. sidePanel.open must run inside the click (user gesture), so the
   * window ID is read when the popup loads and nothing is awaited before the call.
   */
  function onAskGenie() {
    setGenieStatus(null);
    const sp = chromeApi.sidePanel;
    if (!sp || typeof sp.open !== 'function') {
      setGenieStatus('warn', 'The side panel isn\'t available here', ['It needs Chrome or Edge 116 or newer.']);
      return;
    }
    const target = Number.isInteger(windowId) ? windowId : chromeApi.windows && chromeApi.windows.WINDOW_ID_CURRENT;
    let opening;
    try {
      opening = sp.open({ windowId: target });
    } catch (e) {
      opening = Promise.reject(e);
    }
    Promise.resolve(opening).then(
      () => closePopup(),
      (e) => setGenieStatus('warn', 'The side panel could not be opened', [clean(e && e.message) || 'Try again.'])
    );
  }

  function onGenieNotifyChange(ev) {
    const el = ev.currentTarget;
    const save = async (notify) => {
      const r = await send({ type: 'genie:settings', notify });
      if (!r.ok) {
        el.checked = !notify;
        setGenieStatus('warn', errorParts(r.error).title, errorParts(r.error).steps.slice(0, 1));
        return;
      }
      if (state && state.settings) state.settings.genie = Object.assign({}, state.settings.genie, { notify: r.data.notify });
      el.checked = r.data.notify === true;
    };
    if (!el.checked) {
      save(false);
      return;
    }
    // Ask for the optional permission first, synchronously inside the user gesture.
    let req;
    try {
      req = chromeApi.permissions.request({ permissions: ['notifications'] });
    } catch (e) {
      req = Promise.reject(e);
    }
    Promise.resolve(req).then(
      (granted) => {
        if (!granted) {
          el.checked = false;
          setGenieStatus('warn', 'Notifications were not allowed', ['Genie answers still wait in the side panel. You can try again at any time.']);
          return null;
        }
        setGenieStatus(null);
        return save(true);
      },
      () => {
        el.checked = false;
        setGenieStatus('warn', 'Could not ask for notification permission', ['Genie answers still wait in the side panel.']);
      }
    );
  }

  async function onOpenMonitor() {
    const btn = $('monitor-open');
    btn.disabled = true;
    setMonitorStatus(null);
    const r = await send({ type: 'monitor:open' });
    btn.disabled = false;
    if (!r.ok) {
      const p = errorParts(r.error);
      const unknown = p.code === 'UNKNOWN';
      setMonitorStatus('warn', 'The monitor could not be opened', unknown ? ['The monitor may not be available in this version yet, or it needs a moment to start. Try again shortly.'] : [p.title].concat(p.steps.slice(0, 1)));
      return;
    }
    closePopup();
  }

  /* ---------------------------------------------------------------- diagnostics */

  function timeLabel(ms) {
    if (!Number.isFinite(ms)) return '';
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }

  function renderDiagnostics() {
    const list = $('diag-list');
    const items = Array.isArray(state && state.diagnostics) ? state.diagnostics : [];
    list.textContent = '';
    $('diag-count').textContent = items.length ? '(' + items.length + ')' : '';
    $('diag-clear').disabled = !items.length;
    if (!items.length) {
      list.appendChild(h('li', { class: 'pp-diag-empty' }, 'No recent errors.'));
      return;
    }
    for (const d of items.slice(0, 5)) {
      const p = errorParts({ code: d && d.code });
      const det = (d && d.details) || {};
      const statementId = V.isStatementId(String(det.statementId || '').toLowerCase()) ? String(det.statementId).toLowerCase() : null;
      const meta = [timeLabel(d && d.at), p.code, d && typeof d.type === 'string' ? clean(d.type, 40) : null, Number.isInteger(det.httpStatus) ? 'HTTP ' + det.httpStatus : null].filter(Boolean).join(' · ');
      // The background's own words (redacted when recorded, again here): what a generic
      // "Something went wrong" was about.
      const message = det.message ? clean(det.message, 300) : '';
      list.appendChild(
        h('li', {}, [
          h('div', { class: 'pp-diag-title' }, p.title),
          h('div', { class: 'pp-diag-meta' }, meta),
          statementId ? h('div', { class: 'pp-diag-meta' }, ['Statement ID ', h('code', {}, statementId)]) : null,
          message ? h('div', { class: 'pp-diag-meta' }, message) : null,
        ])
      );
    }
    if (items.length > 5) list.appendChild(h('li', { class: 'pp-diag-empty' }, 'Older entries are in Connection preferences → Diagnostics.'));
  }

  async function onClearDiagnostics() {
    const r = await send({ type: 'page:clearDiagnostics' });
    if (!r.ok) return showAlert(r.error);
    state.diagnostics = [];
    renderDiagnostics();
  }

  /* ---------------------------------------------------------------- wiring */

  async function openPage(page, anchor) {
    const r = await send(anchor ? { type: 'page:open', page, anchor } : { type: 'page:open', page });
    if (!r.ok) return showAlert(r.error);
    closePopup();
  }

  /** The store build removes developer-only links (the local test workspace), not just hides them. */
  function applyFlags() {
    const flags = (root.DCC && root.DCC.flags) || DCC.flags;
    if (!flags) return;
    if (flags.devTools === false) for (const el of doc.querySelectorAll('[data-feature="dev-tools"]')) el.remove();
  }

  function wire() {
    $('connect-btn').addEventListener('click', onConnect);
    $('oauth-save-connect').addEventListener('click', onSaveAndConnect);
    $('signin-alt').addEventListener('click', onToggleSetup);
    $('pat-connect').addEventListener('click', onPatConnect);
    $('pat-input').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') onPatConnect();
    });
    $('token-create').addEventListener('click', onCreateToken);
    $('oauth-copy').addEventListener('click', onCopyRedirect);
    $('oauth-guide').addEventListener('click', () => openPage('guide', 'sign-in'));
    $('open-options').addEventListener('click', () => openPage('options'));
    $('guide-link').addEventListener('click', () => openPage('guide'));
    $('privacy-link').addEventListener('click', () => chromeApi.tabs.create({ url: PRIVACY_URL }));
    for (const input of doc.querySelectorAll('input[name="mode"]')) {
      input.addEventListener('change', () => {
        if (input.checked) updateSettings({ mode: input.value });
      });
    }
    for (const input of doc.querySelectorAll('input[name="period"]')) {
      input.addEventListener('change', () => {
        if (input.checked) updateSettings({ periodDays: Number(input.value) });
      });
    }
    $('show-costs').addEventListener('change', (ev) => updateSettings({ showCosts: ev.currentTarget.checked }));
    $('monitor-enabled').addEventListener('change', (ev) => updateSettings({ monitor: { enabled: ev.currentTarget.checked } }));
    $('monitor-autoopen').addEventListener('change', (ev) => updateSettings({ monitor: { autoOpen: ev.currentTarget.checked } }));
    $('monitor-notify').addEventListener('change', onNotifyChange);
    $('monitor-open').addEventListener('click', onOpenMonitor);
    $('genie-open').addEventListener('click', onAskGenie);
    $('genie-notify').addEventListener('change', onGenieNotifyChange);
    $('diag-clear').addEventListener('click', onClearDiagnostics);
  }

  function setControlsDisabled(disabled) {
    for (const el of doc.querySelectorAll('input[name="mode"], input[name="period"], #show-costs, #monitor-enabled, #monitor-autoopen, #monitor-notify, #genie-notify')) el.disabled = disabled;
  }

  async function init() {
    applyFlags();
    wire();
    const [res, t] = await Promise.all([send({ type: 'page:state' }), readActiveTab()]);
    tab = t;
    if (!res.ok || !res.data) {
      state = { settings: {}, connections: {}, diagnostics: [] };
      showAlert(res.error);
      setControlsDisabled(true);
      $('mode-summary').textContent = 'Unavailable';
      renderTab();
      renderDiagnostics();
      return;
    }
    state = res.data;
    renderSettings();
    renderTab();
    renderDiagnostics();
    await showRecentConnectOutcome();
  }

  const ready = init().catch((e) => showAlert(backgroundError(e && e.message)));
  (root.DCC || (root.DCC = {})).popupPage = Object.freeze({ ready });
})(typeof globalThis !== 'undefined' ? globalThis : this);
