/*
 * Genie side panel page (ui/sidepanel.html).
 *
 * Pick a workspace and a Genie Agent, ask, and keep working: the service worker sends the
 * question, waits for Genie and stores the conversation in session storage, so closing this
 * panel loses nothing. The page holds a runtime port ('dcc-genie-panel') so the service worker
 * knows it is open and can say when something changed; the data itself always comes through the
 * sender-validated genie:* messages. The page never polls: it re-reads state when the port says
 * so or when it becomes visible again, and a one-second local timer only updates elapsed times.
 *
 * Everything from Genie is rendered with textContent (never innerHTML). Answer text goes through
 * the safe Markdown subset in src/core/mini-markdown.js (DOM nodes only, https links only). Result
 * tables are profiled by src/core/genie-viz.js (column types, number, date and header formatting,
 * automatic chart choice) and drawn by genie-chart.js; each result offers Chart (or Summary for
 * a single row) and Table views, Copy table (TSV) and Download CSV (explorer/csv.js escaping).
 * The generated SQL stays behind a "Show SQL" disclosure.
 */
(function (root) {
  'use strict';
  const DCC = root.DCC || {};
  const doc = root.document;
  const chromeApi = root.chrome;
  const V = DCC.validate;
  const errors = DCC.errors;
  const MD = DCC.miniMarkdown;
  const VIZ = DCC.genieViz;
  const CHART = DCC.genieChart;
  const CSV = DCC.exploreCsv;
  const $ = (id) => doc.getElementById(id);
  const nav = root.navigator || {};
  const LOCALE = VIZ.safeLocale((nav.languages && nav.languages[0]) || nav.language || 'en-US');
  const CHART_FALLBACK_WIDTH = 320;

  const PORT_NAME = 'dcc-genie-panel';
  const MAX_QUESTION = 2000;
  const MAX_RECONNECTS = 8;
  const PHASES = Object.freeze({
    sending: { label: 'Sending', live: true, step: 'Sending your question' },
    working: { label: 'Genie is working', live: true, step: 'Thinking' },
    query: { label: 'Running query', live: true, step: 'Running the query' },
    done: { label: 'Answer ready', live: false, step: null },
    failed: { label: 'Failed', live: false, step: null },
  });
  const STATUS_SUFFIX = { signin: ' · needs Allow Genie', pat: ' · needs a token', helper: ' · helper not supported', unsupported: ' · sign-in not supported' };
  const DEMO_STARTERS = Object.freeze({
    revenue: ['What was revenue by region last month?', 'Show daily revenue by channel for the last 2 weeks', 'What were our headline numbers last month?'],
    ops: ['Which jobs failed this week?', 'How do run duration and DBUs relate?', 'Show the latest pipeline updates'],
  });

  const ui = {
    init: null,
    origin: null,
    spaces: [],
    spaceId: null,
    thread: null,
    rev: -1,
    blocked: true,
    openSql: new Set(),
    wrapSql: new Set(),
    views: new Map(), // turnId → {view: 'chart'|'table', pick: measure index}
    redraw: new WeakMap(), // observed element → redraw()
    drawnWidth: new WeakMap(), // chart host → {w, measured} of its last drawing
    ro: null,
    rendered: new Map(), // turnId → {sig, el}
    emptyKey: null,
    port: null,
    reconnects: 0,
    timer: null,
    refreshing: null,
    again: false,
    clearArmed: null,
    spacesSeq: 0,
    stopped: false,
  };

  /* ---------------------------------------------------------------- helpers */

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

  const clean = (t, max = 400) => (errors ? errors.redact(V.safeText(t, max)) : V.safeText(t, max));

  function backgroundError(message) {
    return {
      code: 'UNKNOWN',
      title: 'Could not reach the extension background',
      steps: ['Close and reopen this panel. If it keeps happening, reload the extension from the browser\'s extensions page.'],
      details: { message: message || null },
    };
  }

  /** sendMessage that always resolves to {ok, data} | {ok:false, error}. */
  async function send(msg) {
    try {
      const res = await chromeApi.runtime.sendMessage(msg);
      if (res && typeof res === 'object' && typeof res.ok === 'boolean') return res;
      return { ok: false, error: backgroundError('No response') };
    } catch (e) {
      return { ok: false, error: backgroundError(e && e.message) };
    }
  }

  function errorParts(error) {
    const e = error && typeof error === 'object' ? error : {};
    const code = typeof e.code === 'string' && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : 'UNKNOWN';
    const cat = (errors && errors.CATALOG[code]) || { title: 'Something went wrong', steps: [] };
    const title = clean(e.title, 200) || cat.title;
    const steps = (Array.isArray(e.steps) ? e.steps : cat.steps).map((s) => clean(s)).filter(Boolean).slice(0, 3);
    return { code, title, steps };
  }

  function duration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  }

  const count = (n) => n.toLocaleString(LOCALE);
  const plural = (n, word) => count(n) + ' ' + word + (n === 1 ? '' : 's');

  function currentWorkspace() {
    return (ui.init && ui.init.workspaces.find((w) => w.origin === ui.origin)) || null;
  }

  function currentSpace() {
    return ui.spaces.find((s) => s.id === ui.spaceId) || null;
  }

  function threadBusy() {
    return Boolean(ui.thread && ui.thread.turns.some((t) => PHASES[t.phase] && PHASES[t.phase].live));
  }

  /* ---------------------------------------------------------------- notice */

  /**
   * @param {'error'|'warn'|'ok'|null} kind
   * @param {{title, steps?, actions?: [{label, primary?, onclick}]}} [content]
   */
  function setNotice(kind, content) {
    const box = $('notice');
    box.textContent = '';
    if (!kind || !content) {
      box.hidden = true;
      return;
    }
    const steps = (content.steps || []).filter(Boolean);
    const actions = (content.actions || []).map((a) => h('button', { type: 'button', class: 'dcc-btn dcc-btn--small' + (a.primary ? ' dcc-btn--primary' : ''), onclick: a.onclick, 'data-action': a.id || null }, a.label));
    box.appendChild(
      h('div', { class: 'dcc-alert dcc-alert--' + kind, role: kind === 'error' ? 'alert' : 'status' }, [
        h('p', { class: 'dcc-alert__title' }, content.title),
        steps.length === 1 ? h('p', { class: 'dcc-alert__body' }, steps[0]) : null,
        steps.length > 1 ? h('ul', { class: 'dcc-alert__steps' }, steps.map((s) => h('li', {}, s))) : null,
        actions.length ? h('div', { class: 'gp-notice-actions' }, actions) : null,
      ])
    );
    box.hidden = false;
  }

  function errorNotice(error, actions) {
    const p = errorParts(error);
    setNotice(p.code === 'GENIE_RATE_LIMITED' || p.code === 'GENIE_BUSY' ? 'warn' : 'error', { title: p.title, steps: p.steps, actions });
    return p;
  }

  function openOptions() {
    send({ type: 'page:open', page: 'options', anchor: 'connect' });
  }

  /** The workspace can't ask yet: explain why and offer the one next step. */
  function workspaceNotice(ws) {
    if (!ws || ws.status === 'ready') return false;
    if (ws.status === 'signin') {
      const p = errorParts({ code: 'GENIE_SIGNIN' });
      setNotice('warn', { title: p.title, steps: p.steps, actions: [{ id: 'signin', label: 'Allow Genie and run status', primary: true, onclick: onSignIn }] });
    } else if (ws.status === 'pat') {
      const p = errorParts({ code: 'GENIE_PAT_MISSING' });
      setNotice('warn', { title: p.title, steps: p.steps, actions: [{ id: 'options', label: 'Open Connection preferences', onclick: openOptions }] });
    } else {
      const p = errorParts({ code: ws.status === 'helper' ? 'GENIE_HELPER_MODE' : 'GENIE_AUTH_UNSUPPORTED' });
      setNotice('warn', { title: p.title, steps: p.steps, actions: [{ id: 'options', label: 'Open Connection preferences', onclick: openOptions }] });
    }
    return true;
  }

  /* ---------------------------------------------------------------- composer */

  /** A status message for the composer, or (idle) the keyboard hint, kept for screen readers only. */
  function setHint(text) {
    const hint = $('composer-hint');
    hint.textContent = '';
    hint.classList.toggle('dcc-visually-hidden', !text);
    if (text) {
      hint.textContent = text;
      return;
    }
    hint.append(h('kbd', {}, 'Enter'), ' sends · ', h('kbd', {}, 'Shift'), ' + ', h('kbd', {}, 'Enter'), ' adds a line');
  }

  function updateComposer() {
    const ready = !ui.blocked && Boolean(ui.origin && ui.spaceId);
    const busy = threadBusy();
    const input = $('question');
    input.disabled = !ready;
    $('send').disabled = !ready || busy || !input.value.trim();
    $('new-conv').disabled = !ready || !ui.thread;
    if (!ready) setHint(ui.origin && !ui.blocked ? 'Choose a Genie Agent to ask.' : '');
    else if (busy) setHint('Genie is answering. You can close this panel; the answer will be here when you come back.');
    else setHint('');
    for (const b of doc.querySelectorAll('[data-suggest]')) b.disabled = !ready || busy;
  }

  function autosize() {
    const input = $('question');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  async function ask(text) {
    const question = String(text || '').trim();
    if (!question || !ui.origin || !ui.spaceId) return;
    if (question.length > MAX_QUESTION) {
      setHint('Questions can be up to ' + count(MAX_QUESTION) + ' characters.');
      return;
    }
    const space = currentSpace();
    $('send').disabled = true;
    const r = await send({ type: 'genie:ask', origin: ui.origin, spaceId: ui.spaceId, spaceTitle: space ? space.title : '', question });
    if (!r.ok) {
      const code = r.error && r.error.code;
      if (code === 'GENIE_SIGNIN') {
        const ws = currentWorkspace();
        if (ws) ws.status = 'signin';
        workspaceNotice(ws);
      } else if (code === 'GENIE_BUSY') {
        setHint(errorParts(r.error).steps[0] || 'Genie is still answering.');
      } else {
        errorNotice(r.error);
      }
      updateComposer();
      return;
    }
    setNotice(null);
    const input = $('question');
    if (input.value.trim() === question) input.value = '';
    autosize();
    await refresh();
    scrollToEnd(true);
  }

  function onSubmit(ev) {
    ev.preventDefault();
    ask($('question').value);
  }

  function onKeyDown(ev) {
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing || ev.keyCode === 229) return;
    ev.preventDefault();
    const input = $('question');
    if (!input.disabled && !threadBusy() && input.value.trim()) ask(input.value);
  }

  /* ---------------------------------------------------------------- thread rendering */

  function nearBottom() {
    const t = $('thread');
    return t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  }

  function scrollToEnd(force) {
    const t = $('thread');
    if (force || nearBottom()) t.scrollTop = t.scrollHeight;
  }

  function emptyState() {
    const space = currentSpace();
    const demo = ui.init && ui.init.mode === 'demo';
    const name = space ? space.title : 'a Genie Agent';
    const starters = !demo || !space || /Unavailable/.test(space.title) ? [] : /Pipeline/.test(space.title) ? DEMO_STARTERS.ops : DEMO_STARTERS.revenue;
    return h('section', { class: 'gp-empty', 'aria-labelledby': 'empty-title' }, [
      h('p', { class: 'gp-section-label' }, demo ? 'Demo · synthetic answers' : 'New conversation'),
      h('h2', { id: 'empty-title' }, 'Ask ' + name),
      space && space.description ? h('p', { class: 'gp-empty-desc' }, space.description) : null,
      h('p', {}, demo ? 'Demo mode answers with canned, synthetic data and makes no Databricks requests.' : 'Your question goes only to your own workspace. Genie answers from the tables this agent covers and may run SQL on its warehouse.'),
      h('p', {}, 'You can close this panel while Genie works. The answer will be here when you come back.'),
      starters.length ? h('div', { class: 'gp-starters' }, starters.map((q) => h('button', { type: 'button', class: 'gp-chipbtn', 'data-suggest': '', onclick: () => ask(q) }, q))) : null,
    ]);
  }

  function statusLine(turn) {
    const p = PHASES[turn.phase] || PHASES.working;
    const parts = [h('span', { class: 'gp-chip gp-chip--' + turn.phase + (p.live ? ' gp-chip--live' : ''), 'data-phase': turn.phase }, p.label)];
    if (p.live) {
      parts.push(h('span', { class: 'gp-step' }, [(turn.step || p.step) + ' · ', h('span', { class: 'gp-elapsed', 'data-since': String(turn.askedAt) }, duration(Date.now() - turn.askedAt))]));
    } else if (turn.phase === 'done' && turn.finishedAt) {
      parts.push(h('span', { class: 'gp-step' }, 'in ' + duration(turn.finishedAt - turn.askedAt)));
    }
    return h('div', { class: 'gp-status' }, parts);
  }

  /* ---------------------------------------------------------------- resize */

  /** One ResizeObserver for every chart host and table scroller; window resize as a fallback. */
  function observe(el, redraw) {
    ui.redraw.set(el, redraw);
    if (ui.ro) ui.ro.observe(el);
  }

  function initResize() {
    if (typeof root.ResizeObserver === 'function') {
      ui.ro = new root.ResizeObserver((entries) => {
        for (const e of entries) {
          if (!e.target.isConnected) {
            ui.ro.unobserve(e.target);
            continue;
          }
          const fn = ui.redraw.get(e.target);
          if (fn) fn();
        }
      });
      return;
    }
    let pending = false;
    root.addEventListener('resize', () => {
      if (pending) return;
      pending = true;
      root.setTimeout(() => {
        pending = false;
        for (const el of doc.querySelectorAll('[data-observed]')) {
          const fn = ui.redraw.get(el);
          if (fn) fn();
        }
      }, 120);
    });
  }

  /* ---------------------------------------------------------------- result: table */

  function tableNode(model, title) {
    const P = model.columns;
    const head = h('tr', {}, P.map((p) => h('th', { scope: 'col', class: p.numeric ? 'num' : null, title: VIZ.headerTitle(p), 'data-col': p.name }, p.label)));
    const body = model.rows.map((row) =>
      h(
        'tr',
        {},
        P.map((p) => {
          const raw = row[p.index];
          const cls = [p.numeric ? 'num' : null, p.role === 'id' ? 'id' : null, p.kind === 'text' && raw && raw.length > 32 ? 'long' : null].filter(Boolean).join(' ') || null;
          const shown = VIZ.format(raw, p);
          if (shown === null) return h('td', { class: cls }, h('span', { class: 'gp-na' }, 'n/a'));
          return h('td', { class: cls, title: shown !== String(raw) ? String(raw) : null }, shown);
        })
      )
    );
    const wrap = h(
      'div',
      { class: 'gp-table-wrap', tabindex: '0', role: 'region', 'aria-label': (title || 'Result') + ', scrollable table', 'data-observed': '' },
      h('table', { class: 'dcc-table gp-table' }, [h('caption', { class: 'dcc-visually-hidden' }, title || 'Query result'), h('thead', {}, head), h('tbody', {}, body)])
    );
    const box = h('div', { class: 'gp-tablebox' }, wrap);
    // Edge cues: a fade on the side that has more columns to scroll to.
    const edges = () => {
      const max = wrap.scrollWidth - wrap.clientWidth;
      box.toggleAttribute('data-more-left', wrap.scrollLeft > 2);
      box.toggleAttribute('data-more-right', max - wrap.scrollLeft > 2);
    };
    wrap.addEventListener('scroll', edges, { passive: true });
    observe(wrap, edges);
    return box;
  }

  function resultCount(turn) {
    const t = turn.table;
    const q = turn.query || {};
    const counted = Number.isInteger(t.totalRows) ? 'Showing ' + count(t.shown) + ' of ' + plural(t.totalRows, 'row') : 'Showing the first ' + plural(t.shown, 'row');
    const extra = [];
    if (t.columnsHidden > 0) extra.push(plural(t.columnsHidden, 'more column') + ' not shown');
    if (t.serverTruncated || q.truncated) extra.push('Genie truncated this result');
    return h('p', { class: 'gp-count' }, [h('span', {}, counted), extra.length ? h('span', { class: 'gp-count-extra' }, extra.join(' · ')) : null]);
  }

  function resultFoot(turn) {
    return h('div', { class: 'gp-result-foot' }, resultCount(turn));
  }

  /* ---------------------------------------------------------------- result: chart, KPI */

  function viewState(turnId) {
    if (!ui.views.has(turnId)) ui.views.set(turnId, { view: 'chart', pick: 0 });
    return ui.views.get(turnId);
  }

  function segmented(turnId, chartLabel, value, onChange) {
    const name = 'view-' + turnId;
    const option = (val, label) => {
      const input = h('input', { type: 'radio', name, id: name + '-' + val, value: val, 'data-view-option': val });
      input.checked = value === val;
      input.addEventListener('change', () => {
        if (input.checked) onChange(val);
      });
      return [input, h('label', { for: name + '-' + val }, label)];
    };
    return h('div', { class: 'dcc-segmented gp-seg', role: 'radiogroup', 'aria-label': 'Show the result as' }, option('chart', chartLabel).concat(option('table', 'Table')));
  }

  function kpiNode(data) {
    const tiles = data.tiles.map((t) =>
      h('div', { class: 'gp-kpi', title: t.title }, [
        h('p', { class: 'gp-kpi-label' }, t.label),
        h('p', { class: 'gp-kpi-value' + (t.value === null ? ' gp-na' : '') }, t.value === null ? 'n/a' : t.value),
        t.exact ? h('p', { class: 'gp-kpi-exact' }, t.exact) : null,
      ])
    );
    const context = data.context.length ? h('dl', { class: 'gp-kpi-context' }, data.context.flatMap((c) => [h('dt', {}, c.label), h('dd', {}, c.value)])) : null;
    return h('div', { class: 'gp-kpis-wrap' }, [h('div', { class: 'gp-kpis', 'data-count': String(data.tiles.length) }, tiles), context]);
  }

  /** The chart host: draws at its own width, redraws when the width changes. */
  function chartNode(model, choice, st, caption) {
    const host = h('div', { class: 'gp-chart', 'data-observed': '' });
    let data = VIZ.build(model, choice, st.pick);
    const redraw = (force) => {
      const measured = host.clientWidth;
      // Hidden (Table view) or detached hosts keep their last drawing until they have a width.
      if (!force && (!host.isConnected || !measured)) return;
      const w = measured || CHART_FALLBACK_WIDTH;
      const prev = ui.drawnWidth.get(host);
      // A first drawing made while detached used estimated text widths: redraw it once attached.
      if (!force && prev && prev.measured && Math.abs(prev.w - w) < 4) return;
      ui.drawnWidth.set(host, { w, measured: host.isConnected });
      CHART.draw(doc, host, data, { width: w, caption });
    };
    observe(host, () => redraw(false));
    redraw(true);
    return {
      host,
      setPick(i) {
        st.pick = i;
        data = VIZ.build(model, choice, i);
        redraw(true);
      },
      redraw: () => redraw(true),
    };
  }

  function measurePicker(turnId, choice, st, onPick) {
    const id = 'measure-' + turnId;
    const sel = h('select', { id, class: 'gp-select gp-pick-select', 'data-measure': '' }, choice.measures.map((m, i) => h('option', { value: String(i), title: m.name }, m.label)));
    sel.value = String(Math.min(st.pick, choice.measures.length - 1));
    sel.addEventListener('change', () => onPick(Number(sel.value) || 0));
    return h('div', { class: 'gp-pick' }, [h('label', { for: id }, 'Measure'), h('span', { class: 'gp-quiet' }, sel)]);
  }

  function resultBody(turn, model) {
    const choice = VIZ.choose(model);
    const box = tableNode(model, turn.query.title);
    const out = [];
    if (choice.type === 'none') {
      out.push(h('div', { class: 'gp-view', 'data-view': 'table' }, box));
      out.push(resultFoot(turn));
      return { nodes: out, choice };
    }
    const st = viewState(turn.id);
    const visual = h('div', { class: 'gp-view', 'data-view': 'chart', 'data-chart-type': choice.type });
    const tableView = h('div', { class: 'gp-view', 'data-view': 'table' }, box);
    let chart = null;
    let picker = null;
    const ensureVisual = () => {
      if (visual.firstChild) return;
      if (choice.type === 'kpi') visual.appendChild(kpiNode(VIZ.build(model, choice)));
      else {
        chart = chartNode(model, choice, st, !picker);
        visual.appendChild(chart.host);
      }
    };
    const multiPick = (choice.type === 'bar' || (choice.type === 'line' && !choice.together)) && choice.measures.length > 1;
    if (multiPick) picker = measurePicker(turn.id, choice, st, (i) => chart && chart.setPick(i));
    const apply = () => {
      visual.hidden = st.view !== 'chart';
      tableView.hidden = st.view !== 'table';
      if (picker) picker.hidden = st.view !== 'chart';
      if (!visual.hidden) {
        ensureVisual();
        if (chart) root.setTimeout(() => chart.host.isConnected && ui.redraw.get(chart.host) && ui.redraw.get(chart.host)(), 0);
      }
    };
    const seg = segmented(turn.id, choice.type === 'kpi' ? 'Summary' : 'Chart', st.view, (v) => {
      st.view = v;
      apply();
    });
    out.push(h('div', { class: 'gp-viewbar' }, [seg, picker]));
    out.push(visual, tableView);
    apply();
    out.push(resultFoot(turn));
    return { nodes: out, choice };
  }

  /* ---------------------------------------------------------------- result: section, SQL */

  function sqlDisclosure(turn) {
    const sql = turn.query.sql;
    const pre = h('pre', { class: 'gp-code' + (ui.wrapSql.has(turn.id) ? ' is-wrapped' : ''), tabindex: '0', 'aria-label': 'Generated SQL' }, h('code', {}, sql));
    const wrapBtn = h('button', { type: 'button', class: 'dcc-btn dcc-btn--small dcc-btn--quiet', 'aria-pressed': ui.wrapSql.has(turn.id) ? 'true' : 'false', 'data-wrap': turn.id }, 'Wrap lines');
    wrapBtn.addEventListener('click', () => {
      const on = !ui.wrapSql.has(turn.id);
      if (on) ui.wrapSql.add(turn.id);
      else ui.wrapSql.delete(turn.id);
      pre.classList.toggle('is-wrapped', on);
      wrapBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const lines = sql.split('\n').length;
    const d = h('details', { class: 'gp-sql', 'data-sql': turn.id }, [
      h('summary', {}, [h('span', {}, 'Show SQL'), h('span', { class: 'gp-sql-meta' }, plural(lines, 'line'))]),
      h('div', { class: 'gp-sql-body' }, [
        h('div', { class: 'gp-sql-bar' }, [wrapBtn, h('button', { type: 'button', class: 'dcc-btn dcc-btn--small dcc-btn--quiet', 'data-copy-sql': turn.id, onclick: (ev) => copy(sql, ev.currentTarget, 'Copy SQL') }, 'Copy SQL')]),
        pre,
      ]),
    ]);
    if (ui.openSql.has(turn.id)) d.open = true;
    d.addEventListener('toggle', () => {
      if (d.open) ui.openSql.add(turn.id);
      else ui.openSql.delete(turn.id);
    });
    return d;
  }

  function resultSection(turn, model) {
    const q = turn.query;
    const titleId = 'rt-' + turn.id;
    const children = [h('header', { class: 'gp-result-head' }, [h('h3', { class: 'gp-result-title', id: titleId }, q.title || 'Query result'), q.description ? h('p', { class: 'gp-result-desc' }, q.description) : null])];
    const live = PHASES[turn.phase] && PHASES[turn.phase].live;
    const msg = (t, extra) => h('div', { class: 'gp-result-msg' }, [h('span', {}, t), extra || null]);
    if (live) children.push(msg('The query is running…'));
    else if (model) children.push(...resultBody(turn, model).nodes);
    else if (turn.tableState === 'loading') children.push(msg('Loading the result…'));
    else if (turn.tableState === 'expired') {
      children.push(msg('This result expired in Databricks.', q.canRerun ? h('button', { type: 'button', class: 'dcc-btn dcc-btn--small', 'data-rerun': turn.id, onclick: (ev) => onRerun(turn, ev.currentTarget) }, 'Run query again') : null));
    } else if (turn.tableState === 'trimmed') children.push(msg('The table was removed to keep this session small. Ask again to see it.'));
    else if (turn.tableState === 'ready') children.push(msg('The query returned no columns.'));
    else children.push(msg("The result table isn't available." + (turn.tableError ? ' ' + clean(turn.tableError, 200) : '')));
    if (q.sql) children.push(sqlDisclosure(turn));
    return h('section', { class: 'gp-result', 'aria-labelledby': titleId }, children);
  }

  function answerText(turn, model) {
    const parts = turn.texts.map((t) => t.content);
    if (model) parts.push(VIZ.toTsv(model));
    return parts.join('\n\n');
  }

  /** Brief confirmation on a button; a menu item closes its menu afterwards. */
  function flash(btn, textNow, label) {
    btn.textContent = textNow;
    root.setTimeout(() => {
      if (!btn.isConnected) return;
      btn.textContent = label;
      const menu = btn.closest('details.gp-menu');
      if (menu) menu.open = false;
    }, 1600);
  }

  const DOTS = () => {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true', focusable: 'false', fill: 'currentColor' })) svg.setAttribute(k, v);
    for (const cx of [3.5, 8, 12.5]) {
      const c = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(cx));
      c.setAttribute('cy', '8');
      c.setAttribute('r', '1.4');
      svg.appendChild(c);
    }
    return svg;
  };

  /** The answer's secondary actions, behind one quiet button. */
  function answerMenu(turn, model) {
    const items = [h('button', { type: 'button', class: 'gp-menu-item', 'data-copy': turn.id, onclick: (ev) => copy(answerText(turn, model), ev.currentTarget, 'Copy answer') }, 'Copy answer')];
    if (model) {
      items.push(h('button', { type: 'button', class: 'gp-menu-item', 'data-copy-table': turn.id, onclick: (ev) => copy(VIZ.toTsv(model), ev.currentTarget, 'Copy table') }, 'Copy table'));
      items.push(
        h('button', {
          type: 'button',
          class: 'gp-menu-item',
          'data-download': turn.id,
          onclick: (ev) => {
            const btn = ev.currentTarget;
            const ok = CSV.download(doc, btn.parentNode, (turn.query && turn.query.title) || 'genie-result', VIZ.toCsv(model));
            flash(btn, ok ? 'Downloaded' : "Can't download here", 'Download CSV');
          },
        }, 'Download CSV')
      );
    }
    return h('details', { class: 'gp-menu' }, [h('summary', { class: 'gp-menu-btn', 'aria-label': 'More actions for this answer', title: 'More actions' }, DOTS()), h('div', { class: 'gp-menu-list', role: 'group', 'aria-label': 'Answer actions' }, items)]);
  }

  async function copy(text, btn, label) {
    let ok = true;
    try {
      await root.navigator.clipboard.writeText(text);
    } catch (_) {
      ok = false;
    }
    flash(btn, ok ? 'Copied' : 'Copy failed', label);
  }

  function markdown(content) {
    const box = h('div', { class: 'gp-md gp-text' });
    box.appendChild(MD.render(doc, content));
    return box;
  }

  function renderTurn(turn, isLast) {
    const p = PHASES[turn.phase] || PHASES.working;
    const model = turn.query && turn.tableState === 'ready' && turn.table && turn.table.columns.length ? VIZ.profile(turn.table, { locale: LOCALE }) : null;
    const texts = turn.texts || [];
    const done = turn.phase === 'done' && (texts.length || turn.query);
    const answer = [h('div', { class: 'gp-answer-head' }, [statusLine(turn), done ? answerMenu(turn, model) : null])];
    if (turn.phase === 'failed' && turn.error) {
      const e = errorParts(turn.error);
      answer.push(
        h('div', { class: 'dcc-alert ' + (e.code === 'GENIE_RATE_LIMITED' ? 'dcc-alert--warn' : 'dcc-alert--error') }, [
          h('p', { class: 'dcc-alert__title' }, e.title),
          e.steps.length ? h('p', { class: 'dcc-alert__body' }, e.steps[0]) : null,
          turn.error.detail ? h('p', { class: 'gp-error-detail' }, 'Details: ' + clean(turn.error.detail, 300)) : null,
        ])
      );
      if (isLast) answer.push(h('div', { class: 'gp-actions' }, h('button', { type: 'button', class: 'dcc-btn dcc-btn--small', onclick: () => retry(turn.question) }, 'Ask again')));
    }
    for (const t of texts) answer.push(t.purpose === 'followUp' ? h('div', { class: 'gp-followup' }, [h('p', { class: 'gp-kicker' }, 'Genie asks'), markdown(t.content)]) : markdown(t.content));
    if (turn.query) answer.push(resultSection(turn, model));
    if (turn.phase === 'done' && !done) answer.push(h('p', { class: 'gp-none' }, "Genie didn't return an answer for this question. Try rephrasing it."));
    const parts = [h('p', { class: 'gp-q' }, turn.question), h('section', { class: 'gp-a gp-answer', 'aria-label': "Genie's answer" }, answer)];
    if (turn.phase === 'done' && isLast && (turn.suggested || []).length) {
      parts.push(
        h('div', { class: 'gp-suggest' }, [
          h('p', { class: 'gp-section-label', id: 'sg-' + turn.id }, 'Follow up'),
          h('div', { class: 'gp-suggest-list', role: 'group', 'aria-labelledby': 'sg-' + turn.id }, turn.suggested.map((q) => h('button', { type: 'button', class: 'gp-chipbtn', 'data-suggest': '', onclick: () => ask(q) }, q))),
        ])
      );
    }
    return h('article', { class: 'gp-turn', 'data-turn': turn.id, 'data-phase': turn.phase, 'aria-busy': p.live ? 'true' : 'false' }, parts);
  }

  function retry(question) {
    const input = $('question');
    input.value = question;
    autosize();
    input.focus();
    updateComposer();
  }

  function renderThread() {
    const box = $('thread');
    const thread = ui.thread;
    if (!thread || !thread.turns.length) {
      const key = JSON.stringify([ui.origin, ui.spaceId, ui.init && ui.init.mode, ui.blocked, (currentSpace() || {}).title || null]);
      if (ui.emptyKey !== key) {
        ui.emptyKey = key;
        ui.rendered.clear();
        box.replaceChildren(ui.origin && ui.spaceId && !ui.blocked ? emptyState() : '');
      }
      syncTimer();
      return;
    }
    ui.emptyKey = null;
    const follow = nearBottom();
    const keep = new Set();
    let prev = null;
    thread.turns.forEach((turn, i) => {
      const isLast = i === thread.turns.length - 1;
      const sig = JSON.stringify(turn) + (isLast ? '|last' : '');
      keep.add(turn.id);
      let entry = ui.rendered.get(turn.id);
      if (!entry || entry.sig !== sig) {
        const el = renderTurn(turn, isLast);
        if (entry && entry.el.parentNode === box) box.replaceChild(el, entry.el);
        entry = { sig, el };
        ui.rendered.set(turn.id, entry);
      }
      const want = prev ? prev.nextSibling : box.firstChild;
      if (entry.el !== want) box.insertBefore(entry.el, want);
      prev = entry.el;
    });
    for (const [id, entry] of ui.rendered) {
      if (!keep.has(id)) {
        entry.el.remove();
        ui.rendered.delete(id);
      }
    }
    for (const node of [...box.children]) if (![...ui.rendered.values()].some((e) => e.el === node)) node.remove();
    if (follow) scrollToEnd(true);
    syncTimer();
  }

  /** One-second local timer for elapsed times while something is in flight; no messages. */
  function syncTimer() {
    const live = threadBusy();
    if (live && !ui.timer) {
      ui.timer = root.setInterval(() => {
        for (const el of doc.querySelectorAll('.gp-elapsed[data-since]')) el.textContent = duration(Date.now() - Number(el.getAttribute('data-since')));
      }, 1000);
    } else if (!live && ui.timer) {
      root.clearInterval(ui.timer);
      ui.timer = null;
    }
  }

  /* ---------------------------------------------------------------- state */

  /** Re-read the current conversation; overlapping calls coalesce into one follow-up read. */
  function refresh() {
    if (ui.refreshing) {
      ui.again = true;
      return ui.refreshing;
    }
    ui.refreshing = (async () => {
      do {
        ui.again = false;
        if (!ui.origin || !ui.spaceId || ui.blocked) {
          ui.thread = null;
          break;
        }
        const origin = ui.origin;
        const spaceId = ui.spaceId;
        const r = await send({ type: 'genie:state', origin, spaceId });
        if (origin !== ui.origin || spaceId !== ui.spaceId) continue;
        if (!r.ok) {
          errorNotice(r.error);
          break;
        }
        ui.thread = r.data.thread;
        ui.rev = r.data.rev;
      } while (ui.again);
      renderThread();
      updateComposer();
    })().finally(() => {
      ui.refreshing = null;
    });
    return ui.refreshing;
  }

  function hostLabel(ws) {
    return ws.host + (STATUS_SUFFIX[ws.status] || '');
  }

  function renderWorkspaces() {
    const sel = $('ws');
    const list = (ui.init && ui.init.workspaces) || [];
    sel.replaceChildren(...(list.length ? list.map((w) => h('option', { value: w.origin }, hostLabel(w))) : [h('option', { value: '' }, 'No connected workspace')]));
    sel.value = ui.origin || '';
    sel.title = sel.selectedOptions && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : '';
    sel.disabled = list.length < 2;
    $('demo-chip').hidden = !(ui.init && ui.init.mode === 'demo');
  }

  function setSpaces(list, placeholder) {
    const sel = $('space');
    ui.spaces = list;
    if (!list.length) {
      sel.replaceChildren(h('option', { value: '' }, placeholder || 'No agents'));
      sel.disabled = true;
      return;
    }
    sel.replaceChildren(...list.map((s) => h('option', { value: s.id }, s.title)));
    sel.disabled = false;
  }

  async function selectSpace(spaceId, { remember = false } = {}) {
    ui.spaceId = spaceId || null;
    $('space').value = ui.spaceId || '';
    const space = currentSpace();
    $('space-desc').textContent = space && space.description ? space.description : '';
    $('space').title = space ? space.title + (space.description ? '\n' + space.description : '') : '';
    ui.thread = null;
    ui.rendered.clear();
    ui.emptyKey = null;
    $('thread').replaceChildren();
    if (remember && ui.spaceId) send({ type: 'genie:remember', origin: ui.origin, spaceId: ui.spaceId });
    updateComposer();
    await refresh();
  }

  async function loadSpaces({ refresh: force = false } = {}) {
    const seq = ++ui.spacesSeq;
    const origin = ui.origin;
    setSpaces([], 'Loading agents…');
    ui.spaceId = null;
    updateComposer();
    const r = await send({ type: 'genie:spaces', origin, refresh: force });
    if (seq !== ui.spacesSeq || origin !== ui.origin) return;
    if (!r.ok) {
      setSpaces([], 'Agents unavailable');
      ui.blocked = true;
      const code = r.error && r.error.code;
      if (code === 'GENIE_SIGNIN') {
        const ws = currentWorkspace();
        if (ws) ws.status = 'signin';
        renderWorkspaces();
        workspaceNotice(ws);
      } else {
        errorNotice(r.error, [{ id: 'retry', label: 'Try again', onclick: () => loadSpaces({ refresh: true }) }]);
      }
      await selectSpace(null);
      return;
    }
    const list = r.data.spaces || [];
    if (!list.length) {
      setSpaces([], 'No agents');
      ui.blocked = true;
      setNotice('warn', { title: 'No Genie Agents here yet', steps: ['Create one in Databricks (Genie), or ask a colleague to share one with you. Then select Try again.'], actions: [{ id: 'retry', label: 'Try again', onclick: () => loadSpaces({ refresh: true }) }] });
      await selectSpace(null);
      return;
    }
    ui.blocked = false;
    setNotice(null);
    setSpaces(list);
    const pick = list.some((s) => s.id === r.data.lastSpace) ? r.data.lastSpace : list[0].id;
    await selectSpace(pick);
    if (r.data.more) $('space-desc').textContent = ($('space-desc').textContent ? $('space-desc').textContent + ' ' : '') + '(Showing the first ' + list.length + ' agents.)';
  }

  async function selectOrigin(origin) {
    ui.origin = origin || null;
    renderWorkspaces();
    ui.blocked = true;
    setNotice(null);
    const ws = currentWorkspace();
    if (!ws) {
      setSpaces([], 'No agents');
      await selectSpace(null);
      return;
    }
    if (workspaceNotice(ws)) {
      setSpaces([], ws.status === 'signin' ? 'Allow Genie first' : 'Unavailable');
      await selectSpace(null);
      return;
    }
    await loadSpaces();
  }

  async function activeTabUrl() {
    try {
      const tabs = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
      const t = tabs && tabs[0];
      return t && typeof t.url === 'string' ? t.url : null;
    } catch (_) {
      return null;
    }
  }

  async function loadInit() {
    const r = await send({ type: 'genie:init', activeUrl: await activeTabUrl() });
    if (!r.ok || !r.data) {
      ui.init = { mode: null, workspaces: [] };
      renderWorkspaces();
      setSpaces([], 'Unavailable');
      errorNotice(r.error, [{ id: 'retry', label: 'Try again', onclick: start }]);
      return false;
    }
    ui.init = r.data;
    return true;
  }

  async function start() {
    if (!(await loadInit())) return;
    const d = ui.init;
    if (d.modeError) {
      ui.origin = null;
      renderWorkspaces();
      setSpaces([], 'Unavailable');
      const p = errorParts(d.modeError);
      setNotice('warn', { title: p.title, steps: p.steps });
      await selectSpace(null);
      return;
    }
    if (!d.workspaces.length) {
      ui.origin = null;
      renderWorkspaces();
      setSpaces([], 'No agents');
      setNotice('warn', { title: 'No connected workspace', steps: ['Open the extension popup on a Databricks workspace tab and select Connect. Or switch to Demo mode in the popup to try Genie with synthetic answers.'] });
      await selectSpace(null);
      return;
    }
    await selectOrigin(d.defaultOrigin || d.workspaces[0].origin);
  }

  /* ---------------------------------------------------------------- actions */

  async function onSignIn(ev) {
    const btn = ev && ev.currentTarget;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Waiting for Databricks…';
    }
    const r = await send({ type: 'genie:signIn', origin: ui.origin });
    if (!r.ok) {
      errorNotice(r.error, [{ id: 'signin', label: 'Allow Genie and run status', primary: true, onclick: onSignIn }]);
      return;
    }
    const ws = currentWorkspace();
    if (ws) ws.status = 'ready';
    await selectOrigin(ui.origin);
  }

  async function onNewConversation() {
    if (!ui.origin || !ui.spaceId) return;
    const r = await send({ type: 'genie:new', origin: ui.origin, spaceId: ui.spaceId });
    if (!r.ok) return errorNotice(r.error);
    ui.thread = r.data.thread;
    renderThread();
    updateComposer();
    $('question').focus();
  }

  async function onRerun(turn, btn) {
    btn.disabled = true;
    btn.textContent = 'Running…';
    const r = await send({ type: 'genie:rerunQuery', threadId: ui.thread && ui.thread.id, turnId: turn.id });
    if (!r.ok) errorNotice(r.error);
    await refresh();
  }

  async function onClear(ev) {
    const btn = ev.currentTarget;
    if (!ui.clearArmed) {
      btn.textContent = 'Select again to clear all conversations';
      ui.clearArmed = root.setTimeout(() => {
        ui.clearArmed = null;
        btn.textContent = 'Clear now';
      }, 4000);
      return;
    }
    root.clearTimeout(ui.clearArmed);
    ui.clearArmed = null;
    btn.textContent = 'Clear now';
    const r = await send({ type: 'genie:clear' });
    if (!r.ok) return errorNotice(r.error);
    ui.thread = null;
    ui.openSql.clear();
    ui.wrapSql.clear();
    ui.views.clear();
    await refresh();
  }

  /* ---------------------------------------------------------------- port */

  function connectPort() {
    if (ui.stopped || !chromeApi || !chromeApi.runtime || typeof chromeApi.runtime.connect !== 'function') return;
    let port;
    try {
      port = chromeApi.runtime.connect({ name: PORT_NAME });
    } catch (_) {
      return; // extension reloaded or removed: nothing to reconnect to
    }
    ui.port = port;
    port.onMessage.addListener((msg) => {
      ui.reconnects = 0;
      if (msg && msg.type === 'genie:changed' && msg.rev !== ui.rev) refresh();
    });
    port.onDisconnect.addListener(() => {
      ui.port = null;
      // The service worker restarted: reconnect so it knows the panel is open, then re-read.
      if (ui.stopped || ui.reconnects >= MAX_RECONNECTS) return;
      const wait = Math.min(1000 * Math.pow(2, ui.reconnects++), 15000);
      root.setTimeout(() => {
        connectPort();
        if (ui.port) refresh();
      }, wait);
    });
  }

  function wire() {
    $('composer').addEventListener('submit', onSubmit);
    const input = $('question');
    input.addEventListener('keydown', onKeyDown);
    input.addEventListener('input', () => {
      autosize();
      updateComposer();
    });
    $('ws').addEventListener('change', (ev) => selectOrigin(ev.currentTarget.value));
    $('space').addEventListener('change', (ev) => selectSpace(ev.currentTarget.value, { remember: true }));
    $('new-conv').addEventListener('click', onNewConversation);
    $('clear').addEventListener('click', onClear);
    // Answer menus: close on a click elsewhere or Escape (focus returns to the menu button).
    doc.addEventListener('click', (ev) => {
      for (const d of doc.querySelectorAll('details.gp-menu[open]')) if (!d.contains(ev.target)) d.open = false;
    });
    doc.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      for (const d of doc.querySelectorAll('details.gp-menu[open]')) {
        d.open = false;
        d.querySelector('summary').focus();
      }
    });
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'visible') refresh();
    });
  }

  function stop() {
    ui.stopped = true;
    if (ui.timer) root.clearInterval(ui.timer);
    ui.timer = null;
    if (ui.port) {
      try {
        ui.port.disconnect();
      } catch (_) {
        /* gone */
      }
    }
  }

  wire();
  initResize();
  connectPort();
  const ready = start().catch((e) => errorNotice(backgroundError(e && e.message)));
  (root.DCC || (root.DCC = {})).sidePanel = Object.freeze({ ready, refresh: () => refresh(), stop, state: () => ui });
})(typeof globalThis !== 'undefined' ? globalThis : this);
