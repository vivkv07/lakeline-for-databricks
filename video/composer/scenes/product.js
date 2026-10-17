// Shared scaffolding for product scenes: a camera over a world container (the browser window sits
// at world origin and fills the frame), lower-third pill captions placed away from the focus,
// cross-fading capture stacks, rings and a cursor. Captures are only positioned, scaled, cropped
// and faded; never redrawn.
import { E, clamp, prog, env, ep, lerp } from '../lib/ease.js';
import { el, op, show, camera, view, captions, ring, cursor, shot, decodeAll, px } from '../lib/kit.js';
import { findState, findBox, findText } from '../lib/manifest.js';
import { T, RULES } from '../timeline.js';

/**
 * Framing (notes/VIDEO.md, framing rules and Pacing v2): the full-window shot spans the stage
 * width with FRAME.mx margins and the window top at FRAME.top; push-ins scale 1.25–1.8× from there
 * and place the focus box in the upper part of the frame, above the lower-third captions.
 */
export const FRAME = { mx: 32, top: 24, focusArea: { w: 1760, h: 690 }, focusAt: { x: 960, y: 455 }, minK: 1.25, maxK: RULES.maxZoom };
/** Default timings used by the scenes (seconds). */
export const PACE = { move: 1.5, click: RULES.clickPause, xfade: 0.5, hover: 0.4, tab: RULES.tab };
/** Kept for scenes that frame a rect inside a stage area directly. */
export const AREAS = { full: { x: 32, y: 24, w: 1856, h: 1032 } };
export function productScene(ctx, { n, t0, t1, theme, enter = 'rise', exit = 'sink', sheet = null }) {
  const m = ctx.manifests.scenes[n];
  const warn = (w) => ctx.warn(w);
  const layer = el('div', 'layer t-' + theme, ctx.root);
  // Optional backdrop sheet that rises from the bottom over the previous scene (theme changes).
  let sheetEl = null;
  if (sheet) sheetEl = el('div', 'abs', layer, { width: '1920px', height: '1260px', background: sheet.color });
  const zone = el('div', 'zone', layer, { left: '0px', top: '0px', width: '1920px', height: '1080px' });
  const wrap = el('div', 'abs', zone, { width: '1920px', height: '1080px', transformOrigin: '960px 640px' });
  const world = el('div', 'world', wrap);
  const fxLayer = el('div', 'abs', world); // rings/cursor above everything in world space
  fxLayer.style.zIndex = 50;
  const cam = camera(world);
  const caps = captions(layer, theme);
  const parts = [];
  const rings = [];
  const states = []; // logged UI changes {t, d, kind, label} for the pacing check
  const named = []; // explicit events (answer lands, paste, notification, ...)
  const cursors = [];
  let win = null;
  const sc = {
    n, t0, t1, theme, m, layer, zone, wrap, world, fxLayer, cam, caps, warn,
    area: AREAS.full,
    beats: (T[n] && T[n].beats) || [['intro', 0]],
    /** Absolute time of a named camera beat. */
    beat(name) { const b = sc.beats.find(([nm]) => nm === name); return b ? t0 + b[1] : null; },
    /** Record a named timed event for the sound-effects layer ({t, kind, label, dur?, zoom?}). */
    event(t, kind, label = '', extra = {}) { if (Number.isFinite(t) && t > -1e8) named.push(Object.assign({ t, kind, label }, extra)); },
    /** Log a UI change (crossfade 'state', 'tab' switch, or 'open' for popups and panels). */
    log(t, d, kind = 'state', label = '') { if (t > -1e8) states.push({ t, d, kind, label }); },
    /** One camera move: ease-in-out cubic, no overshoot (default 1.5 s). */
    move(t, v, d = PACE.move) { cam.to(t, d, v, E.inOutCubic); return sc; },
    /** Register the browser window the camera frames. */
    setWindow(w) { win = w; return w; },
    /** Full-window shot: the window spans the stage width (≥ 92 %), top at FRAME.top. */
    full() {
      const Wd = win.W, s = (1920 - 2 * FRAME.mx) / Wd;
      return { s, fx: Wd / 2, fy: 0, px: 960, py: FRAME.top, rect: win.rect() };
    },
    /**
     * Push-in on a world rect: scale k× the full shot (fit to the focus area, clamped to
     * minK..maxK unless k is given), focus placed above the captions, clamped so the window
     * never exposes empty stage at the sides or bottom.
     */
    focus(rect, { k, minK = FRAME.minK, maxK = FRAME.maxK, at = FRAME.focusAt } = {}) {
      const base = sc.full().s;
      const fit = Math.min(FRAME.focusArea.w / rect.w, FRAME.focusArea.h / rect.h) / base;
      const kk = k != null ? k : clamp(fit, minK, maxK);
      const s = base * kk;
      const fx = rect.x + rect.w / 2, fy = rect.y + rect.h / 2;
      let tx = at.x - s * fx, ty = at.y - s * fy;
      const Ww = win.W * s, Wh = win.H * s;
      if (Ww >= 1920 - 2 * FRAME.mx) tx = clamp(tx, 1920 - FRAME.mx - Ww, FRAME.mx);
      if (Wh >= 1080 - FRAME.top) ty = clamp(ty, 1080 - Wh, FRAME.top);
      return { s, fx, fy, px: tx + s * fx, py: ty + s * fy, rect };
    },
    pre: 0.6, post: 0.5,
    S: (spec) => findState(m, spec, warn),
    B: (state, hints, not) => (state ? findBox(m, state, hints, not, warn) : null),
    T: (state, hints, not) => findText(m, state, hints, not, warn),
    /** Exact text by flattened key (e.g. "options.3.preview"); no fuzzy matching. */
    Tx: (state, key) => (state && state.texts[key] != null ? state.texts[key] : null),
    /** Optional lookups: no warning when absent. */
    Tq: (state, hints, not) => (state ? findText(m, state, hints, not, null) : null),
    Bq: (state, hints, not) => (state ? findBox(m, state, hints, not, null) : null),
    add(fn) { parts.push(fn); return fn; },
    ring(rect, opts) {
      const r = ring(fxLayer, rect, opts);
      rings.push({ rect: r.rect, t0: opts.t0, t1: opts.t1, label: opts.label || '' });
      parts.push((t, s) => r.update(t, s));
      return r;
    },
    cursor(path, opts) {
      const pts = path.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.t - b.t);
      if (!pts.length) return null;
      const c = cursor(fxLayer, pts, opts);
      cursors.push(c);
      parts.push((t, s) => c.update(t, s));
      return c;
    },
    /**
     * Every timed event of this scene for the sound-effects layer: camera moves, captions and
     * step-label advances, cursor moves and clicks, crossfades, tab switches, popups and panels,
     * highlight rings and the scene's named events. Shape: {t, kind, scene, label, dur?, zoom?}.
     */
    events() {
      const out = [];
      const add = (t, kind, label, extra = {}) => { if (Number.isFinite(t) && t > -1e8) out.push(Object.assign({ t, kind, scene: n, label }, extra)); };
      const full = win ? sc.full().s : 1;
      for (const mv of cam.moves) {
        const k0 = cam.at(mv.t0).s / full, k1 = mv.v.s / full;
        const kind = k1 > k0 + 0.01 ? 'push-in' : k1 < k0 - 0.01 ? 'pull-back' : 'pan';
        add(mv.t0, kind, `camera ${k0.toFixed(2)}→${k1.toFixed(2)}×`, { dur: mv.dur, zoom: +k1.toFixed(3) });
      }
      const stepSeen = new Set();
      for (const r of caps.items) {
        add(r.item.t0, 'caption', r.item.head, { dur: r.item.t1 - r.item.t0 });
        const st = r.item.steps;
        if (st) st.times.forEach((ts, i) => {
          const key = ts.toFixed(3) + st.labels[i];
          if (i > 0 && ts >= r.item.t0 - 1e-6 && ts <= r.item.t1 && !stepSeen.has(key)) { stepSeen.add(key); add(ts, 'step', `${i + 1} ${st.labels[i]}`); }
        });
      }
      for (const c of cursors) {
        for (const g of c.segments) if (g.dist > 4) {
          add(g.start, 'cursor-move', g.label ? 'to ' + g.label : 'cursor move', { dur: g.end - g.start });
          add(g.end, 'cursor-stop', g.label || 'cursor stop');
        }
        for (const ck of c.clickEvents) add(ck.t, 'click', ck.label || 'click');
      }
      for (const st of states) {
        const kind = st.kind === 'tab' ? 'tab' : st.kind === 'open' ? (/close/.test(st.label) ? 'popup-close' : /panel/.test(st.label) ? 'panel-open' : 'popup-open') : 'crossfade';
        add(st.t, kind, st.label, { dur: st.d });
      }
      for (const r of rings) add(r.t0, 'highlight', r.label || 'highlight ring', { dur: (Number.isFinite(r.t1) ? r.t1 : t1) - r.t0 });
      for (const e of named) out.push(Object.assign({ scene: n }, e));
      return out;
    },
    /** Pacing data for render.mjs --info (camera moves, captions, clicks, UI changes). */
    pacing() {
      const full = sc.full();
      const fullT = { s: full.s, tx: full.px - full.s * full.fx, ty: full.py - full.s * full.fy };
      const isFull = (t) => { const tr = cam.transformAt(t); return Math.abs(tr.s - fullT.s) < 1e-3 && Math.abs(tr.tx - fullT.tx) < 0.5 && Math.abs(tr.ty - fullT.ty) < 0.5; };
      return {
        n, t0, t1, beats: sc.beats,
        startFull: isFull(t0), endFull: isFull(t1),
        moves: cam.moves.map((mv) => {
          // The world rect visible when the move starts, and the rect it moves to.
          const tr = cam.transformAt(mv.t0);
          const vis = { x: -tr.tx / tr.s, y: -tr.ty / tr.s, w: 1920 / tr.s, h: 1080 / tr.s };
          return {
            t0: mv.t0, dur: mv.dur, ease: mv.ease === E.inOutCubic ? 'inOutCubic' : 'other',
            kFrom: cam.at(mv.t0).s / full.s, kTo: mv.v.s / full.s, fromVisible: vis, toRect: mv.v.rect || null,
          };
        }),
        captions: caps.items.map((r) => ({ t0: r.item.t0, t1: r.item.t1, head: r.item.head })),
        clicks: cursors.flatMap((c) => c.clicks),
        cursor: cursors.flatMap((c) => c.segments.map((g) => ({ start: g.start, end: g.end, dist: g.dist }))),
        states: states.slice().sort((a, b) => a.t - b.t),
      };
    },
    /** Entrance and exit envelope applied to the whole product zone. */
    transition(t) {
      let o = 1, dy = 0, k = 1;
      if (enter === 'rise') {
        const p = ep(t, t0 - 0.05, 0.75, E.enter);
        o = Math.min(o, clamp(p * 1.4));
        dy += (1 - p) * 60;
        k *= lerp(1.012, 1, p);
      } else if (enter === 'fade') {
        o = Math.min(o, ep(t, t0 - 0.3, 0.6, E.outCubic));
      }
      if (exit === 'sink') {
        const q = E.exit(prog(t, t1 - 0.4, t1 + 0.02));
        o = Math.min(o, 1 - q);
        dy -= q * 26;
        k *= lerp(1, 0.985, q);
      } else if (exit === 'fade') {
        o = Math.min(o, 1 - E.inCubic(prog(t, t1 - 0.3, t1 + 0.2)));
      }
      wrap.style.opacity = clamp(o).toFixed(4);
      wrap.style.transform = `translateY(${dy.toFixed(3)}px) scale(${k.toFixed(5)})`;
    },
    update(t) {
      if (sheetEl) {
        const p = E.camera(prog(t, sheet.t0, sheet.t1));
        const r = lerp(260, 0, p);
        sheetEl.style.transform = `translateY(${lerp(1100, -90, p).toFixed(3)}px)`;
        sheetEl.style.borderRadius = `${50}% ${50}% 0 0 / ${r.toFixed(2)}px ${r.toFixed(2)}px 0 0`;
      }
      sc.transition(t);
      const { s } = cam.apply(t);
      for (const p of parts) p(t, s);
      caps.update(t);
    },
    async ready() {
      await decodeAll(layer);
      sc.placeCaptions();
    },
    /**
     * Put each caption pill on the side (bottom-left or bottom-right) that overlaps the camera's
     * focus box and the active highlight rings least over the caption's lifetime.
     */
    placeCaptions() {
      const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      caps.layout((item, Lr, Rr) => {
        let oL = 0, oR = 0;
        for (let t = item.t0; t <= item.t1; t += 0.2) {
          const tr = cam.transformAt(t);
          const rects = [];
          const fr = cam.rectAt(t);
          if (fr) rects.push(fr);
          for (const r of rings) if (t >= r.t0 - 0.2 && t <= r.t1) rects.push(r.rect, r.rect); // rings weigh double
          for (const w of rects) {
            const st = { x: w.x * tr.s + tr.tx, y: w.y * tr.s + tr.ty, w: w.w * tr.s, h: w.h * tr.s };
            oL += overlap(st, Lr);
            oR += overlap(st, Rr);
          }
        }
        return oR < oL * 0.98 ? 'right' : 'left';
      });
    },
  };
  return sc;
}

/**
 * Cross-fading stack of capture states inside a container. sched: [{t, i, d?, kind?}]; the first
 * entry is the initial state. kind 'state' (default, a crossfade of 0.5 s) or 'tab' (0.3 s). The
 * incoming layer fades in on top; the outgoing stays opaque under it until the fade completes, so
 * the composite is a clean dissolve between two real captures. With log (a scene), every change
 * is logged for the pacing check.
 */
export function crossStack(parent, states, sched, { offsetY = 0, offsetFor, log, label = '' } = {}) {
  const uniq = [];
  const idx = states.map((s) => {
    if (!s) return -1;
    let k = uniq.indexOf(s);
    if (k < 0) { uniq.push(s); k = uniq.length - 1; }
    return k;
  });
  const imgs = uniq.map((s) => {
    const im = shot(parent, s, { offsetY: offsetY + (offsetFor ? offsetFor(s) : 0) });
    im.style.display = 'none';
    return im;
  });
  // Steps that point at a missing (optional) state are skipped: the previous state stays up.
  const steps = sched
    .map((x) => Object.assign({ kind: 'state' }, x, { d: x.d != null ? x.d : x.kind === 'tab' ? PACE.tab : PACE.xfade, k: idx[x.i] }))
    .filter((x) => x.k >= 0);
  if (!steps.length) steps.push({ t: -1e9, k: 0, d: 0 });
  if (log) {
    let cur = steps[0].k;
    for (const st of steps.slice(1)) {
      if (st.k !== cur) log.log(st.t, st.d, st.kind, label + ':' + (uniq[st.k] && uniq[st.k].id));
      cur = st.k;
    }
  }
  return {
    imgs, uniq,
    current(t) {
      let cur = steps[0].k;
      for (const st of steps) if (t >= st.t) cur = st.k;
      return uniq[cur];
    },
    update(t) {
      let cur = steps[0].k, prev = -1, p = 1;
      for (let j = 1; j < steps.length; j++) {
        const st = steps[j];
        if (t >= st.t) {
          if (st.k !== cur) { prev = cur; cur = st.k; p = E.inOutCubic(prog(t, st.t, st.t + st.d)); }
        }
      }
      imgs.forEach((im, k) => {
        const a = k === cur ? p : k === prev && p < 1 ? 1 : 0;
        show(im, a > 0.001 && k >= 0);
        if (a > 0.001) {
          im.style.opacity = a.toFixed(4);
          im.style.zIndex = k === cur ? 2 : 1;
        }
      });
    },
  };
}

/**
 * Extension popup anchored under the toolbar icon. states/sched as crossStack. Tall captures are
 * cropped to maxH (Chrome caps popups at 600 px) and panned so the state's focus box is visible.
 * open/close: times the popup appears and disappears.
 */
export function popup(sc, win, states, sched, { open, close = Infinity, maxH = 600, focusFor, scale = 1.4 } = {}) {
  const live = states.filter(Boolean);
  if (!live.length) return null;
  const pw = live[0].vw;
  const k = scale;
  // Anchored under the toolbar icon: the popup's top-right corner sits below the icon and the
  // popup is magnified k× from there so its text reads at 1080p.
  const right = Math.min(win.icon.x + 18, win.W - 6), y = win.CH + 4;
  const x = right - pw;
  const box = el('div', 'popup', sc.world, { left: x + 'px', top: y + 'px', width: pw + 'px', height: Math.min(live[0].vh, maxH) + 'px', transformOrigin: '100% 0' });
  const scrollFor = (st) => {
    if (!st || st.vh <= maxH) return 0;
    const f = focusFor ? focusFor(st) : null;
    return f ? clamp(f.y + f.h / 2 - maxH / 2, 0, st.vh - maxH) : 0;
  };
  const stack = crossStack(box, states, sched, { offsetFor: (st) => -scrollFor(st), log: sc, label: 'popup' });
  sc.log(open, 0.22, 'open', 'popup open');
  if (Number.isFinite(close)) sc.log(close - 0.18, 0.18, 'open', 'popup close');
  const api = {
    box, x, y, w: pw, stack, k,
    heightAt(t) { const st = stack.current(t); return st ? Math.min(st.vh, maxH) : 0; },
    /** World rect of the (magnified) popup. */
    rect(t) { return { x: right - pw * k, y, w: pw * k, h: api.heightAt(t) * k }; },
    /** World rect of a box given in the popup state's CSS px. */
    at(st, b, pad = 0) {
      if (!b) return null;
      return { x: right - (pw - b.x) * k - pad, y: y + (b.y - scrollFor(st)) * k - pad, w: b.w * k + 2 * pad, h: b.h * k + 2 * pad };
    },
    update(t) {
      const o = env(t, open, close, 0.22, 0.18, E.outCubic, E.inCubic);
      op(box, o);
      if (o <= 0) return;
      const p = ep(t, open, 0.32, E.outCubic);
      box.style.transform = `translateY(${((1 - p) * -6).toFixed(3)}px) scale(${(k * lerp(0.965, 1, p)).toFixed(5)})`;
      box.style.height = api.heightAt(t) + 'px';
      stack.update(t);
    },
  };
  sc.add((t) => api.update(t));
  return api;
}

/** Camera helpers in window coordinates. */
export function overview(win, area, opts = {}) {
  return view(win.rect(), area, Object.assign({ fit: 'contain' }, opts));
}

/** Expand a rect so its aspect ratio is at least as wide as the area's (keeps zooms gentle). */
export function focusRect(r, minW, minH) {
  const w = Math.max(r.w, minW || 0), h = Math.max(r.h, minH || 0);
  return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h };
}

/** Center point of a rect. */
export const mid = (r) => (r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null);

/** Detail-line builder: [text, {num}, '·', ...] where nums come from manifest texts (null → dropped). */
export const num = (v) => ({ num: v });

/**
 * Extract part of an exact UI string from the manifest (e.g. "+12% vs prior" out of the banner's
 * meta line). Never invents text: returns null when the pattern is absent.
 */
export const rx = (text, re, g = 1) => {
  if (text == null) return null;
  const m = re.exec(String(text));
  return m ? String(m[g] != null ? m[g] : m[0]).trim() : null;
};

export { E, clamp, prog, env, ep, lerp, el, op, show, view, px };

/**
 * Locate the selected tab's accent underline inside box (CSS px) of a capture state, by scanning
 * the real capture's pixels for the longest horizontal run of accent-blue. Returns the tab's rect
 * in the state's CSS px (full box height), or null. Used to click the real tab positions.
 */
export function accentRun(state, box) {
  if (!state || !state.img || !box) return null;
  const k = state.dsf;
  const sx = Math.max(0, Math.round(box.x * k)), sy = Math.max(0, Math.round(box.y * k));
  const sw = Math.round(box.w * k), sh = Math.round(box.h * k);
  const cv = document.createElement('canvas');
  cv.width = sw;
  cv.height = sh;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(state.img, sx, sy, sw, sh, 0, 0, sw, sh);
  const d = g.getImageData(0, 0, sw, sh).data;
  let best = null;
  for (let y = 0; y < sh; y++) {
    let run = 0;
    for (let x = 0; x <= sw; x++) {
      const i = (y * sw + x) * 4;
      const on = x < sw && d[i + 2] - d[i] > 60 && d[i + 2] - d[i + 1] > 30;
      if (on) run++;
      else {
        if (run > 0 && (!best || run > best.len)) best = { len: run, x0: x - run, y };
        run = 0;
      }
    }
  }
  if (!best || best.len < 16 * k) return null;
  return { x: box.x + best.x0 / k, y: box.y, w: best.len / k, h: box.h };
}
