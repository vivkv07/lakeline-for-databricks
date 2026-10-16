/*
 * Options page ("Connection preferences"): workspace discovery and explicit choice, site access,
 * helper or PAT sign-in, warehouse listing (Automatic or explicit), billing source, save and
 * disconnect, local import, diagnostics.
 *
 * Rules kept here:
 * - Never switch workspace silently: with several candidate workspaces or workspace IDs, the
 *   user picks one.
 * - Late responses are dropped: workspace preparation is tied to a selection generation, and
 *   warehouse listings to a per-request ID for the selected origin and sign-in type.
 * - Secrets are never echoed: token and pairing-key fields are cleared as soon as they are
 *   read, and no response is expected to carry them back.
 * - DOM is built with textContent only (no innerHTML with variable data). Error text is
 *   redacted again before display.
 */
(function (root) {
  'use strict';
  const DCC = root.DCC;
  const doc = root.document;
  const chromeApi = root.chrome;
  const V = DCC.validate;
  const ids = DCC.ids;
  const errors = DCC.errors;
  const pricing = DCC.pricing;
  const config = DCC.config;
  const warehouses = DCC.warehouses;
  const $ = (id) => doc.getElementById(id);
  const hasOwn = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);

  const PRICE_TABLE_LABELS = Object.freeze({
    'system.billing.list_prices': 'List prices (system.billing.list_prices): excludes private discounts',
    'system.billing.account_prices': 'Account prices (system.billing.account_prices): may be unavailable on some clouds/accounts; invoice adjustments not modeled',
  });
  const SOURCE_LABELS = Object.freeze({
    pending: 'From the popup',
    saved: 'Saved connection',
    observed: 'Seen in a tab',
    granted: 'Site access allowed',
    manual: 'Entered here',
  });
  const CLOUD_LABELS = Object.freeze({ aws: 'AWS', azure: 'Azure', gcp: 'GCP', fixture: 'Local test' });
  const URL_REASONS = Object.freeze({
    'invalid-url': 'Enter the full workspace URL, for example https://your-workspace.cloud.databricks.com.',
    'credentials-in-url': 'Remove the user name or password from the URL.',
    'not-https': 'Databricks workspaces use https:// URLs.',
    'non-default-port': 'Use the workspace URL without a port number.',
    'unsupported-host': 'That isn\'t a supported Databricks workspace host.',
    'account-console': 'That is an account-console URL. Use the URL of a workspace instead.',
  });
  const UNUSABLE_STATES = new Set(['DELETING', 'DELETED']);

  const S = {
    page: null, // page:state data
    pending: null, // popup hand-off {origin, workspaceId, conflict}
    granted: [], // origins with site access
    manual: [], // origins entered on this page
    sel: null, // {origin, host, cloud, kind, conn, idCandidates, conflict, prepError, ready}
    selGen: 0,
    hasPat: false,
    access: null, // site access for the selected origin: true | false | null (unknown)
    whChoice: null, // {mode:'auto'} | {mode:'manual', id, name}
    wh: null, // last accepted listing {origin, authMode, list, automatic}
    whRequest: null, // in-flight listing {id, origin, authMode}
    whSeq: 0,
  };

  /* ---------------------------------------------------------------- DOM helpers */

  /** h('div', {class, onclick, ...}, children): children may nest; text nodes only. */
  function h(tag, attrs, children) {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of [].concat(children === undefined ? [] : children).flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? doc.createTextNode(String(c)) : c);
    }
    return el;
  }

  function show(container, node) {
    container.textContent = '';
    if (node) container.appendChild(node);
  }

  const clean = (t, max = 600) => errors.redact(V.safeText(t, max));

  function messageBox(kind, title, lines) {
    const items = (lines || []).filter(Boolean);
    return h('div', { class: 'dcc-alert dcc-alert--' + kind, role: kind === 'error' ? 'alert' : null }, [
      h('p', { class: 'dcc-alert__title' }, title),
      items.length === 1 ? h('p', { class: 'dcc-alert__body' }, items[0]) : null,
      items.length > 1 ? h('ul', { class: 'dcc-alert__steps' }, items.map((l) => h('li', {}, l))) : null,
    ]);
  }

  /** Sanitize an error payload {code, title, steps, details} before rendering. */
  function normalizeError(error) {
    const src = error && typeof error === 'object' ? error : {};
    const code = typeof src.code === 'string' && /^[A-Z_]{1,40}$/.test(src.code) ? src.code : 'UNKNOWN';
    const cat = errors.CATALOG[code] || errors.CATALOG.UNKNOWN;
    const title = clean(src.title, 200) || cat.title;
    const steps = (Array.isArray(src.steps) ? src.steps : cat.steps).map((s) => clean(s, 400)).filter(Boolean).slice(0, 6);
    const d = src.details && typeof src.details === 'object' ? src.details : {};
    const statementId = String(d.statementId || '').toLowerCase();
    return {
      code,
      title,
      steps,
      details: {
        errorCode: d.errorCode ? clean(d.errorCode, 80) : null,
        sqlState: typeof d.sqlState === 'string' && /^[0-9A-Z]{5}$/.test(d.sqlState) ? d.sqlState : null,
        statementId: V.isStatementId(statementId) ? statementId : null,
        httpStatus: Number.isInteger(d.httpStatus) ? d.httpStatus : null,
        message: d.message ? clean(d.message, 600) : null,
      },
    };
  }

  /** Error: title, next steps, and collapsible technical details (code, SQL error, statement ID). */
  function errorBox(error) {
    const e = normalizeError(error);
    const d = e.details;
    const rows = [['Code', e.code, true]];
    if (d.errorCode) rows.push(['SQL error code', d.errorCode, true]);
    if (d.sqlState) rows.push(['SQL state', d.sqlState, true]);
    if (d.statementId) rows.push(['Statement ID', d.statementId, true]);
    if (d.httpStatus) rows.push(['HTTP status', String(d.httpStatus), false]);
    if (d.message) rows.push(['Message', d.message, false]);
    return h('div', { class: 'dcc-alert dcc-alert--error', role: 'alert' }, [
      h('p', { class: 'dcc-alert__title' }, e.title),
      e.steps.length === 1 ? h('p', { class: 'dcc-alert__body' }, e.steps[0]) : null,
      e.steps.length > 1 ? h('ul', { class: 'dcc-alert__steps' }, e.steps.map((s) => h('li', {}, s))) : null,
      h('details', { class: 'dcc-tech-details' }, [
        h('summary', {}, 'Technical details'),
        h('dl', { class: 'dcc-tech' }, rows.map(([label, value, mono]) => [h('dt', {}, label), h('dd', {}, mono ? h('code', {}, value) : value)])),
      ]),
    ]);
  }

  function busyLine(text) {
    return h('p', { class: 'op-busy', role: 'status' }, text);
  }

  function setBusy(btn, busy) {
    btn.disabled = busy;
    if (busy) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
  }

  function setFieldError(id, message) {
    const input = $(id);
    const out = $(id + '-error');
    if (input) {
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    if (out) {
      out.textContent = message || '';
      out.hidden = !message;
    }
  }

  function onEnter(id, fn) {
    $(id).addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        fn();
      }
    });
  }

  /* ---------------------------------------------------------------- messaging */

  function backgroundError(message) {
    return {
      code: 'UNKNOWN',
      title: 'Could not reach the extension background',
      steps: ['Reload this page. If it keeps happening, reload the extension from the browser\'s extensions page.'],
      details: { message: message || null },
    };
  }

  async function send(msg) {
    try {
      const res = await chromeApi.runtime.sendMessage(msg);
      if (res && typeof res === 'object' && typeof res.ok === 'boolean') return res;
      return { ok: false, error: backgroundError('No response') };
    } catch (e) {
      return { ok: false, error: backgroundError(e && e.message) };
    }
  }

  async function grantedOrigins() {
    try {
      const all = await chromeApi.permissions.getAll();
      const out = [];
      for (const pattern of (all && all.origins) || []) {
        // Exact-origin grants only; wildcard host patterns are not a workspace choice.
        const cls = ids.classifyOrigin(String(pattern).replace(/\/\*$/, '/'));
        if (cls.ok && !out.includes(cls.origin)) out.push(cls.origin);
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  async function hasAccess(origin) {
    try {
      return Boolean(await chromeApi.permissions.contains({ origins: [origin + '/*'] }));
    } catch (_) {
      return null;
    }
  }

  async function takePending() {
    const r = await send({ type: 'admin:takePendingConnect' });
    if (!r.ok || !r.data || !ids.classifyOrigin(r.data.origin).ok) return null;
    return { origin: r.data.origin, workspaceId: V.isWorkspaceId(r.data.workspaceId) ? r.data.workspaceId : null, conflict: r.data.conflict === true };
  }

  async function refreshState() {
    const [res, granted] = await Promise.all([send({ type: 'page:state' }), grantedOrigins()]);
    if (res.ok && res.data) S.page = res.data;
    S.granted = granted;
    if (S.sel) S.sel.conn = savedConnection(S.sel.origin) || null;
    renderCandidates();
    renderHelperStatus();
    renderPriceWarn();
    renderSave();
    renderImportStatus();
    renderDiagnostics();
    return res;
  }

  function savedConnection(origin) {
    const all = (S.page && S.page.connections) || {};
    return hasOwn(all, origin) ? all[origin] : null;
  }

  function currentAuthMode() {
    const checked = doc.querySelector('input[name="auth"]:checked');
    return checked ? checked.value : null;
  }

  /* ---------------------------------------------------------------- 1. workspace */

  function candidateList() {
    const map = new Map();
    const add = (origin, source, id) => {
      const cls = ids.classifyOrigin(origin);
      if (!cls.ok) return;
      const c = map.get(cls.origin) || { origin: cls.origin, host: cls.host, cloud: cls.cloud, kind: cls.kind, sources: [], ids: [] };
      if (!c.sources.includes(source)) c.sources.push(source);
      if (V.isWorkspaceId(id) && !c.ids.includes(id)) c.ids.push(id);
      map.set(cls.origin, c);
    };
    if (S.pending) add(S.pending.origin, 'pending', S.pending.workspaceId);
    for (const [o, c] of Object.entries((S.page && S.page.connections) || {})) add(o, 'saved', c && c.workspaceId);
    for (const [o, ob] of Object.entries((S.page && S.page.observed) || {})) add(o, 'observed', ob && ob.workspaceId);
    for (const o of S.granted) add(o, 'granted');
    for (const o of S.manual) add(o, 'manual');
    return [...map.values()];
  }

  function renderPendingNote() {
    const box = $('pending-note');
    if (!S.pending) return show(box, null);
    const host = ids.classifyOrigin(S.pending.origin).host;
    const lines = [];
    if (S.pending.workspaceId) lines.push('The tab\'s URL shows workspace ID ' + S.pending.workspaceId + '.');
    if (S.pending.conflict) lines.push('The tab\'s URL contains conflicting workspace IDs, so you\'ll choose the ID below.');
    show(box, messageBox('ok', 'Connecting ' + host + ' from the popup', lines));
  }

  let candidateSig = null;

  function renderCandidates() {
    const box = $('ws-candidates');
    const list = candidateList();
    // Same candidates: only sync the checked state, so keyboard focus inside the group survives.
    const sig = JSON.stringify(list.map((c) => [c.origin, c.sources, c.ids]));
    if (sig === candidateSig && box.childElementCount) {
      for (const input of box.querySelectorAll('input[name="ws"]')) input.checked = Boolean(S.sel && S.sel.origin === input.value);
      return;
    }
    candidateSig = sig;
    box.textContent = '';
    if (!list.length) {
      box.appendChild(h('p', { class: 'op-empty' }, 'No workspaces found yet. Open your workspace in a tab and select Connect in the extension popup, or enter its URL below.'));
      return;
    }
    list.forEach((c, i) => {
      const id = 'ws-opt-' + i;
      const input = h('input', { type: 'radio', name: 'ws', id, value: c.origin });
      input.checked = Boolean(S.sel && S.sel.origin === c.origin);
      input.addEventListener('change', () => {
        if (input.checked) selectWorkspace(c.origin);
      });
      const meta = [h('span', {}, CLOUD_LABELS[c.cloud] || c.cloud)];
      if (c.ids.length) meta.push(h('span', {}, (c.ids.length === 1 ? 'Workspace ID ' : 'Workspace IDs ') + c.ids.join(', ')));
      for (const s of c.sources) meta.push(h('span', { class: 'dcc-pill' + (s === 'pending' ? ' dcc-pill--accent' : s === 'saved' ? ' dcc-pill--ok' : '') }, SOURCE_LABELS[s]));
      box.appendChild(
        h('label', { class: 'op-option', for: id }, [
          input,
          h('span', { class: 'op-option__main' }, [h('span', { class: 'op-option__title' }, c.host), h('span', { class: 'op-option__meta' }, meta)]),
        ])
      );
    });
  }

  function onUseUrl() {
    const raw = $('ws-url').value.trim();
    if (!raw) return setFieldError('ws-url', 'Enter a workspace URL.');
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
    const cls = ids.classifyOrigin(candidate);
    if (!cls.ok) return setFieldError('ws-url', URL_REASONS[cls.reason] || 'That isn\'t a supported Databricks workspace URL.');
    setFieldError('ws-url', null);
    if (!S.manual.includes(cls.origin)) S.manual.push(cls.origin);
    return selectWorkspace(candidate);
  }

  function choiceFromSaved(w) {
    if (w && w.mode === 'manual' && V.isWarehouseId(w.id)) return { mode: 'manual', id: w.id, name: w.name || null };
    return { mode: 'auto' };
  }

  function invalidateWarehouses() {
    // Any in-flight listing is now stale; its response will be dropped.
    S.whRequest = null;
    S.wh = null;
  }

  function fillForm(conn) {
    const auth = conn && config.AUTH_MODES.includes(conn.authMode) ? conn.authMode : 'oauth';
    for (const r of doc.querySelectorAll('input[name="auth"]')) r.checked = r.value === auth;
    $('price-table').value = conn && hasOwn(pricing.PRICE_TABLES, conn.priceTable) ? conn.priceTable : pricing.DEFAULT_PRICE_TABLE;
    $('currency').value = conn && V.isCurrency(conn.currency) ? conn.currency : 'USD';
    $('usage-source').value = (conn && conn.usageSource) || config.DEFAULT_USAGE_SOURCE;
    $('history-source').value = (conn && conn.historySource) || config.DEFAULT_HISTORY_SOURCE;
    $('advanced').open = Boolean(conn && (conn.usageSource !== config.DEFAULT_USAGE_SOURCE || conn.historySource !== config.DEFAULT_HISTORY_SOURCE));
    for (const id of ['ws-id', 'currency', 'usage-source', 'history-source']) setFieldError(id, null);
    for (const id of ['access-result', 'oauth-result', 'session-result', 'helper-result', 'helper-monitor-result', 'pat-result', 'save-result']) show($(id), null);
  }

  /**
   * Select a workspace explicitly (radio, manual URL, or the popup hand-off). Resets the form to
   * the saved connection for that origin (or defaults) and drops any in-flight work for the
   * previous selection.
   */
  async function selectWorkspace(input) {
    const cls = ids.classifyOrigin(input);
    if (!cls.ok) return false;
    const gen = ++S.selGen;
    const conn = savedConnection(cls.origin);
    S.sel = { origin: cls.origin, host: cls.host, cloud: cls.cloud, kind: cls.kind, conn, idCandidates: [], conflict: false, prepError: null, ready: false };
    S.hasPat = Boolean(conn && conn.secrets && conn.secrets.hasPat);
    S.access = null;
    S.whChoice = choiceFromSaved(conn && conn.warehouse);
    invalidateWarehouses();
    fillForm(conn);
    $('ws-id').value = '';
    $('ws-id-candidates').textContent = '';
    hideDisconnectConfirm();
    renderAll();

    const [prep, secret, access] = await Promise.all([
      send({ type: 'admin:prepare', url: typeof input === 'string' ? input : cls.origin }),
      send({ type: 'admin:secretStatus', origin: cls.origin }),
      hasAccess(cls.origin),
    ]);
    if (gen !== S.selGen) return false; // superseded by a newer selection

    const found = [];
    const addId = (v) => {
      if (V.isWorkspaceId(v) && !found.includes(v)) found.push(v);
    };
    if (prep.ok && prep.data) {
      (prep.data.candidates || []).forEach(addId);
      S.sel.conflict = prep.data.conflict === true;
    } else {
      S.sel.prepError = prep.error;
    }
    if (S.pending && S.pending.origin === cls.origin) {
      addId(S.pending.workspaceId);
      if (S.pending.conflict) S.sel.conflict = true;
    }
    if (conn) addId(conn.workspaceId);
    const observed = S.page && S.page.observed && S.page.observed[cls.origin];
    if (observed) addId(observed.workspaceId);
    S.sel.idCandidates = found;
    if (secret.ok && secret.data) S.hasPat = secret.data.hasPat === true;
    S.access = access;
    S.sel.ready = true;
    renderIdChoice();
    renderAll();
    return true;
  }

  function renderSelection() {
    const detail = $('ws-detail');
    if (!S.sel) {
      detail.hidden = true;
      return;
    }
    detail.hidden = false;
    show(
      $('ws-selected'),
      h('p', { class: 'op-selected' }, [
        h('span', {}, 'Selected:'),
        h('strong', {}, S.sel.host),
        h('span', { class: 'dcc-pill' }, CLOUD_LABELS[S.sel.cloud] || S.sel.cloud),
        S.sel.conn ? h('span', { class: 'dcc-pill dcc-pill--ok' }, 'Saved') : null,
        S.sel.ready ? null : h('span', { class: 'op-busy' }, 'Checking…'),
      ])
    );
  }

  /** Workspace ID: prefilled only when exactly one candidate exists; otherwise the user picks. */
  function renderIdChoice() {
    const box = $('ws-id-candidates');
    const input = $('ws-id');
    const help = $('ws-id-help');
    box.textContent = '';
    const found = S.sel.idCandidates;
    if (S.sel.prepError) box.appendChild(errorBox(S.sel.prepError));
    if (S.sel.conflict) box.appendChild(messageBox('warn', 'Conflicting workspace IDs in the URL', ['No ID was chosen automatically. Pick the right one below or type it.']));
    if (found.length === 1) {
      input.value = found[0];
      help.textContent = 'Detected from the workspace URL, a tab you opened, or the saved connection. Change it only if it is wrong.';
    } else if (found.length > 1) {
      input.value = '';
      help.textContent = 'Several workspace IDs were found for this URL. Choose the one to connect, or type it.';
      const group = h('fieldset', { class: 'dcc-fieldset' }, [h('legend', { class: 'op-label' }, 'Workspace IDs found')]);
      const wrap = h('div', { class: 'op-id-choices' });
      found.forEach((wsId, i) => {
        const rid = 'ws-id-opt-' + i;
        const radio = h('input', { type: 'radio', name: 'ws-id-choice', id: rid, value: wsId });
        radio.addEventListener('change', () => {
          if (!radio.checked) return;
          input.value = wsId;
          setFieldError('ws-id', null);
          renderSave();
        });
        const tags = [];
        if (S.sel.conn && S.sel.conn.workspaceId === wsId) tags.push(h('span', { class: 'dcc-pill dcc-pill--ok' }, 'Saved'));
        if (S.pending && S.pending.origin === S.sel.origin && S.pending.workspaceId === wsId) tags.push(h('span', { class: 'dcc-pill dcc-pill--accent' }, 'Tab URL'));
        wrap.appendChild(h('label', { class: 'op-option', for: rid }, [radio, h('span', { class: 'op-option__main' }, [h('span', { class: 'op-option__title' }, wsId), tags.length ? h('span', { class: 'op-option__meta' }, tags) : null])]));
      });
      group.appendChild(wrap);
      box.appendChild(group);
    } else {
      input.value = '';
      help.textContent = 'Enter the number after ?o= in the workspace URL (it is also shown in the workspace settings).';
    }
  }

  /* ---------------------------------------------------------------- 2. site access */

  function renderAccess() {
    const status = $('access-status');
    const grant = $('access-grant');
    const remove = $('access-remove');
    status.textContent = '';
    if (!S.sel) {
      status.appendChild(h('span', {}, 'Choose a workspace first.'));
      grant.hidden = false;
      grant.disabled = true;
      remove.hidden = true;
      return;
    }
    grant.textContent = 'Allow access to ' + S.sel.host;
    if (S.access === true) {
      status.append(h('span', { class: 'op-dot op-dot--ok', 'aria-hidden': 'true' }), 'Access allowed for ' + S.sel.host + '.');
      grant.hidden = true;
      remove.hidden = false;
    } else if (S.access === false) {
      status.append(h('span', { class: 'op-dot op-dot--warn', 'aria-hidden': 'true' }), 'Not allowed yet. Costs can\'t appear inside this workspace until you allow it.');
      grant.hidden = false;
      grant.disabled = false;
      remove.hidden = true;
    } else {
      status.appendChild(h('span', { class: 'op-busy' }, S.sel.ready ? 'Access status unknown.' : 'Checking…'));
      grant.hidden = false;
      grant.disabled = !S.sel.ready;
      remove.hidden = true;
    }
  }

  function onGrantAccess() {
    if (!S.sel) return;
    const origin = S.sel.origin;
    const out = $('access-result');
    // Request exactly this origin, synchronously inside the click (user gesture).
    let req;
    try {
      req = chromeApi.permissions.request({ origins: [origin + '/*'] });
    } catch (e) {
      req = Promise.reject(e);
    }
    Promise.resolve(req).then(
      async (granted) => {
        if (!granted) {
          show(out, messageBox('warn', 'Access was not granted', ['Select Allow when the browser asks. Without access, costs can\'t appear inside this workspace.']));
          return;
        }
        if (!S.granted.includes(origin)) S.granted.push(origin);
        if (S.sel && S.sel.origin === origin) S.access = true;
        const r = await send({ type: 'admin:syncScripts', origin });
        renderAccess();
        renderCandidates();
        if (!r.ok) return show(out, errorBox(r.error));
        const n = r.data && Number.isInteger(r.data.injected) ? r.data.injected : 0;
        show(out, messageBox('ok', 'Access allowed', [n ? 'Cost display started in ' + n + ' open tab' + (n === 1 ? '' : 's') + '.' : 'Open or reload a tab of this workspace to see costs there.']));
        return undefined;
      },
      () => show(out, messageBox('error', 'Could not ask for site access', ['Try again, or allow access from the browser\'s extension details page.']))
    );
  }

  async function onRemoveAccess() {
    if (!S.sel) return;
    const origin = S.sel.origin;
    const out = $('access-result');
    let removed = false;
    try {
      removed = await chromeApi.permissions.remove({ origins: [origin + '/*'] });
    } catch (_) {
      removed = false;
    }
    await send({ type: 'admin:syncScripts' });
    S.granted = await grantedOrigins();
    if (S.sel && S.sel.origin === origin) S.access = await hasAccess(origin);
    renderAccess();
    renderCandidates();
    show(out, removed ? messageBox('ok', 'Site access removed', ['Reload open tabs of this workspace to remove cost display from them. The saved connection is kept.']) : messageBox('warn', 'Site access was not removed', ['You can also remove it from the browser\'s extension details page.']));
  }

  /* ---------------------------------------------------------------- 3. sign-in */

  function renderAuth() {
    const mode = currentAuthMode();
    $('auth-oauth').hidden = mode !== 'oauth';
    $('auth-session').hidden = mode !== 'session';
    $('session-connect').disabled = !(S.sel && S.sel.kind === 'workspace');
    $('auth-helper').hidden = mode !== 'helper';
    $('auth-pat').hidden = mode !== 'pat';
    const workspaceOk = Boolean(S.sel && S.sel.kind === 'workspace');
    $('oauth-signin').disabled = !workspaceOk;
    renderOauthStatus();
    if (mode === 'oauth') fillRedirectUrl();
    $('helper-login').disabled = !workspaceOk;
    $('helper-login-monitor').disabled = !workspaceOk;
    $('pat-input').disabled = !S.sel;
    $('pat-save').disabled = !S.sel;
    $('pat-clear').hidden = !(S.sel && S.hasPat);
    renderHelperStatus();
    renderPatStatus();
  }

  function renderHelperStatus() {
    const b = (S.page && S.page.bridge) || {};
    const box = $('helper-status');
    box.textContent = '';
    $('helper-unpair').hidden = !b.bridgePaired;
    if (!b.bridgePaired) {
      box.appendChild(h('p', { class: 'op-status' }, [h('span', { class: 'op-dot', 'aria-hidden': 'true' }), 'Not paired with the local helper yet.']));
      return;
    }
    const version = b.helperVersion ? ' v' + clean(b.helperVersion, 40) : '';
    box.appendChild(h('p', { class: 'op-status' }, [h('span', { class: 'op-dot op-dot--ok', 'aria-hidden': 'true' }), 'Paired with the local helper' + version + '.']));
    const caps = b.capabilities || {};
    const adapter = Number.isInteger(caps.priceAdapterVersion) ? caps.priceAdapterVersion : 0;
    const items = [
      [adapter >= 2, adapter >= 2 ? 'Price adapter v' + adapter : 'Price adapter v' + adapter + ' (needs v2)'],
      [caps.accountPrices === true, caps.accountPrices === true ? 'Account prices' : 'No account prices'],
      [caps.jobPipelineAttribution === true, caps.jobPipelineAttribution === true ? 'Job + pipeline attribution' : 'No job + pipeline attribution'],
      [caps.monitor === true, caps.monitor === true ? 'Monitor' : 'No monitor support'],
    ];
    box.appendChild(h('ul', { class: 'op-caps', 'aria-label': 'Helper capabilities' }, items.map(([ok, label]) => h('li', { class: 'dcc-pill ' + (ok ? 'dcc-pill--ok' : 'dcc-pill--warn') }, label))));
    if (adapter < 2 || caps.accountPrices !== true || caps.jobPipelineAttribution !== true) {
      box.appendChild(messageBox('warn', 'The running helper is outdated for some features', ['Stop it (close its terminal window or press Ctrl+C), run start-helper.command again, then select Check helper. A version difference alone doesn\'t require a restart.']));
    }
  }

  function renderOauthStatus() {
    const p = $('oauth-status');
    p.textContent = '';
    if (!S.sel) return void p.appendChild(h('span', {}, 'Choose a workspace first.'));
    if (S.sel.kind !== 'workspace') return void p.appendChild(h('span', {}, 'The local test workspace uses a personal access token instead.'));
    const conn = S.sel.conn;
    const on = Boolean(conn && conn.authMode === 'oauth');
    p.append(h('span', { class: 'op-dot' + (on ? ' op-dot--ok' : ''), 'aria-hidden': 'true' }), on ? 'Connected with Databricks sign-in. Sign in again any time it asks.' : 'Not signed in yet.');
    const saved = S.page && S.page.settings && S.page.settings.oauth && S.page.settings.oauth.clientId;
    if (saved && !$('oauth-client-id-opt').value) $('oauth-client-id-opt').value = saved;
    if (!saved) $('oauth-setup-opt').open = true;
  }

  async function fillRedirectUrl() {
    if ($('oauth-redirect-opt').textContent) return;
    const r = await send({ type: 'connect:redirectUrl' });
    if (r.ok && r.data) $('oauth-redirect-opt').textContent = r.data.redirectUrl;
  }

  /** Site access first (inside the click), then sign in, detect the warehouse and save. */
  function onOauthSignIn() {
    if (!S.sel || S.sel.kind !== 'workspace') return;
    const sel = S.sel;
    const gen = S.selGen;
    const pending = S.access === true ? Promise.resolve(true) : chromeApi.permissions.request({ origins: [sel.origin + '/*'] });
    pending.then(async (granted) => {
      const out = $('oauth-result');
      if (!granted) return show(out, messageBox('error', 'Site access was not allowed', ['Allow access to ' + sel.host + ' so the extension can show costs there.']));
      const typedId = $('ws-id').value.trim();
      const clientId = $('oauth-client-id-opt').value.trim();
      const msg = { type: 'connect:oneClick', url: sel.origin + (V.isWorkspaceId(typedId) ? '/?o=' + typedId : '/') };
      if (clientId) msg.clientId = clientId;
      setBusy($('oauth-signin'), true);
      show(out, busyLine('Signing in with Databricks… finish in the window that opens.'));
      const res = await send(msg);
      setBusy($('oauth-signin'), false);
      await refreshState();
      if (gen !== S.selGen) return show(out, null);
      if (!res.ok) return show(out, errorBox(res.error));
      if (res.data && res.data.needsClientId) {
        $('oauth-setup-opt').open = true;
        await fillRedirectUrl();
        return show(out, messageBox('warn', 'One-time setup needed', ['Paste the OAuth client ID from your Databricks admin below, then select Sign in with Databricks again.']));
      }
      await selectWorkspace(sel.origin + '/?o=' + res.data.workspaceId);
      show($('oauth-result'), messageBox('ok', 'Connected ' + sel.host, ['Workspace ' + res.data.workspaceId + (res.data.warehouseName ? ' · Automatic → ' + res.data.warehouseName : '') + ' · list prices.', 'Costs now show inside the workspace. You can change the warehouse or price table below.']));
      return undefined;
    }).catch((e) => show($('oauth-result'), errorBox(backgroundError(e && e.message))));
  }

  function onSessionConnect() {
    if (!S.sel || S.sel.kind !== 'workspace') return;
    const sel = S.sel;
    const gen = S.selGen;
    const pending = S.access === true ? Promise.resolve(true) : chromeApi.permissions.request({ origins: [sel.origin + '/*'] });
    pending.then(async (granted) => {
      const out = $('session-result');
      if (!granted) return show(out, messageBox('error', 'Site access was not allowed', ['Allow access to ' + sel.host + ' so the extension can work in that tab.']));
      const typedId = $('ws-id').value.trim();
      setBusy($('session-connect'), true);
      show(out, busyLine('Checking your Databricks login through the open tab…'));
      const res = await send({ type: 'connect:oneClick', method: 'session', url: sel.origin + (V.isWorkspaceId(typedId) ? '/?o=' + typedId : '/') });
      setBusy($('session-connect'), false);
      await refreshState();
      if (gen !== S.selGen) return show(out, null);
      if (!res.ok) return show(out, errorBox(res.error));
      await selectWorkspace(sel.origin + '/?o=' + res.data.workspaceId);
      show($('session-result'), messageBox('ok', 'Connected ' + sel.host + ' with your Databricks login', ['Workspace ' + res.data.workspaceId + (res.data.warehouseName ? ' · Automatic → ' + res.data.warehouseName : '') + ' · list prices.', 'Keep a tab of this workspace open for costs, the monitor and Genie.']));
      return undefined;
    }).catch((e) => show($('session-result'), errorBox(backgroundError(e && e.message))));
  }

  function renderPatStatus() {
    const p = $('pat-status');
    p.textContent = '';
    if (!S.sel) {
      p.appendChild(h('span', {}, 'Choose a workspace first.'));
      return;
    }
    const remembered = Boolean(S.sel.conn && S.sel.conn.secrets && S.sel.conn.secrets.patRemembered);
    $('pat-remember').checked = remembered;
    p.append(h('span', { class: 'op-dot' + (S.hasPat ? ' op-dot--ok' : ''), 'aria-hidden': 'true' }), S.hasPat ? 'A token is saved for ' + S.sel.host + (remembered ? ' and remembered on this computer.' : ' for this browser session.') : 'No token saved for ' + S.sel.host + '.');
  }

  function onAuthChange() {
    invalidateWarehouses(); // a different identity may see different warehouses
    renderAuth();
    renderWarehouse();
    renderPriceWarn();
    renderSave();
  }

  async function onHelperCheck() {
    const btn = $('helper-check');
    const out = $('helper-result');
    setBusy(btn, true);
    show(out, busyLine('Checking the local helper…'));
    const r = await send({ type: 'admin:helperHello' });
    setBusy(btn, false);
    if (!r.ok) return show(out, errorBox(r.error));
    const d = r.data || {};
    const lines = [d.version ? 'Version ' + clean(d.version, 40) : null];
    if (typeof d.cli === 'string') lines.push('Databricks CLI ' + clean(d.cli, 60));
    else if (d.cli && typeof d.cli === 'object') {
      if (typeof d.cli.version === 'string') lines.push('Databricks CLI ' + clean(d.cli.version, 40));
      if (d.cli.ok === false) lines.push('The Databricks CLI is missing or older than v1.12. Update it, or use a personal access token.');
    }
    show(out, messageBox('ok', 'The local helper is running', lines));
    await refreshState();
    return undefined;
  }

  async function onHelperLogin(purpose) {
    const out = purpose === 'monitor' ? $('helper-monitor-result') : $('helper-result');
    const btn = purpose === 'monitor' ? $('helper-login-monitor') : $('helper-login');
    if (!S.sel || S.sel.kind !== 'workspace') {
      return show(out, messageBox('warn', 'Choose a Databricks workspace first', S.sel && S.sel.kind === 'fixture' ? ['The local test workspace doesn\'t need a sign-in.'] : []));
    }
    const origin = S.sel.origin;
    const gen = S.selGen;
    setBusy(btn, true);
    show(out, busyLine('Waiting for you to finish signing in to Databricks in your browser…'));
    const r = await send({ type: 'admin:helperLogin', origin, purpose });
    setBusy(btn, false);
    if (gen !== S.selGen) return show(out, null);
    renderAuth();
    if (!r.ok) return show(out, errorBox(r.error));
    const d = r.data || {};
    if (d.signedIn !== true) return show(out, messageBox('warn', 'Sign-in did not complete', ['Select the sign-in button to try again.']));
    const next = purpose === 'monitor' ? 'The monitor can now read run and compute status.' : 'Next: list warehouses in step 4.';
    show(out, messageBox('ok', d.reused ? 'Already signed in, reusing the existing session' : 'Signed in', [next, d.profile ? 'CLI profile: ' + clean(d.profile, 80) : null]));
    if (purpose === 'cost') {
      invalidateWarehouses();
      renderWarehouse();
    }
    return undefined;
  }

  async function onPairManual() {
    const input = $('pair-key');
    const key = input.value.trim().toLowerCase();
    input.value = ''; // never keep or echo the key
    const out = $('pair-result');
    if (!V.isPairingKey(key)) {
      return show(out, messageBox('error', 'That pairing key isn\'t valid', ['It is exactly 24 characters: digits 0–9 and letters a–f. Copy it again from the helper\'s terminal window.']));
    }
    const btn = $('pair-submit');
    setBusy(btn, true);
    const r = await send({ type: 'admin:pairManual', key });
    setBusy(btn, false);
    if (!r.ok) return show(out, errorBox(r.error));
    const v = r.data && r.data.helperVersion ? ' v' + clean(r.data.helperVersion, 40) : '';
    show(out, messageBox('ok', 'Paired with the local helper' + v, ['Next: choose your workspace and select Sign in.']));
    await refreshState();
    return undefined;
  }

  async function onUnpair() {
    const out = $('helper-result');
    const r = await send({ type: 'admin:unpair' });
    if (!r.ok) return show(out, errorBox(r.error));
    await refreshState();
    show(out, messageBox('ok', 'Helper pairing removed', ['Run start-helper.command again to pair.']));
    return undefined;
  }

  async function onSavePat() {
    const input = $('pat-input');
    const token = input.value.trim();
    input.value = ''; // never keep or echo the token
    const out = $('pat-result');
    if (!S.sel) return show(out, messageBox('warn', 'Choose a workspace first', []));
    if (!V.isPlausiblePat(token)) return show(out, messageBox('error', 'That doesn\'t look like a personal access token', ['Paste the whole token: 20–512 visible characters, no spaces.']));
    const origin = S.sel.origin;
    const gen = S.selGen;
    const btn = $('pat-save');
    setBusy(btn, true);
    const remember = $('pat-remember').checked;
    const r = await send({ type: 'admin:setPat', origin, token, remember });
    setBusy(btn, false);
    if (gen !== S.selGen) return show(out, null);
    if (!r.ok) return show(out, errorBox(r.error));
    S.hasPat = true;
    invalidateWarehouses();
    renderAuth();
    renderWarehouse();
    show(out, messageBox('ok', remember ? 'Token saved and remembered on this computer.' : 'Token saved for this browser session (cleared when the browser closes).', ['Next: list warehouses in step 4 to check that it works.']));
    return undefined;
  }

  async function onClearPat() {
    if (!S.sel) return;
    const out = $('pat-result');
    const r = await send({ type: 'admin:clearPat', origin: S.sel.origin });
    if (!r.ok) return show(out, errorBox(r.error));
    S.hasPat = false;
    invalidateWarehouses();
    renderAuth();
    renderWarehouse();
    show(out, messageBox('ok', 'Token removed', []));
  }

  /* ---------------------------------------------------------------- 4. warehouse */

  function titleCase(s) {
    const t = V.safeText(s || '', 20).toLowerCase();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Unknown';
  }

  function savedLine(saved) {
    if (saved.mode === 'manual') {
      return h('p', { class: 'op-line' }, ['Saved choice: ', h('strong', {}, saved.name || 'Warehouse'), ' ', h('code', {}, saved.id)]);
    }
    return h('p', { class: 'op-line' }, [
      'Saved choice: ',
      h('strong', {}, 'Automatic'),
      saved.resolvedId ? [' (currently ', h('strong', {}, saved.resolvedName || 'Warehouse'), ' ', h('code', {}, saved.resolvedId), ')'] : null,
    ]);
  }

  function setChoice(choice) {
    S.whChoice = choice;
    renderSave();
  }

  function warehouseRow(w, choice, flags) {
    const rid = 'wh-opt-' + w.id;
    const input = h('input', { type: 'radio', name: 'wh', id: rid, value: w.id });
    input.checked = choice.mode === 'manual' && choice.id === w.id;
    input.addEventListener('change', () => {
      if (input.checked) setChoice({ mode: 'manual', id: w.id, name: w.name || null });
    });
    const state = flags.unavailable
      ? h('span', { class: 'op-state op-state--unavailable' }, flags.missing ? 'Unavailable' : 'Unavailable (' + titleCase(w.state) + ')')
      : h('span', { class: 'op-state' + (w.state === 'RUNNING' ? ' op-state--running' : '') }, titleCase(w.state));
    return h('tr', { class: flags.unavailable ? 'is-unavailable' : null }, [
      h('td', { class: 'op-radio-cell' }, input),
      h('td', {}, [h('label', { for: rid }, w.name || 'Saved warehouse'), w.serverless ? [' ', h('span', { class: 'dcc-pill' }, 'Serverless')] : null, flags.missing ? [' ', h('span', { class: 'dcc-pill dcc-pill--danger' }, 'Saved · not listed')] : null]),
      h('td', {}, h('code', {}, w.id)),
      h('td', {}, state),
      h('td', {}, w.size || 'n/a'),
    ]);
  }

  function warehouseChooser() {
    const list = S.wh.list;
    const saved = (S.sel.conn && S.sel.conn.warehouse) || null;
    const desc = warehouses.describeSaved(saved, list);
    const choice = S.whChoice || { mode: 'auto' };
    const set = h('fieldset', { class: 'dcc-fieldset' }, [h('legend', { class: 'op-label' }, 'Warehouse for cost queries')]);

    const autoInput = h('input', { type: 'radio', name: 'wh', id: 'wh-opt-auto', value: 'auto' });
    autoInput.checked = choice.mode === 'auto';
    autoInput.addEventListener('change', () => {
      if (autoInput.checked) setChoice({ mode: 'auto' });
    });
    const auto = S.wh.automatic;
    set.appendChild(
      h('label', { class: 'op-option op-wh-auto', for: 'wh-opt-auto' }, [
        autoInput,
        h('span', { class: 'op-option__main' }, [
          h('span', { class: 'op-option__title' }, 'Automatic (prefer running, then smallest)'),
          h('span', { class: 'op-option__meta op-option__meta--text' }, auto ? ['Would use ', h('strong', {}, auto.name || 'Warehouse'), ' ', h('code', {}, auto.id), '. Resolved when you save, then kept until you save again.'] : 'No usable warehouse is visible to this sign-in.'),
        ]),
      ])
    );
    if (saved && saved.mode === 'auto' && desc.status === 'unavailable') {
      set.appendChild(messageBox('warn', 'Automatic previously resolved to a warehouse that is no longer usable', [(desc.name || 'Warehouse') + ' (' + desc.id + ') is not usable in this list. Saving re-resolves Automatic.']));
    }

    const rows = [];
    const savedMissing = Boolean(saved && saved.mode === 'manual' && desc.status === 'unavailable' && !list.some((w) => w.id === desc.id));
    if (savedMissing) rows.push(warehouseRow({ id: desc.id, name: desc.name || null, state: null, size: null }, choice, { unavailable: true, missing: true }));
    for (const w of list) rows.push(warehouseRow(w, choice, { unavailable: UNUSABLE_STATES.has(w.state) }));
    if (!list.length) set.appendChild(h('p', { class: 'op-empty' }, 'No SQL warehouses are visible to this sign-in. Ask a workspace admin for access to a warehouse, or check the sign-in.'));
    if (rows.length) {
      set.appendChild(
        h('div', { class: 'op-table-wrap' }, h('table', { class: 'dcc-table op-wh-table' }, [
          h('caption', { class: 'dcc-visually-hidden' }, 'SQL warehouses visible to this sign-in'),
          h('thead', {}, h('tr', {}, [h('th', { class: 'op-radio-cell', scope: 'col' }, h('span', { class: 'dcc-visually-hidden' }, 'Choose')), h('th', { scope: 'col' }, 'Name'), h('th', { scope: 'col' }, 'ID'), h('th', { scope: 'col' }, 'State'), h('th', { scope: 'col' }, 'Size')])),
          h('tbody', {}, rows),
        ]))
      );
    }
    if (savedMissing) {
      set.appendChild(messageBox('warn', 'Your saved warehouse is unavailable', ['It isn\'t in the current list. It may have been deleted, or this sign-in can\'t see it. It stays selected until you choose another one.']));
    }
    return set;
  }

  function renderWarehouse() {
    const savedBox = $('wh-saved');
    const body = $('wh-body');
    const btn = $('wh-list');
    btn.disabled = !S.sel || !currentAuthMode();
    if (S.whRequest) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
    if (!S.sel) {
      show(savedBox, h('p', { class: 'op-help' }, 'Choose a workspace first.'));
      show(body, null);
      return;
    }
    const saved = S.sel.conn && S.sel.conn.warehouse;
    show(savedBox, saved ? savedLine(saved) : null);
    if (S.whRequest) return show(body, busyLine('Listing warehouses…'));
    if (!S.wh) return show(body, saved ? null : h('p', { class: 'op-help' }, 'Select List warehouses to see the SQL warehouses this sign-in can see.'));
    return show(body, warehouseChooser());
  }

  async function onListWarehouses() {
    if (!S.sel) return;
    const authMode = currentAuthMode();
    if (!config.AUTH_MODES.includes(authMode)) return;
    const req = { id: 'wh-' + Date.now().toString(36) + '-' + ++S.whSeq, origin: S.sel.origin, authMode };
    S.whRequest = req;
    renderWarehouse();
    const res = await send({ type: 'admin:listWarehouses', origin: req.origin, authMode: req.authMode, requestId: req.id });
    // Ignore late responses: a newer listing, another workspace, or another sign-in type won.
    if (S.whRequest !== req || !S.sel || S.sel.origin !== req.origin || currentAuthMode() !== req.authMode) return;
    S.whRequest = null;
    if (res.ok && (!res.data || res.data.origin !== req.origin || res.data.requestId !== req.id)) {
      renderWarehouse();
      return;
    }
    if (!res.ok) {
      renderWarehouse();
      show($('wh-body'), errorBox(res.error));
      return;
    }
    const list = (Array.isArray(res.data.warehouses) ? res.data.warehouses : []).filter((w) => w && V.isWarehouseId(w.id));
    const auto = res.data.automatic && V.isWarehouseId(res.data.automatic.id) ? res.data.automatic : null;
    S.wh = { origin: req.origin, authMode: req.authMode, list: warehouses.sortForDisplay(list), automatic: auto };
    renderWarehouse();
    renderSave();
  }

  /* ---------------------------------------------------------------- 5. billing */

  function buildPriceTableOptions() {
    const select = $('price-table');
    select.textContent = '';
    for (const table of Object.keys(pricing.PRICE_TABLES)) {
      if (!hasOwn(PRICE_TABLE_LABELS, table)) continue;
      select.appendChild(h('option', { value: table }, PRICE_TABLE_LABELS[table]));
    }
    select.value = pricing.DEFAULT_PRICE_TABLE;
  }

  function renderPriceWarn() {
    const warn = $('price-table-warn');
    const caps = (S.page && S.page.bridge && S.page.bridge.capabilities) || null;
    const needs = $('price-table').value === 'system.billing.account_prices' && currentAuthMode() === 'helper' && S.page && S.page.bridge && S.page.bridge.bridgePaired && !(caps && caps.accountPrices === true);
    warn.textContent = needs ? 'The running helper doesn\'t support account prices. Restart it with the latest version, or choose list prices.' : '';
    warn.hidden = !needs;
  }

  function validateSourceField(id, fallback) {
    const res = config.validateSource($(id).value.trim(), fallback);
    setFieldError(id, res.ok ? null : 'Use ' + fallback + ' or catalog.schema.view outside the system catalog.');
    return res;
  }

  /* ---------------------------------------------------------------- 6. save / disconnect */

  function renderSave() {
    const summary = $('save-summary');
    $('save-btn').disabled = !S.sel;
    if (!S.sel) {
      summary.textContent = 'Choose a workspace in step 1 first.';
      return;
    }
    const wsId = $('ws-id').value.trim();
    let text = 'Saves the cost connection for ' + S.sel.host + (V.isWorkspaceId(wsId) ? ' (workspace ' + wsId + ')' : '') + '.';
    if (S.sel.conn && V.isWorkspaceId(wsId) && wsId !== S.sel.conn.workspaceId) text += ' This replaces the saved workspace ID ' + S.sel.conn.workspaceId + '.';
    summary.textContent = text;
    renderDisconnect();
  }

  function collect() {
    const problems = [];
    const fields = {};
    if (!S.sel) problems.push('Choose a workspace in step 1.');
    const workspaceId = $('ws-id').value.trim();
    if (S.sel && !V.isWorkspaceId(workspaceId)) {
      fields['ws-id'] = 'Enter the numeric workspace ID (digits only).';
      problems.push('Enter the numeric workspace ID in step 1.');
    }
    const authMode = currentAuthMode();
    if (!config.AUTH_MODES.includes(authMode)) problems.push('Choose a sign-in method in step 3.');
    const priceTable = $('price-table').value;
    if (!hasOwn(pricing.PRICE_TABLES, priceTable)) problems.push('Choose one of the two supported price tables.');
    const currency = $('currency').value.trim().toUpperCase();
    if (!V.isCurrency(currency)) {
      fields.currency = 'Use a three-letter code such as USD.';
      problems.push('Enter a three-letter currency code in step 5.');
    }
    const usage = config.validateSource($('usage-source').value.trim(), config.DEFAULT_USAGE_SOURCE);
    if (!usage.ok) {
      fields['usage-source'] = 'Use ' + config.DEFAULT_USAGE_SOURCE + ' or catalog.schema.view outside the system catalog.';
      problems.push('Fix the usage source under Advanced in step 5.');
    }
    const history = config.validateSource($('history-source').value.trim(), config.DEFAULT_HISTORY_SOURCE);
    if (!history.ok) {
      fields['history-source'] = 'Use ' + config.DEFAULT_HISTORY_SOURCE + ' or catalog.schema.view outside the system catalog.';
      problems.push('Fix the query history source under Advanced in step 5.');
    }
    const choice = S.whChoice;
    if (!choice || (choice.mode === 'manual' && !V.isWarehouseId(choice.id))) problems.push('Choose Automatic or a SQL warehouse in step 4.');
    if (S.sel && !S.sel.conn && !(S.wh && S.wh.origin === S.sel.origin)) problems.push('List warehouses in step 4 first, so you can see which warehouse will run cost queries.');
    const warehouse = choice && choice.mode === 'manual' ? { mode: 'manual', id: choice.id, name: choice.name || null } : { mode: 'auto' };
    return {
      problems,
      fields,
      connection: S.sel
        ? { origin: S.sel.origin, workspaceId, authMode, priceTable, currency, usageSource: usage.value, historySource: history.value, warehouse }
        : null,
    };
  }

  async function onSave() {
    const out = $('save-result');
    const btn = $('save-btn');
    const { problems, fields, connection } = collect();
    for (const id of ['ws-id', 'currency', 'usage-source', 'history-source']) setFieldError(id, fields[id] || null);
    if (fields['usage-source'] || fields['history-source']) $('advanced').open = true;
    if (problems.length) return show(out, messageBox('error', 'Check these settings before saving', problems));
    const gen = S.selGen;
    const host = S.sel.host;
    setBusy(btn, true);
    show(out, busyLine(connection.warehouse.mode === 'auto' ? 'Saving: resolving Automatic from a fresh warehouse list…' : 'Saving…'));
    const res = await send({ type: 'admin:saveConnection', connection });
    setBusy(btn, false);
    await refreshState();
    if (gen !== S.selGen) return show(out, null);
    if (!res.ok) return show(out, errorBox(res.error));
    const saved = res.data || {};
    S.sel.conn = savedConnection(S.sel.origin) || saved;
    S.whChoice = choiceFromSaved(saved.warehouse);
    const wh = saved.warehouse || {};
    const whText = wh.mode === 'manual' ? 'warehouse ' + (wh.name || wh.id) : 'Automatic → ' + (wh.resolvedName || wh.resolvedId || 'unresolved');
    const lines = [
      'Workspace ' + saved.workspaceId + ' · ' + ({ oauth: 'Sign in with Databricks', session: 'your Databricks login', pat: 'personal access token', helper: 'local helper' }[saved.authMode] || saved.authMode) + ' · ' + whText + '.',
      'Listing a warehouse doesn\'t prove CAN USE or billing-table access. If the first cost query fails, its error names the missing permission.',
      S.access === false ? 'Next: allow site access in step 2 so costs appear inside the workspace.' : null,
    ];
    renderAll();
    show(out, messageBox('ok', 'Connection saved for ' + host, lines));
    return undefined;
  }

  function renderDisconnect() {
    const zone = $('disconnect');
    zone.hidden = !(S.sel && S.sel.conn);
    if (zone.hidden) hideDisconnectConfirm();
  }

  function hideDisconnectConfirm() {
    $('disconnect-confirm').hidden = true;
    $('disconnect-btn').hidden = false;
  }

  function onDisconnectAsk() {
    if (!S.sel || !S.sel.conn) return;
    $('disconnect-question').textContent = 'Disconnect ' + S.sel.host + '? This removes its saved cost connection and session token. Workspace colors are kept.';
    $('disconnect-confirm').hidden = false;
    $('disconnect-btn').hidden = true;
    $('disconnect-yes').focus();
  }

  async function onDisconnectYes() {
    if (!S.sel) return;
    const origin = S.sel.origin;
    const host = S.sel.host;
    const out = $('save-result');
    setBusy($('disconnect-yes'), true);
    const r = await send({ type: 'admin:removeConnection', origin });
    setBusy($('disconnect-yes'), false);
    hideDisconnectConfirm();
    if (!r.ok) return show(out, errorBox(r.error));
    await refreshState();
    if (S.sel && S.sel.origin === origin) {
      S.sel.conn = null;
      S.hasPat = false;
      S.whChoice = { mode: 'auto' };
      invalidateWarehouses();
    }
    renderAll();
    show(out, messageBox('ok', 'Disconnected ' + host, ['The saved connection and session token were removed. Workspace colors were not changed.']));
    $('save-btn').focus();
    return undefined;
  }

  function onDisconnectNo() {
    hideDisconnectConfirm();
    $('disconnect-btn').focus();
  }

  /* ---------------------------------------------------------------- local import */

  function readFileText(file) {
    if (file && typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
      const reader = new root.FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  function renderImportStatus() {
    const p = $('import-status');
    const imp = S.page && S.page.importSummary;
    const mode = S.page && S.page.settings && S.page.settings.mode;
    p.textContent = '';
    if (imp) {
      const when = Number.isFinite(imp.importedAt) ? new Date(imp.importedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null;
      p.append(h('span', { class: 'op-dot op-dot--ok', 'aria-hidden': 'true' }), imp.entries + (imp.entries === 1 ? ' summary' : ' summaries') + ' imported' + (when ? ' on ' + when : '') + '.' + (mode === 'import' ? ' Local import mode is on.' : ''));
    } else {
      p.append(h('span', { class: 'op-dot', 'aria-hidden': 'true' }), 'Nothing imported.');
    }
    $('import-use-mode').hidden = !(imp && mode !== 'import');
    $('import-clear').disabled = !imp;
  }

  async function onImportFile(ev) {
    const input = ev.currentTarget;
    const file = input.files && input.files[0];
    const out = $('import-result');
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      input.value = '';
      show(out, messageBox('error', 'The file is too large', ['Imports are limited to 5 MB.']));
      return;
    }
    let text;
    try {
      text = await readFileText(file);
    } catch (_) {
      show(out, messageBox('error', 'The file could not be read', ['Choose the file again.']));
      return;
    }
    try {
      input.value = '';
    } catch (_) {
      /* some environments don't allow resetting file inputs */
    }
    show(out, busyLine('Validating…'));
    const r = await send({ type: 'admin:importCosts', text });
    if (!r.ok) return show(out, errorBox(r.error));
    const d = r.data || {};
    if (d.ok === false) {
      const list = (Array.isArray(d.errors) ? d.errors : []).slice(0, 20).map((e) => clean(e, 300));
      return show(out, messageBox('error', 'The file was not imported', list.length ? list : ['The file did not pass validation.']));
    }
    await refreshState();
    const n = Number.isInteger(d.entries) ? d.entries : 0;
    const on = S.page && S.page.settings && S.page.settings.mode === 'import';
    show(out, messageBox('ok', 'Imported ' + n + (n === 1 ? ' summary' : ' summaries'), [on ? 'Local import mode is on.' : 'Switch to Local import mode to use them.']));
    return undefined;
  }

  async function onClearImport() {
    const out = $('import-result');
    const r = await send({ type: 'admin:clearImport' });
    if (!r.ok) return show(out, errorBox(r.error));
    await refreshState();
    show(out, messageBox('ok', 'Import cleared', []));
    return undefined;
  }

  async function onUseImportMode() {
    const out = $('import-result');
    const r = await send({ type: 'page:updateSettings', patch: { mode: 'import' } });
    if (!r.ok) return show(out, errorBox(r.error));
    await refreshState();
    show(out, messageBox('ok', 'Local import mode is on', []));
    return undefined;
  }

  /* ---------------------------------------------------------------- diagnostics */

  function renderDiagnostics() {
    const list = $('diag-list');
    const items = Array.isArray(S.page && S.page.diagnostics) ? S.page.diagnostics : [];
    list.textContent = '';
    $('diag-clear').disabled = !items.length;
    if (!items.length) {
      list.appendChild(h('li', { class: 'op-diag-empty' }, 'No recent errors.'));
      return;
    }
    for (const entry of items.slice(0, 20)) {
      const e = normalizeError({ code: entry && entry.code, details: entry && entry.details });
      const when = entry && Number.isFinite(entry.at) ? new Date(entry.at).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : null;
      const type = entry && typeof entry.type === 'string' ? clean(entry.type, 40) : null;
      const d = e.details;
      list.appendChild(
        h('li', {}, [
          h('div', {}, h('strong', {}, e.title)),
          h('div', { class: 'op-diag-meta' }, [when, e.code, type].filter(Boolean).join(' · ')),
          d.statementId || d.errorCode || d.httpStatus
            ? h('div', { class: 'op-diag-meta' }, [d.errorCode ? ['SQL error ', h('code', {}, d.errorCode), ' '] : null, d.statementId ? ['Statement ID ', h('code', {}, d.statementId), ' '] : null, d.httpStatus ? 'HTTP ' + d.httpStatus : null])
            : null,
          d.message ? h('div', { class: 'op-diag-meta' }, d.message) : null,
        ])
      );
    }
  }

  async function onClearDiagnostics() {
    const r = await send({ type: 'page:clearDiagnostics' });
    if (!r.ok) return show($('page-alert'), errorBox(r.error));
    if (S.page) S.page.diagnostics = [];
    renderDiagnostics();
    return undefined;
  }

  /* ---------------------------------------------------------------- page */

  function renderAll() {
    renderCandidates();
    renderSelection();
    renderAccess();
    renderAuth();
    renderWarehouse();
    renderPriceWarn();
    renderSave();
    renderDisconnect();
    renderImportStatus();
    renderDiagnostics();
  }

  function handlePairedHash() {
    if (root.location.hash !== '#paired') return;
    const b = (S.page && S.page.bridge) || {};
    const v = b.helperVersion ? ' v' + clean(b.helperVersion, 40) : '';
    show(
      $('page-alert'),
      b.bridgePaired
        ? messageBox('ok', 'Paired with the local helper' + v, ['Next: choose your workspace, then select Sign in under step 3.'])
        : messageBox('warn', 'No active helper pairing found', ['Run start-helper.command again; its setup page pairs automatically.'])
    );
    try {
      root.history.replaceState(null, '', root.location.pathname + root.location.search);
    } catch (_) {
      /* keep the hash */
    }
  }

  async function adoptPending() {
    const pending = await takePending();
    if (!pending) return false;
    S.pending = pending;
    renderPendingNote();
    await selectWorkspace(pending.origin);
    return true;
  }

  function wire() {
    $('ws-url-use').addEventListener('click', onUseUrl);
    onEnter('ws-url', onUseUrl);
    $('ws-url').addEventListener('input', () => setFieldError('ws-url', null));
    $('ws-id').addEventListener('input', () => {
      setFieldError('ws-id', null);
      for (const r of doc.querySelectorAll('input[name="ws-id-choice"]')) r.checked = r.value === $('ws-id').value.trim();
      renderSave();
    });
    for (const r of doc.querySelectorAll('input[name="auth"]')) r.addEventListener('change', onAuthChange);
    $('access-grant').addEventListener('click', onGrantAccess);
    $('access-remove').addEventListener('click', onRemoveAccess);
    $('helper-check').addEventListener('click', onHelperCheck);
    $('oauth-signin').addEventListener('click', onOauthSignIn);
    $('session-connect').addEventListener('click', onSessionConnect);
    $('helper-login').addEventListener('click', () => onHelperLogin('cost'));
    $('helper-login-monitor').addEventListener('click', () => onHelperLogin('monitor'));
    $('pair-submit').addEventListener('click', onPairManual);
    onEnter('pair-key', onPairManual);
    $('helper-unpair').addEventListener('click', onUnpair);
    $('pat-save').addEventListener('click', onSavePat);
    onEnter('pat-input', onSavePat);
    $('pat-clear').addEventListener('click', onClearPat);
    $('wh-list').addEventListener('click', onListWarehouses);
    $('price-table').addEventListener('change', renderPriceWarn);
    $('currency').addEventListener('input', () => setFieldError('currency', null));
    $('currency').addEventListener('blur', () => {
      const v = $('currency').value.trim().toUpperCase();
      $('currency').value = v;
      setFieldError('currency', v && !V.isCurrency(v) ? 'Use a three-letter code such as USD.' : null);
    });
    $('usage-source').addEventListener('blur', () => validateSourceField('usage-source', config.DEFAULT_USAGE_SOURCE));
    $('history-source').addEventListener('blur', () => validateSourceField('history-source', config.DEFAULT_HISTORY_SOURCE));
    $('save-btn').addEventListener('click', onSave);
    $('disconnect-btn').addEventListener('click', onDisconnectAsk);
    $('disconnect-yes').addEventListener('click', onDisconnectYes);
    $('disconnect-no').addEventListener('click', onDisconnectNo);
    $('import-file').addEventListener('change', onImportFile);
    $('import-clear').addEventListener('click', onClearImport);
    $('import-use-mode').addEventListener('click', onUseImportMode);
    $('diag-clear').addEventListener('click', onClearDiagnostics);
    for (const el of doc.querySelectorAll('[data-guide]')) {
      el.addEventListener('click', async () => {
        const r = await send({ type: 'page:open', page: 'guide', anchor: el.getAttribute('data-guide') });
        if (!r.ok) show($('page-alert'), errorBox(r.error));
      });
    }
    // The popup may hand over a workspace while this page is already open (it re-opens us at
    // #connect), and the helper setup page re-opens us at #paired.
    root.addEventListener('hashchange', async () => {
      if (root.location.hash === '#paired') {
        await refreshState();
        handlePairedHash();
      } else if (root.location.hash === '#connect') {
        await adoptPending();
      }
    });
    root.addEventListener('focus', () => {
      adoptPending();
    });
  }

  async function init() {
    buildPriceTableOptions();
    for (const r of doc.querySelectorAll('input[name="auth"]')) r.checked = r.value === 'helper';
    wire();
    const [stateRes, pending, granted] = await Promise.all([send({ type: 'page:state' }), takePending(), grantedOrigins()]);
    if (stateRes.ok && stateRes.data) S.page = stateRes.data;
    else {
      S.page = { settings: {}, connections: {}, observed: {}, diagnostics: [], bridge: {}, importSummary: null };
      show($('page-alert'), errorBox(stateRes.error));
    }
    S.pending = pending;
    S.granted = granted;
    renderPendingNote();
    renderAll();
    handlePairedHash();
    // Pre-select only without ambiguity: the workspace the user just chose in the popup, or the
    // single candidate. With several candidates the user picks.
    const list = candidateList();
    if (pending) await selectWorkspace(pending.origin);
    else if (list.length === 1) await selectWorkspace(list[0].origin);
  }

  const ready = init().catch((e) => show($('page-alert'), errorBox(backgroundError(e && e.message))));
  DCC.optionsPage = Object.freeze({ ready });
})(typeof globalThis !== 'undefined' ? globalThis : this);
