/*
 * Run monitor page (ui/monitor.html). Renders the service worker's monitor state and re-reads it
 * every 15 s while visible (the service worker does the REST polling on its own schedule). Cost
 * comes from cache, or from an explicit "Load cost" that asks first when the cost warehouse is
 * stopped. "Float on top" moves the app into a Document Picture-in-Picture window.
 *
 * DOM is built with text nodes only (no innerHTML). Run links are validated again here before
 * they are rendered: same workspace origin, exact job run route.
 */
(function (root) {
  'use strict';
  const DCC = root.DCC;
  const labels = DCC.labels;
  const mapi = DCC.monitorApi;
  const doc = root.document;
  const chromeApi = root.chrome;

  const STATE_POLL_MS = 15000;
  const RECENT_SHOWN = 10;
  const PIP_SIZE = Object.freeze({ width: 360, height: 520 });
  const OUTCOME_CLASSES = new Set(['running', 'pending', 'succeeded', 'failed', 'partial', 'canceled', 'skipped', 'stopped', 'unknown']);
  const PIPELINE_TEXT = { IDLE: 'Idle', RUNNING: 'Running', STARTING: 'Starting', STOPPING: 'Stopping', DELETED: 'Deleted', RECOVERING: 'Recovering', FAILED: 'Failed', RESETTING: 'Resetting', DEPLOYING: 'Deploying' };
  const WAREHOUSE_TEXT = { RUNNING: 'Running', STARTING: 'Starting', STOPPING: 'Stopping', STOPPED: 'Stopped', DELETING: 'Deleting', DELETED: 'Deleted' };
  const SOURCE_TEXT = { UI: 'Interactive', API: 'API', JOB: 'Job compute', PIPELINE: 'Pipeline', PIPELINE_MAINTENANCE: 'Pipeline maintenance', SQL: 'SQL', MODELS: 'Model serving' };
  const FLOAT_UNAVAILABLE = 'Float on top is not available here. You can keep this small monitor window open instead; it stays where you place it.';

  const el = {};
  let model = null;
  let modelError = null;
  let cost = null;
  let costBusy = false;
  let busy = false;
  let pip = null;
  let timer = null;
  let showAllRuns = false;
  let showStopped = false;
  let floatNote = false;
  let windowType = null;
  let wsKey = null;

  /* ---------------------------------------------------------------- helpers */

  function h(tag, attrs, children) {
    const d = el.app ? el.app.ownerDocument : doc;
    const node = d.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'class') node.className = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of [].concat(children === undefined ? [] : children)) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? d.createTextNode(String(c)) : c);
    }
    return node;
  }

  function fill(container, nodes) {
    container.replaceChildren(...[].concat(nodes || []).filter(Boolean));
  }

  async function send(msg) {
    try {
      const res = await chromeApi.runtime.sendMessage(msg);
      if (res && typeof res === 'object') return res;
    } catch (_) {
      /* fall through */
    }
    return { ok: false, error: { code: 'UNKNOWN', title: 'The extension did not respond', steps: ['Close this window and open the monitor again.'] } };
  }

  const isVisible = () => doc.visibilityState !== 'hidden' || Boolean(pip && !pip.closed);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  function hostOf(origin) {
    try {
      return new URL(origin).host;
    } catch (_) {
      return String(origin || '');
    }
  }

  function clock(ms, seconds) {
    const opts = seconds ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' };
    const d = new Date(ms);
    const sameDay = new Date().toDateString() === d.toDateString();
    return sameDay ? d.toLocaleTimeString([], opts) : d.toLocaleString([], Object.assign({ month: 'short', day: 'numeric' }, opts));
  }

  function since(ms) {
    return labels.formatDuration(Date.now() - ms);
  }

  function humanize(code) {
    const t = String(code || '').toLowerCase().replace(/_/g, ' ');
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
  }

  function intervalText(sec) {
    return sec === 60 ? 'minute' : plural(Math.round(sec / 60), 'minute');
  }

  function chip(outcome, text) {
    return h('span', { class: 'st st-' + (OUTCOME_CLASSES.has(outcome) ? outcome : 'unknown') }, text || 'Status unknown');
  }

  function errorNodes(err) {
    const e = err || {};
    const steps = Array.isArray(e.steps) ? e.steps : [];
    return [h('strong', null, e.title || 'Something went wrong'), steps.length ? h('ul', null, steps.map((s) => h('li', null, String(s)))) : null];
  }

  function sectionError(err, at) {
    const why = at ? 'Showing data from ' + clock(at) + '.' : (err && Array.isArray(err.steps) && err.steps[0]) || '';
    return h('p', { class: 'err-box' }, ["Couldn't refresh: " + ((err && err.title) || 'error') + '. ', h('span', { class: 'why' }, why)]);
  }

  function truncNote(text) {
    return h('p', { class: 'trunc' }, text);
  }

  function liveState() {
    if (!model || !model.settings || !model.settings.enabled || !model.state) return null;
    return model.state.status === 'ok' || model.state.status === 'error' ? model.state : null;
  }

  /** Re-validate before rendering: only this exact job run on the monitored workspace origin. */
  function safeRunUrl(run, st) {
    if (!run || !run.url) return null;
    return mapi.validRunUrl(run.url, st.origin, st.workspaceId, run.jobId, [run.runId, run.originalRunId]);
  }

  function openLink(event, url) {
    if (chromeApi && chromeApi.tabs && typeof chromeApi.tabs.create === 'function') {
      event.preventDefault();
      chromeApi.tabs.create({ url });
    }
  }

  function openOptions(anchor) {
    send({ type: 'page:open', page: 'options', anchor });
  }

  /* ---------------------------------------------------------------- render */

  function render() {
    renderHeader();
    renderNotice();
    renderCounts();
    renderRuns();
    renderPipelines();
    renderWarehouses();
    renderClusters();
    renderCost();
    renderFloatNote();
  }

  function renderHeader() {
    const m = model;
    const conns = (m && m.connections) || [];
    const key = JSON.stringify([conns, m && m.monitorOrigin]);
    if (key !== wsKey) {
      wsKey = key;
      const opts = [];
      if (!conns.length) opts.push(h('option', { value: '' }, 'No saved workspace'));
      else {
        if (!m.monitorOrigin) opts.push(h('option', { value: '' }, 'Choose a workspace…'));
        for (const o of conns) opts.push(h('option', { value: o }, hostOf(o)));
      }
      fill(el.ws, opts);
      el.ws.value = (m && m.monitorOrigin) || '';
    }
    el.ws.disabled = busy || !conns.length;

    let text;
    if (!m) text = modelError ? 'Could not load the monitor state.' : 'Loading…';
    else if (!m.settings.enabled) text = 'Monitoring is off.';
    else if (!m.state) text = 'Checking…';
    else {
      const st = m.state;
      text = st.at ? 'Updated ' + clock(st.at, true) + ' · checks every ' + intervalText(m.settings.intervalSec) : 'Not updated yet';
      if (st.status === 'error' && st.at) text += ' · last refresh failed';
      if (st.retryAt) text += ' · next try after ' + clock(st.retryAt);
    }
    el.updated.textContent = text;
    if (m && m.settings && el.interval.ownerDocument.activeElement !== el.interval) el.interval.value = String(m.settings.intervalSec);
    el.interval.disabled = busy || !m || !m.settings.enabled;
    el.refresh.disabled = busy || !m || !m.settings.enabled;
    el.refresh.textContent = busy ? 'Refreshing…' : 'Refresh';
    el.refresh.setAttribute('aria-busy', String(busy));
  }

  function renderNotice() {
    const m = model;
    let nodes = null;
    let err = false;
    if (modelError) {
      nodes = errorNodes(modelError);
      err = true;
    } else if (m && !m.settings.enabled) {
      nodes = [
        h('strong', null, 'Monitoring is off'),
        h('span', null, 'Turn it on to check job runs, pipelines, SQL warehouses and clusters with read-only requests. It never starts a warehouse.'),
        h('div', { class: 'actions' }, [h('button', { type: 'button', class: 'primary', onclick: enableMonitoring }, 'Turn on monitoring')]),
      ];
    } else if (m && m.state && m.state.next) {
      const next = m.state.next;
      err = m.state.status === 'error';
      const offerPrefs = next.code !== 'MONITOR_CHOOSE' && next.code !== 'MONITOR_DEMO';
      nodes = errorNodes(next).concat(offerPrefs ? [h('div', { class: 'actions' }, [h('button', { type: 'button', onclick: () => openOptions('auth') }, 'Open Connection preferences')])] : []);
    }
    el.notice.hidden = !nodes;
    el.notice.className = 'notice' + (err ? ' err' : '');
    fill(el.notice, nodes);
  }

  function tile(n, label, sub, cls, truncated) {
    const known = n !== null && n !== undefined;
    return h('div', { class: 'tile' + (cls ? ' ' + cls : '') }, [
      h('span', { class: 'n' }, known ? String(n) + (truncated ? '+' : '') : '—'),
      h('span', { class: 'l' }, [label, known ? null : h('span', { class: 'sr-only' }, ' (unknown)')]),
      sub ? h('span', { class: 'sub' }, sub) : null,
    ]);
  }

  function renderCounts() {
    const st = liveState();
    el.counts.hidden = !st;
    if (!st) return fill(el.counts, null);
    const c = st.counts || {};
    const active = c.running === null || c.running === undefined ? null : c.running + (c.pending || 0);
    fill(el.counts, [
      tile(active, 'Running', c.pending ? c.pending + ' queued' : 'now', 'run', st.truncated && st.truncated.runsActive),
      tile(c.failed, 'Failed', 'last 24 h', c.failed ? 'bad' : null, st.truncated && st.truncated.runsRecent),
      tile(c.succeeded, 'Succeeded', 'last 24 h', c.succeeded ? 'good' : null, st.truncated && st.truncated.runsRecent),
    ]);
  }

  function runItem(r, st) {
    const url = safeRunUrl(r, st);
    const name = r.name || 'Run ' + r.runId;
    const nameNode = url
      ? h('a', { class: 'name', href: url, target: '_blank', rel: 'noopener noreferrer', title: 'Open this run in Databricks', onclick: (e) => openLink(e, url) }, name)
      : h('span', { class: 'name' }, name);
    const meta = [];
    if (r.active) {
      if (r.startMs) meta.push((r.outcome === 'pending' ? 'Waiting since ' : 'Started ') + clock(r.startMs));
      if (r.outcome === 'running' && r.startMs && since(r.startMs)) meta.push('running ' + since(r.startMs));
    } else {
      if (r.endMs) meta.push('Ended ' + clock(r.endMs));
      else if (r.startMs) meta.push('Started ' + clock(r.startMs));
      if (labels.formatDuration(r.durationMs)) meta.push('took ' + labels.formatDuration(r.durationMs));
    }
    // Termination code adds detail only where the status text does not already say it.
    if (r.code && ['failed', 'canceled', 'skipped'].includes(r.outcome)) meta.push(humanize(r.code));
    return h('li', { class: 'item' }, [h('div', { class: 'line1' }, [chip(r.outcome, r.statusText), nameNode]), meta.length ? h('p', { class: 'meta' }, meta.join(' · ')) : null]);
  }

  function setSection(container, st) {
    container.parentElement.hidden = !st;
    if (!st) fill(container, null);
    return Boolean(st);
  }

  function renderRuns() {
    const st = liveState();
    if (!setSection(el.runs, st)) return;
    const nodes = [];
    const err = st.errors.runsActive || st.errors.runsRecent;
    if (err) nodes.push(sectionError(err, st.sectionAt.runsActive || st.sectionAt.runsRecent));
    const runs = st.runs || [];
    const active = runs.filter((r) => r.active);
    const done = runs.filter((r) => !r.active);
    if (!runs.length) {
      if (st.sectionAt.runsActive || st.sectionAt.runsRecent) nodes.push(h('p', { class: 'empty' }, 'No active runs, and no runs finished in the last 24 hours.'));
    } else {
      nodes.push(h('p', { class: 'sub-h' }, 'Active'));
      nodes.push(active.length ? h('ul', { class: 'list', 'aria-label': 'Active runs' }, active.map((r) => runItem(r, st))) : h('p', { class: 'empty' }, 'No active runs.'));
      if (done.length) {
        nodes.push(h('p', { class: 'sub-h' }, 'Finished · last 24 h'));
        const shown = showAllRuns ? done : done.slice(0, RECENT_SHOWN);
        nodes.push(h('ul', { class: 'list', 'aria-label': 'Runs finished in the last 24 hours' }, shown.map((r) => runItem(r, st))));
        if (done.length > RECENT_SHOWN) {
          nodes.push(
            h('button', { type: 'button', class: 'link more', 'aria-expanded': String(showAllRuns), onclick: () => ((showAllRuns = !showAllRuns), renderRuns()) }, showAllRuns ? 'Show fewer runs' : 'Show all ' + done.length + ' finished runs')
          );
        }
      }
    }
    if (st.truncated.runsActive) nodes.push(truncNote('Showing the first 25 active runs.'));
    if (st.truncated.runsRecent) nodes.push(truncNote('Showing the latest 50 runs started in the last 24 hours.'));
    fill(el.runs, nodes);
  }

  function renderPipelines() {
    const st = liveState();
    if (!setSection(el.pipelines, st)) return;
    const nodes = [];
    if (st.errors.pipelines) nodes.push(sectionError(st.errors.pipelines, st.sectionAt.pipelines));
    const list = st.pipelines || [];
    if (!list.length) {
      if (st.sectionAt.pipelines) nodes.push(h('p', { class: 'empty' }, 'No pipeline updates running, and no recent pipeline failures.'));
    } else {
      nodes.push(
        h(
          'ul',
          { class: 'list', 'aria-label': 'Pipelines' },
          list.map((p) => {
            const u = p.update;
            const updateShown = u && ['running', 'pending', 'failed'].includes(u.outcome);
            const outcome = p.active ? (u && u.outcome === 'pending' ? 'pending' : 'running') : p.recentFailure ? 'failed' : 'unknown';
            const text = updateShown ? u.statusText : PIPELINE_TEXT[p.state] || 'Status unknown';
            const meta = [];
            if (u && u.createdMs) meta.push('Update started ' + clock(u.createdMs));
            if (p.health === 'UNHEALTHY') meta.push('Unhealthy');
            return h('li', { class: 'item' }, [h('div', { class: 'line1' }, [chip(outcome, text), h('span', { class: 'name' }, p.name || 'Pipeline ' + p.pipelineId)]), meta.length ? h('p', { class: 'meta' }, meta.join(' · ')) : null]);
          })
        )
      );
    }
    if (st.truncated.pipelines) nodes.push(truncNote('Checked the first 100 pipelines.'));
    fill(el.pipelines, nodes);
  }

  function renderWarehouses() {
    const st = liveState();
    if (!setSection(el.warehouses, st)) return;
    const nodes = [];
    if (st.errors.warehouses) nodes.push(sectionError(st.errors.warehouses, st.sectionAt.warehouses));
    const list = st.warehouses || [];
    const c = st.counts || {};
    if (st.sectionAt.warehouses || list.length) {
      const parts = [];
      if (c.warehousesRunning !== null) parts.push(c.warehousesRunning + ' running');
      if (c.warehousesStarting) parts.push(c.warehousesStarting + ' starting');
      if (c.warehousesStopped !== null) parts.push(c.warehousesStopped + ' stopped');
      if (parts.length) nodes.push(h('p', { class: 'sum' }, parts.join(' · ')));
    }
    const awake = (w) => w.state === 'RUNNING' || w.state === 'STARTING' || w.state === 'STOPPING';
    const shown = list.filter((w) => showStopped || awake(w));
    if (!list.length) {
      if (st.sectionAt.warehouses) nodes.push(h('p', { class: 'empty' }, 'No SQL warehouses visible to this sign-in.'));
    } else {
      if (shown.length) {
        nodes.push(
          h(
            'ul',
            { class: 'list', 'aria-label': 'SQL warehouses' },
            shown.map((w) => {
              const outcome = w.state === 'RUNNING' ? 'running' : w.state === 'STARTING' ? 'pending' : 'stopped';
              const meta = [w.size, w.serverless ? 'Serverless' : w.type ? humanize(w.type) : null, w.state === 'RUNNING' && w.activeClusters !== null ? plural(w.activeClusters, 'cluster') : null].filter(Boolean);
              return h('li', { class: 'item' }, [h('div', { class: 'line1' }, [chip(outcome, WAREHOUSE_TEXT[w.state] || 'Status unknown'), h('span', { class: 'name' }, w.name)]), meta.length ? h('p', { class: 'meta' }, meta.join(' · ')) : null]);
            })
          )
        );
      } else nodes.push(h('p', { class: 'empty' }, 'No SQL warehouses running.'));
      const hidden = list.length - list.filter(awake).length;
      if (hidden > 0) {
        nodes.push(h('button', { type: 'button', class: 'link more', 'aria-expanded': String(showStopped), onclick: () => ((showStopped = !showStopped), renderWarehouses()) }, showStopped ? 'Hide stopped warehouses' : 'Show ' + plural(hidden, 'stopped warehouse')));
      }
    }
    if (st.truncated.warehouses) nodes.push(truncNote('Showing the first pages of warehouses only.'));
    fill(el.warehouses, nodes);
  }

  function renderClusters() {
    const st = liveState();
    if (!setSection(el.clusters, st)) return;
    const nodes = [];
    if (st.errors.clusters) nodes.push(sectionError(st.errors.clusters, st.sectionAt.clusters));
    const list = st.clusters || [];
    if (!list.length) {
      if (st.sectionAt.clusters) nodes.push(h('p', { class: 'empty' }, 'No clusters running.'));
    } else {
      nodes.push(
        h(
          'ul',
          { class: 'list', 'aria-label': 'Active clusters' },
          list.map((c) => {
            const workers = c.autoscale ? c.autoscale.min + '–' + c.autoscale.max + ' workers' : c.workers !== null ? plural(c.workers, 'worker') : null;
            const meta = [c.source ? SOURCE_TEXT[c.source] || humanize(c.source) : null, workers, c.startMs && since(c.startMs) ? 'started ' + since(c.startMs) + ' ago' : null].filter(Boolean);
            return h('li', { class: 'item' }, [h('div', { class: 'line1' }, [chip(c.state === 'RUNNING' ? 'running' : 'pending', c.statusText), h('span', { class: 'name' }, c.name || c.clusterId)]), meta.length ? h('p', { class: 'meta' }, meta.join(' · ')) : null]);
          })
        )
      );
    }
    if (st.truncated.clusters) nodes.push(truncNote('More active clusters may exist than shown.'));
    fill(el.clusters, nodes);
  }

  function lastDay(endExclusive) {
    const ms = Date.parse(endExclusive + 'T00:00:00Z');
    return Number.isFinite(ms) ? new Date(ms - 86400000).toISOString().slice(0, 10) : null;
  }

  function costValue(c) {
    const nodes = [];
    const amount = labels.formatAmount(c.amount, c.currency || 'USD');
    const basis = labels.BASIS[c.basis] || null;
    const days = c.period && c.period.days;
    if (amount) {
      nodes.push(
        h('p', null, [
          h('span', { class: 'amount' }, amount),
          ' ' + (days ? days + 'd ' : '') + 'est.',
          basis ? h('span', { class: 'pill', title: basis.note }, basis.short) : null,
          c.coverage === 'partial' ? h('span', { class: 'pill warn' }, 'Priced subtotal') : null,
        ])
      );
    } else {
      const why = c.noImport ? 'No imported summary for this workspace and period.' : c.coverage === 'none' ? 'Usage was found, but none of it has a matching price.' : 'No cost data for this period.';
      nodes.push(h('p', null, why));
    }
    if (days) {
      const range = c.period.start && c.period.endExclusive ? ' (' + c.period.start + ' to ' + lastDay(c.period.endExclusive) + ')' : '';
      nodes.push(h('p', null, 'Last ' + days + ' complete UTC days' + range));
    }
    if (c.coverage === 'partial') nodes.push(h('p', null, 'Some usage has no matching price, so this is a priced subtotal, not a full total.'));
    if (basis) nodes.push(h('p', null, basis.note));
    const fresh = [c.cached ? 'From cache' : 'Just loaded', c.latestUsageMs ? 'latest usage ' + since(c.latestUsageMs) + ' ago' : null].filter(Boolean);
    nodes.push(h('p', null, fresh.join(' · ')));
    return nodes;
  }

  function renderCost() {
    const m = model;
    let nodes = [];
    const periodDays = (m && m.periodDays) || 30;
    const loadButton = (label, confirm) => h('button', { type: 'button', class: confirm ? 'primary' : null, onclick: () => loadCost(confirm) }, label);
    if (!m) nodes = [];
    else if (!m.showCosts) nodes = [h('p', null, 'Cost display is paused. Resume it from the extension popup.')];
    else if (!m.monitorOrigin) nodes = [h('p', null, 'Choose a workspace to see its estimated cost.')];
    else if (costBusy) nodes = [h('p', null, 'Loading cost…')];
    else if (!cost || cost.notCached) {
      nodes = [
        h('p', null, 'Loads the estimated cost for the last ' + periodDays + ' complete UTC days from cache, or with a query on the cost connection’s SQL warehouse. If that warehouse is stopped, you are asked first.'),
        h('div', { class: 'actions' }, [loadButton('Load cost', false)]),
      ];
    } else if (cost.needsConfirm) {
      const state = WAREHOUSE_TEXT[cost.state] ? WAREHOUSE_TEXT[cost.state].toLowerCase() : 'not running';
      nodes = [
        h('p', null, 'The SQL warehouse “' + (cost.warehouseName || cost.warehouseId) + '” is ' + state + '. Loading cost runs a query that starts it, and a running warehouse bills your account until it stops.'),
        h('div', { class: 'actions' }, [loadButton('Start warehouse and load cost', true), h('button', { type: 'button', onclick: () => ((cost = null), renderCost()) }, 'Not now')]),
      ];
    } else if (cost.error) {
      nodes = [h('div', { class: 'err-box' }, errorNodes(cost.error)), h('div', { class: 'actions' }, [loadButton('Try again', false)])];
    } else if (cost.paused) nodes = [h('p', null, 'Cost display is paused. Resume it from the extension popup.')];
    else if (cost.notConnected) nodes = [h('p', null, 'This workspace has no saved cost connection.')];
    else if (cost.stale) nodes = [h('p', null, 'Settings changed while the cost was loading.'), h('div', { class: 'actions' }, [loadButton('Load cost', false)])];
    else nodes = costValue(cost);
    fill(el.cost, nodes);
  }

  function renderFloatNote() {
    el.floatNote.hidden = !floatNote;
    if (!floatNote) return fill(el.floatNote, null);
    fill(el.floatNote, [
      FLOAT_UNAVAILABLE,
      windowType && windowType !== 'popup' ? h('span', null, [' ', h('button', { type: 'button', class: 'link', onclick: () => send({ type: 'monitor:open' }) }, 'Open as a small window')]) : null,
    ]);
  }

  /* ---------------------------------------------------------------- actions */

  function apply(res) {
    if (res && res.ok) {
      model = res.data;
      modelError = null;
    } else {
      modelError = (res && res.error) || { title: 'Something went wrong' };
    }
    render();
  }

  async function loadState(ack) {
    apply(await send({ type: 'monitor:state', ack: Boolean(ack && isVisible()) }));
  }

  async function withBusy(work) {
    busy = true;
    renderHeader();
    try {
      return await work();
    } finally {
      busy = false;
      renderHeader();
    }
  }

  async function refreshNow() {
    apply(await withBusy(() => send({ type: 'monitor:refresh' })));
  }

  async function enableMonitoring() {
    const res = await send({ type: 'page:updateSettings', patch: { monitor: { enabled: true } } });
    if (!res.ok) return apply(res);
    await refreshNow();
  }

  async function setPollInterval(value) {
    const sec = Number(value);
    if (![60, 120, 300].includes(sec)) return;
    const res = await send({ type: 'page:updateSettings', patch: { monitor: { intervalSec: sec } } });
    if (!res.ok) return apply(res);
    await loadState(false);
  }

  async function setOrigin(origin) {
    if (!origin) return;
    apply(await withBusy(() => send({ type: 'monitor:setOrigin', origin })));
    cost = null;
    await loadCachedCost();
  }

  async function loadCachedCost() {
    const res = await send({ type: 'monitor:loadCost', cachedOnly: true });
    if (res.ok && res.data && !res.data.notCached) cost = res.data;
    renderCost();
  }

  async function loadCost(confirmStart) {
    costBusy = true;
    renderCost();
    const res = await send({ type: 'monitor:loadCost', confirmStart: confirmStart === true });
    costBusy = false;
    cost = res.ok ? res.data : { error: res.error };
    renderCost();
  }

  /* ---------------------------------------------------------------- float on top */

  /**
   * Same-origin rules are inlined into a <style> (applies immediately); a sheet whose rules
   * cannot be read, or that has not loaded, is linked by its absolute extension URL instead.
   */
  function copyStyles(target) {
    for (const node of Array.from(doc.querySelectorAll('link[rel="stylesheet"], style'))) {
      let css = null;
      try {
        css = node.sheet ? Array.from(node.sheet.cssRules).map((r) => r.cssText).join('\n') : null;
      } catch (_) {
        css = null;
      }
      if (!css && node.tagName === 'STYLE') css = node.textContent;
      if (css) {
        const style = target.createElement('style');
        style.textContent = css;
        target.head.appendChild(style);
      } else if (node.href) {
        const link = target.createElement('link');
        link.rel = 'stylesheet';
        link.href = node.href;
        target.head.appendChild(link);
      }
    }
  }

  function setFloating(on) {
    el.placeholder.hidden = !on;
    el.float.setAttribute('aria-pressed', String(on));
    el.float.textContent = on ? 'Back to window' : 'Float on top';
  }

  function restoreFromPip() {
    if (!el.host.contains(el.app)) el.host.appendChild(el.app);
    pip = null;
    setFloating(false);
    render();
  }

  function floatUnavailable() {
    floatNote = true;
    renderFloatNote();
  }

  /** Must run inside the click handler (user activation) for requestWindow to be allowed. */
  async function onFloat() {
    if (pip && !pip.closed) {
      pip.close();
      return;
    }
    const api = root.documentPictureInPicture;
    if (!api || typeof api.requestWindow !== 'function') return floatUnavailable();
    let w;
    try {
      w = await api.requestWindow(PIP_SIZE);
    } catch (_) {
      return floatUnavailable();
    }
    try {
      copyStyles(w.document);
      w.document.title = 'Run monitor';
      w.document.body.appendChild(el.app);
    } catch (_) {
      try {
        w.close();
      } catch (__) {
        /* ignore */
      }
      restoreFromPip();
      return floatUnavailable();
    }
    pip = w;
    floatNote = false;
    setFloating(true);
    renderFloatNote();
    w.addEventListener('pagehide', () => restoreFromPip(), { once: true });
  }

  /* ---------------------------------------------------------------- start */

  function tick() {
    if (isVisible()) loadState(true);
  }

  function stop() {
    if (timer) root.clearInterval(timer);
    timer = null;
  }

  async function start() {
    for (const id of ['host', 'app', 'ws', 'updated', 'refresh', 'float', 'notice', 'counts', 'runs', 'pipelines', 'warehouses', 'clusters', 'cost', 'settings', 'interval']) el[id] = doc.getElementById(id);
    el.floatNote = doc.getElementById('float-note');
    el.placeholder = doc.getElementById('pip-placeholder');
    el.disclaimer = doc.getElementById('disclaimer');
    el.disclaimer.textContent = labels.DISCLAIMER;

    el.refresh.addEventListener('click', () => refreshNow());
    el.float.addEventListener('click', () => onFloat());
    el.ws.addEventListener('change', () => setOrigin(el.ws.value));
    el.settings.addEventListener('click', () => openOptions('auth'));
    el.interval.addEventListener('change', () => setPollInterval(el.interval.value));
    doc.getElementById('pip-return').addEventListener('click', () => pip && pip.close());
    doc.addEventListener('visibilitychange', () => {
      if (isVisible()) loadState(true);
    });

    try {
      if (chromeApi.windows && chromeApi.windows.getCurrent) windowType = (await chromeApi.windows.getCurrent()).type || null;
    } catch (_) {
      windowType = null;
    }
    await loadState(true);
    if (model && model.settings.enabled) {
      const res = await send({ type: 'monitor:refresh', ifStale: true });
      if (res.ok) apply(res);
    }
    await loadCachedCost();
    timer = root.setInterval(tick, STATE_POLL_MS);
  }

  const ready = start();
  DCC.monitorPage = Object.freeze({ ready, stop, tick, refresh: refreshNow, float: onFloat, model: () => model });
})(typeof globalThis !== 'undefined' ? globalThis : this);
