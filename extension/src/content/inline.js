/*
 * Inline cost badges beside native resource names, run/update rows and job/pipeline titles.
 *
 * Every tick: scan the page for references (row-refs), request data for references near the
 * viewport (row-data, ≤ 40 per batch, deduplicated), then reconcile badges. A badge sits right
 * after its anchor (the identity link, or the native title); a badge whose anchor moved, whose
 * row now carries a different reference, or that this instance didn't create is removed or
 * replaced. Nothing is written when nothing changed, so our own mutations settle after one tick.
 *
 * Labels: recorded amounts say "est.", period totals name the period ("30d est."), execution
 * amounts are that run/update only. Partial pricing says "priced subtotal"; direct-only job
 * amounts say "Direct job cost". Missing data is never shown as $0. Tooltips (title + aria-label)
 * carry scope, attribution, warnings, price basis and the estimates notice.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const V = dep('validate', '../core/validate.js');
  const labels = dep('labels', '../core/labels.js');
  const periods = dep('periods', '../core/periods.js');
  const rowRefs = dep('rowRefs', './row-refs.js');
  const rowData = dep('rowData', './row-data.js');

  const FEATURE = 'inline';
  const BADGE_SEL = '[data-dcc="inline"]';
  const STYLE_SEL = 'style[data-dcc="inline-style"]';
  const EXECUTION_LOOKBACK_DAYS = 365;

  const theme = dep('theme', '../core/theme.js');
  const vars = (name) => (theme ? theme.cssVars(name, 'dcc-') : '');

  // Theme tokens as custom properties on the badge itself; data-dcc-theme follows the page.
  const CSS = `
.dcc-inline { ${vars('light')} }
.dcc-inline[data-dcc-theme="dark"] { ${vars('dark')} }
.dcc-inline { display: inline-flex; align-items: center; gap: 3px; margin: 0 0 0 6px; padding: 0 8px;
  border: 1px solid var(--dcc-line2); border-radius: 999px; background: var(--dcc-bg); color: var(--dcc-text);
  font: 500 11px/16px var(--dcc-font); font-variant-numeric: tabular-nums; letter-spacing: normal; text-transform: none; text-decoration: none;
  white-space: nowrap; vertical-align: middle; max-width: 100%; overflow: hidden; text-overflow: ellipsis; cursor: help; }
.dcc-inline--title { margin: 6px 0 0; padding: 1px 10px; font-size: 12px; line-height: 18px; border-color: var(--dcc-accent-line);
  color: var(--dcc-accent-text); background: var(--dcc-accent-soft); }
.dcc-inline--pending { color: var(--dcc-muted); border-style: dashed; background: transparent; font-weight: 400; }
.dcc-inline--partial, .dcc-inline--direct-only { border-color: var(--dcc-warm-line); color: var(--dcc-warm); background: var(--dcc-warm-soft); }
.dcc-inline--none, .dcc-inline--unavailable { color: var(--dcc-muted); background: transparent; font-weight: 400; }
.dcc-inline--demo { border-style: dotted; }
.dcc-inline:focus-visible { outline: 2px solid var(--dcc-accent); outline-offset: 2px; }
`;

  const BASE_LABEL = Object.freeze({
    job: 'Job total',
    job_run: 'Run cost',
    pipeline: 'Pipeline total',
    pipeline_update: 'Update cost',
    warehouse: 'Warehouse total',
    notebook: 'Notebook total',
    app: 'App total',
  });
  const NOUN = Object.freeze({
    job: 'job',
    job_run: 'job run',
    pipeline: 'pipeline',
    pipeline_update: 'pipeline update',
    warehouse: 'SQL warehouse',
    notebook: 'notebook',
    app: 'app',
  });
  // The banner already explains these; per-row badges would only repeat them.
  const SILENT_ERRORS = new Set(['NOT_CONNECTED', 'WORKSPACE_MISMATCH', 'PERMISSION_NOT_GRANTED']);

  const isExecution = (type) => type === 'job_run' || type === 'pipeline_update';
  const clip = (s, n = 600) => V.safeText(s, n);

  function scopeLine(item, type, periodDays, nowMs) {
    if (item && item.note) return clip(item.note);
    if (isExecution(type)) {
      return 'This execution only. Billing searched across ' + EXECUTION_LOOKBACK_DAYS + ' UTC dates up to and including today; delayed billing or bounded history can make it incomplete.';
    }
    const w = item && item.window && item.window.start ? item.window : periods.completePeriod(periodDays, nowMs);
    return 'Period: ' + periods.periodLabel(w.start, w.endExclusive) + ', ' + periods.daysBetween(w.start, w.endExclusive) + ' complete UTC days excluding today. Not lifetime spend.';
  }

  function attributionLine(item, type, currency) {
    const noun = NOUN[type] || 'resource';
    switch (item.attribution) {
      case 'direct+pipelines': {
        const linked = labels.formatAmount(item.linkedAmount, currency);
        return (
          'Attribution: billing tagged with this ' + noun + ' plus pipeline updates it triggered' + (type === 'job_run' ? ' (this run only)' : '') +
          '; each usage record is counted once.' + (linked ? ' Includes ' + linked + ' from triggered pipeline updates.' : '')
        );
      }
      case 'direct-only':
        return 'Attribution: direct job billing only. Pipeline updates triggered by this job could not be attributed, so this is not a complete job total.';
      case 'direct':
        return 'Attribution: billing records tagged with this ' + noun + "'s ID." + (type === 'notebook' ? ' Usage on shared all-purpose compute is not allocated to notebooks.' : '');
      default:
        return null;
    }
  }

  /**
   * Badge content for a placement.
   * @param {'title'|'row'} kind
   * @param {object} ref
   * @param {object|null} entry row-data entry
   * @param {number} periodDays
   * @returns {{cls:string, text:string, tip:string}|null} null = show nothing
   */
  function viewFor(kind, ref, entry, periodDays, nowMs = Date.now()) {
    if (!entry || entry.state === 'paused') return null;
    const type = ref.type;
    const exec = isExecution(type);
    const title = kind === 'title';
    const base = BASE_LABEL[type] || 'Cost';
    if (entry.state === 'pending' || entry.state === 'retry') {
      return { cls: 'pending', text: title ? base + ': …' : '…', tip: 'Loading estimated cost…' };
    }
    if (entry.state === 'error') {
      const err = entry.error || {};
      if (SILENT_ERRORS.has(err.code)) return null;
      const tip = ['Cost unavailable: ' + clip(err.title || 'request failed', 200)].concat((err.steps || []).map((s) => clip(s, 300))).join('\n');
      return { cls: 'unavailable', text: title ? base + ': unavailable' : 'Unavailable', tip };
    }
    const item = entry.item || {};
    const env = entry.env || {};
    const currency = V.isCurrency(env.currency) ? env.currency : 'USD';
    const demo = Boolean(env.synthetic) || item.attribution === 'demo' || env.pricingBasis === 'demo';
    const imported = item.attribution === 'import' || env.pricingBasis === 'import';
    const tag = demo ? 'DEMO' : imported ? 'imported' : labels.KIND.recorded;
    const scopeTag = exec ? tag : periodDays + 'd ' + tag;
    const directOnly = item.attribution === 'direct-only';
    let label = clip(item.label || base, 80);
    const amount = labels.formatAmount(item.amount, currency);
    let status = item.status;
    if ((status === 'ok' || status === 'partial') && amount === null) status = 'unavailable';
    if (status === 'partial' && !/subtotal/i.test(label)) label += ' (priced subtotal)';

    let cls;
    let text;
    let headline;
    if (status === 'ok' || status === 'partial') {
      cls = status === 'partial' ? 'partial' : directOnly ? 'direct-only' : 'ok';
      headline = label + ': ' + amount + (exec ? '' : ' (' + periodDays + 'd)');
      if (title) text = label + ': ' + amount + ' · ' + scopeTag;
      else text = (directOnly ? 'Direct ' : '') + amount + ' ' + tag + (status === 'partial' ? ' (partial)' : '');
    } else if (status === 'none') {
      cls = 'none';
      headline = label + ': no usage recorded' + (exec ? '' : ' in the last ' + periodDays + ' complete days');
      text = title ? label + ': no usage recorded' + (exec ? '' : ' · ' + periodDays + 'd') : 'No usage';
    } else {
      cls = 'unavailable';
      if (item.reason === 'not-imported') {
        if (!title) return null;
        headline = label + ': not in the imported data';
        text = label + ': not in import';
      } else if (item.reason === 'price-unavailable') {
        headline = label + ': usage recorded, but no matching price';
        text = title ? label + ': price unavailable' : 'No price';
      } else {
        headline = label + ': unavailable';
        text = title ? label + ': unavailable' : 'Unavailable';
      }
    }
    if (demo) cls += ' demo';

    const lines = [headline];
    lines.push(demo ? 'Synthetic demo figure; not from Databricks.' : imported ? 'Imported summary from a local costs.json file; contains no run detail.' : 'Estimated recorded cost: signed usage quantity × unit price.');
    lines.push(scopeLine(item, type, periodDays, nowMs));
    const attr = attributionLine(item, type, currency);
    if (attr) lines.push(attr);
    for (const w of Array.isArray(item.warnings) ? item.warnings : []) if (w && w.text) lines.push('Warning: ' + clip(w.text));
    const basis = labels.BASIS[demo ? 'demo' : env.pricingBasis];
    if (basis) lines.push(basis.note);
    lines.push(labels.DISCLAIMER);
    return { cls, text, tip: lines.join('\n') };
  }

  function createFeature() {
    const scanner = rowRefs.createScanner();
    const badgeFor = new WeakMap(); // anchor element → its badge
    const sigOf = new WeakMap(); // badge → last applied content signature
    let client = null;
    let lastCtx = null;
    let listening = false;

    function connectionSig(ctx) {
      const c = ctx.connection;
      return JSON.stringify([ctx.origin, ctx.workspaceId, ctx.settings && ctx.settings.mode, c ? [c.workspaceId, c.authMode, c.priceTable, c.currency] : null]);
    }

    function active(ctx) {
      const s = ctx && ctx.settings;
      if (!s || s.showCosts === false || !ctx.workspaceId || !V.isPeriodDays(s.periodDays)) return false;
      if (s.mode === 'connected' && !ctx.connection) return false;
      return true;
    }

    function removeAll(doc) {
      for (const b of doc.querySelectorAll(BADGE_SEL)) b.remove();
    }

    function ensureStyle(doc) {
      const styles = doc.querySelectorAll(STYLE_SEL);
      if (styles.length === 1) return;
      for (let i = 1; i < styles.length; i++) styles[i].remove();
      if (!styles.length) {
        const s = doc.createElement('style');
        s.setAttribute('data-dcc', 'inline-style');
        s.textContent = CSS;
        (doc.head || doc.documentElement).appendChild(s);
      }
    }

    function makeBadge(doc, kind) {
      const b = doc.createElement('span');
      b.setAttribute('data-dcc', FEATURE);
      b.setAttribute('data-dcc-kind', kind);
      b.setAttribute('role', 'note');
      if (kind === 'title') b.setAttribute('tabindex', '0');
      return b;
    }

    function apply(badge, kind, key, v, themeName) {
      const sig = kind + '\u0001' + key + '\u0001' + v.cls + '\u0001' + v.text + '\u0001' + v.tip + '\u0001' + themeName;
      if (sigOf.get(badge) === sig) return;
      badge.className = 'dcc-inline dcc-inline--' + kind + ' ' + v.cls.split(' ').map((c) => 'dcc-inline--' + c).join(' ');
      badge.setAttribute('data-dcc-theme', themeName);
      badge.setAttribute('data-dcc-key', key);
      badge.textContent = v.text;
      badge.setAttribute('title', v.tip);
      badge.setAttribute('aria-label', v.tip.replace(/\n/g, ' '));
      sigOf.set(badge, sig);
    }

    function render(ctx) {
      if (!ctx || !ctx.doc) return;
      lastCtx = ctx;
      const doc = ctx.doc;
      if (!active(ctx)) {
        if (client) client.reset();
        removeAll(doc);
        return;
      }
      if (!client) client = rowData.create({ data: ctx.data, onUpdate: () => lastCtx && lastCtx.requestTick() });
      const periodDays = ctx.settings.periodDays;
      client.setContext(connectionSig(ctx), periodDays);
      const win = doc.defaultView;
      const scan = scanner.scan(doc, { origin: ctx.origin, workspaceId: ctx.workspaceId, href: win ? win.location.href : '' });
      const places = [];
      if (scan.title) places.push({ kind: 'title', anchor: scan.title.heading, ref: scan.title.ref, key: scan.title.key });
      for (const r of scan.rows) places.push({ kind: 'row', anchor: r.anchor, ref: r.ref, key: r.key });
      client.ensure(places.filter((p) => p.kind === 'title' || rowRefs.nearViewport(p.anchor)).map((p) => p.ref));

      const keep = new Set();
      const nowMs = Date.now();
      // Light or dark tokens, matching the page's main container (re-checked every tick).
      const themeName = theme ? theme.pickForPage(doc) : 'light';
      for (const p of places) {
        const v = viewFor(p.kind, p.ref, client.get(p.key), periodDays, nowMs);
        if (!v) continue;
        let badge = badgeFor.get(p.anchor);
        if (badge && (keep.has(badge) || badge.previousSibling !== p.anchor || badge.getAttribute('data-dcc-kind') !== p.kind)) {
          if (!keep.has(badge)) badge.remove();
          badge = null;
        }
        if (!badge) {
          badge = makeBadge(doc, p.kind);
          p.anchor.after(badge);
          badgeFor.set(p.anchor, badge);
        }
        apply(badge, p.kind, p.key, v, themeName);
        keep.add(badge);
      }
      // Stale (anchor gone or recycled), duplicate and foreign copies of badges.
      for (const b of doc.querySelectorAll(BADGE_SEL)) if (!keep.has(b)) b.remove();
      if (keep.size) ensureStyle(doc);
    }

    function listen(ctx) {
      if (listening || !ctx || !ctx.doc) return;
      listening = true;
      const onMove = () => lastCtx && lastCtx.requestTick();
      ctx.doc.addEventListener('scroll', onMove, { capture: true, passive: true });
      if (ctx.doc.defaultView) ctx.doc.defaultView.addEventListener('resize', onMove, { passive: true });
    }

    return {
      name: FEATURE,
      onStart(ctx) {
        listen(ctx);
        render(ctx);
      },
      onTick(ctx) {
        render(ctx);
      },
      onRoute(ctx) {
        if (client) client.reset();
        lastCtx = ctx;
      },
      onPeriod(ctx) {
        if (client) client.reset();
        render(ctx);
      },
      onSettings(ctx) {
        if (client) client.reset();
        render(ctx);
      },
      /** Test/diagnostic access. */
      get client() {
        return client;
      },
    };
  }

  const api = Object.freeze({ FEATURE, CSS, viewFor, createFeature });
  if (NODE) module.exports = api;
  else {
    const DCC = root.DCC || (root.DCC = {});
    const instance = createFeature();
    DCC.inline = Object.freeze(Object.assign({ instance }, api));
    (DCC.features || (DCC.features = [])).push(instance);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
