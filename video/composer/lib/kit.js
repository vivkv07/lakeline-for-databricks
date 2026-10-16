// Motion-graphics building blocks. Each component builds its DOM once and exposes update(t),
// which writes styles as a pure function of the virtual time t (seconds).
import { E, clamp, lerp, prog, env, ep } from './ease.js';

export const W = 1920, H = 1080;

export function el(tag, cls, parent, style) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (style) Object.assign(n.style, style);
  if (parent) parent.appendChild(n);
  return n;
}

export function svg(markup, parent, cls) {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup.trim(); // static composer-authored SVG constants only
  const n = tpl.content.firstElementChild;
  if (cls) n.setAttribute('class', cls);
  if (parent) parent.appendChild(n);
  return n;
}

export const px = (v) => v.toFixed(3) + 'px';
export function setT(node, x, y, s = 1, extra = '') {
  node.style.transform = `translate(${px(x)}, ${px(y)}) scale(${s.toFixed(5)})${extra}`;
}
export function show(node, on) {
  const d = on ? '' : 'none';
  if (node.style.display !== d) node.style.display = d;
}
export function op(node, o) {
  node.style.opacity = clamp(o).toFixed(4);
  show(node, o > 0.001);
}

/* ----------------------------------------------------------------- icon mark */

/** The extension icon: black rounded square, three bars on a 16-unit grid, the tallest #5B8CFF. */
export function iconMarkSvg(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
    <rect width="16" height="16" rx="3.52" fill="#000"/>
    <rect x="3" y="9" width="2" height="4" fill="#fff"/><rect x="7" y="6" width="2" height="7" fill="#fff"/>
    <rect x="11" y="3" width="2" height="10" fill="#5B8CFF"/></svg>`;
}

/** Animated icon mark built from divs so each bar can grow on its own. */
export function iconMark(parent, size) {
  const root = el('div', 'abs', parent, { width: size + 'px', height: size + 'px' });
  const sq = el('div', 'abs', root, { width: size + 'px', height: size + 'px', borderRadius: size * 0.22 + 'px', background: '#000', boxShadow: '0 0 0 1px rgba(143,176,255,0.10)' });
  const u = size / 16;
  const bars = [[3, 9, '#fff'], [7, 6, '#fff'], [11, 3, '#5B8CFF']].map(([x, top, c]) =>
    el('div', 'abs', sq, { left: x * u + 'px', top: top * u + 'px', width: 2 * u + 'px', height: (13 - top) * u + 'px', background: c, transformOrigin: '50% 100%' }));
  return {
    root, sq, bars, size,
    /** p0: square entrance progress (0..1), barP: per-bar growth progress array. */
    set(sqScale, sqOpacity, barP) {
      sq.style.transform = `scale(${sqScale.toFixed(5)})`;
      sq.style.opacity = clamp(sqOpacity).toFixed(4);
      bars.forEach((b, i) => { b.style.transform = `scaleY(${Math.max(0, barP[i]).toFixed(5)})`; });
    },
  };
}

/* ------------------------------------------------------------ kinetic text */

/**
 * Word-by-word masked reveal. words: string or array of {text, color?}. Returns {el, update(t, t0)}.
 */
export function kinetic(parent, words, { size = 80, weight = 600, color = 'var(--panel-text)', tracking = -0.035, stagger = 0.06, dur = 0.9, lineHeight = 1.06, style = {} } = {}) {
  const root = el('div', 'kt abs', parent, Object.assign({ fontSize: size + 'px', fontWeight: weight, color, letterSpacing: tracking + 'em', lineHeight }, style));
  const list = typeof words === 'string' ? words.split(' ').map((w) => ({ text: w })) : words;
  const spans = [];
  list.forEach((w, i) => {
    if (w.br) { el('br', null, root); return; }
    const wrap = el('span', 'w', root);
    const inner = el('span', null, wrap);
    inner.textContent = w.text;
    if (w.color) inner.style.color = w.color;
    if (w.cls) inner.className = w.cls;
    spans.push(inner);
    if (i < list.length - 1 && !(list[i + 1] && list[i + 1].br)) root.appendChild(document.createTextNode(' '));
  });
  return {
    el: root, spans,
    update(t, t0) {
      spans.forEach((s, i) => {
        const p = ep(t, t0 + i * stagger, dur, E.enter);
        s.style.transform = `translateY(${((1 - p) * 105).toFixed(3)}%)`;
        s.style.opacity = clamp(p * 1.6).toFixed(4);
      });
    },
  };
}

/* ---------------------------------------------------------------- captions */

const t0Of = (item) => item.t0;
/** Drop missing numbers and the separators they would leave dangling. */
function cleanParts(parts) {
  const kept = (parts || []).filter((p) => p != null && p !== '' && !(typeof p === 'object' && (p.num == null || p.num === '')));
  const out = [];
  for (const p of kept) {
    if (p === '·') { if (out.length && out[out.length - 1] !== '·') out.push(p); }
    else out.push(p);
  }
  while (out.length && out[out.length - 1] === '·') out.pop();
  while (out.length && out[0] === '·') out.shift();
  return out;
}

/**
 * Lower-third pill captions in stage space. item: {t0, t1, eyebrow, head, detail | details}.
 * Each pill sits at the bottom-left or bottom-right; layout(choose) picks the side per pill
 * (choose(item, rectLeft, rectRight) → 'left' | 'right'), so it can avoid the camera's focus.
 * The detail line is built only from manifest strings plus static labels and separators.
 */
export const CAP = { margin: 48, bottom: 1080 - 44 };

export function captions(parent, theme) {
  const root = el('div', 'abs t-' + theme, parent, { width: W + 'px', height: H + 'px', zIndex: 80 });
  const scrim = el('div', 'scrim', root);
  const items = [];
  return {
    root, items,
    add(item) {
      const node = el('div', 'cap', root);
      let eb = null;
      if (item.eyebrow) { eb = el('div', 'eyebrow', node); eb.textContent = item.eyebrow; }
      const head = el('div', 'head', node);
      const words = item.head.split(' ');
      const spans = [];
      words.forEach((w, i) => {
        const wrap = el('span', 'w', head, { display: 'inline-block', overflow: 'hidden', verticalAlign: 'top', padding: '0.04em 0.02em 0.14em', margin: '-0.04em -0.02em -0.14em' });
        const sp = el('span', null, wrap, { display: 'inline-block' });
        sp.textContent = w;
        spans.push(sp);
        if (i < words.length - 1) head.appendChild(document.createTextNode(' '));
      });
      // Detail lines: one, or several steps that swap ({t, parts}) as the shown state changes.
      const steps = item.details || (item.detail ? [{ t: item.t0, parts: item.detail }] : []);
      const dets = [];
      let holder = null;
      const cleaned = steps.map((st) => {
        const c = cleanParts(st.parts);
        return c.length && (c.some((p) => typeof p === 'object') || item.detailStatic) ? c : [];
      });
      if (cleaned.some((c) => c.length)) {
        holder = el('div', 'detail', node, { position: 'relative' });
        steps.forEach((st, k) => {
          const d = el('div', null, holder, dets.length ? { position: 'absolute', left: '0px', top: '0px' } : {});
          for (const p of cleaned[k]) {
            if (p === '·') { const sp = el('span', 'sep', d); sp.textContent = '·'; }
            else if (typeof p === 'object') {
              if (p.label) d.appendChild(document.createTextNode(p.label + ' '));
              const sp = el('span', 'num', d);
              sp.textContent = p.num;
              if (p.suffix) d.appendChild(document.createTextNode(' ' + p.suffix));
            } else d.appendChild(document.createTextNode(p));
          }
          if (!cleaned[k].length) d.textContent = '\u00a0';
          dets.push({ t: st.t, el: d });
        });
        // The holder is as wide as the widest step so swapping numbers never reflows the pill.
        holder.style.width = Math.max(...dets.map((d) => d.el.scrollWidth)) + 'px';
      }
      const rec = { item, node, eb, spans, det: holder, dets, side: item.side || 'left' };
      items.push(rec);
      return node;
    },
    /** Measure each pill and place it bottom-left or bottom-right. */
    layout(choose) {
      for (const r of items) {
        const w = r.node.offsetWidth, h = r.node.offsetHeight;
        const top = CAP.bottom - h;
        const L = { x: CAP.margin, y: top, w, h }, R = { x: W - CAP.margin - w, y: top, w, h };
        if (!r.item.side && choose) r.side = choose(r.item, L, R);
        const pos = r.side === 'right' ? R : L;
        r.node.style.left = pos.x + 'px';
        r.node.style.top = pos.y + 'px';
        r.rect = pos;
      }
    },
    update(t) {
      let scrimO = 0;
      for (const { item, node, eb, spans, det, dets } of items) {
        const { t0, t1 } = item;
        const vis = t >= t0 - 0.01 && t <= t1;
        show(node, vis);
        if (!vis) continue;
        const pin = ep(t, t0, 0.6, E.enter);
        const out = Number.isFinite(t1) ? E.exit(prog(t, t1 - 0.35, t1)) : 0;
        const o = Math.min(clamp(pin * 1.4), 1 - out);
        scrimO = Math.max(scrimO, o);
        node.style.opacity = o.toFixed(4);
        node.style.transform = `translateY(${((1 - pin) * 22 + out * 14).toFixed(3)}px)`;
        if (eb) eb.style.opacity = ep(t, t0 + 0.1, 0.6).toFixed(4);
        spans.forEach((sp, i) => {
          const p = ep(t, t0 + 0.12 + i * 0.045, 0.8);
          sp.style.transform = `translateY(${((1 - p) * 105).toFixed(3)}%)`;
        });
        if (det) {
          const p = ep(t, t0 + 0.3 + spans.length * 0.045, 0.7);
          det.style.opacity = p.toFixed(4);
          // Swap numbers in sequence: the old line leaves first, then the new one rises in.
          dets.forEach((d, k) => {
            const next = dets[k + 1];
            const a = k === 0 ? 1 : ep(t, d.t + 0.12, 0.4, E.enter);
            const b = next ? 1 - E.inCubic(prog(t, next.t - 0.1, next.t + 0.1)) : 1;
            const oo = Math.min(a, b);
            d.el.style.opacity = oo.toFixed(4);
            d.el.style.transform = `translateY(${(k === 0 ? 0 : (1 - a) * 10 - (1 - b) * 6).toFixed(3)}px)`;
            d.el.style.visibility = oo > 0.001 ? 'visible' : 'hidden';
          });
        }
      }
      scrim.style.opacity = (scrimO * 0.9).toFixed(4);
    },
  };
}

/* ---------------------------------------------------------- browser window */

const NAV_SVG = `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4 6 9l5 5"/></svg>`;
const FWD_SVG = `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m7 4 5 5-5 5"/></svg>`;
const RLD_SVG = `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 9a5.5 5.5 0 1 1-1.7-4"/><path d="M13.5 2.5v3h-3"/></svg>`;
const LOCK_SVG = `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="2.5" y="6" width="9" height="6.5" rx="1.6"/><path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6"/></svg>`;

/** Height of the browser chrome: one thin row with tabs, address pill and the extension icon. */
export const CHROME_H = 50;

/**
 * Minimal neutral browser window drawn in house tokens: a single 50 px row (window dots, tabs,
 * navigation, address pill, extension icon). Window coordinates: (0,0) is the outer top-left; page
 * content starts at (0, CH). An optional side panel docks at the right of the page.
 */
export function browserWindow(parent, { theme, w, h, host, path = '', tab, tabs: tabList, active = 0, panelW = 0, favColor, tabW = 210 }) {
  const CH = CHROME_H;
  const PW = panelW ? panelW + 1 : 0;
  const Wd = w + PW;
  const root = el('div', 'win t-' + theme, parent, { width: Wd + 'px', height: CH + h + 'px' });
  const frame = el('div', 'frame', root);
  const bar = el('div', 'chrome', frame);
  const dots = el('div', 'dots', bar);
  for (let i = 0; i < 3; i++) el('i', null, dots);
  const list = tabList && tabList.length ? tabList : [{ title: tab || host, host, path, fav: favColor }];
  const tabX0 = 74;
  const titleEls = [];
  const tabEls = list.map((tb, i) => {
    const n = el('div', 'tab', bar, { left: tabX0 + i * (tabW + 6) + 'px', width: tabW + 'px' });
    el('span', 'fav', n, { background: tb.fav || 'var(--line2)' });
    const tt = el('span', 'tt', n);
    tt.textContent = tb.title || tb.host || '';
    titleEls.push(tt);
    return n;
  });
  const navX = tabX0 + list.length * (tabW + 6) + 10;
  const nav = el('div', 'nav', bar, { left: navX + 'px' });
  svg(NAV_SVG, nav); svg(FWD_SVG, nav); svg(RLD_SVG, nav);
  const addrX = navX + 96;
  const addr = el('div', 'addr', bar, { left: addrX + 'px' });
  svg(LOCK_SVG, addr);
  const hs = el('span', null, addr, { color: 'var(--text)' });
  const ps = el('span', 'path', addr, { marginLeft: '-8px' });
  const extX = Wd - 16 - 24 - 14 - 30;
  addr.style.width = Math.max(220, extX - 14 - addrX) + 'px';
  const ext = el('div', 'ext', bar, { left: extX + 'px' });
  ext.appendChild(svg(iconMarkSvg(18)));
  el('div', 'avatar', bar, { left: Wd - 16 - 24 + 'px' });
  const content = el('div', 'content', frame, { top: CH + 'px', width: w + 'px', height: h + 'px' });
  let panel = null;
  if (panelW) panel = el('div', 'panelwrap', frame, { top: CH + 'px', left: w + 'px', width: PW + 'px', height: h + 'px' });
  let cur = -1;
  function setActive(i) {
    if (i === cur) return;
    cur = i;
    tabEls.forEach((n, k) => { n.classList.toggle('on', k === i); });
    const tb = list[i] || list[0];
    hs.textContent = tb.host || '';
    ps.textContent = tb.path || '';
    ps.style.display = tb.path ? '' : 'none';
  }
  setActive(active);
  /** Relabel tab i (e.g. the Databricks tab after a workspace switch). */
  function setTab(i, patch) {
    const tb = list[i];
    if (!tb || (tb.title === patch.title && tb.host === patch.host)) return;
    Object.assign(tb, patch);
    titleEls[i].textContent = tb.title || tb.host || '';
    if (i === cur) { cur = -1; setActive(i); }
  }
  return {
    el: root, frame, content, panel, ext, CH, W: Wd, H: CH + h, w, h, setActive, setTab,
    /** Window-coordinate center of tab i (for cursor clicks). */
    tabCenter(i) { return { x: tabX0 + i * (tabW + 6) + tabW / 2, y: CH / 2 }; },
    icon: { x: extX + 15, y: CH / 2 },
    /** Window-coordinate rect of a box given in page (or panel) CSS px. */
    pageRect(b, pad = 0) { return { x: b.x - pad, y: CH + b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad }; },
    panelRect(b, pad = 0) { return { x: w + 1 + b.x - pad, y: CH + b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad }; },
    rect() { return { x: 0, y: 0, w: Wd, h: CH + h }; },
  };
}

/** Image layer for a capture state, placed unmodified (only positioned/scaled by its container). */
export function shot(parent, state, { offsetY = 0 } = {}) {
  const img = el('img', 'shot', parent);
  img.decoding = 'sync';
  img.loading = 'eager';
  img.alt = '';
  img.src = state.url;
  img.style.width = state.nw / state.dsf + 'px';
  img.style.height = state.nh / state.dsf + 'px';
  img.style.top = -(state.scrollY || 0) + offsetY + 'px';
  img.draggable = false;
  return img;
}

/** Wait for every image under a node to decode. */
export async function decodeAll(node) {
  await Promise.all([...node.querySelectorAll('img')].map((i) => i.decode().catch(() => {})));
}

/* ------------------------------------------------------------------ camera */

/**
 * Camera over a world container in stage coordinates. A view frames a world rect inside a stage
 * area: { s, fx, fy, px, py } means world point (fx, fy) appears at stage (px, py) at scale s.
 * Moves interpolate scale logarithmically and points linearly with an eased progress.
 */
export function view(rect, area, { fit = 'contain', anchor = 'center', maxS = 1.6, minS = 0.1, s: fixedS } = {}) {
  let s = fixedS;
  if (s == null) {
    s = fit === 'width' ? area.w / rect.w : fit === 'height' ? area.h / rect.h : Math.min(area.w / rect.w, area.h / rect.h);
    s = clamp(s, minS, maxS);
  }
  const v = { s, fx: rect.x + rect.w / 2, fy: rect.y + rect.h / 2, px: area.x + area.w / 2, py: area.y + area.h / 2 };
  if (anchor === 'top') { v.fy = rect.y; v.py = area.y; }
  if (anchor === 'left') { v.fx = rect.x; v.px = area.x; }
  return v;
}

export function camera(worldEl) {
  const moves = [];
  let base = null;
  const api = {
    moves,
    set(v) { base = v; return api; },
    to(t0, dur, v, ease = E.camera) { moves.push({ t0, dur, v, ease }); moves.sort((a, b) => a.t0 - b.t0); return api; },
    at(t) {
      let cur = base;
      for (const m of moves) {
        if (t < m.t0) break;
        const p = m.ease(prog(t, m.t0, m.t0 + m.dur));
        cur = p >= 1 ? m.v : mix(cur, m.v, p);
      }
      return cur;
    },
    /** Stage transform at t: world → stage is (x * s + tx, y * s + ty). */
    transformAt(t) {
      const v = api.at(t);
      return { s: v.s, tx: v.px - v.s * v.fx, ty: v.py - v.s * v.fy };
    },
    /** The focus rect of the latest camera target at t (for caption placement). */
    rectAt(t) {
      let r = base && base.rect;
      for (const m of moves) if (t >= m.t0) r = m.v.rect || r;
      return r;
    },
    apply(t, extra = {}) {
      const v = api.at(t);
      const s = v.s * (extra.scale || 1);
      const tx = v.px - s * v.fx + (extra.dx || 0);
      const ty = v.py - s * v.fy + (extra.dy || 0);
      worldEl.style.transform = `translate(${px(tx)}, ${px(ty)}) scale(${s.toFixed(5)})`;
      return { s, tx, ty };
    },
  };
  return api;
}

function mix(a, b, p) {
  return {
    s: Math.exp(lerp(Math.log(a.s), Math.log(b.s), p)),
    fx: lerp(a.fx, b.fx, p), fy: lerp(a.fy, b.fy, p),
    px: lerp(a.px, b.px, p), py: lerp(a.py, b.py, p),
  };
}

/* ------------------------------------------------------------------- rings */

/** Highlight ring around a world rect, drawn just outside it so it never covers UI text. */
export function ring(parent, rect, { t0, t1 = Infinity, pad = 4, warm = false, radius = 10 }) {
  const r = el('div', 'ring' + (warm ? ' warm' : ''), parent);
  const R = { x: rect.x - pad, y: rect.y - pad, w: rect.w + 2 * pad, h: rect.h + 2 * pad };
  Object.assign(r.style, { left: R.x + 'px', top: R.y + 'px', width: R.w + 'px', height: R.h + 'px', borderRadius: radius + 'px' });
  return {
    el: r, rect: R,
    update(t, camS = 1) {
      const vis = env(t, t0, t1, 0.45, 0.3);
      op(r, vis);
      if (vis <= 0) return;
      const p = ep(t, t0, 0.6);
      const k = lerp(1.06, 1, p);
      r.style.transform = `scale(${k.toFixed(5)})`;
      const bw = 3 / camS;
      r.style.borderWidth = bw.toFixed(3) + 'px';
      const glow = 7 / camS;
      r.style.boxShadow = `0 0 0 ${glow.toFixed(2)}px ${warm ? 'rgba(245,184,61,0.16)' : 'rgba(91,140,255,0.18)'}`;
    },
  };
}

/* ------------------------------------------------------------------ cursor */

const CURSOR_SVG = `<svg viewBox="0 0 26 32" xmlns="http://www.w3.org/2000/svg"><path d="M3 2.2v23.6l6.1-5.8 4.1 9.2 3.9-1.7-4-9h8.4z" fill="#fff" stroke="#0A0A0A" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

/**
 * Smooth cursor in world coordinates. path: [{t, x, y, click?}]; moves between waypoints with
 * an eased arc; a click presses the pointer and emits a ripple.
 */
export function cursor(parent, path, { size = 1, appear, vanish } = {}) {
  const c = el('div', 'cursor', parent);
  svg(CURSOR_SVG, c);
  const ripples = path.filter((p) => p.click).map((p) => ({ p, el: el('div', 'ripple', parent) }));
  const t0 = appear != null ? appear : path[0].t - 0.3;
  const t1 = vanish != null ? vanish : path[path.length - 1].t + 0.8;
  function pos(t) {
    if (t <= path[0].t) return [path[0].x, path[0].y];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      // Each move takes a distance-based duration and ends exactly on the waypoint time.
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const dur = clamp(0.38 + dist / 1500, 0.45, 1.15);
      const start = b.from != null ? b.from : Math.max(a.t + (a.click ? 0.18 : 0), b.t - dur);
      if (t <= b.t) {
        if (t <= start) return [a.x, a.y];
        const p = E.inOutCubic(prog(t, start, b.t));
        // A gentle arc: control point offset perpendicular to the move.
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dx = b.x - a.x, dy = b.y - a.y;
        const k = 0.12;
        const cx = mx - dy * k, cy = my + dx * k;
        const u = 1 - p;
        return [u * u * a.x + 2 * u * p * cx + p * p * b.x, u * u * a.y + 2 * u * p * cy + p * p * b.y];
      }
    }
    const l = path[path.length - 1];
    return [l.x, l.y];
  }
  return {
    el: c,
    update(t, camS = 1) {
      const vis = env(t, t0, t1, 0.3, 0.3);
      op(c, vis);
      const [x, y] = pos(t);
      let press = 1;
      for (const { p } of ripples) {
        const d = t - p.t;
        if (d >= -0.08 && d < 0.3) press = Math.min(press, d < 0 ? lerp(1, 0.86, (d + 0.08) / 0.08) : lerp(0.86, 1, E.outBack(clamp(d / 0.3), 2)));
      }
      const sc = size / Math.sqrt(camS);
      c.style.transform = `translate(${px(x - 3 * sc)}, ${px(y - 3 * sc)}) scale(${(sc * press).toFixed(5)})`;
      for (const { p, el: r } of ripples) {
        const d = t - p.t;
        const vis2 = d >= 0 && d < 0.65;
        show(r, vis2);
        if (!vis2) continue;
        const q = E.outCubic(d / 0.65);
        const rad = lerp(6, 34, q) / Math.sqrt(camS);
        Object.assign(r.style, { left: px(p.x - rad), top: px(p.y - rad), width: px(rad * 2), height: px(rad * 2), opacity: ((1 - q) * 0.9).toFixed(4), borderWidth: (2.5 / camS).toFixed(3) + 'px' });
      }
    },
  };
}

/* ------------------------------------------------------------ notification */

/** A stylized, house-style desktop notification (no OS marks) built from the real notification text. */
export function notification(parent, { title, message, context }) {
  const n = el('div', 'notif', parent);
  const row = el('div', 'row', n);
  row.appendChild(svg(iconMarkSvg(22)));
  const b = el('b', null, row);
  b.textContent = 'Lakeline';
  const when = el('span', 'when', row);
  when.textContent = 'now';
  const tt = el('div', 'title', n);
  tt.textContent = title || '';
  const msg = el('div', 'msg', n);
  msg.textContent = message || '';
  if (context) { const c = el('div', 'ctx', n); c.textContent = context; }
  return n;
}

/* ------------------------------------------------------------------- icons */

export const LINE_ICONS = {
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/></svg>',
  route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="8" height="6" rx="1.5"/><rect x="13.5" y="14" width="8" height="6" rx="1.5"/><path d="M6.5 10v3.5a3 3 0 0 0 3 3h4"/><path d="m3 21 18-18" opacity="0"/></svg>',
  session: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="15" rx="2.5"/><path d="M2.5 8.5h19"/><circle cx="12" cy="14" r="2.6"/><path d="M12 12.6v1.4l.9.7"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4H6.5"/><path d="M8.5 8h7M8.5 11.5h4.5"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.4"/></svg>',
};
