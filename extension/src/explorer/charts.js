/*
 * Accessible SVG charts for the Explorer. No external libraries, no innerHTML: every node is
 * created with createElementNS and text goes through textContent.
 *
 * Each chart is one <svg role="group"> holding a static <g role="img" aria-label=summary> layer
 * (axes, grid) and focusable marks (role="button", aria-label with exact values) that use a
 * roving tabindex: one Tab stop per chart, arrow keys move between marks, Enter/Space activates
 * (drilldown). Hover, focus and tap call onInspect so the caller can show exact values; on touch
 * the first tap only inspects and a second tap on the same mark activates.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const SVG = 'http://www.w3.org/2000/svg';
  const T = NODE ? require('../core/theme.js') : root.DCC && root.DCC.theme;

  /**
   * Chart colors per theme, from the shared tokens: ink and grid from the text and line tokens,
   * accent blue for the primary series, warm amber for prior-period overlays. Marks are drawn on
   * the theme's bg; segment gaps and rings use bg so they read as spacing in both themes.
   */
  function paletteFor(name) {
    const t = T ? T.tokens(name) : null;
    const dark = name === 'dark';
    return Object.freeze({
      ink: t ? t.text : '#0A0A0A',
      muted: t ? t.muted : '#6B6B74',
      grid: t ? t.line : '#E4E4E7',
      axis: t ? (dark ? t.muted : t.faint) : '#A1A1AA',
      accent: t ? t.accent : '#2F5BEA',
      warm: t ? t.warm : '#B45309',
      bg: t ? t.bg : '#FFFFFF',
      selFill: t ? t.accentSoft : '#EEF2FF',
      unavailable: dark ? '#6E6E76' : '#8A8A93',
      hatchBg: t ? t.surface2 : '#EFEFF1',
    });
  }
  const PALETTES = Object.freeze({ light: paletteFor('light'), dark: paletteFor('dark') });
  const colors = (theme) => (theme === 'dark' ? PALETTES.dark : PALETTES.light);
  // Light-theme values, kept for callers that don't pass a theme.
  const INK = PALETTES.light.ink;
  const MUTED = PALETTES.light.muted;
  const ACCENT = PALETTES.light.accent;
  const WARM = PALETTES.light.warm;
  const UNAVAILABLE = PALETTES.light.unavailable;
  let uid = 0;

  function s(doc, tag, attrs, children) {
    const el = doc.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      el.setAttribute(k, String(v));
    }
    for (const c of [].concat(children === undefined ? [] : children)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? doc.createTextNode(String(c)) : c);
    }
    return el;
  }

  function text(doc, x, y, str, attrs = {}) {
    const t = s(doc, 'text', Object.assign({ x, y, fill: MUTED, 'font-size': 10 }, attrs));
    // fill comes from attrs (theme palette) whenever the caller passes one.
    t.textContent = str;
    return t;
  }

  /** Shorten to n chars; `fromStart` keeps the tail (useful for paths). */
  function truncate(str, n, fromStart) {
    const v = String(str === null || str === undefined ? '' : str);
    if (v.length <= n) return v;
    return fromStart ? '…' + v.slice(v.length - Math.max(1, n - 1)) : v.slice(0, Math.max(1, n - 1)) + '…';
  }

  function niceStep(range, count) {
    const raw = range / Math.max(1, count);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nf * p;
  }

  // Duration steps in minutes, so time axes read 15m, 30m, 1h, 2h … rather than 1.7h.
  const MINUTE_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440, 2880, 10080];

  /** Nice linear domain including zero (`minutes` picks time-friendly steps). */
  function domain(values, count = 4, minutes = false) {
    const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
    let lo = Math.min(0, ...v);
    let hi = Math.max(0, ...v);
    if (hi === lo) hi = lo + 1;
    const raw = (hi - lo) / Math.max(1, count);
    const step = minutes ? MINUTE_STEPS.find((m) => m >= raw) || niceStep(hi - lo, count) : niceStep(hi - lo, count);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.abs(t) < step / 1e6 ? 0 : t);
    return { lo, hi, ticks };
  }

  function hatch(doc, defs, P = PALETTES.light) {
    const id = 'dcc-hatch-' + ++uid;
    defs.appendChild(
      s(doc, 'pattern', { id, width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, [
        s(doc, 'rect', { width: 4, height: 4, fill: P.hatchBg }),
        s(doc, 'line', { x1: 0, y1: 0, x2: 0, y2: 4, stroke: P.unavailable, 'stroke-width': 1.5 }),
      ])
    );
    return 'url(#' + id + ')';
  }

  function frame(doc, width, height, title, summary, cls, fixed) {
    // Fixed-size charts (calendar) keep their natural size; others scale to the panel width.
    const svg = s(doc, 'svg', { class: 'chart ' + (cls || ''), viewBox: '0 0 ' + width + ' ' + height, width: fixed ? width : '100%', role: 'group', 'aria-label': title, 'data-dcc': 'explorer' });
    const defs = s(doc, 'defs');
    const base = s(doc, 'g', { role: 'img', 'aria-label': summary, class: 'base' });
    const marks = s(doc, 'g', { class: 'marks' });
    const overlay = s(doc, 'g', { class: 'overlay', 'aria-hidden': 'true', 'pointer-events': 'none' });
    svg.append(defs, base, marks, overlay);
    return { svg, defs, base, marks, overlay };
  }

  /**
   * Wire focus, hover, tap and keyboard behavior for a list of marks.
   * @param {object[]} list [{el, info}] in navigation order
   * @param {object} h {onInspect(info, el, extra), onLeave(info), onActivate(info, el), onKey?(e, index, list) → newIndex|undefined}
   * @param {number} active initially tabbable index
   */
  function bindMarks(list, h, active = 0) {
    let touched = null;
    let pinned = null;
    const idx = Math.max(0, Math.min(list.length - 1, active));
    list.forEach(({ el, info }, i) => {
      el.setAttribute('tabindex', i === idx ? '0' : '-1');
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', info.label);
      el.setAttribute('focusable', 'true');
      if (info.key !== undefined) el.setAttribute('data-fk', 'mark:' + info.key);
      el.addEventListener('focus', () => {
        // Keep exactly one Tab stop: the mark that last had focus.
        for (const m of list) m.el.setAttribute('tabindex', m.el === el ? '0' : '-1');
        if (h.onInspect) h.onInspect(info, el, { via: 'focus' });
      });
      el.addEventListener('blur', () => h.onLeave && h.onLeave(info));
      el.addEventListener('mouseenter', () => h.onInspect && h.onInspect(info, el, { via: 'hover' }));
      el.addEventListener('mouseleave', () => h.onLeave && h.onLeave(info));
      el.addEventListener('pointerdown', (e) => {
        touched = e.pointerType === 'touch' || e.pointerType === 'pen' ? el : null;
      });
      el.addEventListener('click', (e) => {
        if (touched === el && pinned !== el) {
          // First tap on touch: show exact values only.
          pinned = el;
          touched = null;
          if (h.onInspect) h.onInspect(info, el, { via: 'tap' });
          e.preventDefault();
          return;
        }
        touched = null;
        pinned = null;
        if (h.onActivate) h.onActivate(info, el);
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (h.onActivate) h.onActivate(info, el);
          return;
        }
        let next;
        if (h.onKey) next = h.onKey(e, i, list);
        if (next === undefined) {
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = i + 1;
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = i - 1;
          else if (e.key === 'Home') next = 0;
          else if (e.key === 'End') next = list.length - 1;
          else return;
        }
        if (next === null) return;
        e.preventDefault();
        next = Math.max(0, Math.min(list.length - 1, next));
        if (next === i) return;
        el.setAttribute('tabindex', '-1');
        list[next].el.setAttribute('tabindex', '0');
        list[next].el.focus();
      });
    });
  }

  function yAxis(doc, f, d, x0, x1, yOf, fmt, P = PALETTES.light) {
    for (const t of d.ticks) {
      const y = yOf(t);
      f.base.appendChild(s(doc, 'line', { x1: x0, x2: x1, y1: y, y2: y, stroke: t === 0 ? P.axis : P.grid, 'stroke-width': 1 }));
      f.base.appendChild(text(doc, x0 - 4, y + 3, fmt(t), { 'text-anchor': 'end', fill: P.muted }));
    }
  }

  /**
   * Stacked daily bars with total trend line and aligned prior-period overlay.
   * @param {object} o {width,height,title,summary, days:[{date, axisLabel, cost, status, prior:{cost,status},
   *   segments:[{key,label,color,cost}], flagged, selected, label}], showPrior, formatAxis,
   *   onInspect, onLeave, onActivate}
   */
  function stackedBars(doc, o) {
    const P = colors(o.theme);
    const W = o.width || 720;
    const H = o.height || 230;
    const m = { l: 56, r: 10, t: 16, b: 26 };
    const f = frame(doc, W, H, o.title, o.summary, 'stacked');
    const fill = hatch(doc, f.defs, P);
    const n = Math.max(1, o.days.length);
    const band = (W - m.l - m.r) / n;
    const bw = Math.max(2, Math.min(28, band * 0.72));
    const vals = [];
    for (const d of o.days) {
      let pos = 0;
      let neg = 0;
      for (const sg of d.segments) if (typeof sg.cost === 'number') (sg.cost >= 0 ? (pos += sg.cost) : (neg += sg.cost));
      vals.push(pos, neg, d.cost);
      if (o.showPrior && d.prior) vals.push(d.prior.cost);
    }
    const dom = domain(vals);
    const yOf = (v) => m.t + ((dom.hi - v) / (dom.hi - dom.lo)) * (H - m.t - m.b);
    yAxis(doc, f, dom, m.l, W - m.r, yOf, o.formatAxis || String, P);
    const every = Math.max(1, Math.ceil(n / (W / 64)));
    const marks = [];
    o.days.forEach((d, i) => {
      const cx = m.l + i * band + band / 2;
      if (i % every === 0) f.base.appendChild(text(doc, cx, H - 8, d.axisLabel, { 'text-anchor': 'middle', fill: P.muted }));
      const g = s(doc, 'g', { class: 'col' + (d.selected ? ' selected' : ''), 'data-date': d.date });
      g.appendChild(s(doc, 'rect', { class: 'hit', x: cx - band / 2, y: m.t, width: band, height: H - m.t - m.b, fill: 'transparent' }));
      if (d.status === 'unavailable') {
        g.appendChild(s(doc, 'rect', { x: cx - bw / 2, y: yOf(0) - 8, width: bw, height: 8, fill, stroke: P.unavailable, 'stroke-width': 1 }));
      } else {
        let pos = 0;
        let neg = 0;
        for (const sg of d.segments) {
          if (typeof sg.cost !== 'number' || sg.cost === 0) continue;
          const from = sg.cost >= 0 ? pos : neg;
          const to = from + sg.cost;
          if (sg.cost >= 0) pos = to;
          else neg = to;
          const y = Math.min(yOf(from), yOf(to));
          const h = Math.max(0.5, Math.abs(yOf(from) - yOf(to)));
          const seg = s(doc, 'rect', { class: 'seg', x: cx - bw / 2, y, width: bw, height: h, fill: sg.color, stroke: P.bg, 'stroke-width': 1, 'data-key': sg.key });
          seg.addEventListener('mouseenter', (e) => {
            e.stopPropagation();
            if (o.onInspect) o.onInspect(Object.assign({}, d.info, { segment: sg }), g, { via: 'hover' });
          });
          g.appendChild(seg);
        }
        if (d.status === 'partial' || d.status === 'unpriced') {
          g.appendChild(s(doc, 'rect', { x: cx - bw / 2 - 1, y: Math.min(yOf(pos), yOf(0)) - 1, width: bw + 2, height: Math.abs(yOf(pos) - yOf(neg)) + 2, fill: 'none', stroke: P.ink, 'stroke-width': 1, 'stroke-dasharray': '2 2' }));
        }
      }
      if (d.selected) g.appendChild(s(doc, 'rect', { x: cx - band / 2 + 0.5, y: m.t - 4, width: band - 1, height: H - m.t - m.b + 4, fill: 'none', stroke: P.accent, 'stroke-width': 2, rx: 2 }));
      f.marks.appendChild(g);
      marks.push({ el: g, info: d.info, x: cx });
    });
    // Lines on top: total trend (solid) and aligned prior period (dashed). Gaps stay gaps.
    const line = (get, attrs) => {
      let pts = [];
      const flush = () => {
        if (pts.length > 1) f.overlay.appendChild(s(doc, 'polyline', Object.assign({ points: pts.join(' '), fill: 'none' }, attrs)));
        else if (pts.length === 1) f.overlay.appendChild(s(doc, 'circle', { cx: pts[0].split(',')[0], cy: pts[0].split(',')[1], r: 1.6, fill: attrs.stroke }));
        pts = [];
      };
      o.days.forEach((d, i) => {
        const v = get(d);
        if (typeof v === 'number' && Number.isFinite(v)) pts.push((m.l + i * band + band / 2).toFixed(1) + ',' + yOf(v).toFixed(1));
        else flush();
      });
      flush();
    };
    if (o.showPrior) line((d) => d.prior && d.prior.cost, { stroke: P.warm, 'stroke-width': 1.5, 'stroke-dasharray': '4 3', class: 'prior-line' });
    if (o.showTrend !== false) line((d) => d.cost, { stroke: P.ink, 'stroke-width': 1.5, class: 'trend-line' });
    o.days.forEach((d, i) => {
      if (!d.flagged) return;
      const cx = m.l + i * band + band / 2;
      const y = Math.min(yOf(typeof d.cost === 'number' ? Math.max(d.cost, 0) : 0), yOf(0)) - 7;
      f.overlay.appendChild(s(doc, 'path', { d: `M${cx} ${y - 4} L${cx + 4} ${y} L${cx} ${y + 4} L${cx - 4} ${y} Z`, fill: P.ink, class: 'flag' }));
    });
    const sel = o.days.findIndex((d) => d.selected);
    bindMarks(marks, o, sel >= 0 ? sel : 0);
    return f.svg;
  }

  /**
   * Ranked horizontal bars with optional prior-period ticks.
   * @param {object} o {width,title,summary, items:[{key,label,value,prior,color,selected,flagged,info}], formatAxis,
   *   formatValue, labelWidth, onInspect, onLeave, onActivate}
   */
  function hBars(doc, o) {
    const P = colors(o.theme);
    const W = o.width || 720;
    const row = o.rowHeight || 20;
    const lw = o.labelWidth || 190;
    const m = { l: lw, r: 70, t: 18, b: 6 };
    const H = m.t + m.b + row * Math.max(1, o.items.length);
    const f = frame(doc, W, H, o.title, o.summary, 'hbars');
    const vals = [];
    for (const it of o.items) vals.push(it.value, it.prior);
    const dom = domain(vals, 4);
    const xOf = (v) => m.l + ((v - dom.lo) / (dom.hi - dom.lo)) * (W - m.l - m.r);
    for (const t of dom.ticks) {
      const x = xOf(t);
      f.base.appendChild(s(doc, 'line', { x1: x, x2: x, y1: m.t - 4, y2: H - m.b, stroke: t === 0 ? P.axis : P.grid }));
      f.base.appendChild(text(doc, x, m.t - 7, (o.formatAxis || String)(t), { 'text-anchor': 'middle', fill: P.muted }));
    }
    const marks = [];
    o.items.forEach((it, i) => {
      const y = m.t + i * row;
      const g = s(doc, 'g', { class: 'hrow' + (it.selected ? ' selected' : '') });
      g.appendChild(s(doc, 'rect', { class: 'hit', x: 0, y, width: W, height: row, fill: it.selected ? P.selFill : 'transparent' }));
      g.appendChild(text(doc, lw - 6, y + row / 2 + 3.5, truncate(it.label, Math.floor((lw - 8) / 7), it.truncateStart), { 'text-anchor': 'end', fill: P.ink, 'font-size': 11 }));
      const hasPrior = typeof it.prior === 'number' && Number.isFinite(it.prior);
      const xp = hasPrior ? xOf(it.prior) : -Infinity;
      if (typeof it.value === 'number' && Number.isFinite(it.value)) {
        const x0 = xOf(0);
        const x1 = xOf(it.value);
        g.appendChild(s(doc, 'rect', { class: 'bar', x: Math.min(x0, x1), y: y + 4, width: Math.max(1, Math.abs(x1 - x0)), height: row - 8, fill: it.color || P.accent, rx: 2 }));
        // Value label sits past both the bar end and the prior tick so they never overlap.
        g.appendChild(text(doc, Math.max(x0, x1, xp) + 5, y + row / 2 + 3.5, it.valueLabel || (o.formatValue || String)(it.value), { fill: P.ink }));
      } else {
        g.appendChild(text(doc, Math.max(xOf(0), xp) + 5, y + row / 2 + 3.5, it.valueLabel || 'unavailable', { fill: P.muted, 'font-style': 'italic' }));
      }
      if (hasPrior) g.appendChild(s(doc, 'line', { class: 'prior-tick', x1: xp, x2: xp, y1: y + 2, y2: y + row - 2, stroke: P.warm, 'stroke-width': 2 }));
      if (it.flagged) g.appendChild(s(doc, 'circle', { cx: 6, cy: y + row / 2, r: 3.5, fill: P.ink }));
      f.marks.appendChild(g);
      marks.push({ el: g, info: it.info });
    });
    const sel = o.items.findIndex((it) => it.selected);
    bindMarks(marks, o, sel >= 0 ? sel : 0);
    return f.svg;
  }

  /**
   * Duration (x) vs cost (y) scatter. Points falling in the same pixel cell form one group mark;
   * Up/Down cycles through the group's members, Enter activates the group (list or select).
   * @param {object} o {width,height,title,summary, points:[{key,x,y,flagged,selected,info}], formatX, formatY,
   *   xLabel, yLabel, onInspect(group, el, {member}), onLeave, onActivate(group)}
   */
  function scatter(doc, o) {
    const P = colors(o.theme);
    const W = o.width || 720;
    const H = o.height || 260;
    const m = { l: 60, r: 14, t: 14, b: 34 };
    const f = frame(doc, W, H, o.title, o.summary, 'scatter');
    const dx = domain(o.points.map((p) => p.x), 5, Boolean(o.timeAxis));
    const dy = domain(o.points.map((p) => p.y), 4);
    const xOf = (v) => m.l + ((v - dx.lo) / (dx.hi - dx.lo)) * (W - m.l - m.r);
    const yOf = (v) => m.t + ((dy.hi - v) / (dy.hi - dy.lo)) * (H - m.t - m.b);
    yAxis(doc, f, dy, m.l, W - m.r, yOf, o.formatY || String, P);
    for (const t of dx.ticks) {
      const x = xOf(t);
      f.base.appendChild(s(doc, 'line', { x1: x, x2: x, y1: m.t, y2: H - m.b, stroke: P.grid }));
      f.base.appendChild(text(doc, x, H - m.b + 12, (o.formatX || String)(t), { 'text-anchor': 'middle', fill: P.muted }));
    }
    f.base.appendChild(text(doc, (m.l + W - m.r) / 2, H - 4, o.xLabel || '', { 'text-anchor': 'middle', fill: P.ink }));
    f.base.appendChild(text(doc, 10, m.t + (H - m.t - m.b) / 2, o.yLabel || '', { 'text-anchor': 'middle', fill: P.ink, transform: `rotate(-90 10 ${m.t + (H - m.t - m.b) / 2})` }));
    const cell = o.cell || 7;
    const groups = new Map();
    for (const p of o.points) {
      const px = xOf(p.x);
      const py = yOf(p.y);
      const k = Math.round(px / cell) + '|' + Math.round(py / cell);
      if (!groups.has(k)) groups.set(k, { key: k, px, py, members: [] });
      groups.get(k).members.push(p);
    }
    const list = [...groups.values()].sort((a, b) => a.px - b.px || b.py - a.py);
    const marks = [];
    const cursor = new Map();
    for (const gr of list) {
      gr.flagged = gr.members.some((p) => p.flagged);
      gr.selected = gr.members.some((p) => p.selected);
      const count = gr.members.length;
      const g = s(doc, 'g', { class: 'pt' + (gr.selected ? ' selected' : '') + (gr.flagged ? ' flagged' : ''), 'data-count': count });
      const r = count > 1 ? 6.5 : 4.5;
      g.appendChild(s(doc, 'circle', { class: 'hit', cx: gr.px, cy: gr.py, r: 10, fill: 'transparent' }));
      g.appendChild(s(doc, 'circle', { cx: gr.px, cy: gr.py, r, fill: gr.flagged ? P.bg : P.accent, 'fill-opacity': gr.flagged ? 1 : 0.85, stroke: gr.flagged ? P.ink : P.bg, 'stroke-width': gr.flagged ? 2.5 : 1 }));
      if (count > 1) g.appendChild(text(doc, gr.px, gr.py + 3, String(count), { 'text-anchor': 'middle', fill: gr.flagged ? P.ink : P.bg, 'font-size': 8, 'font-weight': 700 }));
      if (gr.selected) g.appendChild(s(doc, 'circle', { cx: gr.px, cy: gr.py, r: r + 3.5, fill: 'none', stroke: P.accent, 'stroke-width': 2 }));
      f.marks.appendChild(g);
      const info = o.groupInfo ? o.groupInfo(gr) : { key: gr.key, label: count + ' points', members: gr.members };
      cursor.set(g, 0);
      marks.push({ el: g, info });
    }
    const h = Object.assign({}, o, {
      onKey(e, i, all) {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return undefined;
        const { el, info } = all[i];
        const n = info.members.length;
        if (n < 2) return e.key === 'ArrowUp' ? i - 1 : i + 1;
        const next = (cursor.get(el) + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        cursor.set(el, next);
        if (o.onInspect) o.onInspect(info, el, { via: 'cycle', member: next });
        return null;
      },
    });
    const sel = marks.findIndex((mk) => mk.info.members && mk.info.members.some((p) => p.selected));
    bindMarks(marks, h, sel >= 0 ? sel : 0);
    return f.svg;
  }

  /**
   * Monday-first calendar heatmap. Left/Right move one day, Up/Down one week.
   * @param {object} o {title, summary, weeks:[[cell]], weekdayLabels, weekLabel(week), fillFor(cell),
   *   cellInfo(cell) → info, selectedDate, flagged:Set, onInspect, onLeave, onActivate, cellSize}
   */
  function heatmap(doc, o) {
    const P = colors(o.theme);
    const c = o.cellSize || 22;
    const gap = 3;
    const m = { l: 52, t: 18, r: 6, b: 6 };
    const W = m.l + 7 * (c + gap) + m.r;
    const H = m.t + o.weeks.length * (c + gap) + m.b;
    const f = frame(doc, W, H, o.title, o.summary, 'heatmap', true);
    const fill = hatch(doc, f.defs, P);
    o.weekdayLabels.forEach((lab, i) => f.base.appendChild(text(doc, m.l + i * (c + gap) + c / 2, m.t - 6, lab, { 'text-anchor': 'middle', fill: P.muted })));
    const marks = [];
    const byDate = new Map();
    o.weeks.forEach((week, wi) => {
      const y = m.t + wi * (c + gap);
      f.base.appendChild(text(doc, m.l - 6, y + c / 2 + 3.5, o.weekLabel ? o.weekLabel(week) : '', { 'text-anchor': 'end', fill: P.muted }));
      week.forEach((cellData, di) => {
        if (!cellData.inPeriod) return;
        const x = m.l + di * (c + gap);
        const unavailable = cellData.status === 'unavailable';
        const g = s(doc, 'g', { class: 'cell' + (cellData.date === o.selectedDate ? ' selected' : ''), 'data-date': cellData.date });
        g.appendChild(s(doc, 'rect', { x, y, width: c, height: c, rx: 3, fill: unavailable ? fill : o.fillFor(cellData), stroke: unavailable ? P.unavailable : cellData.status === 'partial' || cellData.status === 'unpriced' ? P.ink : 'none', 'stroke-width': 1, 'stroke-dasharray': cellData.status === 'partial' || cellData.status === 'unpriced' ? '2 2' : null }));
        if (o.flagged && o.flagged.has(cellData.date)) g.appendChild(s(doc, 'path', { d: `M${x + c - 8} ${y + 1} L${x + c - 1} ${y + 1} L${x + c - 1} ${y + 8} Z`, fill: P.ink, class: 'flag' }));
        // Selected: white inset ring (visible on any fill). Focus: ink ring outside the cell.
        if (cellData.date === o.selectedDate) g.appendChild(s(doc, 'rect', { class: 'sel-ring', x: x + 2.5, y: y + 2.5, width: c - 5, height: c - 5, rx: 2, fill: 'none', stroke: P.bg, 'stroke-width': 2 }));
        g.appendChild(s(doc, 'rect', { class: 'focus-ring', x: x - 2, y: y - 2, width: c + 4, height: c + 4, rx: 4, fill: 'none', stroke: P.ink, 'stroke-width': 2 }));
        f.marks.appendChild(g);
        const info = o.cellInfo(cellData);
        byDate.set(cellData.date, marks.length);
        marks.push({ el: g, info, date: cellData.date });
      });
    });
    const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    const h = Object.assign({}, o, {
      onKey(e, i, all) {
        const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 }[e.key];
        if (!step) return undefined;
        const target = byDate.get(addDays(all[i].date, step));
        return target === undefined ? null : target;
      },
    });
    const sel = byDate.has(o.selectedDate) ? byDate.get(o.selectedDate) : 0;
    bindMarks(marks, h, sel);
    return f.svg;
  }

  /** Legend swatch (HTML-free SVG square) for use inside buttons. */
  function swatch(doc, color, opts = {}) {
    const P = colors(opts.theme);
    const svg = s(doc, 'svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': 'true', class: 'swatch' });
    if (opts.kind === 'line') svg.appendChild(s(doc, 'line', { x1: 0, x2: 10, y1: 5, y2: 5, stroke: color, 'stroke-width': 2, 'stroke-dasharray': opts.dashed ? '3 2' : null }));
    else if (opts.kind === 'hatch') {
      const defs = s(doc, 'defs');
      svg.appendChild(defs);
      svg.appendChild(s(doc, 'rect', { width: 10, height: 10, rx: 2, fill: hatch(doc, defs, P), stroke: P.unavailable }));
    } else if (opts.kind === 'dashed') svg.appendChild(s(doc, 'rect', { x: 0.5, y: 0.5, width: 9, height: 9, fill: 'none', stroke: P.ink, 'stroke-dasharray': '2 2' }));
    else if (opts.kind === 'diamond') svg.appendChild(s(doc, 'path', { d: 'M5 0 L10 5 L5 10 L0 5 Z', fill: P.ink }));
    else if (opts.kind === 'ring') svg.appendChild(s(doc, 'circle', { cx: 5, cy: 5, r: 3.6, fill: P.bg, stroke: P.ink, 'stroke-width': 2 }));
    else if (opts.kind === 'dot') svg.appendChild(s(doc, 'circle', { cx: 5, cy: 5, r: 4, fill: color }));
    else svg.appendChild(s(doc, 'rect', { width: 10, height: 10, rx: 2, fill: color }));
    return svg;
  }

  const api = Object.freeze({ SVG, ACCENT, INK, MUTED, WARM, UNAVAILABLE, colors, paletteFor, s, truncate, domain, niceStep, bindMarks, stackedBars, hBars, scatter, heatmap, swatch });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).exploreCharts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
