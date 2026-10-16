/*
 * SVG charts for Genie results in the side panel. Draws what src/core/genie-viz.js build()
 * returns (line, bar or scatter) into a host element at the host's pixel width, so text stays
 * at its real size; the panel redraws on resize.
 *
 * Builds on src/explorer/charts.js: its SVG element helper, nice-domain ticks and bindMarks
 * (one Tab stop per chart, arrow keys and Home/End move between marks, hover, focus and tap
 * show exact values). Marks get role="img" with an aria-label holding the exact values; the
 * static layer is a role="img" group with the chart summary. Every label is set through
 * textContent. Colors come from CSS classes (sidepanel.css: --gp-series-1..4, validated for
 * light and dark), so a theme change needs no redraw.
 *
 * Mark specs: 2px lines with round joins, 8px dots with a 2px surface ring, bars at most 14px
 * thick with a 4px rounded data end and a square baseline end, hairline solid grid. Missing
 * values are gaps (lines), "n/a" (bars) or omitted points (scatter), never zero.
 */
(function (root) {
  'use strict';
  const DCC = root.DCC || {};
  const C = DCC.exploreCharts;
  const s = C.s;

  const MONO_W = 0.62; // average advance of IBM Plex Mono, in em
  const SANS_W = 0.56; // average advance of Inter, in em
  const textW = (str, px, mono) => String(str).length * px * (mono ? MONO_W : SANS_W);

  /**
   * Text widths for layout: measured with a hidden SVG probe when the host is in the document
   * (exact for the real fonts), estimated from average advances otherwise (detached, jsdom).
   */
  function measurer(doc, host) {
    let probe = null;
    if (host && host.isConnected) {
      probe = s(doc, 'svg', { class: 'gp-svg', width: 0, height: 0, 'aria-hidden': 'true', style: 'position:absolute;visibility:hidden;pointer-events:none' });
      host.appendChild(probe);
    }
    const cache = new Map();
    return {
      width(str, cls, px, mono) {
        const key = cls + '|' + str;
        if (!cache.has(key)) {
          let w = 0;
          if (probe) {
            const t = s(doc, 'text', { class: cls });
            t.textContent = String(str);
            probe.appendChild(t);
            try {
              w = typeof t.getComputedTextLength === 'function' ? t.getComputedTextLength() : 0;
            } catch (_) {
              w = 0;
            }
            t.remove();
          }
          cache.set(key, w > 0 ? w : textW(str, px, mono));
        }
        return cache.get(key);
      },
      /** Longest prefix of `str` (plus an ellipsis) that fits in `max` px. */
      fit(str, max, cls, px, mono) {
        const full = String(str);
        if (this.width(full, cls, px, mono) <= max) return full;
        let lo = 1;
        let hi = full.length - 1;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (this.width(full.slice(0, mid) + '\u2026', cls, px, mono) <= max) lo = mid;
          else hi = mid - 1;
        }
        return full.slice(0, lo) + '\u2026';
      },
      done() {
        if (probe) probe.remove();
      },
    };
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const fx = (n) => Math.round(n * 10) / 10;

  function h(doc, tag, attrs, children) {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else el.setAttribute(k, String(v));
    }
    for (const c of [].concat(children === undefined ? [] : children)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    }
    return el;
  }

  function text(doc, x, y, str, cls, attrs) {
    const t = s(doc, 'text', Object.assign({ x: fx(x), y: fx(y), class: cls }, attrs || {}));
    t.textContent = str;
    return t;
  }

  /** The svg frame: a role="img" summary layer, a marks layer and a pointer-free overlay. */
  function frame(doc, W, H, label, summary, kind) {
    const svg = s(doc, 'svg', { class: 'gp-svg gp-svg--' + kind, width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'group', 'aria-label': label });
    const base = s(doc, 'g', { role: 'img', 'aria-label': summary, class: 'gp-base-layer' });
    const marks = s(doc, 'g', { class: 'gp-marks' });
    const overlay = s(doc, 'g', { class: 'gp-overlay', 'aria-hidden': 'true', 'pointer-events': 'none' });
    svg.append(base, marks, overlay);
    return { svg, base, marks, overlay };
  }

  /** Tooltip: values lead (strong), names follow; a short line key per series. */
  function tooltip(doc) {
    const tip = h(doc, 'div', { class: 'gp-tip', 'aria-hidden': 'true', hidden: true });
    return {
      el: tip,
      show(head, rows, x, y, plotW) {
        tip.textContent = '';
        if (head) tip.appendChild(h(doc, 'p', { class: 'gp-tip-head' }, head));
        for (const r of rows) {
          const line = h(doc, 'p', { class: 'gp-tip-row' });
          if (r.cls) {
            const key = s(doc, 'svg', { class: 'gp-key', width: 12, height: 8, viewBox: '0 0 12 8', 'aria-hidden': 'true' }, [s(doc, 'line', { x1: 0, x2: 12, y1: 4, y2: 4, class: 'gp-line ' + r.cls })]);
            line.appendChild(key);
          }
          line.appendChild(h(doc, 'strong', { class: r.value === null ? 'gp-na' : null }, r.value === null ? 'n/a' : r.value));
          if (r.name) line.appendChild(h(doc, 'span', {}, r.name));
          tip.appendChild(line);
        }
        tip.hidden = false;
        const w = tip.offsetWidth || 140;
        const ht = tip.offsetHeight || 40;
        const left = clamp(x - w / 2, 0, Math.max(0, plotW - w));
        const top = y - ht - 10 < 0 ? y + 14 : y - ht - 10;
        tip.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
      },
      hide() {
        tip.hidden = true;
      },
    };
  }

  /** Marks are inspectable images, not buttons: nothing happens on activation. */
  function bind(list, handlers, svg, tip) {
    if (!list.length) return;
    C.bindMarks(list, handlers, 0);
    for (const m of list) m.el.setAttribute('role', 'img');
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') tip.hide();
    });
    svg.addEventListener('pointerleave', () => tip.hide());
  }

  /* ---------------------------------------------------------------- line */

  function line(doc, data, W, M) {
    const H = Math.round(clamp(W * 0.56, 168, 248));
    const ys = [];
    for (const se of data.series) for (const p of se.points) if (p.y !== null) ys.push(p.y);
    const dom = C.domain(ys, 4);
    const labels = dom.ticks.map((t) => data.axis(t));
    const m = { l: Math.ceil(Math.max(...labels.map((t) => M.width(t, 'gp-tick', 10.5, true)))) + 10, r: 14, t: 10, b: 26 };
    const pw = Math.max(40, W - m.l - m.r);
    const ph = H - m.t - m.b;
    const x0 = data.xs[0];
    const x1 = data.xs[data.xs.length - 1];
    const xOf = (ms) => (x1 === x0 ? m.l + pw / 2 : m.l + ((ms - x0) / (x1 - x0)) * pw);
    const yOf = (v) => m.t + ((dom.hi - v) / (dom.hi - dom.lo)) * ph;
    const f = frame(doc, W, H, data.caption, data.summary, 'line');
    dom.ticks.forEach((t, i) => {
      const y = yOf(t);
      f.base.appendChild(s(doc, 'line', { x1: m.l, x2: W - m.r, y1: fx(y), y2: fx(y), class: t === 0 ? 'gp-baseline' : 'gp-grid' }));
      f.base.appendChild(text(doc, m.l - 6, y + 3.5, labels[i], 'gp-tick', { 'text-anchor': 'end' }));
    });
    // X labels sit on real data points, evenly spaced by index; the end labels hug the edges.
    const k = clamp(Math.floor(pw / 74), 2, data.xs.length);
    const picks = new Set();
    for (let i = 0; i < k; i++) picks.add(Math.round((i * (data.xs.length - 1)) / Math.max(1, k - 1)));
    for (const i of picks) {
      const ms = data.xs[i];
      const anchor = data.xs.length === 1 ? 'middle' : i === 0 ? 'start' : i === data.xs.length - 1 ? 'end' : 'middle';
      f.base.appendChild(text(doc, xOf(ms), H - 8, data.tick(ms), 'gp-tick', { 'text-anchor': anchor }));
    }
    const single = data.series.length === 1;
    // Every point gets a dot only while that stays readable; otherwise the last point and any
    // point isolated by gaps keep theirs.
    const dotsAll = data.xs.length <= (single ? 16 : 8);
    for (const se of data.series) {
      const segs = [];
      let cur = [];
      for (const p of se.points) {
        if (p.y === null) {
          if (cur.length) segs.push(cur);
          cur = [];
        } else cur.push(p);
      }
      if (cur.length) segs.push(cur);
      const g = s(doc, 'g', { class: 'gp-series', 'data-series': se.key });
      for (const seg of segs) {
        const pts = seg.map((p) => fx(xOf(p.x)) + ',' + fx(yOf(p.y)));
        if (single && seg.length > 1) {
          const base = fx(yOf(Math.max(dom.lo, Math.min(0, dom.hi))));
          g.appendChild(s(doc, 'path', { class: 'gp-area ' + se.cls, d: 'M' + pts.join(' L') + ' L' + fx(xOf(seg[seg.length - 1].x)) + ',' + base + ' L' + fx(xOf(seg[0].x)) + ',' + base + ' Z' }));
        }
        if (seg.length > 1) g.appendChild(s(doc, 'polyline', { class: 'gp-line ' + se.cls, points: pts.join(' ') }));
      }
      const valued = se.points.filter((p) => p.y !== null);
      const lonely = (p) => {
        const i = se.points.indexOf(p);
        return (i === 0 || se.points[i - 1].y === null) && (i === se.points.length - 1 || se.points[i + 1].y === null);
      };
      for (const p of valued) {
        if (dotsAll || p === valued[valued.length - 1] || lonely(p)) g.appendChild(s(doc, 'circle', { class: 'gp-dot ' + se.cls, cx: fx(xOf(p.x)), cy: fx(yOf(p.y)), r: 4 }));
      }
      f.base.appendChild(g);
    }
    const cross = s(doc, 'line', { class: 'gp-cross', x1: 0, x2: 0, y1: m.t, y2: H - m.b, visibility: 'hidden' });
    const focus = s(doc, 'g', { class: 'gp-focus' });
    f.overlay.append(cross, focus);
    const tip = tooltip(doc);
    const marks = data.xs.map((ms, i) => {
      const left = i === 0 ? m.l : (xOf(data.xs[i - 1]) + xOf(ms)) / 2;
      const right = i === data.xs.length - 1 ? W - m.r : (xOf(ms) + xOf(data.xs[i + 1])) / 2;
      const el = s(doc, 'rect', { class: 'gp-hit', x: fx(left), y: m.t, width: fx(Math.max(1, right - left)), height: ph, fill: 'transparent' });
      f.marks.appendChild(el);
      const rows = data.series.map((se) => {
        const p = se.points.find((q) => q.x === ms);
        return { cls: data.series.length > 1 ? se.cls : null, name: data.series.length > 1 ? se.name : null, value: p && p.y !== null ? p.text : null, y: p ? p.y : null, se };
      });
      const label = data.xText(ms) + ': ' + rows.map((r) => (data.series.length > 1 ? r.se.name + ' ' : data.series[0].name + ' ') + (r.value === null ? 'n/a' : r.value)).join(', ');
      return { el, info: { label, key: String(i), ms, rows } };
    });
    bind(
      marks,
      {
        onInspect(info) {
          const x = xOf(info.ms);
          cross.setAttribute('x1', fx(x));
          cross.setAttribute('x2', fx(x));
          cross.setAttribute('visibility', 'visible');
          focus.textContent = '';
          let top = H;
          for (const r of info.rows) {
            if (r.y === null) continue;
            top = Math.min(top, yOf(r.y));
            focus.appendChild(s(doc, 'circle', { class: 'gp-dot gp-dot--active ' + r.se.cls, cx: fx(x), cy: fx(yOf(r.y)), r: 5 }));
          }
          tip.show(data.xText(info.ms), info.rows, x, top === H ? m.t : top, W);
        },
        onLeave() {
          cross.setAttribute('visibility', 'hidden');
          focus.textContent = '';
          tip.hide();
        },
      },
      f.svg,
      tip
    );
    return { svg: f.svg, tip };
  }

  /* ---------------------------------------------------------------- bars */

  function barPath(xa, xb, y, hgt) {
    // Rounded at the data end (xb), square at the baseline (xa).
    const r = Math.min(4, Math.abs(xb - xa) / 2, hgt / 2);
    const dir = xb >= xa ? 1 : -1;
    const e = xb - dir * r;
    return ['M' + fx(xa) + ',' + fx(y), 'H' + fx(e), 'Q' + fx(xb) + ',' + fx(y) + ' ' + fx(xb) + ',' + fx(y + r), 'V' + fx(y + hgt - r), 'Q' + fx(xb) + ',' + fx(y + hgt) + ' ' + fx(e) + ',' + fx(y + hgt), 'H' + fx(xa), 'Z'].join(' ');
  }

  function bars(doc, data, W, M) {
    const rowH = 28;
    const barH = 14;
    const items = data.items;
    const H = items.length * rowH + 8;
    const labelW = clamp(Math.max(...items.map((it) => M.width(it.labelText, 'gp-bar-label', 12, false))) + 4, 48, W * 0.42);
    const valueW = Math.max(...items.map((it) => M.width(it.text === null ? 'n/a' : it.text, 'gp-bar-value', 11, true))) + 10;
    const vals = items.filter((it) => it.value !== null).map((it) => it.value);
    const neg = vals.some((v) => v < 0);
    const lo = Math.min(0, ...vals);
    const hi = Math.max(0, ...vals);
    const px0 = labelW + 10 + (neg ? valueW : 0);
    const px1 = Math.max(px0 + 20, W - valueW);
    const xOf = (v) => px0 + ((v - lo) / (hi - lo || 1)) * (px1 - px0);
    const f = frame(doc, W, H, data.caption, data.summary, 'bar');
    const zero = xOf(0);
    f.base.appendChild(s(doc, 'line', { class: 'gp-baseline', x1: fx(zero), x2: fx(zero), y1: 2, y2: H - 2 }));
    const tip = tooltip(doc);
    const marks = items.map((it, i) => {
      const y = 4 + i * rowH;
      const g = s(doc, 'g', { class: 'gp-bar-row', 'data-label': it.label });
      g.appendChild(s(doc, 'rect', { class: 'gp-hit', x: 0, y, width: W, height: rowH, fill: 'transparent' }));
      g.appendChild(text(doc, labelW, y + rowH / 2 + 4, M.fit(it.labelText, labelW - 2, 'gp-bar-label', 12, false), 'gp-bar-label', { 'text-anchor': 'end' }));
      const by = y + (rowH - barH) / 2;
      if (it.value === null) {
        g.appendChild(text(doc, zero + 6, y + rowH / 2 + 4, 'n/a', 'gp-bar-value gp-na'));
      } else {
        const xv = xOf(it.value);
        if (Math.abs(xv - zero) >= 0.5) g.appendChild(s(doc, 'path', { class: 'gp-bar ' + it.cls, d: barPath(zero, xv, by, barH) }));
        const pos = it.value >= 0;
        g.appendChild(text(doc, pos ? Math.max(xv, zero) + 6 : Math.min(xv, zero) - 6, y + rowH / 2 + 4, it.text, 'gp-bar-value', { 'text-anchor': pos ? 'start' : 'end' }));
      }
      f.marks.appendChild(g);
      return { el: g, info: { key: String(i), label: it.labelText + ': ' + (it.text === null ? 'n/a' : it.text), it, y } };
    });
    bind(
      marks,
      {
        onInspect(info, el) {
          for (const mk of marks) mk.el.classList.toggle('is-active', mk.el === el);
          const v = info.it.value;
          tip.show(info.it.labelText, [{ value: info.it.text, name: data.measure.label }], v === null ? zero : xOf(v), info.y + 2, W);
        },
        onLeave() {
          for (const mk of marks) mk.el.classList.remove('is-active');
          tip.hide();
        },
      },
      f.svg,
      tip
    );
    return { svg: f.svg, tip };
  }

  /* ---------------------------------------------------------------- scatter */

  function scatter(doc, data, W, M) {
    const H = Math.round(clamp(W * 0.72, 200, 300));
    const pts = data.points;
    const dy = C.domain(pts.map((p) => p.y), 4);
    const yLabels = dy.ticks.map((t) => data.yAxis(t));
    const m = { l: Math.ceil(Math.max(...yLabels.map((t) => M.width(t, 'gp-tick', 10.5, true)))) + 10, r: 14, t: 22, b: 40 };
    const pw = Math.max(40, W - m.l - m.r);
    const dx = C.domain(pts.map((p) => p.x), clamp(Math.floor(pw / 70), 2, 6));
    const ph = H - m.t - m.b;
    const xOf = (v) => m.l + ((v - dx.lo) / (dx.hi - dx.lo)) * pw;
    const yOf = (v) => m.t + ((dy.hi - v) / (dy.hi - dy.lo)) * ph;
    const f = frame(doc, W, H, data.caption, data.summary, 'scatter');
    dy.ticks.forEach((t, i) => {
      const y = yOf(t);
      f.base.appendChild(s(doc, 'line', { x1: m.l, x2: W - m.r, y1: fx(y), y2: fx(y), class: t === 0 ? 'gp-baseline' : 'gp-grid' }));
      f.base.appendChild(text(doc, m.l - 6, y + 3.5, yLabels[i], 'gp-tick', { 'text-anchor': 'end' }));
    });
    dx.ticks.forEach((t, i) => {
      const x = xOf(t);
      f.base.appendChild(s(doc, 'line', { x1: fx(x), x2: fx(x), y1: m.t, y2: H - m.b, class: t === 0 ? 'gp-baseline' : 'gp-grid' }));
      const anchor = i === 0 ? 'start' : i === dx.ticks.length - 1 ? 'end' : 'middle';
      f.base.appendChild(text(doc, x, H - m.b + 14, data.xAxis(t), 'gp-tick', { 'text-anchor': anchor }));
    });
    f.base.appendChild(text(doc, m.l + pw / 2, H - 6, data.xCol.label, 'gp-axis-title', { 'text-anchor': 'middle' }));
    f.base.appendChild(text(doc, m.l - 6, 12, data.yCol.label, 'gp-axis-title', { 'text-anchor': 'start' }));
    const tip = tooltip(doc);
    const marks = pts.map((p, i) => {
      const cx = fx(xOf(p.x));
      const cy = fx(yOf(p.y));
      const g = s(doc, 'g', { class: 'gp-pt' });
      g.appendChild(s(doc, 'circle', { class: 'gp-hit', cx, cy, r: 12, fill: 'transparent' }));
      g.appendChild(s(doc, 'circle', { class: 'gp-dot s1', cx, cy, r: 4 }));
      f.marks.appendChild(g);
      const label = (p.label ? p.label + ': ' : '') + data.xCol.label + ' ' + p.xText + ', ' + data.yCol.label + ' ' + p.yText;
      return { el: g, info: { key: String(i), label, p, cx, cy } };
    });
    bind(
      marks,
      {
        onInspect(info, el) {
          for (const mk of marks) mk.el.classList.toggle('is-active', mk.el === el);
          tip.show(info.p.label, [{ value: info.p.yText, name: data.yCol.label }, { value: info.p.xText, name: data.xCol.label }], info.cx, info.cy, W);
        },
        onLeave() {
          for (const mk of marks) mk.el.classList.remove('is-active');
          tip.hide();
        },
      },
      f.svg,
      tip
    );
    return { svg: f.svg, tip };
  }

  /* ---------------------------------------------------------------- public */

  /**
   * Draw `data` (genie-viz build() output) into `host`, replacing what was there.
   * @param {{width:number, caption?:boolean}} opts width in CSS px (the host's content width);
   *   caption false keeps the caption for screen readers only
   */
  function draw(doc, host, data, opts) {
    const W = Math.max(220, Math.floor((opts && opts.width) || 320));
    const M = measurer(doc, host);
    let out = null;
    try {
      out = data.type === 'line' ? line(doc, data, W, M) : data.type === 'bar' ? bars(doc, data, W, M) : data.type === 'scatter' ? scatter(doc, data, W, M) : null;
    } finally {
      M.done();
    }
    const fig = h(doc, 'figure', { class: 'gp-fig', 'data-chart': data.type });
    // The caption names the figure; it is only shown when no legend or picker already says it.
    const quiet = (opts && opts.caption === false) || (data.type === 'line' && data.legend);
    fig.appendChild(h(doc, 'figcaption', { class: 'gp-fig-cap' + (quiet ? ' dcc-visually-hidden' : '') }, data.caption));
    if (data.type === 'line' && data.legend) {
      fig.appendChild(
        h(
          doc,
          'ul',
          { class: 'gp-legend', 'aria-label': 'Legend' },
          data.series.map((se) => {
            const key = s(doc, 'svg', { class: 'gp-key', width: 16, height: 10, viewBox: '0 0 16 10', 'aria-hidden': 'true' }, [s(doc, 'line', { x1: 0, x2: 16, y1: 5, y2: 5, class: 'gp-line ' + se.cls })]);
            return h(doc, 'li', {}, [key, h(doc, 'span', {}, se.name)]);
          })
        )
      );
    }
    if (out) fig.appendChild(h(doc, 'div', { class: 'gp-plot' }, [out.svg, out.tip.el]));
    if (data.note) fig.appendChild(h(doc, 'p', { class: 'gp-fig-note' }, data.note));
    host.replaceChildren(fig);
    return fig;
  }

  (root.DCC || (root.DCC = {})).genieChart = Object.freeze({ draw, barPath });
})(typeof globalThis !== 'undefined' ? globalThis : this);
