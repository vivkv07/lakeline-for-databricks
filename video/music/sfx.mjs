#!/usr/bin/env node
// Sound-effects layer for the Lakeline launch video, driven by the composer's
// timed events (dist/video/music/events.json), mixed with the music and mastered.
//
// Run: node video/music/sfx.mjs [--wait]
//   --wait  poll for events.json every 30 s for up to 20 min if it is missing
//
// Writes (dist/video/music/):
//   sfx.wav            the SFX stem alone (48 kHz, 24-bit), at the level used in the mix
//   mix-raw.wav        music + SFX before ffmpeg loudnorm
//   mix.wav            music + SFX, -14 LUFS integrated, true peak <= -1 dBTP (48 kHz, 24-bit)
//   mix-preview.mp3    320 kb/s preview
//   sfx-placed.json    every placed SFX (time, kind, level), counts per kind, skipped events
//   qc-mix.json, spectrum-mix.png, waveform-mix.png
//
// Every sound is synthesized here from oscillators and seeded noise (no samples,
// no libraries), so the output is deterministic.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './synth.mjs';
import { render, musicChain, finalize, dropGap, tailFade, TIMING, OUT_DIR, markers } from './compose.mjs';
import { master } from './master.mjs';
import { check } from './check.mjs';

const SR = S.SR;
const TAU = Math.PI * 2;
const SEED = 0x5fc1a7e;
const EVENTS = path.join(OUT_DIR, 'events.json');

// ---------------------------------------------------------------------------
// SFX voices. Each renders into a (short, local) Bus at local time t0.

function addLR(bus, idx, l, r) {
  if (idx >= 0 && idx < bus.n) {
    bus.L[idx] += l;
    bus.R[idx] += r;
  }
}

/** Soft, crisp UI click: a tiny high-passed noise transient plus a short two-tone "tock". */
function uiClick(bus, t0, rng, { pitch = 1, pan = 0 } = {}) {
  const i0 = Math.round(t0 * SR);
  const n = Math.round(0.09 * SR);
  const hp = new S.SVF(3000, 0.7);
  const [pl, pr] = S.panLR(pan);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    hp.tick(rng() * 2 - 1);
    const tr = hp.hp * Math.exp(-t / 0.0008) * 0.35;
    const tone =
      Math.sin(TAU * 2300 * pitch * t) * Math.exp(-t / 0.01) * 0.45 + Math.sin(TAU * 1150 * pitch * t) * Math.exp(-t / 0.018) * 0.35;
    const y = (tr + tone) * Math.min(1, t / 0.0003) * Math.min(1, (n - i) / (0.01 * SR));
    addLR(bus, i0 + i, y * pl, y * pr);
  }
}

/** Tiny tick: a short high sine ping with a breath of noise. */
function tick(bus, t0, rng, { pitch = 1, pan = 0 } = {}) {
  const i0 = Math.round(t0 * SR);
  const n = Math.round(0.05 * SR);
  const hp = new S.SVF(6000, 0.7);
  const [pl, pr] = S.panLR(pan);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    hp.tick(rng() * 2 - 1);
    const y = (Math.sin(TAU * 3400 * pitch * t) * Math.exp(-t / 0.005) + hp.hp * Math.exp(-t / 0.0005) * 0.12) * Math.min(1, t / 0.0002);
    addLR(bus, i0 + i, y * pl, y * pr);
  }
}

/**
 * Airy whoosh: band-passed noise whose brightness follows its level, plus a
 * thin high "air" layer, panned from `from` to `to` across its length. The
 * level peaks at `peak` (fraction of the length).
 */
function whoosh(bus, t0, dur, rng, { from = -0.6, to = 0.6, f0 = 450, f1 = 5200, air = 0.12, q = 0.9, peak = 0.55 } = {}) {
  const i0 = Math.round(t0 * SR);
  const n = Math.round(dur * SR);
  const bl = new S.SVF(f0, q);
  const br = new S.SVF(f0, q);
  const al = new S.SVF(6500, 0.7);
  const ar = new S.SVF(6500, 0.7);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const env = u < peak ? Math.sin((Math.PI / 2) * (u / peak)) ** 2 : Math.cos((Math.PI / 2) * ((u - peak) / (1 - peak))) ** 2;
    if ((i & 15) === 0) {
      bl.set(f0 * (f1 / f0) ** env, q);
      br.copyCoeffs(bl);
    }
    const c = rng() * 2 - 1;
    const nl = 0.6 * c + 0.4 * (rng() * 2 - 1);
    const nr = 0.6 * c + 0.4 * (rng() * 2 - 1);
    bl.tick(nl);
    br.tick(nr);
    al.tick(nl);
    ar.tick(nr);
    const [pl, pr] = S.panLR(from + (to - from) * u);
    addLR(bus, i0 + i, (bl.bp + al.hp * air) * env * pl, (br.bp + ar.hp * air) * env * pr);
  }
}

/** Very subtle low swish for camera moves: lowpassed noise sweeping up (push-in) or down (pull-back). */
function swish(bus, t0, dur, rng, { up = true, from = 0, to = 0 } = {}) {
  const i0 = Math.round(t0 * SR);
  const n = Math.round(dur * SR);
  const fl = new S.SVF(220, 0.8);
  const fr = new S.SVF(220, 0.8);
  const [a, b] = up ? [220, 950] : [950, 220];
  for (let i = 0; i < n; i++) {
    const u = i / n;
    if ((i & 15) === 0) {
      fl.set(a * (b / a) ** u, 0.8);
      fr.copyCoeffs(fl);
    }
    const c = rng() * 2 - 1;
    fl.tick(0.8 * c + 0.2 * (rng() * 2 - 1));
    fr.tick(0.8 * c + 0.2 * (rng() * 2 - 1));
    const env = Math.sin(Math.PI * u) ** 1.5;
    const [pl, pr] = S.panLR(from + (to - from) * u);
    addLR(bus, i0 + i, fl.lp * env * pl, fr.lp * env * pr);
  }
}

/** Deep cinematic impact: a sub drop, a body thud, a noise burst and a short crack, saturated. */
function impact(bus, t0, rng) {
  const i0 = Math.round(t0 * SR);
  const len = 3.2;
  const n = Math.round(len * SR);
  const ll = new S.SVF(2500, 0.7);
  const lr = new S.SVF(2500, 0.7);
  const hl = new S.SVF(4000, 0.7);
  const hr = new S.SVF(4000, 0.7);
  const norm = 1 / Math.tanh(1.4);
  let p1 = 0;
  let p2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    p1 += (30 + 55 * Math.exp(-t / 0.3)) / SR;
    p2 += (70 + 50 * Math.exp(-t / 0.05)) / SR;
    const sub = Math.sin(TAU * p1) * Math.exp(-t / 1.0) * 0.9;
    const thud = Math.sin(TAU * p2) * Math.exp(-t / 0.1) * 0.5;
    const c = rng() * 2 - 1;
    const nl = 0.5 * c + 0.5 * (rng() * 2 - 1);
    const nr = 0.5 * c + 0.5 * (rng() * 2 - 1);
    ll.tick(nl);
    lr.tick(nr);
    hl.tick(nl);
    hr.tick(nr);
    const burst = Math.exp(-t / 0.16) * 0.55;
    const crack = Math.exp(-t / 0.015) * 0.25;
    const env = Math.min(1, t / 0.002) * Math.min(1, (len - t) / 0.3);
    const yl = Math.tanh(1.4 * (sub + thud + ll.lp * burst + hl.hp * crack)) * norm * env;
    const yr = Math.tanh(1.4 * (sub + thud + lr.lp * burst + hr.hp * crack)) * norm * env;
    addLR(bus, i0 + i, yl, yr);
  }
}

/** Soft "land" thump for the wordmark settling. */
function land(bus, t0, rng) {
  const i0 = Math.round(t0 * SR);
  const n = Math.round(0.5 * SR);
  const hp = new S.SVF(3000, 0.7);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (60 + 35 * Math.exp(-t / 0.04)) / SR;
    hp.tick(rng() * 2 - 1);
    const y = (Math.sin(TAU * ph) * Math.exp(-t / 0.12) * 0.8 + hp.hp * Math.exp(-t / 0.004) * 0.25) * Math.min(1, t / 0.001);
    addLR(bus, i0 + i, y, y);
  }
}

/** Bright two-note "answer ready" chime: A5 then E6, small bell partials. */
function chime(bus, t0, rng) {
  const notes = [
    [0, 880, -0.15],
    [0.09, 1318.51, 0.15],
  ];
  const partials = [
    [1, 1, 0.9],
    [2, 0.38, 0.5],
    [3, 0.14, 0.25],
    [4.17, 0.07, 0.12],
  ];
  for (const [dt, f, pan] of notes) {
    const i0 = Math.round((t0 + dt) * SR);
    const n = Math.round(2.2 * SR);
    const [pl, pr] = S.panLR(pan);
    const ph = partials.map(() => rng());
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let v = 0;
      for (let k = 0; k < partials.length; k++) {
        const [r, a, d] = partials[k];
        v += a * Math.sin(TAU * (f * r * t + ph[k])) * Math.exp(-t / d);
      }
      const y = v * Math.min(1, t / 0.002) * Math.min(1, (n - i) / (0.05 * SR)) * 0.6;
      addLR(bus, i0 + i, y * pl, y * pr);
    }
  }
}

/** Soft paper/paste blip: a flutter of band-passed noise and a short rising blip. */
function pasteBlip(bus, t0, rng) {
  const i0 = Math.round(t0 * SR);
  const n = Math.round(0.25 * SR);
  const bp = new S.SVF(2600, 0.8);
  const bursts = [
    [0, 0.7],
    [0.018, 1],
    [0.04, 0.6],
  ];
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let e = 0.3 * Math.exp(-t / 0.03);
    for (const [bt, w] of bursts) if (t >= bt) e += w * Math.exp(-(t - bt) / 0.006);
    bp.tick(rng() * 2 - 1);
    ph += (620 * (1050 / 620) ** Math.min(1, t / 0.05)) / SR;
    const blip = Math.sin(TAU * ph) * Math.exp(-t / 0.05) * 0.5 * Math.min(1, t / 0.002);
    const y = (bp.bp * e * 1.4 + blip) * Math.min(1, (n - i) / (0.02 * SR));
    addLR(bus, i0 + i, y, y);
  }
}

/** Short alert: two notes a minor third apart, falling (E5 to C#5). */
function alertTone(bus, t0, rng) {
  const notes = [
    [0, 659.26, 0.13],
    [0.15, 554.37, 0.24],
  ];
  for (const [dt, f, gate] of notes) {
    const i0 = Math.round((t0 + dt) * SR);
    const n = Math.round((gate + 0.5) * SR);
    const o1 = new S.Osc(rng());
    const o2 = new S.Osc(rng());
    const lp = new S.SVF(3500, 0.7);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const s = o1.tri(f / SR) + o2.pulse(f / SR, 0.3) * 0.25;
      const y = lp.tick(s) * S.adsr(t, gate, 0.005, 0.6, 0.6, 0.06) * 0.7;
      addLR(bus, i0 + i, y, y);
    }
  }
}

/** Gentle shimmer: a staggered cluster of high partials (D6 A6 E7 F#7 A7) with tremolo. */
function shimmer(bus, t0, dur, rng) {
  const freqs = [1174.66, 1760, 2637.02, 2959.96, 3520];
  freqs.forEach((f0, k) => {
    const start = t0 + k * 0.035 + rng() * 0.02;
    const f = f0 * 2 ** (((rng() - 0.5) * 8) / 1200);
    const rate = 6 + rng() * 3;
    const ph = rng() * TAU;
    const i0 = Math.round(start * SR);
    const n = Math.round((dur + 2.2) * SR);
    const [pl, pr] = S.panLR(-0.6 + (1.2 * k) / (freqs.length - 1));
    const amp = 0.35 / Math.sqrt(k + 1);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const env = Math.min(1, t / 0.12) * Math.exp(-Math.max(0, t - 0.12) / 0.55) * Math.min(1, (n - i) / (0.05 * SR));
      const trem = 1 - 0.35 * (0.5 + 0.5 * Math.sin(TAU * rate * t + ph));
      const y = Math.sin(TAU * f * t + ph) * env * trem * amp;
      addLR(bus, i0 + i, y * pl, y * pr);
    }
  });
}

/** Riser: noise sweep plus a gliding detuned saw pair (synth.mjs primitives). */
function riser(bus, t0, t1, rng) {
  S.noiseSweep(bus, t0, t1, { gain: 0.5, f0: 300, f1: 6500, q: 1.2, shape: 2.4 }, rng);
  S.toneRiser(bus, t0 + (t1 - t0) * 0.35, t1, { gain: 0.12, m0: 45, m1: 81, cut0: 400, cut1: 6000 }, rng);
}

// ---------------------------------------------------------------------------
// Level helpers

function rmsDb(bus, t0, t1) {
  const a = Math.max(0, Math.round(t0 * SR));
  const b = Math.min(bus.n, Math.round(t1 * SR));
  let s = 0;
  for (let i = a; i < b; i++) s += (bus.L[i] * bus.L[i] + bus.R[i] * bus.R[i]) / 2;
  return 10 * Math.log10(s / Math.max(1, b - a) + 1e-20);
}

/** Loudest 50 ms RMS window of a bus, in dB. */
function peakWindowDb(bus, win = 0.05) {
  const w = Math.round(win * SR);
  let s = 0;
  let best = 0;
  for (let i = 0; i < bus.n; i++) {
    s += (bus.L[i] * bus.L[i] + bus.R[i] * bus.R[i]) / 2;
    if (i >= w) s -= (bus.L[i - w] * bus.L[i - w] + bus.R[i - w] * bus.R[i - w]) / 2;
    if (s > best) best = s;
  }
  return 10 * Math.log10(best / w + 1e-20);
}

export function duckGain(n, ducks) {
  const g = new Float32Array(n).fill(1);
  for (const d of ducks) {
    const depth = 1 - S.dbToGain(-d.db);
    const atk = 0.015;
    const rel = d.rel;
    const i0 = Math.round((d.t - atk) * SR);
    const len = Math.round((atk + d.hold + rel * 5) * SR);
    for (let i = 0; i < len; i++) {
      const idx = i0 + i;
      if (idx < 0 || idx >= n) continue;
      const t = i / SR;
      const shape = t < atk ? t / atk : t < atk + d.hold ? 1 : Math.exp(-(t - atk - d.hold) / rel);
      const v = 1 - depth * shape;
      if (v < g[idx]) g[idx] = v;
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// Event mapping

/**
 * How loud each SFX kind sits relative to the music around it: dB above the
 * music's RMS (over the event) for the SFX's loudest 50 ms. Sends go to the SFX
 * reverb; duckDb is how far the music dips under that SFX (15 ms attack, held
 * for `hold`, then released with time constant `rel`, 0.8 s by default).
 */
// win: the window (s) over which an SFX's "peak" level is measured. Very short
// sounds (clicks, ticks, the paste blip) use 10 ms so their transients do not
// overshoot the music's peaks and push the master limiter.
const KINDS = {
  click: { offsetDb: 3, send: 0.04, win: 0.01 },
  tick: { offsetDb: 1.5, send: 0.08, win: 0.01 },
  whoosh: { offsetDb: 3, send: 0.15, duckDb: 1.5, hold: 0.12, rel: 0.25 },
  swish: { offsetDb: -3, send: 0.08 },
  impact: { offsetDb: 6, send: 0.45, duckDb: 4, hold: 0.6 },
  land: { offsetDb: 3, send: 0.2, win: 0.01 },
  chime: { offsetDb: 5, send: 0.35, duckDb: 3, hold: 0.45 },
  paste: { offsetDb: 4, send: 0.12, win: 0.01 },
  alert: { offsetDb: 5, send: 0.2, duckDb: 3, hold: 0.4 },
  shimmer: { offsetDb: 3, send: 0.45 },
  riser: { offsetDb: 3, send: 0.3 },
};

const parseZoom = (label) => {
  const m = /([\d.]+)\s*→\s*([\d.]+)/.exec(label ?? '');
  return m ? Math.abs(Number(m[2]) - Number(m[1])) : 0.3;
};

/** Left-to-right order of tabs, from the tab label, for the whoosh pan direction. */
const tabOrder = (label) => {
  const l = (label ?? '').toLowerCase();
  if (l.includes('video')) return 1;
  if (l.includes('doc')) return 2;
  if (l.includes('-dev') || l.endsWith('dev')) return 1;
  if (l.includes('stage')) return 2;
  if (l.includes('prod')) return l.includes('prod-jobs') ? 0 : 3;
  return 1;
};

function loadEvents(wait) {
  const deadline = Date.now() + 20 * 60 * 1000;
  while (!fs.existsSync(EVENTS)) {
    if (!wait || Date.now() > deadline) throw new Error(`missing ${EVENTS} (run with --wait to poll for it)`);
    console.log('waiting for events.json ...');
    const until = Date.now() + 30000;
    while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  const j = JSON.parse(fs.readFileSync(EVENTS, 'utf8'));
  return (Array.isArray(j) ? j : j.events).slice().sort((a, b) => a.t - b.t || a.kind.localeCompare(b.kind));
}

export function buildSfx(music, events) {
  const n = music.n;
  const dry = new S.Bus(n);
  const send = new S.Bus(n);
  const placed = [];
  const skipped = [];
  const ducks = [];
  const drop = TIMING.start('drop');
  const lift = TIMING.start('lift');
  let serial = 0;

  /** Render one SFX locally, level it against the music around it, add it to the stem. */
  const put = (kind, t, fn, { pre = 0, len, span = 0.4, extraDb = 0, event = null } = {}) => {
    const k = KINDS[kind];
    const rng = S.makeRng((SEED + 7919 * ++serial) >>> 0);
    const local = new S.Bus(Math.ceil((pre + len) * SR));
    fn(local, pre, rng);
    const sfxDb = peakWindowDb(local, k.win ?? 0.05);
    const musicDb = Math.max(rmsDb(music, t - 0.25, t + span), -36);
    const targetDb = musicDb + k.offsetDb + extraDb;
    const g = S.dbToGain(targetDb - sfxDb);
    const off = Math.round((t - pre) * SR);
    for (let i = 0; i < local.n; i++) {
      const idx = off + i;
      if (idx < 0 || idx >= n) continue;
      dry.L[idx] += local.L[i] * g;
      dry.R[idx] += local.R[i] * g;
      send.L[idx] += local.L[i] * g * k.send;
      send.R[idx] += local.R[i] * g * k.send;
    }
    if (k.duckDb) ducks.push({ t, db: k.duckDb, hold: k.hold, rel: k.rel ?? 0.8 });
    placed.push({
      t: +t.toFixed(3),
      kind,
      from: event ? event.kind : 'fixed',
      label: event?.label ?? '',
      musicDb: +musicDb.toFixed(1),
      sfxPeakDb: +targetDb.toFixed(1),
      aboveMusicDb: +(k.offsetDb + extraDb).toFixed(1),
    });
  };
  const skip = (e, why) => skipped.push({ t: e.t, kind: e.kind, label: e.label, why });

  const cuts = events.filter((e) => e.kind === 'cut').map((e) => e.t);
  const transitions = events.filter((e) => e.kind === 'transition');
  const impacts = [];
  const lastTab = {};
  const near = (list, t, d) => list.some((x) => Math.abs(x - t) <= d);

  for (const e of events) {
    switch (e.kind) {
      case 'click':
        put('click', e.t, (b, t0, r) => uiClick(b, t0, r, { pitch: 0.97 + r() * 0.06 }), { len: 0.1, span: 0.2, event: e });
        break;
      case 'step':
        put('tick', e.t, (b, t0, r) => tick(b, t0, r, { pitch: 1 }), { len: 0.06, span: 0.2, event: e });
        break;
      case 'copy':
        // "Copied" confirmation: a slightly higher double tick.
        put('tick', e.t, (b, t0, r) => {
          tick(b, t0, r, { pitch: 1.12 });
          tick(b, t0 + 0.06, r, { pitch: 1.33 });
        }, { len: 0.12, span: 0.2, event: e });
        break;
      case 'logo-bar': {
        const bar = Number((/bar (\d)/.exec(e.label) || [0, 3])[1]) || 3;
        put('tick', e.t, (b, t0, r) => tick(b, t0, r, { pitch: [0.75, 0.84, 1.0][Math.min(2, bar - 1)] ?? 1, pan: (bar - 2) * 0.3 }), {
          len: 0.06, span: 0.2, extraDb: -3, event: e,
        });
        break;
      }
      case 'cut':
        if (Math.abs(e.t - drop) < 0.05) {
          put('impact', drop, (b, t0, r) => impact(b, t0, r), { len: 3.3, span: 0.6, event: e });
          impacts.push(drop);
        } else if (Math.abs(e.t - lift) < 0.05) skip(e, 'the riser into the Genie section carries this cut');
        else if (transitions.some((x) => e.t >= x.t && e.t <= x.t + (x.dur ?? 1) + 0.2)) skip(e, 'covered by the transition whoosh');
        // Peak 40 ms ahead of the cut, so it does not stack on the downbeat kick.
        else put('whoosh', e.t, (b, t0, r) => whoosh(b, t0 - 0.04 - 0.5 * 0.55, 0.5, r, { from: -0.6, to: 0.6 }), { pre: 0.35, len: 0.6, span: 0.3, event: e });
        break;
      case 'transition': {
        // One whoosh per scene change, its peak on the cut the transition leads into.
        const cut = cuts.find((c) => c >= e.t && c <= e.t + (e.dur ?? 1) + 0.2);
        const at = cut ?? e.t + (e.dur ?? 0.6) / 2;
        const vertical = /rise|lower|curtain|sheet/.test(e.label ?? '');
        put('whoosh', at, (b, t0, r) => whoosh(b, t0 - 0.04 - 0.6 * 0.55, 0.6, r, vertical ? { from: -0.15, to: 0.15, f0: 380 } : { from: -0.6, to: 0.6 }), {
          pre: 0.4, len: 0.7, span: 0.3, event: e,
        });
        break;
      }
      case 'theme-flip':
        put('whoosh', e.t + (e.dur ?? 1.8) / 2, (b, t0, r) => whoosh(b, t0 - 0.9 * 0.5, 0.9, r, { from: -0.3, to: 0.3, f0: 350, f1: 4200, peak: 0.5 }), {
          pre: 0.5, len: 1.0, span: 0.5, extraDb: -1, event: e,
        });
        break;
      case 'tab': {
        const o = tabOrder(e.label);
        const prev = lastTab[e.scene] ?? (e.scene === 9 ? 0 : 1);
        lastTab[e.scene] = o;
        const dir = o >= prev ? 1 : -1;
        put('whoosh', e.t, (b, t0, r) => whoosh(b, t0 - 0.35 * 0.55, 0.35, r, { from: -0.5 * dir, to: 0.5 * dir, f0: 600, f1: 6000 }), {
          pre: 0.2, len: 0.4, span: 0.25, extraDb: -1, event: e,
        });
        break;
      }
      case 'workspace-switch':
        put('whoosh', e.t, (b, t0, r) => whoosh(b, t0 - 0.4 * 0.55, 0.4, r, { from: 0.4, to: -0.4, f0: 500, f1: 5000 }), {
          pre: 0.25, len: 0.45, span: 0.25, extraDb: -1, event: e,
        });
        break;
      case 'push-in':
      case 'pull-back':
      case 'pan': {
        const amount = e.kind === 'pan' ? 0.3 : parseZoom(e.label);
        const dur = e.dur ?? 1.5;
        const extraDb = -4 + 4 * Math.min(1, amount / 0.8); // bigger zoom, a little more swish
        put('swish', e.t, (b, t0, r) => swish(b, t0, dur, r, { up: e.kind !== 'pull-back', from: e.kind === 'pan' ? -0.4 : 0, to: e.kind === 'pan' ? 0.4 : 0 }), {
          len: dur + 0.05, span: dur, extraDb, event: e,
        });
        break;
      }
      case 'cta-button':
        put('impact', e.t, (b, t0, r) => impact(b, t0, r), { len: 3.3, span: 0.6, event: e });
        impacts.push(e.t);
        break;
      case 'wordmark-land':
        if (near(impacts, e.t, 0.3)) skip(e, 'merged with the Add to Chrome impact');
        else put('land', e.t, (b, t0, r) => land(b, t0, r), { len: 0.5, span: 0.3, event: e });
        break;
      case 'logo-build':
        if (Math.abs(e.t - drop) < 0.1) skip(e, 'merged with the drop impact at 6.0');
        else skip(e, 'covered by the CTA transition whoosh and logo-bar ticks');
        break;
      case 'answer-land':
        put('chime', e.t, (b, t0, r) => chime(b, t0, r), { len: 2.4, span: 0.4, event: e });
        break;
      case 'paste':
        put('paste', e.t, (b, t0, r) => pasteBlip(b, t0, r), { len: 0.26, span: 0.25, event: e });
        break;
      case 'notification':
        put('alert', e.t, (b, t0, r) => alertTone(b, t0, r), { len: 1.0, span: 0.4, event: e });
        break;
      case 'failure':
        skip(e, 'the alert plays on the desktop notification 0.5 s later');
        break;
      case 'point':
        put('shimmer', e.t, (b, t0, r) => shimmer(b, t0, e.dur ?? 0.9, r), { len: (e.dur ?? 0.9) + 2.4, span: 0.8, event: e });
        break;
      default:
        skip(e, 'no sound for this kind (visual only)');
    }
  }

  // Risers into the drop (ending where the silent gap starts) and into the Genie section.
  const gapAt = drop - TIMING.DROP_GAP;
  put('riser', gapAt, (b, t0, r) => riser(b, t0 - 3.0, t0, r), { pre: 3.0, len: 3.05, span: 0.05 });
  put('riser', lift, (b, t0, r) => riser(b, t0 - 3.0, t0 - 0.02, r), { pre: 3.0, len: 3.05, span: 0.05 });

  // SFX reverb (its own hall), then the stem respects the drop gap and the tail fade.
  const rev = S.freeverb(send, { room: 0.88, damp: 0.35, width: 1, predelay: 0.015, hp: 200, lp: 9000 });
  rev.mixInto(dry, 1.0);
  // Keep the top end smooth: SFX are transient-rich, so tame the very top a little.
  S.eqBus(dry, 'highshelf', 8000, 0.7, -3);
  // Fast peak control on the SFX bus alone: no SFX peak may exceed the music's
  // own loudest true peak minus 2 dB, so the master limiter is not driven by SFX.
  let musicPeak = 0;
  for (const v of S.truePeakEnvelope(music)) if (v > musicPeak) musicPeak = v;
  const sfxLim = S.limiter(dry, { ceilingDb: S.gainToDb(musicPeak) - 2, lookahead: 0.002, release: 0.05 });
  dropGap(dry);
  tailFade(dry);
  return { sfx: dry, placed, skipped, ducks, sfxLimiterDb: sfxLim.maxReductionDb };
}

// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const events = loadEvents(process.argv.includes('--wait'));
  const { mix: music } = render();
  musicChain(music);
  const { sfx, placed, skipped, ducks, sfxLimiterDb } = buildSfx(music, events);

  // Duck the music under impacts, chimes and the alert; sum; master.
  S.applyGain(music, duckGain(music.n, ducks));
  const mix = new S.Bus(music.n);
  music.mixInto(mix);
  sfx.mixInto(mix);
  tailFade(mix);
  const fin = finalize(mix);
  const raw = path.join(OUT_DIR, 'mix-raw.wav');
  fs.writeFileSync(raw, S.encodeWav24(fin.out.L, fin.out.R, SEED));

  // The SFX stem at the gain it has in the mix (true-peak limited for safety).
  sfx.scale(S.dbToGain(fin.gainDb));
  S.limiter(sfx, { ceilingDb: -1.3 });
  fs.writeFileSync(path.join(OUT_DIR, 'sfx.wav'), S.encodeWav24(sfx.L, sfx.R, SEED + 1));

  const wav = path.join(OUT_DIR, 'mix.wav');
  const mp3 = path.join(OUT_DIR, 'mix-preview.mp3');
  const mres = master({ raw, wav, mp3 });

  const counts = {};
  for (const p of placed) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
  const skippedByKind = {};
  for (const s of skipped) (skippedByKind[s.kind] ??= { count: 0, why: s.why }).count++;
  const above = {};
  for (const p of placed) (above[p.kind] ??= new Set()).add(p.aboveMusicDb);
  fs.writeFileSync(
    path.join(OUT_DIR, 'sfx-placed.json'),
    JSON.stringify({ events: events.length, placedCount: placed.length, counts, skippedCount: skipped.length, skippedByKind, ducks, placed, skipped }, null, 2) + '\n',
  );

  console.log(
    `SFX: ${placed.length} placed from ${events.length} events in ${((Date.now() - t0) / 1000).toFixed(1)} s; ` +
      `SFX-bus limiter max GR ${sfxLimiterDb.toFixed(1)} dB, master limiter max GR ${fin.lim.maxReductionDb.toFixed(1)} dB; loudnorm (${mres.pass2.normalization_type}) ` +
      `I ${mres.pass2.output_i} LUFS, TP ${mres.pass2.output_tp} dBTP`,
  );
  console.log('placed per kind:', counts);
  console.log('level above music (dB; SFX loudest 10 ms for click, tick, paste, land, else 50 ms; vs music RMS):', Object.fromEntries(Object.entries(above).map(([k, v]) => [k, [...v].join('/')])));
  console.log('skipped per kind:', Object.fromEntries(Object.entries(skippedByKind).map(([k, v]) => [k, v.count])));
  const qc = check({ wav, markers: markers(), outDir: OUT_DIR, loudnorm: mres, name: 'mix' });
  if (!qc.pass) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
