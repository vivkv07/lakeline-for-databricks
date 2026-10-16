// Easing and interpolation helpers. Everything is a pure function of time so any frame can be
// rendered in isolation (seek to t, draw, capture) and the result is identical every run.

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, p) => a + (b - a) * p;
/** Linear progress of t through [t0, t1], clamped to 0..1. */
export const prog = (t, t0, t1) => (t1 <= t0 ? (t >= t1 ? 1 : 0) : clamp((t - t0) / (t1 - t0)));

/** Cubic bezier easing (CSS semantics), solved with Newton steps plus bisection fallback. */
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (u) => ((ax * u + bx) * u + cx) * u;
  const sy = (u) => ((ay * u + by) * u + cy) * u;
  const dx = (u) => (3 * ax * u + 2 * bx) * u + cx;
  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let u = p;
    for (let i = 0; i < 8; i++) {
      const e = sx(u) - p;
      if (Math.abs(e) < 1e-6) return sy(u);
      const d = dx(u);
      if (Math.abs(d) < 1e-6) break;
      u -= e / d;
    }
    let lo = 0, hi = 1;
    u = p;
    for (let i = 0; i < 30; i++) {
      const x = sx(u);
      if (Math.abs(x - p) < 1e-6) break;
      if (x < p) lo = u; else hi = u;
      u = (lo + hi) / 2;
    }
    return sy(u);
  };
}

export const E = {
  outCubic: (p) => 1 - Math.pow(1 - p, 3),
  inCubic: (p) => p * p * p,
  inOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  outQuint: (p) => 1 - Math.pow(1 - p, 5),
  outExpo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  inOutExpo: (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? Math.pow(2, 20 * p - 10) / 2 : (2 - Math.pow(2, -20 * p + 10)) / 2),
  /** Subtle overshoot, reserved for small elements (icon, popup, notification, cursor press). */
  outBack: (p, s = 1.2) => 1 + (s + 1) * Math.pow(p - 1, 3) + s * Math.pow(p - 1, 2),
  /** Camera moves: a soft start and a long, premium settle. */
  camera: bezier(0.65, 0, 0.2, 1),
  /** Entrances: quick departure, long settle (close to ease-out expo). */
  enter: bezier(0.16, 1, 0.3, 1),
  exit: bezier(0.7, 0, 0.84, 0),
};

/** Eased progress of t through [t0, t0 + d]. */
export const ep = (t, t0, d, fn = E.enter) => fn(prog(t, t0, t0 + d));

/**
 * Visibility envelope: 0 before a, ramps in over din, holds, ramps out over dout ending at b.
 * Pass b = Infinity for no exit.
 */
export function env(t, a, b, din = 0.4, dout = 0.4, ein = E.outCubic, eout = E.inCubic) {
  if (t < a || t > b) return 0;
  const i = din > 0 ? ein(prog(t, a, a + din)) : 1;
  const o = Number.isFinite(b) && dout > 0 ? 1 - eout(prog(t, b - dout, b)) : 1;
  return Math.min(i, o);
}

/** Piecewise keyframes [[t, v], ...] with per-segment easing (default inOutCubic). */
export function keys(t, list, fn = E.inOutCubic) {
  if (t <= list[0][0]) return list[0][1];
  for (let i = 1; i < list.length; i++) {
    const [t1, v1, f] = list[i];
    if (t <= t1) {
      const [t0, v0] = list[i - 1];
      return lerp(v0, v1, (f || fn)(prog(t, t0, t1)));
    }
  }
  return list[list.length - 1][1];
}

/** Deterministic pseudo-random in [0, 1) from an integer seed. */
export function rand(seed) {
  let x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}
