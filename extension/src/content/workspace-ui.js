/*
 * Persistent workspace banner (shadow DOM). Compact, sticky, placed as the first child of the
 * native main container; survives SPA navigation and container replacement without
 * duplication or observer loops. States: loading, available, empty, partial, none, paused,
 * error, disconnected, unidentified, mismatch.
 *
 * Every re-render keeps keyboard focus on the equivalent control and keeps open <details>
 * open, so period changes and refreshes don't drop focus to the page.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const dom = dep('dom', './dom.js');
  const labels = dep('labels', '../core/labels.js');
  const periods = dep('periods', '../core/periods.js');
  const V = dep('validate', '../core/validate.js');

  const PERIODS = Object.freeze([7, 30, 90]);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Placement fight guard: if something keeps evicting the banner, stop re-inserting for a while
  // instead of fighting at scheduler rate forever.
  const FIGHT_WINDOW_MS = 10000;
  const FIGHT_LIMIT = 20;
  const BACKOFF_MIN_MS = 10000;
  const BACKOFF_MAX_MS = 120000;

  // Only `display` is inline (beats generic page rules such as `main > div {display:flex}`); a page
  // that deliberately hides the host with !important still can, and we leave that alone.
  const HOST_STYLE = 'display:block;';
  const EXPANDED_ATTR = 'data-dcc-expanded';

  // Box rules are !important inside the shadow tree, which outranks page rules (even !important
  // ones) for the host. Sticky only when there is room: on small viewports and while the Explorer
  // is open, the banner scrolls with the page instead of covering native controls.
  const CSS = `
:host { all: initial; display: block; }
:host { position: sticky !important; top: 0 !important; left: 0 !important; z-index: 20 !important; margin: 0 !important; padding: 0 !important;
  border: 0 !important; float: none !important; width: auto !important; max-width: 100% !important; min-width: 0 !important;
  box-sizing: border-box !important; grid-column: 1 / -1 !important; flex: none !important; align-self: stretch !important; transform: none !important; }
:host([${EXPANDED_ATTR}]) { position: relative !important; }
@media (max-width: 640px), (max-height: 500px) { :host { position: relative !important; } }
* { box-sizing: border-box; }
.wrap { container-type: inline-size; }
.bar { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #1f2933; background: #ffffff; border-bottom: 1px solid #d9dee3; padding: 6px 12px 4px; text-align: left; }
.bar:focus { outline: none; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.lead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; min-width: 0; }
.mark { width: 14px; height: 14px; flex: none; align-self: center; }
.amount { font-weight: 650; font-size: 15px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.qual { font-size: 12px; color: #52606d; }
.pill { font-size: 11px; font-weight: 600; letter-spacing: .02em; padding: 1px 6px; border-radius: 999px; border: 1px solid #0f766e; color: #0f766e; white-space: nowrap; }
.pill.warn { border-color: #9a6700; color: #7a5200; }
.meta { flex: 1 1 240px; min-width: 0; color: #52606d; font-size: 12px; overflow-wrap: anywhere; }
.change.up { color: #8a2d0a; } .change.down { color: #0f5f37; }
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-left: auto; }
.seg { display: inline-flex; }
.seg button { border-radius: 0; margin-left: -1px; }
.seg button:first-child { border-radius: 6px 0 0 6px; margin-left: 0; }
.seg button:last-child { border-radius: 0 6px 6px 0; }
.seg button:focus-visible { position: relative; z-index: 1; }
button { font: inherit; font-size: 12px; line-height: 1.2; color: #1f2933; background: #ffffff; border: 1px solid #c4ccd4; border-radius: 6px;
  padding: 3px 8px; margin: 0; cursor: pointer; min-height: 26px; min-width: 26px; }
button:hover { background: #f2f5f7; }
button[aria-pressed="true"] { background: #0f766e; border-color: #0f766e; color: #ffffff; font-weight: 650; }
button:focus:not(:focus-visible) { outline: none; }
button:focus-visible, summary:focus-visible { outline: 2px solid #0f766e; outline-offset: 2px; }
.link { border-color: transparent; background: none; color: #0f766e; text-decoration: underline; padding: 3px 4px; }
.link:hover { background: #f2f5f7; }
.disclaimer { margin: 2px 0 0; color: #616e7c; font-size: 11px; }
.note { margin: 4px 0 0; font-size: 12px; color: #3e4c59; }
.note.err { color: #8a1c1c; padding-left: 18px; }
.note.warn { color: #7a5200; }
.note button { margin-left: 4px; }
details { margin-top: 4px; font-size: 12px; color: #3e4c59; }
summary { cursor: pointer; color: #0f766e; width: fit-content; max-width: 100%; }
ul { margin: 4px 0; padding-left: 18px; }
code { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; background: #f2f5f7; padding: 0 3px; border-radius: 3px; overflow-wrap: anywhere; }
.panel { border-top: 1px solid #e4e7eb; margin-top: 6px; padding-top: 6px; max-height: 70vh; overflow: auto; }
table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
caption { text-align: left; font-weight: 600; padding: 2px 6px; }
th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid #eef1f4; }
th { color: #52606d; font-weight: 600; }
td.num, th.num { text-align: right; }
.skeleton { color: #7b8794; font-weight: 500; }
.sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@container (max-width: 640px) {
  .bar { padding: 6px 8px 4px; }
  .meta { flex-basis: 100%; order: 2; }
  .controls { order: 3; margin-left: 0; }
}
@container (max-width: 380px) {
  .amount { font-size: 14px; }
  .disclaimer { font-size: 10.5px; }
}
@media (forced-colors: active) {
  button[aria-pressed="true"] { forced-color-adjust: none; background: Highlight; color: HighlightText; border-color: Highlight; }
  button:focus-visible, summary:focus-visible { outline-color: Highlight; }
}
`;

  /** Defense in depth: errors are redacted by the service worker; never show token-like text. */
  const SCRUB = [
    [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
    [/\bdapi[0-9a-f]{32}(?:-\d+)?\b/gi, '[redacted]'],
    [/\b(?:dose|dkea|dsapi)[0-9a-f]{32}\b/gi, '[redacted]'],
    [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]'],
    [/((?:access_token|refresh_token|id_token|client_secret|token|password|secret|key)"?\s*[:=]\s*)"?[^"\s,}&]+"?/gi, '$1[redacted]'],
    [/\b[0-9a-f]{24}\b/gi, '[redacted]'],
    [/\b[A-Za-z0-9_+/=-]{48,}\b/g, '[redacted]'],
  ];

  function scrub(text, max) {
    let out = V.safeText(text, max || 600);
    for (const [re, rep] of SCRUB) out = out.replace(re, rep);
    return out;
  }

  function money(value, currency) {
    try {
      return labels.formatAmount(value, currency || 'USD');
    } catch (_) {
      return labels.isMissing(value) ? null : String(value) + ' ' + V.safeText(currency, 8);
    }
  }

  function basisKey(s) {
    if (!s) return null;
    if (s.synthetic || s.pricingBasis === 'demo') return 'demo';
    return s.pricingBasis || null;
  }

  function basisLabel(s) {
    const k = basisKey(s);
    if (!k) return '';
    return (labels.BASIS[k] || { short: V.safeText(k, 40) }).short;
  }

  function basisNote(s) {
    const b = labels.BASIS[basisKey(s)];
    return b ? b.note : '';
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  /**
   * @param {Document} doc
   * @param {object} cb callbacks: onPeriod(days), onRefresh(), onSettings(), onGuide(),
   *   onResume(), onConnect(), onToggle(expanded), renderPanel(panelEl, state) → optional
   *   cleanup function (or object with destroy()) called before that panel is discarded.
   * @param {{now?: () => number}} [opts]
   */
  function createBanner(doc, cb, opts) {
    const now = (opts && opts.now) || (() => Date.now());
    const host = doc.createElement('div');
    host.setAttribute('data-dcc', 'banner');
    host.style.cssText = HOST_STYLE;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    const wrap = doc.createElement('div');
    wrap.className = 'wrap';
    shadow.appendChild(wrap);
    const live = doc.createElement('div');
    live.className = 'sr';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    shadow.appendChild(live);

    let expanded = false;
    let lastState = null;
    let destroyed = false;
    // Explorer panel reuse: re-renders that don't change the summary keep the mounted panel.
    let panel = null;
    let panelKey = null;
    let panelCleanup = null;
    // Placement bookkeeping.
    const placeLog = [];
    let backoffMs = 0;
    let backoffUntil = 0;
    const counters = { placements: 0, duplicatesRemoved: 0, renders: 0 };

    const h = (tag, attrs, children) => dom.h(doc, tag, attrs, children);

    function mark() {
      const svg = doc.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'mark');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      for (const [x, y, w, hh, fill, rx] of [[0, 0, 16, 16, '#0f766e', 4], [3.5, 8.5, 2, 4, '#fff'], [7, 5.5, 2, 7, '#fff'], [10.5, 3.5, 2, 9, '#fff']]) {
        const r = doc.createElementNS(SVG_NS, 'rect');
        r.setAttribute('x', x);
        r.setAttribute('y', y);
        r.setAttribute('width', w);
        r.setAttribute('height', hh);
        r.setAttribute('fill', fill);
        if (rx) r.setAttribute('rx', rx);
        svg.appendChild(r);
      }
      return svg;
    }

    function periodControls(state) {
      const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Reporting period' });
      for (const d of PERIODS) {
        seg.appendChild(
          h('button', { type: 'button', 'data-k': 'period-' + d, 'aria-pressed': String(state.periodDays === d), title: 'Last ' + d + ' complete UTC days (today excluded)', onclick: () => cb.onPeriod(d) }, d + 'd')
        );
      }
      return seg;
    }

    function controls(state) {
      const showPeriod = ['loading', 'available', 'partial', 'none', 'empty', 'error'].includes(state.status);
      const expandable = canExpand(state);
      return h('div', { class: 'controls' }, [
        showPeriod ? periodControls(state) : null,
        showPeriod ? h('button', { type: 'button', 'data-k': 'refresh', onclick: () => cb.onRefresh(), 'aria-label': 'Refresh costs' }, 'Refresh') : null,
        h('button', { type: 'button', 'data-k': 'settings', onclick: () => cb.onSettings() }, 'Settings'),
        h('button', { type: 'button', 'data-k': 'guide', class: 'link', onclick: () => cb.onGuide() }, 'How costs work'),
        expandable
          ? h('button', { type: 'button', 'data-k': 'toggle', 'aria-expanded': String(expanded), 'aria-controls': expanded ? 'dcc-panel' : null, onclick: toggle }, expanded ? 'Collapse' : 'Explore')
          : null,
      ]);
    }

    function canExpand(state) {
      const s = state && state.summary;
      return Boolean(state && ['available', 'partial', 'none'].includes(state.status) && s && !s.noImport && !s.unavailableInMode);
    }

    function toggle() {
      expanded = !expanded;
      if (cb.onToggle) cb.onToggle(expanded);
      render(lastState);
    }

    function emptyText(s) {
      if (s && s.noImport) return 'No imported summary for this workspace and period';
      if (s && s.unavailableInMode) return 'Workspace totals are not available in ' + V.safeText(s.unavailableInMode, 20) + ' mode';
      return 'No usage recorded in this period';
    }

    /** One-line headline for the state; also what the live region announces. */
    function headline(state) {
      const s = state.summary;
      switch (state.status) {
        case 'loading':
          return 'Loading costs…';
        case 'available': {
          const amt = money(s.currentAmount, s.currency);
          return amt === null ? 'Amount unavailable' : amt;
        }
        case 'partial': {
          const amt = money(s.currentAmount, s.currency);
          return amt === null ? 'Priced subtotal unavailable' : amt;
        }
        case 'none':
          return 'No priced usage';
        case 'empty':
          return emptyText(s);
        case 'paused':
          return 'Cost display paused';
        case 'disconnected':
          return 'Cost Companion is not connected to this workspace';
        case 'unidentified':
          return state.conflict ? 'Conflicting workspace IDs in this URL' : 'Workspace ID not identified';
        case 'mismatch':
          return (state.error && V.safeText(state.error.title, 160)) || 'This page belongs to a different workspace';
        default:
          return (state.error && V.safeText(state.error.title, 160)) || 'Costs unavailable';
      }
    }

    function announcement(state) {
      const text = headline(state);
      if (state.status === 'available') return 'Estimated cost ' + text + ' for the last ' + state.periodDays + ' days';
      if (state.status === 'partial') return 'Priced subtotal ' + text + ' for the last ' + state.periodDays + ' days; some usage is unpriced';
      return text;
    }

    function lead(state) {
      const s = state.summary;
      const parts = [mark()];
      const text = headline(state);
      switch (state.status) {
        case 'loading':
          parts.push(h('span', { class: 'amount skeleton' }, text));
          break;
        case 'available':
          parts.push(h('span', { class: 'amount' }, text), h('span', { class: 'qual' }, labels.KIND.recorded));
          break;
        case 'partial':
          parts.push(h('span', { class: 'qual' }, 'Priced subtotal'), h('span', { class: 'amount' }, text));
          break;
        default:
          parts.push(h('span', { class: 'amount' }, text));
      }
      if (s && basisKey(s) === 'demo') parts.push(h('span', { class: 'pill' }, 'DEMO'));
      if (s && basisKey(s) === 'import') parts.push(h('span', { class: 'pill' }, 'Imported'));
      if (state.status === 'partial') parts.push(h('span', { class: 'pill warn' }, 'Some usage unpriced'));
      return h('div', { class: 'lead' }, parts);
    }

    function periodText(state) {
      const s = state.summary;
      if (s && s.period && V.isPeriodDays(s.period.days)) {
        try {
          return 'Last ' + s.period.days + ' days · ' + periods.periodLabel(s.period.start, s.period.endExclusive);
        } catch (_) {
          /* malformed dates: fall through to the generic label */
        }
      }
      if (s && basisKey(s) === 'import') {
        return 'Last ' + state.periodDays + ' days (imported)' + (typeof s.coverageEnd === 'string' && s.coverageEnd ? ' · through ' + V.safeText(s.coverageEnd, 10) : '');
      }
      try {
        const p = periods.completePeriod(state.periodDays, state.nowMs || now());
        return 'Last ' + state.periodDays + ' days · ' + periods.periodLabel(p.start, p.endExclusive);
      } catch (_) {
        return '';
      }
    }

    function comparison(s) {
      const ch = labels.formatChange(s.currentAmount, s.previousAmount);
      const partial = (s.current && s.current.coverage === 'partial') || (s.previous && s.previous.coverage === 'partial');
      return ch.pct !== null && partial ? ch.text + ' (priced subtotals)' : ch.text;
    }

    function meta(state) {
      const s = state.summary;
      if (!s || !['available', 'partial', 'none', 'empty'].includes(state.status)) return null;
      const bits = [periodText(state)];
      if (state.status === 'available' || state.status === 'partial') bits.push(comparison(s));
      if (s.latestUsageMs !== undefined && !s.noImport && !s.unavailableInMode) bits.push(periods.ageLabel(s.latestUsageMs, state.nowMs || now()));
      bits.push(basisLabel(s));
      return h('span', { class: 'meta', title: basisNote(s) || null }, bits.filter(Boolean).join(' · '));
    }

    function unpricedDetails(state) {
      const s = state.summary;
      const c = (s && s.current) || {};
      const n = Number.isFinite(c.unpricedRecords) ? c.unpricedRecords : null;
      const skus = Array.isArray(c.unpricedSkus) ? c.unpricedSkus.map((x) => V.safeText(x, 80)) : [];
      const first = c.firstUnpricedDate ? V.safeText(c.firstUnpricedDate, 10) : null;
      const last = c.lastUnpricedDate ? V.safeText(c.lastUnpricedDate, 10) : null;
      const shortSkus = skus.length > 3 ? skus.slice(0, 3).join(', ') + ' +' + (skus.length - 3) + ' more' : skus.join(', ');
      const line = [
        (n === null ? 'Some usage records' : plural(n, 'usage record')) + ' without a matching price',
        skus.length ? 'SKUs: ' + shortSkus : null,
        first || last ? 'UTC dates ' + (first || '?') + ' to ' + (last || '?') : null,
      ].filter(Boolean);
      return h('div', {}, [
        h('p', { class: 'note warn' }, line.join(' · ') + (state.status === 'partial' ? ' — full total withheld.' : ' — no subtotal shown.')),
        h('details', { 'data-k': 'unpriced' }, [
          h('summary', {}, 'About unpriced usage'),
          h('ul', {}, [
            h('li', {}, 'Affected SKUs: ' + (skus.length ? skus.join(', ') : 'not reported')),
            h('li', {}, 'First/last affected usage date (UTC): ' + (first || '—') + ' / ' + (last || '—')),
            c.ambiguousRecords ? h('li', {}, plural(c.ambiguousRecords, 'record') + ' matched more than one price row and were left unpriced.') : null,
            state.status === 'partial' ? h('li', {}, 'The priced subtotal includes signed corrections, so it is not necessarily a lower bound of the full total.') : null,
            h('li', {}, 'Prices come from ' + (s && s.priceTable ? V.safeText(s.priceTable, 80) : 'the selected price table') + '; no fallback to another price source is used.'),
          ]),
        ]),
      ]);
    }

    function technical(items) {
      return h('details', { 'data-k': 'technical' }, [h('summary', {}, 'Technical details'), h('ul', {}, items)]);
    }

    function errorDetails(state) {
      const e = state.error || {};
      const d = e.details && typeof e.details === 'object' ? e.details : {};
      const statementId = typeof d.statementId === 'string' && V.isStatementId(d.statementId.toLowerCase()) ? d.statementId.toLowerCase() : null;
      const steps = Array.isArray(e.steps) ? e.steps : [];
      return h('div', {}, [
        steps.length ? h('ul', { class: 'note err' }, steps.slice(0, 6).map((step) => h('li', {}, V.safeText(step, 400)))) : null,
        technical([
          h('li', {}, ['Code: ', h('code', {}, /^[A-Z_]{1,40}$/.test(String(e.code || '')) ? e.code : 'UNKNOWN')]),
          d.errorCode ? h('li', {}, ['SQL error code: ', h('code', {}, scrub(d.errorCode, 80))]) : null,
          d.sqlState && /^[0-9A-Z]{5}$/.test(d.sqlState) ? h('li', {}, ['SQL state: ', h('code', {}, d.sqlState)]) : null,
          statementId ? h('li', {}, ['Statement ID: ', h('code', {}, statementId)]) : null,
          Number.isInteger(d.httpStatus) ? h('li', {}, 'HTTP status: ' + d.httpStatus) : null,
          d.message ? h('li', {}, scrub(d.message, 600)) : null,
        ]),
      ]);
    }

    function details(state) {
      const s = state.summary;
      switch (state.status) {
        case 'partial':
        case 'none':
          return unpricedDetails(state);
        case 'error':
          return errorDetails(state);
        case 'mismatch': {
          const steps = (state.error && Array.isArray(state.error.steps) && state.error.steps) || [];
          return h('div', {}, [
            steps.length ? h('ul', { class: 'note err' }, steps.slice(0, 4).map((step) => h('li', {}, V.safeText(step, 400)))) : null,
            state.pageWorkspaceId || state.connectedWorkspaceId
              ? technical([
                  state.pageWorkspaceId ? h('li', {}, ['This page: workspace ', h('code', {}, V.safeText(state.pageWorkspaceId, 20))]) : null,
                  state.connectedWorkspaceId ? h('li', {}, ['Saved connection: workspace ', h('code', {}, V.safeText(state.connectedWorkspaceId, 20))]) : null,
                ])
              : null,
          ]);
        }
        case 'paused':
          return h('p', { class: 'note' }, ['New cost requests are paused. Workspace colors stay active.', h('button', { type: 'button', 'data-k': 'resume', onclick: () => cb.onResume() }, 'Resume')]);
        case 'disconnected':
          return h('p', { class: 'note' }, [
            'Connect with read-only SQL access to see estimated costs, or switch to Demo mode in the extension popup.',
            h('button', { type: 'button', 'data-k': 'connect', onclick: () => cb.onConnect() }, 'Connect'),
          ]);
        case 'unidentified':
          return h(
            'p',
            { class: 'note' },
            state.conflict
              ? 'This URL contains conflicting workspace IDs. Open the workspace from its home page, or choose the workspace in Connection preferences.'
              : 'Open any workspace page whose URL includes ?o=<workspace ID>, or choose the workspace in Connection preferences.'
          );
        case 'available':
          if (s && s.freeQuantity && Object.keys(s.freeQuantity).length) {
            const free = Object.entries(s.freeQuantity)
              .map(([k, v]) => V.safeText(k, 80) + ' ' + (labels.formatQuantity(v) || '—'))
              .join(', ');
            return h('p', { class: 'note' }, 'Free usage (not charged): ' + free);
          }
          return null;
        default:
          return null;
      }
    }

    function panelKeyFor(state) {
      return [state.summary, state.status, state.periodDays];
    }

    function samePanelKey(a, b) {
      return Boolean(a && b && a.length === b.length && a.every((v, i) => v === b[i]));
    }

    function dropPanel() {
      if (panelCleanup) {
        try {
          panelCleanup();
        } catch (_) {
          /* explorer cleanup failures must not break the banner */
        }
      }
      panel = null;
      panelKey = null;
      panelCleanup = null;
    }

    function buildPanel(state) {
      const key = panelKeyFor(state);
      if (panel && samePanelKey(key, panelKey)) return panel;
      dropPanel();
      panel = h('div', { class: 'panel', id: 'dcc-panel', role: 'region', 'aria-label': 'Cost explorer' });
      panelKey = key;
      if (cb.renderPanel) {
        try {
          const ret = cb.renderPanel(panel, state);
          if (typeof ret === 'function') panelCleanup = ret;
          else if (ret && typeof ret.destroy === 'function') panelCleanup = () => ret.destroy();
        } catch (_) {
          panel.textContent = '';
          panel.appendChild(h('p', { class: 'note err' }, 'The cost explorer could not be shown. Select Refresh to try again.'));
        }
      }
      return panel;
    }

    function render(state) {
      if (!state || destroyed) return;
      lastState = state;
      counters.renders++;
      // Remember focus and open disclosures so the rebuilt DOM looks continuous.
      const active = shadow.activeElement;
      const focusKey = active && active.getAttribute ? active.getAttribute('data-k') : null;
      const hadFocus = Boolean(active);
      const openKeys = new Set([...wrap.querySelectorAll('details[open][data-k]')].map((d) => d.getAttribute('data-k')));

      const bar = h('div', { class: 'bar', role: 'region', tabindex: '-1', 'aria-label': 'Estimated Databricks costs', 'aria-busy': String(state.status === 'loading') }, [
        h('div', { class: 'row' }, [lead(state), meta(state), controls(state)]),
        details(state),
        state.notice ? h('p', { class: 'note warn' }, V.safeText(state.notice, 300)) : null,
        h('p', { class: 'disclaimer' }, labels.DISCLAIMER),
      ]);
      for (const d of bar.querySelectorAll('details[data-k]')) if (openKeys.has(d.getAttribute('data-k'))) d.open = true;

      // Expansion is a sticky preference: a reload (loading state) doesn't reset it, the panel
      // simply returns when a summary is available again.
      const showPanel = expanded && canExpand(state);
      if (showPanel) bar.appendChild(buildPanel(state));
      else dropPanel();
      // An expanded explorer scrolls with the page instead of covering native controls.
      if (showPanel !== host.hasAttribute(EXPANDED_ATTR)) host.toggleAttribute(EXPANDED_ATTR, showPanel);

      wrap.replaceChildren(bar);

      const said = announcement(state);
      if (live.textContent !== said) live.textContent = said;

      if (hadFocus) {
        // A control inside a reused explorer panel keeps focus; otherwise the equivalent
        // rebuilt control (same data-k), else the banner region itself.
        const target = active.isConnected ? active : (focusKey && bar.querySelector('[data-k="' + focusKey + '"]')) || bar;
        try {
          if (shadow.activeElement !== target) target.focus({ preventScroll: true });
        } catch (_) {
          /* focus is best effort */
        }
      }
    }

    function prune(t) {
      while (placeLog.length && t - placeLog[0] > FIGHT_WINDOW_MS) placeLog.shift();
    }

    /**
     * Make the host the first element child of `container`. No DOM write when it already is,
     * even if the page hid it, so our own insertion never feeds an observer loop. Removes any
     * other banner host (e.g. from an orphaned earlier injection). If something keeps evicting
     * the banner (≥ FIGHT_LIMIT placements in FIGHT_WINDOW_MS), placement backs off.
     * @returns {boolean} true when the host is in place
     */
    function ensurePlaced(container) {
      if (destroyed) return false;
      for (const other of doc.querySelectorAll('[data-dcc="banner"]')) {
        if (other !== host) {
          other.remove();
          counters.duplicatesRemoved++;
        }
      }
      if (!container) return false;
      if (host.parentNode === container && container.firstElementChild === host) return true;
      const t = now();
      if (t < backoffUntil) return false;
      prune(t);
      if (!placeLog.length) backoffMs = 0;
      if (placeLog.length >= FIGHT_LIMIT) {
        backoffMs = Math.min(backoffMs ? backoffMs * 2 : BACKOFF_MIN_MS, BACKOFF_MAX_MS);
        backoffUntil = t + backoffMs;
        placeLog.length = 0;
        return false;
      }
      placeLog.push(t);
      const first = container.firstElementChild;
      container.insertBefore(host, first && first !== host ? first : container.firstChild);
      counters.placements++;
      return true;
    }

    function backoffRemaining() {
      return Math.max(0, backoffUntil - now());
    }

    function destroy() {
      destroyed = true;
      dropPanel();
      host.remove();
    }

    return {
      host,
      shadow,
      render,
      ensurePlaced,
      destroy,
      backoffRemaining,
      isExpanded: () => expanded,
      getState: () => lastState,
      stats: () => Object.assign({}, counters),
    };
  }

  /** Map a summary response ({ok,data}|{ok:false,error}) into a banner status. */
  function statusFor(res) {
    if (!res || res.stale) return { status: 'loading' };
    if (!res.ok) {
      const error = res.error && typeof res.error === 'object' ? res.error : { code: 'UNKNOWN' };
      if (error.code === 'NOT_CONNECTED') return { status: 'disconnected', error };
      if (error.code === 'WORKSPACE_MISMATCH') return { status: 'mismatch', error };
      return { status: 'error', error };
    }
    const s = res.data;
    if (!s || typeof s !== 'object') return { status: 'error', error: { code: 'UNKNOWN', title: 'Costs unavailable', steps: ['Select Refresh.'] } };
    if (s.paused) return { status: 'paused' };
    if (s.unavailableInMode) return { status: 'empty', summary: s };
    const coverage = s.current && s.current.coverage;
    const status = { complete: 'available', partial: 'partial', none: 'none', empty: 'empty' }[coverage] || 'empty';
    return { status, summary: s };
  }

  const api = Object.freeze({ createBanner, statusFor, CSS, HOST_STYLE, PERIODS, scrub });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).workspaceUi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
