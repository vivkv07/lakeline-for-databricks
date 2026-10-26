/*
 * Query History per-execution estimates (spec §8): one badge per native row, a hover/focus
 * tooltip with the reason and assumptions, and a visible explanatory note under the native
 * "Query history" heading. Generic warehouse-total badges are not shown on this page (this module
 * never requests period totals; inline badge modules should skip routes where isActiveRoute()).
 *
 * Batches ≤ 40 targets per dcc:query 'queryEstimates'. Rows are re-parsed every tick, so recycled
 * (virtualized) rows get the estimate of the execution they now show. Every inserted element
 * carries data-dcc="estimates"; all of them are removed on pause and when leaving the route.
 */
(function (root) {
  'use strict';
  const DCC = root.DCC;
  // Guard against double registration when the content files are injected into an open tab again.
  if (!DCC || !DCC.nativeCostData || DCC.nativeEstimates) return;
  const ids = DCC.ids;
  const labels = DCC.labels;
  const allocation = DCC.allocation;
  const ncd = DCC.nativeCostData;

  const FEATURE = 'estimates';
  const SEL = '[data-dcc="' + FEATURE + '"]';
  const BATCH = 40;
  const MAX_INFLIGHT = 2;
  const RETRY_WAITING_MS = 120000;
  const RETRY_ERROR_MS = 60000;
  const TIP_ID = 'dcc-est-tip';
  const RETRY_STATES = new Set(['waiting_history', 'waiting_billing', 'pending']);
  const LABELS = (allocation && allocation.LABELS) || {};
  const ASSUMPTIONS = (allocation && allocation.ASSUMPTIONS) || [];

  const NOTE_TEXT =
    'Lakeline: the amount beside each query is an allocated estimate (approx.), not measured CPU or memory and not an invoice line. ' +
    "Each SQL warehouse billing interval's cost is assumed uniform over the interval and shared equally among the queries active at the same time; " +
    'idle time and unused capacity stay unallocated, so estimates need not add up to the warehouse bill. ' +
    'Active time is approximated from query metadata, executions hidden from you are not counted, and billing can be delayed or partial. ' +
    'Hover or focus an estimate for its reason and assumptions.';

  const theme = DCC.theme || null;
  const vars = (name) => (theme ? theme.cssVars(name, 'dcc-') : '');
  const OURS = '.dcc-est-badge, .dcc-est-note, .dcc-est-tip';
  const DARK_OURS = OURS.split(', ').map((c) => c + '[data-dcc-theme="dark"]').join(', ');

  // Theme tokens as custom properties on each inserted element; data-dcc-theme follows the page.
  const CSS = `
${OURS} { ${vars('light')} }
${DARK_OURS} { ${vars('dark')} }
.dcc-est-badge { display: inline-block; margin-left: 6px; padding: 0 8px; border: 1px solid var(--dcc-accent-line); border-radius: 999px;
  font: 500 11px/18px var(--dcc-font); color: var(--dcc-accent-text); background: var(--dcc-accent-soft); white-space: nowrap;
  font-variant-numeric: tabular-nums; cursor: help; vertical-align: middle; }
.dcc-est-badge.dcc-est-muted { border-color: var(--dcc-line2); color: var(--dcc-muted); background: var(--dcc-bg); font-weight: 400; }
.dcc-est-badge.dcc-est-loading { border-style: dashed; color: var(--dcc-muted); background: transparent; }
.dcc-est-badge:focus-visible { outline: 2px solid var(--dcc-accent); outline-offset: 2px; }
.dcc-est-note { margin: 6px 0 10px; padding: 10px 14px; border: 1px solid var(--dcc-line); border-radius: 12px; background: var(--dcc-bg);
  color: var(--dcc-body); font: 12px/1.5 var(--dcc-font); max-width: 72rem; }
.dcc-est-note .dcc-est-disclaimer { display: block; margin-top: 4px; color: var(--dcc-muted); }
.dcc-est-tip { position: fixed; z-index: 2147483000; max-width: 360px; padding: 10px 12px; border: 1px solid var(--dcc-line2); border-radius: 12px;
  background: var(--dcc-bg); color: var(--dcc-text); box-shadow: 0 8px 24px rgba(0, 0, 0, .16); font: 12px/1.5 var(--dcc-font); }
.dcc-est-tip[hidden] { display: none; }
.dcc-est-tip strong { display: block; margin-bottom: 2px; font-weight: 600; }
.dcc-est-tip ul { margin: 4px 0 0; padding-left: 16px; color: var(--dcc-body); }
.dcc-est-tip .dcc-est-meta { color: var(--dcc-muted); margin-top: 6px; }
`;

  /** Set data-dcc-theme only when it changes (no DOM writes when nothing changed). */
  function setTheme(el, name) {
    if (el && el.getAttribute('data-dcc-theme') !== name) el.setAttribute('data-dcc-theme', name);
  }

  const state = {
    cache: new Map(), // key → {state:'loading'|'done', item, at, retryAfter}
    inflight: 0,
    provenance: null,
    lastCtx: null,
    views: new WeakMap(), // badge → view (tooltip content)
    listening: false,
  };

  function isActiveRoute(href) {
    const r = ids.parsePageRoute(href);
    return Boolean(r && r.type === 'query_history');
  }

  function h(doc, tag, attrs, children) {
    return DCC.dom.h(doc, tag, attrs, children);
  }

  /* ------------------------------------------------------------------ cleanup */

  function cleanup(doc) {
    const nodes = doc.querySelectorAll(SEL);
    for (const n of nodes) n.remove();
  }

  /* ------------------------------------------------------------------ view model */

  function hashKeys(keys) {
    // Two FNV-1a passes with different offsets → 16 hex chars; scope strings stay short and unique.
    let a = 0x811c9dc5;
    let b = 0x01000193 ^ 0x5bd1e995;
    const s = keys.join(',');
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x01000193 + 2) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }

  /** Money with 2 decimals, up to 4 between $0.01 and $1, and labels' 6-decimal rule below that. */
  function fmtMoney(v, currency) {
    const abs = Math.abs(v);
    if (abs >= 0.01 && abs < 1) return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(v);
    return labels.formatAmount(v, currency);
  }

  function viewFor(r, ctx, now) {
    if (r.local) return { status: r.local.status, text: LABELS[r.local.status], reason: r.local.reason };
    if (ctx.settings.mode !== 'connected') {
      return { status: 'unavailable', text: LABELS.unavailable, reason: 'Per-query estimates need Connected mode. Demo and imported data contain no query history.' };
    }
    if (!ctx.workspaceId) {
      return { status: 'unavailable', text: LABELS.unavailable, reason: 'The workspace ID for this page is not identified, so query history cannot be matched.' };
    }
    const entry = state.cache.get(r.key);
    if (!entry) return { status: 'loading', text: '≈ … approx.', reason: 'Estimating from query history and warehouse billing…', needsRequest: true };
    if (entry.state === 'loading' && !entry.item) return { status: 'loading', text: '≈ … approx.', reason: 'Estimating from query history and warehouse billing…' };
    const it = entry.item;
    const needsRequest = entry.state === 'done' && entry.retryAfter !== null && now >= entry.retryAfter;
    if (it.status === 'ok' && Number.isFinite(it.amount)) {
      const prov = state.provenance || {};
      return { status: 'ok', text: '≈ ' + fmtMoney(it.amount, prov.currency || 'USD') + ' approx.', reason: it.reason, item: it, needsRequest };
    }
    return { status: it.status, text: LABELS[it.status] || LABELS.unavailable, reason: it.reason, item: it, needsRequest };
  }

  /* ------------------------------------------------------------------ requests */

  function applyResponse(res, batch, ctx) {
    const now = Date.now();
    if (res && res.stale) {
      for (const t of batch) state.cache.delete(t.key);
      return;
    }
    const done = (key, item, retryAfter) => state.cache.set(key, { state: 'done', item, at: now, retryAfter });
    if (!res || !res.ok) {
      const e = (res && res.error) || {};
      const reason = (e.title || 'The estimate request failed') + (e.steps && e.steps[0] ? '. ' + e.steps[0] : '');
      for (const t of batch) done(t.key, { key: t.key, status: 'unavailable', reason, amount: null }, now + RETRY_ERROR_MS);
      return;
    }
    const d = res.data || {};
    if (d.paused) {
      for (const t of batch) state.cache.delete(t.key);
      return;
    }
    if (d.unavailableInMode) {
      for (const t of batch) done(t.key, { key: t.key, status: 'unavailable', reason: 'Per-query estimates need Connected mode.', amount: null }, null);
      return;
    }
    if (d.pricingBasis) state.provenance = { pricingBasis: d.pricingBasis, priceTable: d.priceTable, currency: d.currency || 'USD' };
    const items = d.items || {};
    for (const t of batch) {
      const it = items[t.key];
      if (!it || typeof it !== 'object') {
        done(t.key, { key: t.key, status: 'unavailable', reason: 'No estimate was returned for this row.', amount: null }, now + RETRY_ERROR_MS);
      } else {
        done(t.key, it, RETRY_STATES.has(it.status) ? now + RETRY_WAITING_MS : null);
      }
    }
  }

  function request(ctx, targets) {
    if (!targets.length || !ctx.workspaceId) return;
    const queue = [];
    const seen = new Set();
    for (const t of targets) {
      if (seen.has(t.key)) continue;
      seen.add(t.key);
      const entry = state.cache.get(t.key);
      if (entry && entry.state === 'loading') continue;
      queue.push(t);
    }
    while (queue.length && state.inflight < MAX_INFLIGHT) {
      const batch = queue.splice(0, BATCH);
      const keys = batch.map((t) => t.key).sort();
      const scope = 'qh:' + keys.length + ':' + hashKeys(keys);
      for (const t of batch) {
        const prev = state.cache.get(t.key);
        state.cache.set(t.key, { state: 'loading', item: prev && prev.item ? prev.item : null, at: Date.now(), retryAfter: null });
      }
      state.inflight += 1;
      Promise.resolve(ctx.data.query(scope, 'queryEstimates', { targets: batch }, scope))
        .then((res) => applyResponse(res, batch, ctx), () => applyResponse({ ok: false, error: { title: 'The estimate request failed' } }, batch, ctx))
        .finally(() => {
          state.inflight -= 1;
          if (ctx.requestTick) ctx.requestTick();
        });
    }
  }

  /* ------------------------------------------------------------------ rendering */

  function ensureStyle(doc) {
    if (doc.querySelector('style' + SEL)) return;
    const style = doc.createElement('style');
    style.setAttribute('data-dcc', FEATURE);
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function findHeading(doc) {
    const scope = (DCC.native && DCC.native.findBannerContainer(doc)) || doc.body;
    for (const el of scope.querySelectorAll('h1, h2, h3, [role="heading"]')) {
      if (el.closest('[data-dcc]') || el.closest('table, [role="table"], [role="grid"], [role="row"]')) continue;
      if (/\bquery history\b/i.test(ncd.cellText(el))) return el;
    }
    return null;
  }

  function ensureNote(doc, scan, themeName) {
    const heading = findHeading(doc);
    const ref = heading || (scan.tables[0] && scan.tables[0].table);
    let note = doc.querySelector('.dcc-est-note' + SEL);
    if (!ref) return;
    const placed = note && (heading ? note.previousElementSibling === heading : note.nextElementSibling === ref);
    if (placed) return setTheme(note, themeName);
    if (note) note.remove();
    note = h(doc, 'div', { 'data-dcc': FEATURE, class: 'dcc-est-note', role: 'note', 'aria-label': 'About per-query cost estimates' }, [
      NOTE_TEXT,
      h(doc, 'span', { class: 'dcc-est-disclaimer' }, labels.DISCLAIMER),
    ]);
    setTheme(note, themeName);
    if (heading) heading.insertAdjacentElement('afterend', note);
    else ref.parentNode.insertBefore(note, ref);
  }

  function badgeClass(view) {
    if (view.status === 'ok') return 'dcc-est-badge';
    if (view.status === 'loading') return 'dcc-est-badge dcc-est-loading';
    return 'dcc-est-badge dcc-est-muted';
  }

  function renderBadge(doc, r, view, rendered, themeName) {
    if (!r.anchor) return;
    let badge = null;
    for (const child of r.anchor.children) {
      if (child.matches('.dcc-est-badge' + SEL)) {
        badge = child;
        break;
      }
    }
    const sig = JSON.stringify([r.key, view.status, view.text, view.reason || '', themeName]);
    if (!badge) {
      badge = h(doc, 'span', { 'data-dcc': FEATURE, tabindex: '0', role: 'button', 'aria-haspopup': 'true' });
      r.anchor.appendChild(badge);
    }
    rendered.add(badge);
    state.views.set(badge, view);
    if (badge.getAttribute('data-dcc-sig') === sig) return;
    badge.setAttribute('data-dcc-sig', sig);
    badge.setAttribute('data-dcc-key', r.key);
    badge.setAttribute('data-dcc-status', view.status);
    badge.className = badgeClass(view);
    setTheme(badge, themeName);
    badge.textContent = view.text;
    badge.setAttribute('aria-label', view.text + (view.reason ? '. ' + view.reason : ''));
  }

  /* ------------------------------------------------------------------ tooltip */

  function tipFor(doc) {
    let tip = doc.getElementById(TIP_ID);
    if (!tip) {
      tip = h(doc, 'div', { id: TIP_ID, 'data-dcc': FEATURE, class: 'dcc-est-tip', role: 'tooltip', hidden: true });
      doc.body.appendChild(tip);
    }
    return tip;
  }

  function fillTip(doc, tip, view) {
    const prov = state.provenance || {};
    const basis = prov.pricingBasis && labels.BASIS[prov.pricingBasis];
    const it = view.item || {};
    const kids = [h(doc, 'strong', {}, view.status === 'ok' ? 'Allocated query estimate: ' + view.text.replace(/^≈ /, '') : view.text)];
    if (view.reason) kids.push(h(doc, 'div', {}, view.reason));
    if (view.status === 'ok') {
      kids.push(h(doc, 'ul', {}, (it.assumptions && it.assumptions.length ? it.assumptions : ASSUMPTIONS).map((a) => h(doc, 'li', {}, a))));
    } else if (view.status !== 'loading') {
      kids.push(h(doc, 'div', { class: 'dcc-est-meta' }, 'Withheld rather than guessed. A missing match can also mean the query is older than the 90-day lookback or its metadata is out of window.'));
    }
    const meta = [];
    if (it.statementId) meta.push('Statement ' + it.statementId);
    if (it.warehouseId) meta.push('Warehouse ' + it.warehouseId);
    if (basis && view.status === 'ok') meta.push(basis.short + ' (' + prov.priceTable + '). ' + basis.note);
    if (meta.length) kids.push(h(doc, 'div', { class: 'dcc-est-meta' }, meta.join(' · ')));
    tip.textContent = '';
    for (const k of kids) tip.appendChild(k);
  }

  function showTip(badge) {
    const doc = badge.ownerDocument;
    const view = state.views.get(badge);
    if (!view) return;
    const tip = tipFor(doc);
    setTheme(tip, badge.getAttribute('data-dcc-theme') || 'light');
    fillTip(doc, tip, view);
    tip.hidden = false;
    badge.setAttribute('aria-describedby', TIP_ID);
    badge.setAttribute('aria-expanded', 'true');
    const rect = badge.getBoundingClientRect();
    const win = doc.defaultView;
    const width = (win && win.innerWidth) || 1024;
    tip.style.left = Math.max(8, Math.min(rect.left, width - 368)) + 'px';
    tip.style.top = rect.bottom + 6 + 'px';
  }

  function hideTip(doc) {
    const tip = doc.getElementById(TIP_ID);
    if (tip && !tip.hidden) tip.hidden = true;
    for (const b of doc.querySelectorAll('.dcc-est-badge[aria-describedby]')) {
      b.removeAttribute('aria-describedby');
      b.setAttribute('aria-expanded', 'false');
    }
  }

  function listen(doc) {
    if (state.listening) return;
    state.listening = true;
    const badgeOf = (e) => (e.target && e.target.closest ? e.target.closest('.dcc-est-badge' + SEL) : null);
    doc.addEventListener('mouseover', (e) => {
      const b = badgeOf(e);
      if (b) showTip(b);
    }, true);
    doc.addEventListener('mouseout', (e) => {
      const b = badgeOf(e);
      if (b && !(e.relatedTarget && b.contains(e.relatedTarget))) hideTip(doc);
    }, true);
    doc.addEventListener('focusin', (e) => {
      const b = badgeOf(e);
      if (b) showTip(b);
    }, true);
    doc.addEventListener('focusout', (e) => {
      if (badgeOf(e)) hideTip(doc);
    }, true);
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideTip(doc);
    }, true);
    // Clicking or tapping a badge toggles its tooltip and never reaches the native row handler.
    doc.addEventListener('click', (e) => {
      const b = badgeOf(e);
      if (!b) return;
      e.stopPropagation();
      e.preventDefault();
      const tip = doc.getElementById(TIP_ID);
      if (tip && !tip.hidden && b.getAttribute('aria-describedby') === TIP_ID) hideTip(doc);
      else showTip(b);
    }, true);
  }

  /* ------------------------------------------------------------------ feature hooks */

  function tick(ctx) {
    const doc = ctx.doc;
    state.lastCtx = ctx;
    const href = doc.defaultView ? doc.defaultView.location.href : '';
    if (!isActiveRoute(href) || ctx.settings.showCosts === false) {
      if (doc.querySelector(SEL)) cleanup(doc);
      return;
    }
    const now = Date.now();
    const scan = ncd.scan(doc, { origin: ctx.origin, workspaceId: ctx.workspaceId, nowMs: now });
    if (!scan.tables.length && !findHeading(doc)) {
      if (doc.querySelector(SEL)) cleanup(doc);
      return;
    }
    // Light or dark tokens, matching the page's main container (re-checked every tick).
    const themeName = theme ? theme.pickForPage(doc) : 'light';
    ensureStyle(doc);
    ensureNote(doc, scan, themeName);
    listen(doc);
    const rendered = new Set();
    const want = [];
    for (const r of scan.rows) {
      const view = viewFor(r, ctx, now);
      renderBadge(doc, r, view, rendered, themeName);
      if (view.needsRequest && r.target) want.push(r.target);
    }
    // Remove badges left on rows that were recycled, re-rendered or no longer parse.
    for (const b of doc.querySelectorAll('.dcc-est-badge' + SEL)) if (!rendered.has(b)) b.remove();
    if (ctx.settings.mode === 'connected') request(ctx, want);
  }

  const feature = {
    name: FEATURE,
    onStart: tick,
    onTick: tick,
    onRoute(ctx) {
      if (!isActiveRoute(ctx.doc.defaultView.location.href)) cleanup(ctx.doc);
      tick(ctx);
    },
    onSettings(ctx) {
      state.cache.clear();
      state.provenance = null;
      cleanup(ctx.doc);
      tick(ctx);
    },
    onSummary() {},
    onPeriod() {}, // estimates use their own 90-day lookback, independent of the banner period
  };

  (root.DCC.features || (root.DCC.features = [])).push(feature);
  root.DCC.nativeEstimates = Object.freeze({ isActiveRoute, NOTE_TEXT, hashKeys });
})(typeof globalThis !== 'undefined' ? globalThis : this);
