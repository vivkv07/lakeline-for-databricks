/*
 * Prospective hourly DBU cost previews beside native compute-size controls (spec §9).
 *
 * SQL warehouse create/edit: beside each size option, "≈ $X/h per cluster · DBU only", where
 *   X = DBU/h × the current price of the warehouse's latest billed SKU (computeRates 'warehouse').
 *   DBU/h comes from explicit option text ("Small · 12 DBU/h"); otherwise the published Azure
 *   serverless table applies, only on Azure, only when Serverless is detectably selected, and never
 *   for real-time warehouses. Anything else shows "Rate unavailable". Autoscaling multiplies it.
 * Interactive compute create/edit: the native DBU/h value or range (driver included only when the
 *   native estimate includes it; we never add or remove anything) × one unambiguous all-purpose
 *   rate (computeRates 'allPurpose', filtered by Photon when detectable). Never a SQL rate.
 *
 * Read-only: never clicks, saves or resizes anything, and never changes native inputs. Inserted
 * elements carry data-dcc="warehouse-preview".
 */
(function (root) {
  'use strict';
  const DCC = root.DCC;
  // Guard against double registration when the content files are injected into an open tab again.
  if (!DCC || DCC.warehousePreview) return;
  const ids = DCC.ids;
  const V = DCC.validate;
  const labels = DCC.labels;

  const FEATURE = 'warehouse-preview';
  const SEL = '[data-dcc="' + FEATURE + '"]';
  const OWN = '[data-dcc]';
  const PREVIEW = '.dcc-wh-preview' + SEL;

  const SIZES = Object.freeze(['2X-Small', 'X-Small', 'Small', 'Medium', 'Large', 'X-Large', '2X-Large', '3X-Large', '4X-Large', '5X-Large']);
  const CANONICAL = new Map(SIZES.map((s) => [s.toLowerCase(), s]));
  // Azure Databricks serverless SQL warehouse DBU/h per cluster (verified 2026-10-15). Source:
  // https://learn.microsoft.com/en-us/azure/databricks/resources/pricing (serverless DBU consumption by size).
  // 5X-Large has no published rate and is deliberately absent.
  const AZURE_SERVERLESS_DBU = Object.freeze({ '2X-Small': 4, 'X-Small': 6, Small: 12, Medium: 24, Large: 40, 'X-Large': 80, '2X-Large': 144, '3X-Large': 272, '4X-Large': 528 });
  const SIZE_RE = /(?:^|[^A-Za-z0-9-])(2X-Small|X-Small|5X-Large|4X-Large|3X-Large|2X-Large|X-Large|Small|Medium|Large)(?=$|[^A-Za-z0-9-])/i;
  const DBU_NUM = '(\\d+(?:\\.\\d+)?)';
  const DBU_UNIT = '\\s*DBUs?\\s*(?:\\/\\s*|per\\s+)(?:h|hr|hour)\\b';
  const DBU_RANGE_RE = new RegExp(DBU_NUM + '\\s*(?:[-–—]|to)\\s*' + DBU_NUM + DBU_UNIT, 'i');
  const DBU_SINGLE_RE = new RegExp(DBU_NUM + DBU_UNIT, 'i');
  const CLUSTER_IN_PATH = /\/compute\/clusters\/([0-9]{4}-[0-9]{6}-[a-z0-9]{8})(?:\/|$)/;
  const CLUSTER_IN_HASH = /^#setting\/clusters\/([0-9]{4}-[0-9]{6}-[a-z0-9]{8})(?:\/|$)/;
  const WAREHOUSE_IN_PATH = /\/(?:sql\/warehouses|compute\/sql-warehouses|sql-warehouses)\/([0-9a-f]{16})(?:\/|$)/;

  const theme = DCC.theme || null;
  const vars = (name) => (theme ? theme.cssVars(name, 'dcc-') : '');

  // Theme tokens as custom properties on each preview; data-dcc-theme follows the page.
  const CSS = `
.dcc-wh-preview { ${vars('light')} }
.dcc-wh-preview[data-dcc-theme="dark"] { ${vars('dark')} }
.dcc-wh-preview { display: inline-block; margin-left: 8px; padding: 0 8px; border: 1px solid var(--dcc-accent-line); border-radius: 999px;
  background: var(--dcc-accent-soft); color: var(--dcc-accent-text); font: 500 11px/18px var(--dcc-font); white-space: nowrap;
  font-variant-numeric: tabular-nums; vertical-align: middle; }
.dcc-wh-preview.dcc-wh-muted { border-color: var(--dcc-line2); background: var(--dcc-bg); color: var(--dcc-muted); font-weight: 400; }
`;

  const state = { rates: new Map(), listening: false, lastCtx: null };

  /* ------------------------------------------------------------------ text helpers */

  /** Visible text of a native element, excluding the extension's own nodes. */
  function text(el) {
    if (!el) return '';
    const walker = el.ownerDocument.createTreeWalker(el, 4);
    let out = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement && n.parentElement.closest(OWN)) continue;
      out += ' ' + n.data;
    }
    return out.replace(/[\s  ]+/g, ' ').trim();
  }

  function sizeIn(t) {
    const m = SIZE_RE.exec(t || '');
    return m ? CANONICAL.get(m[1].toLowerCase()) : null;
  }

  /** Explicit DBU/h in native text: {lo, hi} (equal for a single value) or null. */
  function dbuIn(t) {
    const s = String(t || '');
    let m = DBU_RANGE_RE.exec(s);
    if (m) {
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      return Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo ? { lo, hi } : null;
    }
    m = DBU_SINGLE_RE.exec(s);
    if (m && Number.isFinite(Number(m[1]))) return { lo: Number(m[1]), hi: Number(m[1]) };
    return null;
  }

  function routeMode(loc) {
    const path = loc.pathname || '';
    const hash = loc.hash || '';
    if (/warehouse/i.test(path)) return 'warehouse';
    if (/^\/compute(\/|$)/.test(path) || /^#(setting\/clusters|create\/cluster)/.test(hash)) return 'compute';
    return null;
  }

  function labelText(el) {
    const doc = el.ownerDocument;
    const parts = [];
    if (el.labels) for (const l of el.labels) parts.push(text(l));
    const aria = el.getAttribute('aria-label');
    if (aria) parts.push(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) for (const id of by.split(/\s+/)) parts.push(text(doc.getElementById(id)));
    const wrap = el.closest('label');
    if (wrap) parts.push(text(wrap));
    if (el.getAttribute('role')) parts.push(text(el));
    return parts.join(' ');
  }

  /* ------------------------------------------------------------------ detection */

  const TYPE_RE = /serverless|\bpro\b|classic|real[-\s]?time/i;

  /** Selected SQL warehouse type from checked radios, selects or comboboxes. */
  function detectWarehouseType(doc) {
    const chosen = [];
    for (const r of doc.querySelectorAll('input[type="radio"]')) if (r.checked && !r.closest(OWN)) chosen.push(labelText(r));
    for (const r of doc.querySelectorAll('[role="radio"][aria-checked="true"], [role="tab"][aria-selected="true"], [role="option"][aria-selected="true"]')) {
      if (!r.closest(OWN)) chosen.push(labelText(r));
    }
    for (const s of doc.querySelectorAll('select')) {
      if (s.closest(OWN)) continue;
      const opt = s.selectedOptions && s.selectedOptions[0];
      if (opt) chosen.push(text(opt));
    }
    for (const c of doc.querySelectorAll('[role="combobox"]')) if (!c.closest(OWN)) chosen.push(text(c) + ' ' + (c.getAttribute('aria-label') || ''));
    const typed = chosen.filter((t) => TYPE_RE.test(t) && !sizeIn(t));
    const realtime = typed.some((t) => /real[-\s]?time/i.test(t));
    const serverless = typed.some((t) => /serverless/i.test(t));
    const classicOrPro = typed.some((t) => /\bpro\b|classic/i.test(t) && !/serverless/i.test(t));
    return { serverless: serverless && !classicOrPro ? true : classicOrPro && !serverless ? false : null, realtime };
  }

  function detectPhoton(doc) {
    const states = [];
    for (const el of doc.querySelectorAll('input[type="checkbox"], [role="checkbox"], [role="switch"]')) {
      if (el.closest(OWN) || !/photon/i.test(labelText(el))) continue;
      if (el.tagName === 'INPUT') states.push(el.checked === true);
      else if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-checked') === 'false') states.push(el.getAttribute('aria-checked') === 'true');
    }
    if (states.length && states.every((s) => s === states[0])) return states[0];
    return null;
  }

  /* ------------------------------------------------------------------ rates */

  function rateFor(ctx, key, args) {
    let entry = state.rates.get(key);
    if (entry) return entry;
    entry = { state: 'loading', data: null };
    state.rates.set(key, entry);
    if (ctx.settings.mode !== 'connected') {
      entry.state = 'done';
      entry.data = { status: 'unavailable', reason: 'Rates need Connected mode (read-only SQL on your billing tables).' };
      return entry;
    }
    Promise.resolve(ctx.data.query('rate:' + key, 'computeRates', args, key))
      .then((res) => {
        if (res && res.stale) {
          state.rates.delete(key);
          return;
        }
        entry.state = 'done';
        if (!res || !res.ok) entry.data = { status: 'unavailable', reason: (res && res.error && res.error.title) || 'Rate request failed' };
        else if (res.data && (res.data.paused || res.data.unavailableInMode)) entry.data = { status: 'unavailable', reason: res.data.paused ? 'Cost display is paused.' : 'Rates need Connected mode.' };
        else entry.data = res.data || { status: 'unavailable' };
      }, () => {
        entry.state = 'done';
        entry.data = { status: 'unavailable', reason: 'Rate request failed' };
      })
      .finally(() => ctx.requestTick && ctx.requestTick());
    return entry;
  }

  /** Money with 2 decimals, up to 4 between $0.01 and $1, and labels' 6-decimal rule below that. */
  function fmtRate(v, currency) {
    const abs = Math.abs(v);
    if (abs >= 0.01 && abs < 1) return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(v);
    return labels.formatAmount(v, currency || 'USD');
  }

  function rateNote(r) {
    const basis = r.pricingBasis && labels.BASIS[r.pricingBasis];
    return fmtRate(r.ratePerDbu, r.currency) + '/DBU' + (r.sku ? ' (' + r.sku + ')' : '') + (basis ? ', ' + basis.short.toLowerCase() + ' from ' + r.priceTable : '');
  }

  /* ------------------------------------------------------------------ rendering */

  function ensureStyle(doc) {
    if (doc.querySelector('style' + SEL)) return;
    const style = doc.createElement('style');
    style.setAttribute('data-dcc', FEATURE);
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  /** Place (or update) a preview as the last child of `host` or right after `after`. */
  function place(doc, where, view, rendered, themeName) {
    let el = null;
    if (where.inside) {
      for (const c of where.inside.children) if (c.matches(PREVIEW)) el = c;
    } else {
      const next = where.after.nextElementSibling;
      if (next && next.matches(PREVIEW)) el = next;
    }
    const sig = JSON.stringify([view.text, view.title, view.muted, themeName]);
    if (!el) {
      el = doc.createElement('span');
      el.setAttribute('data-dcc', FEATURE);
      if (where.inside) where.inside.appendChild(el);
      else where.after.insertAdjacentElement('afterend', el);
    }
    rendered.add(el);
    if (el.getAttribute('data-dcc-sig') === sig) return;
    el.setAttribute('data-dcc-sig', sig);
    el.className = 'dcc-wh-preview' + (view.muted ? ' dcc-wh-muted' : '');
    el.setAttribute('data-dcc-theme', themeName || 'light');
    el.textContent = view.text;
    el.setAttribute('title', view.title);
  }

  function warehouseView(dbu, source, entry) {
    const tail = ' Autoscaling multiplies it by the number of running clusters. DBU only: VM, disk, network and other infrastructure are excluded.';
    if (!dbu) return { text: 'Rate unavailable', muted: true, title: 'No DBU/hour value is shown for this option, and no published mapping applies.' + tail };
    if (!entry || entry.state === 'loading') return { text: 'Loading rate…', muted: true, title: 'Looking up the current DBU price for this warehouse.' };
    const r = entry.data || {};
    if (r.status !== 'ok' || !Number.isFinite(r.ratePerDbu)) return { text: 'Rate unavailable', muted: true, title: (r.reason || 'No unambiguous current DBU price.') + tail };
    return {
      text: '≈ ' + fmtRate(dbu.lo * r.ratePerDbu, r.currency) + '/h per cluster · DBU only',
      muted: false,
      title: 'Prospective estimate: ' + dbu.lo + ' DBU/h (' + source + ') × ' + rateNote(r) + ' per cluster.' + tail,
    };
  }

  function computeView(dbu, entry, photon) {
    const tail = ' DBU only: VM, disk, network and other infrastructure are excluded. Uses the DBU/h shown by Databricks; the driver is included only if that estimate includes it.';
    if (!entry || entry.state === 'loading') return { text: 'Loading rate…', muted: true, title: 'Looking up the current all-purpose DBU price.' };
    const r = entry.data || {};
    if (r.status !== 'ok' || !Number.isFinite(r.ratePerDbu)) return { text: 'Rate unavailable', muted: true, title: (r.reason || 'No unambiguous all-purpose DBU price.') + tail };
    const lo = fmtRate(dbu.lo * r.ratePerDbu, r.currency);
    const hi = fmtRate(dbu.hi * r.ratePerDbu, r.currency);
    const dbuText = dbu.lo === dbu.hi ? dbu.lo + ' DBU/h' : dbu.lo + '–' + dbu.hi + ' DBU/h';
    return {
      text: '≈ ' + (dbu.lo === dbu.hi ? lo : lo + '–' + hi) + '/h · DBU only',
      muted: false,
      title: 'Prospective estimate: ' + dbuText + ' × ' + rateNote(r) + (photon === null ? '; Photon not detected' : photon ? '; Photon' : '; without Photon') + '.' + tail,
    };
  }

  /* ------------------------------------------------------------------ SQL warehouses */

  function sizeOptions(doc) {
    const groups = new Map();
    for (const opt of doc.querySelectorAll('[role="option"]')) {
      if (opt.closest(OWN)) continue;
      const size = sizeIn(text(opt));
      if (!size) continue;
      const list = opt.closest('[role="listbox"]') || opt.parentElement;
      if (!groups.has(list)) groups.set(list, []);
      groups.get(list).push({ el: opt, size, text: text(opt) });
    }
    const out = [];
    for (const list of groups.values()) if (list.length >= 2) out.push(...list);
    return out;
  }

  function handleWarehouse(ctx, rendered, themeName) {
    const doc = ctx.doc;
    const loc = doc.defaultView.location;
    const m = WAREHOUSE_IN_PATH.exec(loc.pathname);
    const warehouseId = m && V.isWarehouseId(m[1]) ? m[1] : null;
    const cls = ids.classifyOrigin(ctx.origin);
    const cloud = cls.ok ? cls.cloud : null;
    const type = detectWarehouseType(doc);
    const mappingApplies = cloud === 'azure' && type.serverless === true && !type.realtime;
    const dbuFor = (size, t) => {
      const explicit = dbuIn(t);
      if (explicit && explicit.lo === explicit.hi) return { dbu: explicit, source: 'shown by Databricks' };
      if (mappingApplies && AZURE_SERVERLESS_DBU[size]) return { dbu: { lo: AZURE_SERVERLESS_DBU[size], hi: AZURE_SERVERLESS_DBU[size] }, source: 'published Azure serverless table' };
      return { dbu: null, source: null };
    };

    const targets = [];
    for (const o of sizeOptions(doc)) targets.push(Object.assign({ where: { inside: o.el } }, dbuFor(o.size, o.text)));
    for (const s of doc.querySelectorAll('select')) {
      if (s.closest(OWN)) continue;
      const sized = [...s.options].filter((o) => sizeIn(text(o)));
      if (sized.length < 2) continue;
      const sel = s.selectedOptions && s.selectedOptions[0];
      const size = sel && sizeIn(text(sel));
      if (size) targets.push(Object.assign({ where: { after: s } }, dbuFor(size, text(sel))));
    }
    for (const c of doc.querySelectorAll('[role="combobox"], button[aria-haspopup="listbox"]')) {
      if (c.closest(OWN)) continue;
      const t = text(c);
      const size = sizeIn(t);
      if (size) targets.push(Object.assign({ where: { after: c } }, dbuFor(size, t)));
    }
    if (!targets.length) return;
    ensureStyle(doc);
    const needsRate = targets.some((t) => t.dbu);
    const key = 'wh:' + (warehouseId || 'new') + ':' + String(type.serverless);
    const entry = needsRate ? rateFor(ctx, key, { target: 'warehouse', warehouseId, serverless: type.serverless }) : null;
    for (const t of targets) place(doc, t.where, warehouseView(t.dbu, t.source, entry), rendered, themeName);
  }

  /* ------------------------------------------------------------------ interactive compute */

  function nativeDbuElements(doc) {
    const scope = (DCC.native && DCC.native.findBannerContainer(doc)) || doc.body;
    const out = [];
    const seen = new Set();
    const walker = doc.createTreeWalker(scope, 4);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.data || n.data.indexOf('DBU') === -1) continue;
      const el = n.parentElement;
      if (!el || seen.has(el) || el.closest(OWN) || el.closest('[role="option"], [role="listbox"], select, option, textarea, script, style')) continue;
      seen.add(el);
      const dbu = dbuIn(text(el));
      if (dbu) out.push({ el, dbu });
    }
    // Keep the innermost element when a parent and its child both match.
    return out.filter((x) => !out.some((y) => y !== x && x.el.contains(y.el)));
  }

  function handleCompute(ctx, rendered, themeName) {
    const doc = ctx.doc;
    const loc = doc.defaultView.location;
    const cm = CLUSTER_IN_PATH.exec(loc.pathname) || CLUSTER_IN_HASH.exec(loc.hash || '');
    const clusterId = cm && V.isClusterId(cm[1]) ? cm[1] : null;
    const summaries = nativeDbuElements(doc);
    const options = [];
    for (const opt of doc.querySelectorAll('[role="option"]')) {
      if (opt.closest(OWN)) continue;
      const dbu = dbuIn(text(opt));
      if (dbu) options.push({ el: opt, dbu });
    }
    if (!summaries.length && !options.length) return;
    ensureStyle(doc);
    const photon = detectPhoton(doc);
    const key = 'ap:' + String(photon) + ':' + (clusterId || '-');
    const entry = rateFor(ctx, key, Object.assign({ target: 'allPurpose', photon }, clusterId ? { clusterId } : {}));
    for (const s of summaries) place(doc, { after: s.el }, computeView(s.dbu, entry, photon), rendered, themeName);
    for (const o of options) place(doc, { inside: o.el }, computeView(o.dbu, entry, photon), rendered, themeName);
  }

  /* ------------------------------------------------------------------ hooks */

  function cleanup(doc) {
    for (const n of doc.querySelectorAll(SEL)) n.remove();
  }

  function listen(doc) {
    if (state.listening) return;
    state.listening = true;
    const poke = () => state.lastCtx && state.lastCtx.requestTick && state.lastCtx.requestTick();
    doc.addEventListener('input', poke, true);
    doc.addEventListener('change', poke, true);
  }

  function tick(ctx) {
    const doc = ctx.doc;
    state.lastCtx = ctx;
    const mode = doc.defaultView ? routeMode(doc.defaultView.location) : null;
    if (!mode || ctx.settings.showCosts === false) {
      if (doc.querySelector(SEL)) cleanup(doc);
      return;
    }
    listen(doc);
    const rendered = new Set();
    // Light or dark tokens, matching the page's main container (re-checked every tick).
    const themeName = theme ? theme.pickForPage(doc) : 'light';
    if (mode === 'warehouse') handleWarehouse(ctx, rendered, themeName);
    else handleCompute(ctx, rendered, themeName);
    for (const el of doc.querySelectorAll(PREVIEW)) if (!rendered.has(el)) el.remove();
  }

  (root.DCC.features || (root.DCC.features = [])).push({
    name: FEATURE,
    onStart: tick,
    onTick: tick,
    onRoute: tick,
    onSettings(ctx) {
      state.rates.clear();
      cleanup(ctx.doc);
      tick(ctx);
    },
    onPeriod() {},
    onSummary() {},
  });
  root.DCC.warehousePreview = Object.freeze({ SIZES, AZURE_SERVERLESS_DBU, sizeIn, dbuIn, routeMode, detectWarehouseType, detectPhoton });
})(typeof globalThis !== 'undefined' ? globalThis : this);
