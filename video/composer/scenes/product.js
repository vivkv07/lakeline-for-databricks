// Shared scaffolding for product scenes: a caption area, a masked product zone with a camera over
// a world container (the browser window sits at world origin), cross-fading capture stacks,
// rings and a cursor. Captures are only positioned, scaled, cropped and faded; never redrawn.
import { E, clamp, prog, env, ep, lerp } from '../lib/ease.js';
import { el, op, show, camera, view, captions, ring, cursor, shot, decodeAll, px } from '../lib/kit.js';
import { findState, findBox, findText } from '../lib/manifest.js';

/** Product area on stage for each caption mode (stage px). */
export const AREAS = {
  top: { x: 120, y: 262, w: 1680, h: 780 },
  left: { x: 660, y: 64, w: 1180, h: 952 },
  full: { x: 80, y: 60, w: 1760, h: 960 },
};
const MASKS = {
  top: 'linear-gradient(to bottom, transparent 0px, transparent 222px, #000 258px, #000 100%)',
  left: 'linear-gradient(to right, transparent 0px, transparent 590px, #000 652px, #000 100%)',
  full: 'none',
};

export function productScene(ctx, { n, t0, t1, theme, mode = 'top', enter = 'rise', exit = 'sink' }) {
  const m = ctx.manifests.scenes[n];
  const warn = (w) => ctx.warn(w);
  const layer = el('div', 'layer t-' + theme, ctx.root);
  const zone = el('div', 'zone', layer, { left: '0px', top: '0px', width: '1920px', height: '1080px' });
  const setMask = (md) => {
    zone.style.webkitMaskImage = MASKS[md];
    zone.style.maskImage = MASKS[md];
  };
  setMask(mode);
  const wrap = el('div', 'abs', zone, { width: '1920px', height: '1080px', transformOrigin: '960px 640px' });
  const world = el('div', 'world', wrap);
  const fxLayer = el('div', 'abs', world); // rings/cursor above everything in world space
  fxLayer.style.zIndex = 50;
  const cam = camera(world);
  const caps = captions(layer, theme);
  const parts = [];
  const sc = {
    n, t0, t1, theme, mode, m, layer, zone, wrap, world, fxLayer, cam, caps, warn, setMask,
    area: AREAS[mode],
    pre: 0.6, post: 0.5,
    S: (spec) => findState(m, spec, warn),
    B: (state, hints, not) => (state ? findBox(m, state, hints, not, warn) : null),
    T: (state, hints, not) => findText(m, state, hints, not, warn),
    add(fn) { parts.push(fn); return fn; },
    ring(rect, opts) { const r = ring(fxLayer, rect, opts); parts.push((t, s) => r.update(t, s)); return r; },
    cursor(path, opts) {
      const pts = path.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
      if (!pts.length) return null;
      const c = cursor(fxLayer, pts, opts);
      parts.push((t, s) => c.update(t, s));
      return c;
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
      sc.transition(t);
      const { s } = cam.apply(t);
      for (const p of parts) p(t, s);
      caps.update(t);
    },
    async ready() { await decodeAll(layer); },
  };
  return sc;
}

/**
 * Cross-fading stack of capture states inside a container. sched: [{t, i, d?, from?}]; the first
 * entry is the initial state. The incoming layer fades in on top; the outgoing stays opaque under
 * it until the fade completes, so the composite is a clean dissolve between two real captures.
 */
export function crossStack(parent, states, sched, { offsetY = 0, offsetFor } = {}) {
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
  const steps = sched.map((x) => Object.assign({ d: 0.32 }, x, { k: idx[x.i] }));
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
          if (st.k !== cur) { prev = cur; cur = st.k; p = E.outCubic(prog(t, st.t, st.t + st.d)); }
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
export function popup(sc, win, states, sched, { open, close = Infinity, maxH = 600, focusFor } = {}) {
  const live = states.filter(Boolean);
  if (!live.length) return null;
  const pw = live[0].vw;
  const x = win.icon.x + 16 - pw, y = win.CH + 3;
  const box = el('div', 'popup', sc.world, { left: x + 'px', top: y + 'px', width: pw + 'px', height: Math.min(live[0].vh, maxH) + 'px' });
  const scrollFor = (st) => {
    if (!st || st.vh <= maxH) return 0;
    const f = focusFor ? focusFor(st) : null;
    return f ? clamp(f.y + f.h / 2 - maxH / 2, 0, st.vh - maxH) : 0;
  };
  const stack = crossStack(box, states, sched, { offsetFor: (st) => -scrollFor(st) });
  const api = {
    box, x, y, w: pw, stack,
    heightAt(t) { const st = stack.current(t); return st ? Math.min(st.vh, maxH) : 0; },
    rect(t) { return { x, y, w: pw, h: api.heightAt(t) }; },
    /** World rect of a box given in the popup state's CSS px. */
    at(st, b, pad = 0) { return b ? { x: x + b.x - pad, y: y + b.y - scrollFor(st) - pad, w: b.w + 2 * pad, h: b.h + 2 * pad } : null; },
    update(t) {
      const o = env(t, open, close, 0.22, 0.18, E.outCubic, E.inCubic);
      op(box, o);
      if (o <= 0) return;
      const p = ep(t, open, 0.32, E.outCubic);
      box.style.transform = `scale(${lerp(0.965, 1, p).toFixed(5)}) translateY(${((1 - p) * -6).toFixed(3)}px)`;
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

export { E, clamp, prog, env, ep, lerp, el, op, show, view, px };
