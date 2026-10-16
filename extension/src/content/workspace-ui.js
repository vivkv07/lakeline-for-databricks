/*
 * Persistent workspace banner (shadow DOM). Compact, sticky, placed as the first child of the
 * native main container; survives SPA navigation and container replacement without
 * duplication or observer loops. States: loading, available, empty, partial, none, paused,
 * error, disconnected, unidentified.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const dom = dep('dom', './dom.js');
  const labels = dep('labels', '../core/labels.js');
  const periods = dep('periods', '../core/periods.js');

  const CSS = `
:host { all: initial; display: block; position: sticky; top: 0; z-index: 20; }
* { box-sizing: border-box; }
.bar { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #1f2933; background: #ffffff; border-bottom: 1px solid #d9dee3; padding: 6px 12px 4px; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.lead { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.mark { width: 14px; height: 14px; flex: none; align-self: center; }
.amount { font-weight: 650; font-size: 15px; font-variant-numeric: tabular-nums; }
.qual { font-size: 12px; color: #52606d; }
.pill { font-size: 11px; font-weight: 600; letter-spacing: .02em; padding: 1px 6px; border-radius: 999px; border: 1px solid #0f766e; color: #0f766e; }
.pill.warn { border-color: #9a6700; color: #7a5200; }
.meta { color: #52606d; font-size: 12px; min-width: 0; }
.change.up { color: #8a2d0a; } .change.down { color: #0f5f37; }
.spacer { flex: 1 1 auto; }
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.seg { display: inline-flex; border: 1px solid #c4ccd4; border-radius: 6px; overflow: hidden; }
.seg button { border: 0; border-right: 1px solid #c4ccd4; border-radius: 0; }
.seg button:last-child { border-right: 0; }
button { font: inherit; font-size: 12px; color: #1f2933; background: #fff; border: 1px solid #c4ccd4; border-radius: 6px; padding: 2px 8px; cursor: pointer; min-height: 24px; }
button:hover { background: #f2f5f7; }
button[aria-pressed="true"] { background: #0f766e; color: #fff; }
button:focus-visible, summary:focus-visible, a:focus-visible { outline: 2px solid #0f766e; outline-offset: 2px; }
.link { border: 0; background: none; color: #0f766e; text-decoration: underline; padding: 2px 4px; }
.disclaimer { margin: 2px 0 0; color: #616e7c; font-size: 11px; }
.note { margin: 4px 0 0; font-size: 12px; color: #3e4c59; }
.note.err { color: #8a1c1c; }
details { margin-top: 4px; font-size: 12px; color: #3e4c59; }
summary { cursor: pointer; color: #0f766e; }
ul { margin: 4px 0; padding-left: 18px; }
code { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; background: #f2f5f7; padding: 0 3px; border-radius: 3px; }
.panel { border-top: 1px solid #e4e7eb; margin-top: 6px; padding-top: 6px; max-height: 70vh; overflow: auto; }
table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid #eef1f4; }
th { color: #52606d; font-weight: 600; }
td.num, th.num { text-align: right; }
.skeleton { color: #7b8794; }
@media (max-width: 720px) { .meta { flex-basis: 100%; } }
`;

  const MARK_SVG = '<svg class="mark" viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" rx="4" fill="#0f766e"/><rect x="3.5" y="8.5" width="2" height="4" fill="#fff"/><rect x="7" y="5.5" width="2" height="7" fill="#fff"/><rect x="10.5" y="3.5" width="2" height="9" fill="#fff"/></svg>';

  function basisLabel(s) {
    if (!s) return '';
    if (s.synthetic || s.pricingBasis === 'demo') return labels.BASIS.demo.short;
    return (labels.BASIS[s.pricingBasis] || { short: s.pricingBasis }).short;
  }

  function basisNote(s) {
    if (!s) return '';
    const b = labels.BASIS[s.synthetic ? 'demo' : s.pricingBasis];
    return b ? b.note : '';
  }

  /**
   * @param {Document} doc
   * @param {object} cb callbacks: onPeriod(days), onRefresh(), onSettings(), onGuide(),
   *   onResume(), onConnect(), onToggle(expanded), renderPanel(panelEl, state)
   */
  function createBanner(doc, cb) {
    const host = doc.createElement('div');
    host.setAttribute('data-dcc', 'banner');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    const wrap = doc.createElement('div');
    shadow.appendChild(wrap);
    let expanded = false;
    let lastState = null;
    const h = (tag, attrs, children) => dom.h(doc, tag, attrs, children);

    function mark() {
      const span = doc.createElement('span');
      // Static, extension-authored SVG markup (no page or remote data).
      span.innerHTML = MARK_SVG;
      return span.firstChild;
    }

    function periodControls(state) {
      const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Reporting period' });
      for (const d of [7, 30, 90]) {
        seg.appendChild(h('button', { type: 'button', 'aria-pressed': String(state.periodDays === d), title: 'Last ' + d + ' complete UTC days', onclick: () => cb.onPeriod(d) }, d + 'd'));
      }
      return seg;
    }

    function controls(state) {
      const showPeriod = !['paused', 'disconnected', 'unidentified'].includes(state.status);
      return h('div', { class: 'controls' }, [
        showPeriod ? periodControls(state) : null,
        showPeriod ? h('button', { type: 'button', onclick: () => cb.onRefresh(), 'aria-label': 'Refresh costs' }, 'Refresh') : null,
        h('button', { type: 'button', onclick: () => cb.onSettings() }, 'Settings'),
        h('button', { type: 'button', class: 'link', onclick: () => cb.onGuide() }, 'How costs work'),
        canExpand(state) ? h('button', { type: 'button', 'aria-expanded': String(expanded), 'aria-controls': 'dcc-panel', onclick: toggle }, expanded ? 'Collapse' : 'Explore') : null,
      ]);
    }

    function canExpand(state) {
      return ['available', 'partial', 'none'].includes(state.status) && state.summary && !state.summary.noImport;
    }

    function toggle() {
      expanded = !expanded;
      if (cb.onToggle) cb.onToggle(expanded);
      render(lastState);
    }

    function lead(state) {
      const s = state.summary;
      const parts = [mark()];
      switch (state.status) {
        case 'loading':
          parts.push(h('span', { class: 'amount skeleton', 'aria-live': 'polite' }, 'Loading costs…'));
          break;
        case 'available':
          parts.push(h('span', { class: 'amount', 'aria-live': 'polite' }, labels.formatAmount(s.currentAmount, s.currency || 'USD')), h('span', { class: 'qual' }, 'est.'));
          break;
        case 'partial':
          parts.push(h('span', { class: 'qual' }, 'Priced subtotal'), h('span', { class: 'amount', 'aria-live': 'polite' }, labels.formatAmount(s.currentAmount, s.currency || 'USD')));
          break;
        case 'none':
          parts.push(h('span', { class: 'amount' }, 'No priced usage'));
          break;
        case 'empty':
          parts.push(h('span', { class: 'amount' }, s && s.noImport ? 'No imported summary for this workspace and period' : 'No usage recorded in this period'));
          break;
        case 'paused':
          parts.push(h('span', { class: 'amount' }, 'Cost display paused'));
          break;
        case 'disconnected':
          parts.push(h('span', { class: 'amount' }, 'Cost Companion is not connected to this workspace'));
          break;
        case 'unidentified':
          parts.push(h('span', { class: 'amount' }, 'Workspace ID not identified'));
          break;
        default:
          parts.push(h('span', { class: 'amount' }, (state.error && state.error.title) || 'Costs unavailable'));
      }
      if (s && (s.synthetic || s.pricingBasis === 'demo')) parts.push(h('span', { class: 'pill' }, 'DEMO'));
      if (s && s.pricingBasis === 'import') parts.push(h('span', { class: 'pill' }, 'Imported'));
      if (state.status === 'partial') parts.push(h('span', { class: 'pill warn' }, 'Some usage unpriced'));
      return h('div', { class: 'lead' }, parts);
    }

    function meta(state) {
      const s = state.summary;
      if (!s || !['available', 'partial', 'none', 'empty'].includes(state.status)) return null;
      const bits = [];
      if (s.period) bits.push('Last ' + s.period.days + ' days · ' + periods.periodLabel(s.period.start, s.period.endExclusive));
      if (state.status === 'available' || state.status === 'partial') {
        const ch = labels.formatChange(s.currentAmount, s.previousAmount);
        bits.push(ch.text);
      }
      if (s.latestUsageMs !== undefined) bits.push(periods.ageLabel(s.latestUsageMs, state.nowMs || Date.now()));
      bits.push(basisLabel(s));
      return h('span', { class: 'meta', title: basisNote(s) }, bits.join(' · '));
    }

    function details(state) {
      const s = state.summary;
      if (state.status === 'partial' || state.status === 'none') {
        const c = s.current;
        return h('details', {}, [
          h('summary', {}, c.unpricedRecords + ' usage record' + (c.unpricedRecords === 1 ? '' : 's') + ' without a matching price — ' + (state.status === 'partial' ? 'full total withheld' : 'no subtotal shown')),
          h('ul', {}, [
            h('li', {}, 'Affected SKUs: ' + c.unpricedSkus.join(', ')),
            h('li', {}, 'First/last affected usage date (UTC): ' + c.firstUnpricedDate + ' / ' + c.lastUnpricedDate),
            c.ambiguousRecords ? h('li', {}, c.ambiguousRecords + ' record(s) matched more than one price row and were left unpriced.') : null,
            h('li', {}, 'The priced subtotal includes signed corrections, so it is not necessarily a lower bound of the full total.'),
            h('li', {}, 'Prices come from ' + (s.priceTable || 'the selected price table') + '; no fallback to another price source is used.'),
          ]),
        ]);
      }
      if (state.status === 'error' && state.error) {
        const e = state.error;
        const d = e.details || {};
        return h('div', {}, [
          h('ul', { class: 'note err' }, (e.steps || []).map((step) => h('li', {}, step))),
          h('details', {}, [
            h('summary', {}, 'Technical details'),
            h('ul', {}, [
              h('li', {}, ['Code: ', h('code', {}, e.code || 'UNKNOWN')]),
              d.errorCode ? h('li', {}, ['SQL error: ', h('code', {}, d.errorCode)]) : null,
              d.statementId ? h('li', {}, ['Statement ID: ', h('code', {}, d.statementId)]) : null,
              d.httpStatus ? h('li', {}, 'HTTP ' + d.httpStatus) : null,
              d.message ? h('li', {}, d.message) : null,
            ]),
          ]),
        ]);
      }
      if (state.status === 'paused') {
        return h('p', { class: 'note' }, ['New cost requests are paused. Workspace colors stay active. ', h('button', { type: 'button', onclick: () => cb.onResume() }, 'Resume')]);
      }
      if (state.status === 'disconnected') {
        return h('p', { class: 'note' }, [
          'Connect with read-only SQL access to see estimated costs, or switch to Demo mode in the extension popup. ',
          h('button', { type: 'button', onclick: () => cb.onConnect() }, 'Connect'),
        ]);
      }
      if (state.status === 'unidentified') {
        return h('p', { class: 'note' }, state.conflict ? 'This URL contains conflicting workspace IDs. Open the workspace from its home page, or choose the workspace in Connection preferences.' : 'Open any workspace page whose URL includes ?o=<workspace ID>, or choose the workspace in Connection preferences.');
      }
      if (state.status === 'available' && s && Object.keys(s.freeQuantity || {}).length) {
        return h('p', { class: 'note' }, 'Free usage (not charged): ' + Object.entries(s.freeQuantity).map(([k, v]) => k + ' ' + labels.formatQuantity(v)).join(', '));
      }
      return null;
    }

    function render(state) {
      if (!state) return;
      lastState = state;
      wrap.textContent = '';
      const bar = h('div', { class: 'bar', role: 'region', 'aria-label': 'Estimated Databricks costs', 'aria-busy': String(state.status === 'loading') }, [
        h('div', { class: 'row' }, [lead(state), meta(state), h('span', { class: 'spacer' }), controls(state)]),
        details(state),
        h('p', { class: 'disclaimer' }, labels.DISCLAIMER),
      ]);
      if (expanded && canExpand(state)) {
        const panel = h('div', { class: 'panel', id: 'dcc-panel' });
        if (cb.renderPanel) cb.renderPanel(panel, state);
        bar.appendChild(panel);
      } else if (expanded && !canExpand(state)) {
        expanded = false;
      }
      wrap.appendChild(bar);
    }

    /**
     * Make the host the first child of `container`. No-op (no DOM write) when it already is —
     * even if the page hid it — so our own insertion never feeds an observer loop.
     */
    function ensurePlaced(container) {
      for (const other of doc.querySelectorAll('[data-dcc="banner"]')) if (other !== host) other.remove();
      if (!container) return false;
      if (host.parentNode === container && container.firstElementChild === host) return true;
      container.insertBefore(host, container.firstChild);
      return true;
    }

    function destroy() {
      host.remove();
    }

    return { host, shadow, render, ensurePlaced, destroy, isExpanded: () => expanded };
  }

  /** Map a summary payload / error into a banner status. */
  function statusFor(res) {
    if (!res) return { status: 'loading' };
    if (!res.ok) {
      const code = res.error && res.error.code;
      if (code === 'NOT_CONNECTED') return { status: 'disconnected', error: res.error };
      return { status: 'error', error: res.error };
    }
    const s = res.data;
    if (s && s.paused) return { status: 'paused' };
    if (s && s.unavailableInMode) return { status: 'empty', summary: s };
    const coverage = s && s.current && s.current.coverage;
    const status = { complete: 'available', partial: 'partial', none: 'none', empty: 'empty' }[coverage] || 'empty';
    return { status, summary: s };
  }

  const api = Object.freeze({ createBanner, statusFor, CSS });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).workspaceUi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
