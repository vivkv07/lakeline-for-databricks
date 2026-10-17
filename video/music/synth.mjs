// DSP building blocks for the Lakeline launch theme.
//
// Plain JavaScript, no dependencies, no samples, no sound fonts. Every sound in
// the track is computed here from oscillators and filtered noise. Randomness
// (noise, detune, phase) comes from a seeded PRNG, so a render is bit-identical
// every time it runs.

export const SR = 48000;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Utilities

/** Seeded PRNG (mulberry32). Returns floats in [0, 1). */
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
export const dbToGain = (d) => 10 ** (d / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-12));

/** Equal-power pan, normalised so the centre position is unity on both sides. */
export function panLR(p) {
  const a = (Math.max(-1, Math.min(1, p)) + 1) * (Math.PI / 4);
  return [Math.cos(a) * Math.SQRT2, Math.sin(a) * Math.SQRT2];
}

/** A stereo float buffer. */
export class Bus {
  constructor(n) {
    this.n = n;
    this.L = new Float32Array(n);
    this.R = new Float32Array(n);
  }
  static seconds(s) {
    return new Bus(Math.ceil(s * SR));
  }
  mixInto(dst, gain = 1) {
    const n = Math.min(this.n, dst.n);
    for (let i = 0; i < n; i++) {
      dst.L[i] += this.L[i] * gain;
      dst.R[i] += this.R[i] * gain;
    }
    return dst;
  }
  scale(g) {
    for (let i = 0; i < this.n; i++) {
      this.L[i] *= g;
      this.R[i] *= g;
    }
    return this;
  }
}

/**
 * Bake breakpoint automation into a per-sample array.
 * points: [[seconds, value], ...] in time order. Values are held before the
 * first point and after the last. log=true interpolates in the log domain
 * (right for frequencies).
 */
export function bake(points, n, { log = false } = {}) {
  const out = new Float32Array(n);
  const f = log ? Math.log : (x) => x;
  const g = log ? Math.exp : (x) => x;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    while (k < points.length - 1 && t >= points[k + 1][0]) k++;
    if (t <= points[0][0] || k >= points.length - 1) {
      out[i] = t <= points[0][0] ? points[0][1] : points[points.length - 1][1];
      continue;
    }
    const [t0, v0] = points[k];
    const [t1, v1] = points[k + 1];
    const u = (t - t0) / (t1 - t0);
    out[i] = g(f(v0) + (f(v1) - f(v0)) * u);
  }
  return out;
}

/**
 * Closed-form ADSR. a = linear attack (s), d = decay time constant (s),
 * s = sustain level, r = release time constant (s). gate = note length (s).
 */
export function adsr(t, gate, a, d, s, r) {
  const pre = (x) => (x < a ? x / a : s + (1 - s) * Math.exp(-(x - a) / d));
  if (t < gate) return pre(t);
  return pre(gate) * Math.exp(-(t - gate) / r);
}

// ---------------------------------------------------------------------------
// Band-limited oscillators (polyBLEP)

function blep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

export class Osc {
  constructor(phase = 0) {
    this.p = phase;
    // Triangle state (integrated square) that matches the start phase.
    this.ts = phase < 0.5 ? -1 + 4 * phase : 3 - 4 * phase;
  }
  saw(dt) {
    const p = this.p;
    const v = 2 * p - 1 - blep(p, dt);
    this.p = p + dt;
    if (this.p >= 1) this.p -= 1;
    return v;
  }
  pulse(dt, pw = 0.5) {
    const p = this.p;
    let v = p < pw ? 1 : -1;
    v += blep(p, dt);
    let q = p - pw;
    if (q < 0) q += 1;
    v -= blep(q, dt);
    this.p = p + dt;
    if (this.p >= 1) this.p -= 1;
    return v;
  }
  /** Triangle from a leaky-integrated polyBLEP square (band-limited). */
  tri(dt) {
    const sq = this.pulse(dt, 0.5);
    this.ts = this.ts * 0.9997 + 4 * dt * sq;
    return this.ts;
  }
  sine(dt) {
    const v = Math.sin(TAU * this.p);
    this.p += dt;
    if (this.p >= 1) this.p -= 1;
    return v;
  }
}

// ---------------------------------------------------------------------------
// Filters

/** Trapezoidal (zero-delay feedback) state-variable filter, stable under modulation. */
export class SVF {
  constructor(fc = 1000, q = 0.707) {
    this.s1 = 0;
    this.s2 = 0;
    this.lp = 0;
    this.bp = 0;
    this.hp = 0;
    this.set(fc, q);
  }
  set(fc, q) {
    const f = Math.min(Math.max(fc, 10), SR * 0.45);
    const g = Math.tan((Math.PI * f) / SR);
    const k = 1 / q;
    this.k = k;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  copyCoeffs(o) {
    this.k = o.k;
    this.a1 = o.a1;
    this.a2 = o.a2;
    this.a3 = o.a3;
  }
  tick(v0) {
    const v3 = v0 - this.s2;
    const v1 = this.a1 * this.s1 + this.a2 * v3;
    const v2 = this.s2 + this.a2 * this.s1 + this.a3 * v3;
    this.s1 = 2 * v1 - this.s1;
    this.s2 = 2 * v2 - this.s2;
    this.lp = v2;
    this.bp = v1;
    this.hp = v0 - this.k * v1 - v2;
    return v2;
  }
}

/** RBJ cookbook biquad, transposed direct form II. */
export class Biquad {
  constructor(type, f, q = 0.7071, gainDb = 0) {
    const w = (TAU * Math.min(f, SR * 0.45)) / SR;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const alpha = sw / (2 * q);
    const A = 10 ** (gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lowpass':
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'bandpass':
        b0 = alpha; b1 = 0; b2 = -alpha;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'peak':
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
        break;
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 - (A - 1) * cw + s);
        b1 = 2 * A * (A - 1 - (A + 1) * cw);
        b2 = A * (A + 1 - (A - 1) * cw - s);
        a0 = A + 1 + (A - 1) * cw + s;
        a1 = -2 * (A - 1 + (A + 1) * cw);
        a2 = A + 1 + (A - 1) * cw - s;
        break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cw + s);
        b1 = -2 * A * (A - 1 + (A + 1) * cw);
        b2 = A * (A + 1 + (A - 1) * cw - s);
        a0 = A + 1 - (A - 1) * cw + s;
        a1 = 2 * (A - 1 - (A + 1) * cw);
        a2 = A + 1 - (A - 1) * cw - s;
        break;
      }
      default:
        throw new Error(`unknown biquad type ${type}`);
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    this.z1 = 0;
    this.z2 = 0;
  }
  tick(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** One-pole lowpass coefficient for a cutoff in Hz. */
const onePole = (fc) => 1 - Math.exp((-TAU * fc) / SR);

// ---------------------------------------------------------------------------
// Instruments. Each renders one note additively into a Bus.

function startIndex(t0) {
  return Math.round(t0 * SR);
}

/**
 * Warm analog-style pad voice: a stack of detuned polyBLEP saws with slow,
 * independent pitch drift, spread across the stereo field.
 */
export function padNote(bus, t0, gate, midi, o, rng) {
  const {
    gain = 0.2,
    attack = 0.4,
    decay = 2,
    sustain = 0.85,
    release = 0.5,
    detune = [-12, -5, 0, 6, 13],
    spread = 0.75,
    drift = 4,
    wave = 'saw',
  } = o;
  const f = mtof(midi);
  const nv = detune.length;
  const voices = detune.map((c, v) => ({
    osc: new Osc(rng()),
    dt: (f * 2 ** ((c + (rng() - 0.5) * 3) / 1200)) / SR,
    pan: panLR(nv > 1 ? spread * ((2 * v) / (nv - 1) - 1) : 0),
    lfo: rng() * TAU,
    rate: 0.12 + rng() * 0.3,
    mod: 1,
  }));
  const driftK = (drift / 1200) * Math.LN2;
  const i0 = startIndex(t0);
  const len = Math.ceil((gate + release * 9.5) * SR);
  const norm = gain / Math.sqrt(nv);
  for (let i = 0; i < len; i++) {
    const idx = i0 + i;
    if (idx >= bus.n) break;
    const t = i / SR;
    if ((i & 63) === 0) {
      for (const vc of voices) vc.mod = 1 + driftK * Math.sin(vc.lfo + TAU * vc.rate * t);
    }
    if (idx < 0) continue;
    const e = adsr(t, gate, attack, decay, sustain, release) * norm;
    let l = 0;
    let r = 0;
    for (let v = 0; v < nv; v++) {
      const vc = voices[v];
      const s = wave === 'pulse' ? vc.osc.pulse(vc.dt * vc.mod, 0.3) : vc.osc.saw(vc.dt * vc.mod);
      l += s * vc.pan[0];
      r += s * vc.pan[1];
    }
    bus.L[idx] += l * e;
    bus.R[idx] += r * e;
  }
}

/** Plucky arpeggio voice: saw + pulse through a lowpass with a fast envelope. */
export function pluckNote(bus, t0, midi, o, rng) {
  const {
    gain = 0.2,
    vel = 1,
    pan = 0,
    gate = 0.1,
    decay = 0.22,
    release = 0.08,
    cut = 650,
    env = 3200,
    envDecay = 0.085,
    q = 0.9,
    pulseMix = 0.35,
    detune = 7,
  } = o;
  const f = mtof(midi);
  const a = new Osc(rng());
  const b = new Osc(rng());
  const dtA = f / SR;
  const dtB = (f * 2 ** (detune / 1200)) / SR;
  const flt = new SVF(cut, q);
  const [pl, pr] = panLR(pan);
  const i0 = startIndex(t0);
  const len = Math.ceil(Math.min(2, gate + release * 9) * SR);
  const g = gain * vel;
  for (let i = 0; i < len; i++) {
    const idx = i0 + i;
    if (idx >= bus.n) break;
    const t = i / SR;
    if ((i & 7) === 0) flt.set(cut + env * vel * Math.exp(-t / envDecay), q);
    const s = a.saw(dtA) * (1 - pulseMix) + b.pulse(dtB, 0.42) * pulseMix;
    const y = flt.tick(s) * adsr(t, gate, 0.0015, decay, 0, release) * g;
    if (idx < 0) continue;
    bus.L[idx] += y * pl;
    bus.R[idx] += y * pr;
  }
}

/**
 * Soft mallet/glass voice for the main motif: triangle fundamental, an octave
 * partial and a short inharmonic tine at the attack.
 */
export function bellNote(bus, t0, gate, midi, o, rng) {
  const {
    gain = 0.2,
    vel = 1,
    pan = 0,
    decay = 0.45,
    sustain = 0.2,
    release = 0.35,
    bright = 1,
    cut = 4200,
  } = o;
  const f = mtof(midi);
  const o1 = new Osc(rng());
  const o2 = new Osc(rng());
  const o3 = new Osc(rng());
  const o4 = new Osc(rng());
  const flt = new SVF(cut, 0.7);
  const [pl, pr] = panLR(pan);
  const i0 = startIndex(t0);
  const len = Math.ceil((gate + release * 9) * SR);
  const g = gain * vel;
  const dt1 = f / SR;
  const dt2 = (2 * f) / SR;
  const dt3 = (3 * f) / SR;
  const dt4 = (4.07 * f) / SR;
  for (let i = 0; i < len; i++) {
    const idx = i0 + i;
    if (idx >= bus.n) break;
    const t = i / SR;
    const s =
      o1.tri(dt1) +
      o2.sine(dt2) * 0.32 * bright * Math.exp(-t / 0.35) +
      o3.sine(dt3) * 0.1 * bright * Math.exp(-t / 0.12) +
      o4.sine(dt4) * 0.06 * bright * Math.exp(-t / 0.035);
    const y = flt.tick(s) * adsr(t, gate, 0.003, decay, sustain, release) * g;
    if (idx < 0) continue;
    bus.L[idx] += y * pl;
    bus.R[idx] += y * pr;
  }
}

/** Airy lead for the counter-melody: triangle + a little saw, delayed vibrato. */
export function leadNote(bus, t0, gate, midi, o, rng) {
  const {
    gain = 0.14,
    vel = 1,
    pan = 0,
    attack = 0.09,
    decay = 0.9,
    sustain = 0.7,
    release = 0.35,
    vib = 9,
    vibRate = 5.1,
    vibDelay = 0.3,
    cut = 2800,
  } = o;
  const f = mtof(midi);
  const o1 = new Osc(rng());
  const o2 = new Osc(rng());
  const o3 = new Osc(rng());
  const flt = new SVF(cut, 0.75);
  const [pl, pr] = panLR(pan);
  const i0 = startIndex(t0);
  const len = Math.ceil((gate + release * 9) * SR);
  const g = gain * vel;
  const vk = (vib / 1200) * Math.LN2;
  for (let i = 0; i < len; i++) {
    const idx = i0 + i;
    if (idx >= bus.n) break;
    const t = i / SR;
    const vAmt = Math.min(1, Math.max(0, (t - vibDelay) / 0.4));
    const m = 1 + vk * vAmt * Math.sin(TAU * vibRate * t);
    const dt = (f * m) / SR;
    const s = o1.tri(dt) * 0.8 + o2.saw(dt * 1.0035) * 0.18 + o3.sine(dt * 0.5) * 0.22;
    const y = flt.tick(s) * adsr(t, gate, attack, decay, sustain, release) * g;
    if (idx < 0) continue;
    bus.L[idx] += y * pl;
    bus.R[idx] += y * pr;
  }
}

/** Deep, soft bass: sine fundamental plus a lowpassed saw, gently saturated. Mono. */
export function bassNote(bus, t0, gate, midi, o, rng) {
  const {
    gain = 0.4,
    vel = 1,
    cut = 200,
    env = 450,
    envDecay = 0.07,
    drive = 1.5,
    attack = 0.005,
    decay = 0.7,
    sustain = 0.78,
    release = 0.05,
    sawMix = 0.5,
    sub = 1,
  } = o;
  const f = mtof(midi);
  const s1 = new Osc(0);
  const s2 = new Osc(rng());
  const flt = new SVF(cut, 0.8);
  const i0 = startIndex(t0);
  const len = Math.ceil((gate + release * 9) * SR);
  const dt = f / SR;
  const norm = 1 / Math.tanh(drive);
  const g = gain * vel;
  for (let i = 0; i < len; i++) {
    const idx = i0 + i;
    if (idx >= bus.n) break;
    const t = i / SR;
    if ((i & 7) === 0) flt.set(cut + env * vel * Math.exp(-t / envDecay), 0.8);
    const x = s1.sine(dt) * sub + flt.tick(s2.saw(dt)) * sawMix;
    const y = Math.tanh(drive * x * 0.8) * norm * adsr(t, gate, attack, decay, sustain, release) * g;
    if (idx < 0) continue;
    bus.L[idx] += y;
    bus.R[idx] += y;
  }
}

// ---------------------------------------------------------------------------
// Drums

/**
 * Tight, punchy kick: a fast pitch-swept sine body (short punch decay plus a
 * controlled sub tail), a crisp high-passed click and blip on the transient,
 * then saturation for density.
 */
export function kick(bus, t0, o, rng) {
  const {
    gain = 0.8,
    vel = 1,
    f0 = 165,
    f1 = 50,
    pitchTau = 0.028,
    decay = 0.12,
    sub = 0.4,
    subDecay = 0.2,
    click = 0.32,
    drive = 2.0,
    len = 0.42,
  } = o;
  const i0 = startIndex(t0);
  const n = Math.ceil(len * SR);
  const c = onePole(1800);
  const norm = 1 / Math.tanh(drive);
  let ph = 0;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const idx = i0 + i;
    if (idx >= bus.n) break;
    const t = i / SR;
    const f = f1 + (f0 - f1) * Math.exp(-t / pitchTau);
    ph += f / SR;
    const body = Math.sin(TAU * ph);
    const env =
      Math.min(1, t / 0.0005) *
      (Math.exp(-t / decay) * (1 - sub) + Math.exp(-t / subDecay) * sub) *
      Math.min(1, (len - t) / 0.03);
    const nz = rng() * 2 - 1;
    lp += c * (nz - lp);
    const cl = ((nz - lp) * 0.7 + Math.sin(TAU * 3100 * t) * 0.5) * Math.exp(-t / 0.0018) * click;
    const y = Math.tanh(drive * (body * env + cl)) * norm * gain * vel;
    if (idx < 0) continue;
    bus.L[idx] += y;
    bus.R[idx] += y;
  }
}

/** Snare body layer: two pitched partials with a quick drop plus high-passed noise "wires". */
export function snare(bus, t0, o, rng) {
  const { gain = 0.3, vel = 1, tone = 190, body = 0.7, wires = 0.55, decay = 0.12, len = 0.45, drive = 1.5 } = o;
  const hp = new SVF(1400, 0.7);
  const lp = new SVF(7000, 0.7);
  const i0 = startIndex(t0);
  const n = Math.ceil(len * SR);
  const norm = 1 / Math.tanh(drive);
  let p1 = 0;
  let p2 = 0;
  for (let i = 0; i < n; i++) {
    const idx = i0 + i;
    if (idx >= bus.n) break;
    const t = i / SR;
    const drop = 1 + 0.3 * Math.exp(-t / 0.012);
    p1 += (tone * drop) / SR;
    p2 += (tone * 1.78 * drop) / SR;
    const b = (Math.sin(TAU * p1) + 0.5 * Math.sin(TAU * p2)) * Math.exp(-t / 0.05) * body;
    hp.tick(rng() * 2 - 1);
    const w = lp.tick(hp.hp) * Math.exp(-t / decay) * wires * 1.6;
    const env = Math.min(1, t / 0.0007) * Math.min(1, (len - t) / 0.05);
    const y = Math.tanh(drive * (b + w) * env) * norm * gain * vel;
    if (idx < 0) continue;
    bus.L[idx] += y;
    bus.R[idx] += y;
  }
}

/** Clap: three quick band-passed noise bursts and a short tail, plus a little snare body. */
export function clap(bus, t0, o, rng) {
  const { gain = 0.3, vel = 1, tail = 0.12, fc = 1250, q = 1.1, body = 0.3, spread = 0.3, len = 0.6 } = o;
  const bl = new SVF(fc, q);
  const br = new SVF(fc, q);
  const ll = new Biquad('lowpass', 6500, 0.7);
  const lr = new Biquad('lowpass', 6500, 0.7);
  const bursts = [
    [0, 0.75],
    [0.0105, 0.85],
    [0.0215, 1],
  ];
  const i0 = startIndex(t0);
  const n = Math.ceil(len * SR);
  const g = gain * vel;
  for (let i = 0; i < n; i++) {
    const idx = i0 + i;
    if (idx >= bus.n) break;
    const t = i / SR;
    let e = 0;
    for (const [bt, w] of bursts) if (t >= bt) e += w * Math.exp(-(t - bt) / 0.0032);
    if (t >= 0.0215) e += 0.7 * Math.exp(-(t - 0.0215) / tail);
    const common = rng() * 2 - 1;
    const nl = common * (1 - spread) + (rng() * 2 - 1) * spread;
    const nr = common * (1 - spread) + (rng() * 2 - 1) * spread;
    bl.tick(nl);
    br.tick(nr);
    const tone = Math.sin(TAU * 188 * t) * Math.exp(-t / 0.045) * body;
    const fade = Math.min(1, (len - t) / 0.08);
    const yl = (ll.tick(bl.bp * 2.2) * e + tone) * g * fade;
    const yr = (lr.tick(br.bp * 2.2) * e + tone) * g * fade;
    if (idx < 0) continue;
    bus.L[idx] += yl;
    bus.R[idx] += yr;
  }
}

/** Hi-hat: high-passed noise, softened at the very top. decay ~0.03 closed, ~0.2 open. */
export function hat(bus, t0, o, rng) {
  const { gain = 0.1, vel = 1, decay = 0.03, pan = 0, fc = 7200, top = 12500 } = o;
  const hp = new SVF(fc, 0.75);
  const c = onePole(top);
  const [pl, pr] = panLR(pan);
  const i0 = startIndex(t0);
  const n = Math.ceil(Math.min(1.2, decay * 8 + 0.01) * SR);
  const g = gain * vel;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const idx = i0 + i;
    if (idx >= bus.n) break;
    const t = i / SR;
    hp.tick(rng() * 2 - 1);
    lp += c * (hp.hp - lp);
    const y = lp * Math.min(1, t / 0.0006) * Math.exp(-t / decay) * g;
    if (idx < 0) continue;
    bus.L[idx] += y * pl;
    bus.R[idx] += y * pr;
  }
}

/** Shaker: band-passed noise with a soft swell-in. */
export function shaker(bus, t0, o, rng) {
  const { gain = 0.05, vel = 1, pan = 0.25, fc = 5600, q = 1.2, attack = 0.012, decay = 0.045 } = o;
  const bp = new SVF(fc, q);
  const [pl, pr] = panLR(pan);
  const i0 = startIndex(t0);
  const n = Math.ceil((attack + decay * 8) * SR);
  const g = gain * vel;
  for (let i = 0; i < n; i++) {
    const idx = i0 + i;
    if (idx >= bus.n) break;
    const t = i / SR;
    bp.tick(rng() * 2 - 1);
    const e = t < attack ? Math.sin((Math.PI / 2) * (t / attack)) ** 2 : Math.exp(-(t - attack) / decay);
    const y = bp.bp * e * g * 1.6;
    if (idx < 0) continue;
    bus.L[idx] += y * pl;
    bus.R[idx] += y * pr;
  }
}

// ---------------------------------------------------------------------------
// Transition effects

/**
 * Filtered-noise sweep. mode 'rise' grows towards t1 (riser / reverse swell),
 * 'fall' decays from t0 (downlifter). type: 'bp' | 'lp' | 'hp'.
 */
export function noiseSweep(bus, t0, t1, o, rng) {
  const { gain = 0.2, f0 = 300, f1 = 8000, q = 1.2, shape = 2.5, mode = 'rise', type = 'bp', width = 0.6 } = o;
  const fl = new SVF(f0, q);
  const fr = new SVF(f0, q);
  const i0 = startIndex(t0);
  const n = Math.ceil((t1 - t0) * SR);
  const lf0 = Math.log(f0);
  const lf1 = Math.log(f1);
  for (let i = 0; i < n; i++) {
    const idx = i0 + i;
    if (idx >= bus.n) break;
    const u = i / n;
    if ((i & 15) === 0) {
      fl.set(Math.exp(lf0 + (lf1 - lf0) * u), q);
      fr.copyCoeffs(fl);
    }
    const common = rng() * 2 - 1;
    fl.tick(common * (1 - width) + (rng() * 2 - 1) * width);
    fr.tick(common * (1 - width) + (rng() * 2 - 1) * width);
    const pick = (s) => (type === 'lp' ? s.lp : type === 'hp' ? s.hp : s.bp);
    let a = mode === 'rise' ? u ** shape : (1 - u) ** shape;
    // Short fades so nothing clicks at either end.
    a *= Math.min(1, (i / SR) / 0.01) * Math.min(1, ((n - i) / SR) / (mode === 'rise' ? 0.015 : 0.05));
    if (idx < 0) continue;
    bus.L[idx] += pick(fl) * a * gain;
    bus.R[idx] += pick(fr) * a * gain;
  }
}

/** Tonal riser: a detuned saw pair gliding up, lowpassed, fading in. */
export function toneRiser(bus, t0, t1, o, rng) {
  const { gain = 0.08, m0 = 45, m1 = 69, cut0 = 400, cut1 = 5000, shape = 2 } = o;
  const a = new Osc(rng());
  const b = new Osc(rng());
  const fl = new SVF(cut0, 0.9);
  const fr = new SVF(cut0, 0.9);
  const i0 = startIndex(t0);
  const n = Math.ceil((t1 - t0) * SR);
  for (let i = 0; i < n; i++) {
    const idx = i0 + i;
    if (idx >= bus.n) break;
    const u = i / n;
    const f = mtof(m0 + (m1 - m0) * u * u);
    if ((i & 15) === 0) {
      fl.set(cut0 * (cut1 / cut0) ** u, 0.9);
      fr.copyCoeffs(fl);
    }
    const yl = fl.tick(a.saw((f * 0.997) / SR));
    const yr = fr.tick(b.saw((f * 1.003) / SR));
    const amp = u ** shape * Math.min(1, ((n - i) / SR) / 0.015) * gain;
    if (idx < 0) continue;
    bus.L[idx] += yl * amp;
    bus.R[idx] += yr * amp;
  }
}

/** Soft low impact: a descending sine thump with a puff of lowpassed noise. */
export function boom(bus, t0, o, rng) {
  const { gain = 0.35, f0 = 62, f1 = 33, decay = 0.7, len = 2.5, noise = 0.15 } = o;
  const i0 = startIndex(t0);
  const n = Math.ceil(len * SR);
  const lp = new SVF(500, 0.7);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const idx = i0 + i;
    if (idx >= bus.n) break;
    const t = i / SR;
    ph += (f1 + (f0 - f1) * Math.exp(-t / 0.25)) / SR;
    const nz = lp.tick(rng() * 2 - 1) * noise * Math.exp(-t / 0.18);
    const amp = Math.min(1, t / 0.004) * Math.exp(-t / decay) * Math.min(1, (len - t) / 0.2);
    const y = (Math.sin(TAU * ph) + nz) * amp * gain;
    if (idx < 0) continue;
    bus.L[idx] += y;
    bus.R[idx] += y;
  }
}

// ---------------------------------------------------------------------------
// Bus processing

/** In-place SVF on a bus with a per-sample cutoff array (or a constant). */
export function filterBus(bus, cutoff, q = 0.707, mode = 'lp') {
  const fl = new SVF(1000, q);
  const fr = new SVF(1000, q);
  const isArr = typeof cutoff !== 'number';
  if (!isArr) {
    fl.set(cutoff, q);
    fr.copyCoeffs(fl);
  }
  for (let i = 0; i < bus.n; i++) {
    if (isArr && (i & 15) === 0) {
      fl.set(cutoff[i], q);
      fr.copyCoeffs(fl);
    }
    fl.tick(bus.L[i]);
    fr.tick(bus.R[i]);
    bus.L[i] = mode === 'hp' ? fl.hp : mode === 'bp' ? fl.bp : fl.lp;
    bus.R[i] = mode === 'hp' ? fr.hp : mode === 'bp' ? fr.bp : fr.lp;
  }
  return bus;
}

/** In-place static biquad on both channels. */
export function eqBus(bus, type, f, q = 0.7071, gainDb = 0) {
  const a = new Biquad(type, f, q, gainDb);
  const b = new Biquad(type, f, q, gainDb);
  for (let i = 0; i < bus.n; i++) {
    bus.L[i] = a.tick(bus.L[i]);
    bus.R[i] = b.tick(bus.R[i]);
  }
  return bus;
}

/** Multiply a bus by a per-sample gain array. */
export function applyGain(bus, g) {
  for (let i = 0; i < bus.n; i++) {
    bus.L[i] *= g[i];
    bus.R[i] *= g[i];
  }
  return bus;
}

/**
 * Sidechain-style ducking envelope driven by a list of kick times.
 * Returns a per-sample gain array (1 = no ducking).
 */
export function duckEnvelope(n, times, { depth = 0.3, attack = 0.006, release = 0.16, depthAt = null } = {}) {
  const g = new Float32Array(n).fill(1);
  const span = Math.ceil((attack + release * 6) * SR);
  for (const tk of times) {
    const d = depthAt ? depthAt(tk) * depth : depth;
    if (d <= 0) continue;
    const i0 = Math.round(tk * SR);
    for (let i = 0; i < span; i++) {
      const idx = i0 + i;
      if (idx >= n) break;
      const t = i / SR;
      const shape = t < attack ? t / attack : Math.exp(-(t - attack) / release);
      const v = 1 - d * shape;
      if (v < g[idx]) g[idx] = v;
    }
  }
  return g;
}

/** Stereo chorus: one modulated delay per side, LFOs in quadrature. */
export function chorus(bus, { rate = 0.23, depth = 0.0025, base = 0.012, mix = 0.45 } = {}) {
  const size = Math.ceil((base + depth * 2) * SR) + 8;
  const bl = new Float32Array(size);
  const br = new Float32Array(size);
  let w = 0;
  const read = (buf, d) => {
    let pos = w - d;
    while (pos < 0) pos += size;
    const i = Math.floor(pos);
    const fr = pos - i;
    const a = buf[i % size];
    const b = buf[(i + 1) % size];
    return a + (b - a) * fr;
  };
  const norm = 1 / (1 + mix * 0.5);
  for (let i = 0; i < bus.n; i++) {
    const t = i / SR;
    const xl = bus.L[i];
    const xr = bus.R[i];
    bl[w] = xl;
    br[w] = xr;
    const dl = (base + depth * Math.sin(TAU * rate * t)) * SR;
    const dr = (base + depth * Math.sin(TAU * rate * t + Math.PI / 2)) * SR;
    const wl = read(bl, dl);
    const wr = read(br, dr);
    bus.L[i] = (xl + wl * mix) * norm;
    bus.R[i] = (xr + wr * mix) * norm;
    w = (w + 1) % size;
  }
  return bus;
}

/** Ping-pong delay. Returns a new wet-only Bus. The feedback path is band-limited. */
export function pingPong(src, { time = 0.375, feedback = 0.35, lp = 3800, hp = 350 } = {}) {
  const out = new Bus(src.n);
  const D = Math.round(time * SR);
  const dl = new Float32Array(D);
  const dr = new Float32Array(D);
  const inHp = new Biquad('highpass', hp, 0.7);
  const fbL = new Biquad('lowpass', lp, 0.7);
  const fbR = new Biquad('lowpass', lp, 0.7);
  let w = 0;
  for (let i = 0; i < src.n; i++) {
    const x = inHp.tick((src.L[i] + src.R[i]) * 0.5);
    const yl = dl[w];
    const yr = dr[w];
    dl[w] = x + fbL.tick(yr) * feedback;
    dr[w] = fbR.tick(yl) * feedback * 1.0;
    out.L[i] = yl;
    out.R[i] = yr;
    w = (w + 1) % D;
  }
  return out;
}

/**
 * Freeverb-style algorithmic reverb (8 parallel damped combs + 4 series
 * allpasses per side, Jezar's public-domain topology), tunings rescaled to 48 kHz.
 * Returns a new wet-only Bus.
 */
export function freeverb(src, { room = 0.86, damp = 0.4, width = 1, predelay = 0.02, hp = 220, lp = 8000 } = {}) {
  const scale = SR / 44100;
  const combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const apT = [556, 441, 341, 225];
  const spread = 23;
  const mk = (len) => ({ buf: new Float32Array(Math.round(len * scale)), i: 0, store: 0 });
  const cl = combT.map((t) => mk(t));
  const cr = combT.map((t) => mk(t + spread));
  const al = apT.map((t) => mk(t));
  const ar = apT.map((t) => mk(t + spread));
  const fb = room * 0.28 + 0.7;
  const d1 = damp * 0.4;
  const d2 = 1 - d1;
  const wet1 = width / 2 + 0.5;
  const wet2 = (1 - width) / 2;
  const pd = Math.max(1, Math.round(predelay * SR));
  const pre = new Float32Array(pd);
  let pw = 0;
  const inHp = new Biquad('highpass', hp, 0.7);
  const inLp = new Biquad('lowpass', lp, 0.7);
  const out = new Bus(src.n);
  const comb = (c, x) => {
    const y = c.buf[c.i];
    c.store = y * d2 + c.store * d1;
    c.buf[c.i] = x + c.store * fb;
    if (++c.i >= c.buf.length) c.i = 0;
    return y;
  };
  const allp = (a, x) => {
    const b = a.buf[a.i];
    a.buf[a.i] = x + b * 0.5;
    if (++a.i >= a.buf.length) a.i = 0;
    return b - x;
  };
  for (let n = 0; n < src.n; n++) {
    const xin = inLp.tick(inHp.tick((src.L[n] + src.R[n]) * 0.5));
    const x = pre[pw] * 0.015 * 2;
    pre[pw] = xin;
    pw = (pw + 1) % pd;
    let l = 0;
    let r = 0;
    for (let k = 0; k < 8; k++) {
      l += comb(cl[k], x);
      r += comb(cr[k], x);
    }
    for (let k = 0; k < 4; k++) {
      l = allp(al[k], l);
      r = allp(ar[k], r);
    }
    out.L[n] = l * wet1 + r * wet2;
    out.R[n] = r * wet1 + l * wet2;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Master bus

/** Stereo-linked feed-forward compressor with a soft knee. */
export function compressor(bus, { threshold = -18, ratio = 2, attack = 0.012, release = 0.18, knee = 6, makeup = 0 } = {}) {
  const ca = Math.exp(-1 / (attack * SR));
  const cr = Math.exp(-1 / (release * SR));
  let env = -120;
  const mk = dbToGain(makeup);
  let minGain = 0;
  for (let i = 0; i < bus.n; i++) {
    const x = Math.max(Math.abs(bus.L[i]), Math.abs(bus.R[i]));
    const xd = gainToDb(x);
    let gr;
    const over = xd - threshold;
    if (over <= -knee / 2) gr = 0;
    else if (over >= knee / 2) gr = over * (1 / ratio - 1);
    else gr = ((1 / ratio - 1) * (over + knee / 2) ** 2) / (2 * knee);
    env = gr < env ? ca * env + (1 - ca) * gr : cr * env + (1 - cr) * gr;
    if (i === 0) env = gr;
    if (env < minGain) minGain = env;
    const g = dbToGain(env) * mk;
    bus.L[i] *= g;
    bus.R[i] *= g;
  }
  return { maxReductionDb: -minGain };
}

/** Gentle tanh saturation, unity gain for small signals. */
export function saturate(bus, drive = 1.2) {
  for (let i = 0; i < bus.n; i++) {
    bus.L[i] = Math.tanh(bus.L[i] * drive) / drive;
    bus.R[i] = Math.tanh(bus.R[i] * drive) / drive;
  }
  return bus;
}

/**
 * Parallel ("New York") compression: a heavily compressed and saturated copy,
 * level-matched to the dry signal by RMS, blended underneath it. Adds density
 * and sustain to drums while the dry transients stay intact.
 */
export function parallelCompress(bus, { threshold = -30, ratio = 6, attack = 0.003, release = 0.08, drive = 2, mix = 0.35 } = {}) {
  const wet = new Bus(bus.n);
  wet.L.set(bus.L);
  wet.R.set(bus.R);
  let dry = 0;
  for (let i = 0; i < bus.n; i++) dry += bus.L[i] * bus.L[i] + bus.R[i] * bus.R[i];
  // Threshold relative to the bus peak, so the amount of squash does not depend on gain staging.
  let pk = 0;
  for (let i = 0; i < bus.n; i++) pk = Math.max(pk, Math.abs(bus.L[i]), Math.abs(bus.R[i]));
  const res = compressor(wet, { threshold: gainToDb(pk) + threshold, ratio, attack, release, knee: 6 });
  saturate(wet.scale(1 / Math.max(pk, 1e-9)), drive);
  let w = 0;
  for (let i = 0; i < bus.n; i++) w += wet.L[i] * wet.L[i] + wet.R[i] * wet.R[i];
  const g = Math.sqrt(dry / Math.max(w, 1e-20)) * mix;
  for (let i = 0; i < bus.n; i++) {
    bus.L[i] += wet.L[i] * g;
    bus.R[i] += wet.R[i] * g;
  }
  return res;
}

/**
 * Look-ahead brickwall limiter on true peaks (4x oversampled estimate; sample
 * peaks with truePeak=false). A forward-looking minimum of
 * the required gain, smoothed by a moving average of the same length, can never
 * let a sample exceed the ceiling; release is a one-pole recovery.
 */
export function limiter(bus, { ceilingDb = -2, lookahead = 0.004, release = 0.09, truePeak = true, peakEnv = null, envScale = 1 } = {}) {
  const n = bus.n;
  const c = dbToGain(ceilingDb);
  const W = Math.max(2, Math.round(lookahead * SR));
  const req = new Float32Array(n);
  // peakEnv: a true-peak envelope computed earlier on the same signal before a
  // pure gain change (envScale), so iterating on gain does not recompute it.
  const pk = peakEnv ?? (truePeak ? truePeakEnvelope(bus) : null);
  for (let i = 0; i < n; i++) {
    const p = pk ? pk[i] * envScale : Math.max(Math.abs(bus.L[i]), Math.abs(bus.R[i]));
    req[i] = p > c ? c / p : 1;
  }
  // m[i] = min(req[i .. i+W-1]) with a monotonic deque
  const m = new Float32Array(n);
  const dq = new Int32Array(n);
  let h = 0;
  let tl = 0;
  for (let j = n - 1; j >= 0; j--) {
    while (tl > h && req[dq[tl - 1]] >= req[j]) tl--;
    dq[tl++] = j;
    while (dq[h] > j + W - 1) h++;
    m[j] = req[dq[h]];
  }
  // The deque is filled from the end, so its head holds the largest index and
  // expires first. Next: moving average of m over the last W samples. Every
  // value in that window is <= req at the current sample, so the average is too.
  const rc = 1 - Math.exp(-1 / (release * SR));
  let sum = 0;
  let g = 1;
  let minG = 1;
  for (let i = 0; i < n; i++) {
    sum += m[i];
    if (i >= W) sum -= m[i - W];
    const s = i >= W - 1 ? sum / W : Math.min(1, sum / (i + 1));
    g = Math.min(s, g + (1 - g) * rc);
    if (g < minG) minG = g;
    bus.L[i] *= g;
    bus.R[i] *= g;
  }
  return { maxReductionDb: -gainToDb(minG) };
}

/**
 * Per-sample true-peak estimate: the larger of |x[i]| and the 4x-oversampled
 * (windowed-sinc) inter-sample values on either side of it, over both channels.
 */
export function truePeakEnvelope(bus) {
  const M = 16;
  const phases = [0.25, 0.5, 0.75].map((ph) => {
    const h = new Float64Array(2 * M);
    for (let k = -(M - 1); k <= M; k++) {
      const t = ph - k;
      const sinc = Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.42 + 0.5 * Math.cos((Math.PI * t) / M) + 0.08 * Math.cos((2 * Math.PI * t) / M);
      h[k + M - 1] = sinc * w;
    }
    return h;
  });
  const n = bus.n;
  const env = new Float32Array(n);
  for (const x of [bus.L, bus.R]) {
    for (let i = 0; i < n; i++) {
      const a = Math.abs(x[i]);
      if (a > env[i]) env[i] = a;
      if (i < M - 1 || i + M >= n) continue;
      let m = 0;
      for (const h of phases) {
        let y = 0;
        for (let k = 0; k < 2 * M; k++) y += x[i - (M - 1) + k] * h[k];
        const ay = Math.abs(y);
        if (ay > m) m = ay;
      }
      if (m > env[i]) env[i] = m;
      if (m > env[i + 1]) env[i + 1] = m;
    }
  }
  return env;
}

/** ITU-R BS.1770-4 integrated loudness (LUFS) of a 48 kHz stereo signal. */
export function loudness(L, R) {
  const kw = () => {
    const s1 = { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585, z1: 0, z2: 0 };
    const s2 = { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621, z1: 0, z2: 0 };
    const t = (f, x) => {
      const y = f.b0 * x + f.z1;
      f.z1 = f.b1 * x - f.a1 * y + f.z2;
      f.z2 = f.b2 * x - f.a2 * y;
      return y;
    };
    return (x) => t(s2, t(s1, x));
  };
  const kl = kw();
  const kr = kw();
  const hop = Math.round(0.1 * SR);
  const nSub = Math.floor(L.length / hop);
  const sub = new Float64Array(nSub);
  for (let b = 0; b < nSub; b++) {
    let acc = 0;
    for (let i = b * hop; i < (b + 1) * hop; i++) {
      const l = kl(L[i]);
      const r = kr(R[i]);
      acc += l * l + r * r;
    }
    sub[b] = acc;
  }
  const blocks = [];
  for (let b = 0; b + 3 < nSub; b++) {
    blocks.push((sub[b] + sub[b + 1] + sub[b + 2] + sub[b + 3]) / (4 * hop));
  }
  const lk = (p) => -0.691 + 10 * Math.log10(Math.max(p, 1e-20));
  const abs = blocks.filter((p) => lk(p) > -70);
  if (!abs.length) return -Infinity;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const rel = lk(mean(abs)) - 10;
  const gated = abs.filter((p) => lk(p) > rel);
  return lk(mean(gated));
}

// ---------------------------------------------------------------------------
// WAV I/O

const PCM_GUID = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]);

/** 24-bit stereo WAV (WAVE_FORMAT_EXTENSIBLE) with seeded TPDF dither. */
export function encodeWav24(L, R, seed = 1) {
  const n = L.length;
  const ch = 2;
  const bps = 3;
  const dataBytes = n * ch * bps;
  const buf = Buffer.alloc(68 + dataBytes);
  let o = 0;
  const str = (s) => {
    buf.write(s, o, 'ascii');
    o += s.length;
  };
  const u32 = (v) => {
    buf.writeUInt32LE(v, o);
    o += 4;
  };
  const u16 = (v) => {
    buf.writeUInt16LE(v, o);
    o += 2;
  };
  str('RIFF');
  u32(60 + dataBytes);
  str('WAVE');
  str('fmt ');
  u32(40);
  u16(0xfffe);
  u16(ch);
  u32(SR);
  u32(SR * ch * bps);
  u16(ch * bps);
  u16(24);
  u16(22);
  u16(24);
  u32(3);
  PCM_GUID.copy(buf, o);
  o += 16;
  str('data');
  u32(dataBytes);
  const rng = makeRng(seed);
  const FS = 8388607;
  for (let i = 0; i < n; i++) {
    for (const x of [L[i], R[i]]) {
      let v = Math.round(x * FS + (rng() - rng()));
      if (v > FS) v = FS;
      if (v < -FS - 1) v = -FS - 1;
      buf.writeIntLE(v, o, 3);
      o += 3;
    }
  }
  return buf;
}

/** Decode a PCM WAV (16/24/32-bit int or 32-bit float, any fmt tag) into Float32 channels. */
export function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12;
  let fmt = null;
  let data = null;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      let tag = buf.readUInt16LE(o + 8);
      if (tag === 0xfffe) tag = buf.readUInt16LE(o + 8 + 24);
      fmt = { tag, ch: buf.readUInt16LE(o + 10), sr: buf.readUInt32LE(o + 12), bits: buf.readUInt16LE(o + 22) };
    } else if (id === 'data') {
      data = { start: o + 8, size: Math.min(size, buf.length - o - 8) };
    }
    o += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  const bpsmp = fmt.bits / 8;
  const frames = Math.floor(data.size / (bpsmp * fmt.ch));
  const chans = Array.from({ length: fmt.ch }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.ch; c++) {
      const p = data.start + (i * fmt.ch + c) * bpsmp;
      let v;
      if (fmt.tag === 3) v = buf.readFloatLE(p);
      else if (fmt.bits === 16) v = buf.readInt16LE(p) / 32768;
      else if (fmt.bits === 24) v = buf.readIntLE(p, 3) / 8388608;
      else v = buf.readInt32LE(p) / 2147483648;
      chans[c][i] = v;
    }
  }
  return { sr: fmt.sr, bits: fmt.bits, channels: chans };
}
