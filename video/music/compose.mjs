#!/usr/bin/env node
// Arrangement for the Lakeline for Databricks launch theme.
//
// Run: node video/music/compose.mjs            (render + master + checks)
//      node video/music/compose.mjs --raw-only (render the raw WAV and markers only)
//
// Everything is original and generated here: the chord chart, the motif, the
// counter-melody and every drum hit are written out below as data and played
// by the synthesizers in synth.mjs. No samples, loops or sound fonts.
//
// 120 BPM, 4/4: one beat = 0.5 s, one bar = 2 s, so every storyboard mark in
// notes/VIDEO.md falls on a bar line. All parts are written relative to the
// start of their section, so a timeline change is an edit to SECTIONS only
// (as long as each section keeps roughly its length).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './synth.mjs';
import { master } from './master.mjs';
import { check } from './check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
export const OUT_DIR = path.join(ROOT, 'dist/video/music');

export const BPM = 120;
const SR = S.SR;
const BEAT = 60 / BPM;
const BAR = 4 * BEAT;
const STEP = BEAT / 4; // one 16th note
const SEED = 20261015;

/** Section marks (seconds). They must match the timeline in notes/VIDEO.md. */
const PLAN = [
  { id: 'intro', start: 0, end: 6, scene: '1 Hook', plan: 'Filtered pad, motif hint, riser into the drop. No drums.' },
  { id: 'drop', start: 6, end: 12, scene: '2 Reveal', plan: 'Drop at 6.0: light groove (kick on 1 and 3), full motif statement.' },
  { id: 'groove', start: 12, end: 74, scene: '3-7 Product tour', plan: 'Relaxed, spacious main groove; variation every 8 bars (12, 28, 44, 60).' },
  { id: 'breakdown', start: 74, end: 80, scene: '8 Theme flip', plan: 'Drums out, motif inverted, filter sweep and riser.' },
  { id: 'lift', start: 80, end: 116, scene: '9 Ask Genie', plan: 'Lifted, unhurried groove with the counter-melody; small lift at 99 (doc paste).' },
  { id: 'dark', start: 116, end: 126, scene: '10 Run monitor', plan: 'Groove continues, darker chords and filter.' },
  { id: 'bright', start: 126, end: 140, scene: '11 Workspace colors', plan: 'Brighter, playful variation: bouncy arp, rim ticks, motif returns.' },
  { id: 'calm', start: 140, end: 150, scene: '12 Security and privacy', plan: 'Pads and soft motif, no drums.' },
  { id: 'resolve', start: 150, end: 154, scene: '13 CTA', plan: 'Final chord swell with a callback to the motif.' },
];
const MUSIC_END = PLAN[PLAN.length - 1].end;
const LENGTH = MUSIC_END + 2.5; // reverb tail fades to silence by ~MUSIC_END + 2.3 s
export const SECTIONS = [...PLAN, { id: 'tail', start: MUSIC_END, end: LENGTH, scene: 'Tail', plan: 'Reverb tail fading to silence.' }];

/** The "small lift" inside the Genie section (doc paste). */
const LIFT_CUE = 99;
/** Scene and beat marks inside sections (notes/VIDEO.md, Pacing v2). Bar-aligned ones get a soft swell. */
const CUES = [
  [12, 'Connect'], [22, 'Cost banner'], [34, 'Run costs: runs list'], [41, 'Run costs: job total'],
  [48, 'Queries: estimate'], [54, 'Queries: size picker'], [60, 'Explorer: products'], [65, 'Explorer: top drivers'],
  [69, 'Explorer: calendar spike'], [80, 'Genie: ask'], [86, 'Genie: video tab'], [92, 'Genie: answer waiting'],
  [99, 'Genie: paste into doc (small lift)'], [106, 'Genie: switch agent'], [111, 'Genie: switch workspace'],
  [126, 'Colors: same-looking tabs'], [130, 'Colors: pick colors'], [135, 'Colors: switch tabs'],
].map(([time, label]) => ({ time, label }));

const SEC = Object.fromEntries(PLAN.map((s) => [s.id, { ...s, bar0: s.start / BAR, bars: (s.end - s.start) / BAR }]));
for (const s of PLAN) {
  if (!Number.isInteger(s.start / BAR) || !Number.isInteger(s.end / BAR)) throw new Error(`section ${s.id} is not on bar lines`);
}
const NBARS = MUSIC_END / BAR;
const st = (id) => SEC[id].start;
const at = (bar, step = 0) => bar * BAR + step * STEP;
/** Section id and bar index within it, for an absolute bar. */
const where = (bar) => {
  const s = PLAN.find((p) => bar >= SEC[p.id].bar0 && bar < SEC[p.id].bar0 + SEC[p.id].bars);
  return s ? { id: s.id, i: bar - SEC[s.id].bar0, n: SEC[s.id].bars } : { id: 'tail', i: 0, n: 0 };
};
const sectionAt = (t) => SECTIONS.find((s) => t >= s.start && t < s.end)?.id ?? 'tail';

// ---------------------------------------------------------------------------
// Harmony (key of D major)

const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const nm = (s) => {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(s);
  return 12 * (Number(m[3]) + 1) + NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
};

// root: bass note; pad: voicing without the bass root; arp: six chord tones, low to high.
const CHORDS = {
  D: { root: nm('D2'), pad: [50, 57, 61, 64, 66], arp: [57, 61, 62, 64, 66, 69] }, // Dmaj9
  Bm: { root: nm('B1'), pad: [47, 54, 57, 62, 64], arp: [54, 57, 59, 62, 64, 66] }, // Bm7(11)
  G: { root: nm('G1'), pad: [47, 54, 57, 62, 66], arp: [55, 59, 62, 66, 67, 69] }, // Gmaj9
  A: { root: nm('A1'), pad: [52, 57, 61, 64, 69], arp: [57, 61, 64, 69, 71, 73] }, // A(add9)
  Asus: { root: nm('A1'), pad: [52, 57, 59, 62, 64], arp: [57, 59, 62, 64, 69, 71] }, // A sus4(add9)
  Em: { root: nm('E1'), pad: [50, 55, 59, 62, 66], arp: [55, 59, 62, 64, 66, 71] }, // Em9
  Fsm: { root: nm('F#1'), pad: [49, 52, 57, 61, 64], arp: [57, 61, 64, 66, 69, 73] }, // F#m7
  Dfin: { root: nm('D2'), pad: [50, 57, 61, 64, 66, 69, 73, 76], arp: [57, 61, 62, 64, 66, 69] }, // wide Dmaj9
};

// CHART[bar] = [[chord, startStep, lengthSteps], ...] (16 steps per bar)
const CHART = [];
{
  const whole = (c) => [[c, 0, 16]];
  const halves = (a, b) => [[a, 0, 8], [b, 8, 8]];
  const CYCLE = ['D', 'Bm', 'G', 'A'];
  const fill = (id, f) => {
    for (let i = 0; i < SEC[id].bars; i++) CHART[SEC[id].bar0 + i] = f(i, SEC[id].bars);
  };
  // Lists that should end on the section's last bar are aligned from the end.
  const fromEnd = (list) => (i, n) => whole(list[Math.max(0, list.length - n + i)]);
  fill('intro', fromEnd(['Bm', 'G', 'Asus'])); // vi IV Vsus
  fill('drop', (i, n) => (i === n - 1 ? halves('G', 'A') : whole(['D', 'Bm'][i % 2])));
  fill('groove', (i) => whole(CYCLE[i % 4]));
  fill('breakdown', (i, n) => (i === n - 1 ? halves('Asus', 'A') : whole(['Em', 'G'][i % 2]))); // ii IV V
  fill('lift', (i, n) => (i === n - 1 ? halves('Asus', 'A') : whole(i === n - 2 ? 'Em' : CYCLE[i % 4])));
  fill('dark', (i) => whole(['Bm', 'G', 'Em', 'Fsm', 'A'][i % 5])); // vi IV ii iii V
  fill('bright', (i, n) => whole(i === n - 1 ? 'D' : CYCLE[i % 4]));
  fill('calm', fromEnd(['G', 'Bm', 'Em', 'Asus', 'A']));
  fill('resolve', (i, n) => (i === 0 ? [['Dfin', 0, 16 * n]] : []));
}

const chordAt = (bar, step) => {
  for (const [name, s, len] of CHART[bar] ?? []) if (step >= s && step < s + len) return CHORDS[name];
  for (let b = bar - 1; b >= 0; b--) if (CHART[b]?.length) return CHORDS[CHART[b][CHART[b].length - 1][0]];
  return CHORDS.D;
};

// Per-element seeded randomness, so editing one part never changes another's noise.
const hash = (s) => {
  let h = 2166136261;
  for (const c of s) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const rngFor = (name) => S.makeRng((SEED ^ hash(name)) >>> 0);

// ---------------------------------------------------------------------------
// Melodies. A phrase is a list of [step, lengthSteps, note]; placed notes are
// [time, seconds, midi, velocity].

const place = (bar, phrase, vel = 1) => phrase.map(([s, l, n]) => [at(bar, s), l * STEP, nm(n), vel]);
const B0 = (id, i = 0) => SEC[id].bar0 + i;

// The Lakeline motif: four bars over D | Bm | G | A.
const THEME = [
  [[0, 3, 'F#5'], [3, 3, 'E5'], [6, 4, 'A5'], [12, 2, 'F#5'], [14, 2, 'E5']],
  [[0, 3, 'D5'], [3, 3, 'C#5'], [6, 8, 'F#5'], [14, 2, 'E5']],
  [[0, 3, 'B4'], [3, 3, 'D5'], [6, 4, 'F#5'], [12, 2, 'E5'], [14, 2, 'D5']],
  [[0, 6, 'E5'], [6, 2, 'C#5'], [8, 6, 'B4']],
];

// Intro hint: the motif's first gesture, quiet, through a closed filter and long echoes.
const HINT = [
  ...place(B0('intro', 0), [[4, 3, 'F#5'], [7, 3, 'E5'], [10, 6, 'A5']], 0.5),
  ...place(B0('intro', 1), [[4, 3, 'F#5'], [7, 3, 'E5'], [10, 6, 'D5']], 0.45),
];

const BELL = [
  // Drop: the full statement, cadencing onto the downbeat of the main groove.
  ...place(B0('drop', 0), THEME[0], 0.95),
  ...place(B0('drop', 1), THEME[1], 0.9),
  ...place(B0('drop', 2), [[0, 3, 'B4'], [3, 3, 'D5'], [6, 2, 'F#5'], [8, 4, 'E5'], [12, 4, 'C#5']], 0.9),
  ...place(B0('groove', 0), [[0, 8, 'D5']], 0.75),
  // Main groove: the motif returns softly in the second phrase and again,
  // quieter, at the start of the fourth (bars 12-15 and 24-27 of the groove).
  ...THEME.flatMap((ph, k) => place(B0('groove', 12 + k), ph, 0.6 - 0.015 * k)),
  ...THEME.flatMap((ph, k) => place(B0('groove', 24 + k), ph, 0.5 - 0.015 * k)),
  // Breakdown, "theme flip": the opening gesture inverted over Em9, an answer over G.
  ...place(B0('breakdown', 0), [[0, 3, 'F#5'], [3, 3, 'G5'], [6, 4, 'D5'], [12, 2, 'F#5'], [14, 2, 'G5']], 0.6),
  ...place(B0('breakdown', 1), [[0, 6, 'D5'], [6, 2, 'E5'], [8, 8, 'B4']], 0.5),
  // Bright section: the motif in full, its first half again, then a closing cadence.
  ...THEME.flatMap((ph, k) => place(B0('bright', k), ph, 0.75 - 0.015 * k)),
  ...place(B0('bright', 4), THEME[0], 0.66),
  ...place(B0('bright', 5), THEME[1], 0.64),
  ...place(B0('bright', SEC.bright.bars - 1), [[0, 3, 'F#5'], [3, 3, 'E5'], [6, 6, 'D5']], 0.65),
];

// The small lift at LIFT_CUE: a rising flourish in 16ths (chord tones of Bm7 and Gmaj9).
const FLOURISH = ['D5', 'F#5', 'A5', 'B5', 'D6'].map((n, k) => [LIFT_CUE + k * STEP, k === 4 ? 6 * STEP : STEP, nm(n), 0.5 + 0.06 * k]);

const BELL_SOFT = [
  // Calm: the motif's answer phrase, slow and soft (aligned to the section's end).
  ...[
    THEME[2], // G
    [[0, 3, 'D5'], [3, 3, 'C#5'], [6, 10, 'F#5']], // Bm
    [[0, 6, 'G5'], [6, 4, 'F#5'], [10, 6, 'D5']], // Em
    [[0, 8, 'E5'], [8, 8, 'B4']], // Asus
    [[0, 6, 'C#5'], [6, 10, 'E5']], // A
  ].slice(-SEC.calm.bars).flatMap((ph, k, all) => place(B0('calm', SEC.calm.bars - all.length + k), ph, 0.55 - 0.015 * k)),
  // Resolve: callback to the opening gesture over the final chord, held to the end.
  ...place(B0('resolve', 0), [[0, 3, 'F#5'], [3, 3, 'E5'], [6, 16 * SEC.resolve.bars - 6, 'A5']], 0.62),
];

// Counter-melody for the Genie section: long, airy notes above the groove.
// One phrase per bar of the lift (18 bars: D Bm G A x4, then Em, Asus|A).
const COUNTER_BARS = [
  [[4, 4, 'A5'], [8, 8, 'C#6']], // D (ask)
  [[0, 6, 'D6'], [6, 4, 'C#6'], [10, 6, 'A5']], // Bm
  [[0, 12, 'B5'], [12, 4, 'A5']], // G
  [[0, 10, 'E6'], [10, 6, 'C#6']], // A (video tab)
  [[4, 4, 'A5'], [8, 4, 'C#6'], [12, 4, 'E6']], // D
  [[0, 10, 'F#6'], [10, 6, 'E6']], // Bm
  [[0, 8, 'D6'], [8, 8, 'B5']], // G (answer waiting)
  [[0, 12, 'C#6'], [12, 4, 'B5']], // A
  [[0, 16, 'A5']], // D: a breath
  [[0, 7, 'B5']], // Bm: the flourish answers in the second half (doc paste)
  [[4, 12, 'D6']], // G
  [[0, 6, 'E6'], [6, 4, 'C#6'], [10, 6, 'E6']], // A
  [[0, 6, 'F#6'], [6, 4, 'E6'], [10, 6, 'C#6']], // D
  [[0, 6, 'D6'], [6, 4, 'E6'], [10, 6, 'F#6']], // Bm (switch agent)
  [[0, 8, 'F#6'], [8, 8, 'D6']], // G
  [[0, 8, 'E6'], [8, 8, 'C#6']], // A (switch workspace)
  [[0, 8, 'D6'], [8, 8, 'B5']], // Em
  [[0, 8, 'E6'], [8, 8, 'C#6']], // Asus | A
];
const COUNTER = COUNTER_BARS.slice(0, SEC.lift.bars).flatMap((ph, i) => place(B0('lift', i), ph, 1));

// Arpeggio patterns: [step, chord-tone index, velocity]. Index 6+ = next octave.
const P0 = [[0, 0, 1], [3, 2, 0.7], [6, 4, 0.8], [8, 1, 0.85], [11, 3, 0.7], [14, 5, 0.75]];
const P1 = [[0, 0, 1], [2, 2, 0.7], [4, 4, 0.85], [6, 2, 0.7], [8, 1, 0.9], [10, 3, 0.7], [12, 5, 0.85], [14, 3, 0.7]];
const P2 = [...P1, [7, 3, 0.4], [15, 4, 0.4]];
const P3 = [[0, 0, 1], [3, 3, 0.8], [6, 5, 0.9], [8, 1, 0.8], [11, 4, 0.8], [14, 2, 0.85], [15, 3, 0.45]];
const P4 = [...P3, [1, 2, 0.32], [5, 4, 0.32], [9, 3, 0.32], [13, 4, 0.32]];
const P5 = [[0, 0, 1], [2, 1, 0.6], [4, 2, 0.8], [6, 1, 0.6], [8, 3, 0.9], [10, 2, 0.6], [12, 4, 0.8], [14, 2, 0.6]];
const P6 = [[0, 6, 1], [2, 4, 0.7], [3, 8, 0.8], [6, 5, 0.85], [8, 7, 0.9], [10, 3, 0.7], [11, 9, 0.75], [14, 5, 0.8]];
const BUILD = Array.from({ length: 16 }, (_, i) => [i, i % 6, 0.35 + (0.65 * i) / 15]);

/** Arp hits for a bar: [step, index, velocity]. */
function arpFor(bar) {
  const { id, i, n } = where(bar);
  switch (id) {
    case 'groove': return [P0, P1, P2, P3][Math.min(3, Math.floor(i / 8))];
    case 'breakdown': return i === n - 1 ? BUILD : P1;
    case 'lift': return [...P3, ...P4.filter((h) => !P3.includes(h))].filter(([s, , v]) => v > 0.33 || at(bar, s) >= LIFT_CUE);
    case 'dark': return P5;
    case 'bright': return i === n - 1 ? P6.filter(([s]) => s < 12) : P6;
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Drums

/** Per-bar drum spec. kick/clap/rim: steps; hats: mode; shaker: on/off. */
function drumSpec(bar) {
  const { id, i, n } = where(bar);
  const last = i === n - 1;
  switch (id) {
    case 'drop':
      return { kick: [0, 8], clap: [4, 12], hats: 'off8' };
    case 'groove': {
      // Relaxed and spacious: kick on 1 and 3 for the first two phrases, 8th
      // hats at most, a soft shaker from the second phrase, small fills only.
      const phrase = Math.floor(i / 8);
      const phraseEnd = i % 8 === 7;
      if (last) return { kick: [0, 6, 8], clap: [4, 12, 13, 14, 15], hats: '8', shaker: true, shakerVel: 0.7, until: 12 };
      const kick = phrase < 2 ? (phraseEnd ? [0, 8, 11] : [0, 8]) : phraseEnd ? [0, 6, 8, 11] : [0, 6, 8];
      return {
        kick,
        clap: phraseEnd ? [4, 12, 15] : [4, 12],
        clapVel: phrase === 0 ? 0.85 : 1,
        hats: phrase === 0 ? 'off8' : '8',
        shaker: phrase >= 1,
        shakerVel: 0.7,
      };
    }
    case 'lift':
      return { kick: last ? [0, 4, 8] : [0, 4, 8, 12], kickVel: 0.76, clap: [4, 12], hats: 'lift', shaker: true, shakerVel: 0.8 };
    case 'dark':
      if (last) return { kick: [0, 6, 8, 10], clap: [4, 12, 14, 15], hats: 'dark8' };
      return { kick: i % 2 ? [0, 6, 8, 14] : [0, 6, 8], clap: [4, 12], hats: 'dark8' };
    case 'bright':
      if (last) return { kick: [0, 6], clap: [4], hats: '16', shaker: true, until: 11, rim: [3] };
      return { kick: i % 2 ? [0, 6, 8, 11] : [0, 6, 8], clap: [4, 12], hats: '16', shaker: true, rim: [3, 10] };
    default:
      return null;
  }
}

/** Hat hits for a bar: [step, velocity, open]. The lift adds 16th ghosts after LIFT_CUE. */
function hatHits(bar, mode, until = 16) {
  const out = [];
  for (let s = 0; s < until; s++) {
    const p = s % 4;
    if (mode === 'off8' && p === 2) out.push([s, 0.75, false]);
    if (mode === '8' && s % 2 === 0) out.push([s, p === 2 ? 0.85 : 0.4, false]);
    if (mode === '16') out.push([s, [0.42, 0.2, 0.85, 0.22][p], false]);
    if (mode === 'dark8' && s % 2 === 0) out.push([s, p === 2 ? 0.7 : 0.32, false]);
    if (mode === 'dark8' && s === 15) out.push([s, 0.22, false]);
    if (mode === 'lift') {
      if (p === 2) out.push([s, 0.5, true]);
      else if (p === 0) out.push([s, 0.4, false]);
      else if (at(bar, s) >= LIFT_CUE) out.push([s, 0.18, false]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bass

/** Bass notes for a bar: [step, lengthSteps, interval, velocity]. */
function bassFor(bar) {
  const { id, i, n } = where(bar);
  const last = i === n - 1;
  switch (id) {
    case 'drop':
      return last ? [[0, 8, 0, 0.9], [8, 8, 0, 0.9]] : [[0, 12, 0, 0.9], [12, 4, 0, 0.7]];
    case 'groove': {
      if (last) return [[0, 3, 0, 1], [3, 3, 0, 0.75], [6, 2, 12, 0.6], [8, 8, 0, 0.9]];
      const phrase = Math.floor(i / 8);
      if (phrase === 0) return [[0, 6, 0, 1], [6, 2, 0, 0.7], [8, 8, 0, 0.9]];
      if (phrase === 1) return [[0, 3, 0, 1], [3, 3, 0, 0.75], [6, 2, 0, 0.8], [8, 6, 0, 0.95], [14, 2, 0, 0.7]];
      const end = phrase === 3 ? 7 : 0;
      return [[0, 3, 0, 1], [3, 3, 0, 0.75], [6, 2, 12, 0.6], [8, 3, 0, 0.95], [11, 3, 0, 0.75], [14, 2, end, 0.75]];
    }
    case 'breakdown':
      return i < n - 1 ? [[0, 16, 0, i === 0 ? 0.55 : 0.45]] : [];
    case 'lift': {
      const top = at(bar) >= LIFT_CUE && i % 2 === 1 ? 12 : 0;
      return [[2, 2, 0, 1], [6, 2, 0, 0.95], [10, 2, 0, 1], [14, 2, top, 0.9]];
    }
    case 'dark':
      return [[0, 6, 0, 1], [6, 2, 0, 0.8], [8, 4, 0, 0.95], [12, 2, 12, 0.6], [14, 2, 0, 0.8]];
    case 'bright':
      if (last) return [[0, 3, 0, 1], [3, 3, 0, 0.75], [6, 6, 0, 0.8]];
      return [[0, 3, 0, 1], [3, 3, 12, 0.6], [6, 2, 0, 0.8], [8, 3, 0, 0.95], [11, 3, 7, 0.7], [14, 2, 12, 0.6]];
    case 'calm':
      return [[0, 16, 0, 0.5]];
    default:
      return [];
  }
}

function bassParams(sec) {
  switch (sec) {
    case 'drop': return { cut: 190, env: 340, sawMix: 0.55, decay: 1.2, sustain: 0.8 };
    case 'groove': return { cut: 220, env: 420, sawMix: 0.6 };
    case 'breakdown': return { cut: 140, env: 0, sawMix: 0.25, attack: 0.25, release: 0.4, sustain: 0.9, gain: 0.18 };
    case 'lift': return { cut: 260, env: 560, sawMix: 0.65, decay: 0.25, sustain: 0.6 };
    case 'dark': return { cut: 180, env: 320, sawMix: 0.6 };
    case 'bright': return { cut: 270, env: 600, sawMix: 0.65 };
    case 'calm': return { cut: 140, env: 0, sawMix: 0.25, attack: 0.35, release: 0.6, sustain: 0.9, gain: 0.13 };
    default: return { cut: 160, env: 200, sawMix: 0.3, attack: 0.2, release: 0.6, sustain: 0.9 };
  }
}

// ---------------------------------------------------------------------------
// Pads

function padParams(sec, i) {
  switch (sec) {
    case 'intro': return { attack: i === 0 ? 1.4 : 0.6, decay: 3, sustain: 0.9, release: 0.6 };
    case 'breakdown': return { attack: 0.35, decay: 3, sustain: 0.9, release: 0.6 };
    case 'calm': return { attack: 0.9, decay: 3, sustain: 0.9, release: 1.0, level: 0.85 };
    case 'resolve': return { attack: 1.6, decay: 6, sustain: 1, release: 0.75, level: 0.95 };
    default: return { attack: 0.12, decay: 2.2, sustain: 0.8, release: 0.35 };
  }
}

/** Time windows where the airy upper pad layer plays. */
const AIR = [
  [st('groove') + 32, st('breakdown')],
  [LIFT_CUE, st('dark')],
  [st('bright'), st('calm')],
  [st('resolve'), MUSIC_END],
];

// ---------------------------------------------------------------------------
// Render

export function render() {
  const N = Math.ceil(LENGTH * SR);
  const bus = () => new S.Bus(N);
  const B = {
    kick: bus(), clap: bus(), hats: bus(), bass: bus(), pad: bus(), air: bus(), arp: bus(),
    bell: bus(), hint: bus(), lead: bus(), fx: bus(),
  };
  const kickTimes = [];

  // Drums
  {
    const r = rngFor('drums');
    for (let b = 0; b < NBARS; b++) {
      const d = drumSpec(b);
      if (!d) continue;
      for (const s of d.kick) {
        const t = at(b, s);
        const vel = (d.kickVel ?? 1) * (s === 0 ? 1 : s % 4 === 0 ? 0.92 : 0.8);
        S.kick(B.kick, t, { gain: 0.47, vel, decay: 0.18, f1: 49 }, r);
        kickTimes.push(t);
      }
      d.clap.forEach((s, k) => {
        const roll = k >= 2 && d.clap.length > 3;
        const vel = (roll ? 0.3 + 0.12 * (k - 2) : k >= 2 ? 0.45 : 1) * (d.clapVel ?? 1);
        S.clap(B.clap, at(b, s), { gain: 0.54, vel, tail: roll ? 0.07 : 0.12 }, r);
      });
      for (const [s, vel, open] of hatHits(b, d.hats, d.until ?? 16)) {
        const t = at(b, s) + (s % 2 ? 0.006 : 0) + (r() - 0.5) * 0.002;
        S.hat(B.hats, t, { gain: open ? 0.16 : 0.21, vel: vel * (0.92 + r() * 0.16), decay: open ? 0.15 : 0.028, pan: open ? -0.2 : 0.12 }, r);
      }
      if (d.shaker) {
        for (let s = 0; s < (d.until ?? 16); s++) {
          const vel = [0.55, 0.3, 0.8, 0.35][s % 4] * (0.9 + r() * 0.2) * (d.shakerVel ?? 1);
          S.shaker(B.hats, at(b, s) + (s % 2 ? 0.012 : 0), { gain: 0.09, vel, pan: 0.35 }, r);
        }
      }
      for (const s of d.rim ?? []) {
        // Soft high "tick" (short filtered noise + a tiny tone): the playful accent of the bright section.
        S.hat(B.hats, at(b, s), { gain: 0.07, vel: 0.9, decay: 0.012, fc: 2600, top: 7000, pan: -0.35 }, r);
        S.bellNote(B.hats, at(b, s), 0.02, nm('E6'), { gain: 0.03, decay: 0.04, sustain: 0, release: 0.02, cut: 6000, pan: -0.35 }, r);
      }
    }
  }

  // Bass
  {
    const r = rngFor('bass');
    for (let b = 0; b < NBARS; b++) {
      for (const [s, len, iv, vel] of bassFor(b)) {
        const t = at(b, s);
        const p = bassParams(sectionAt(t));
        const gate = len * STEP - (len >= 8 ? 0.02 : 0.035);
        S.bassNote(B.bass, t, gate, chordAt(b, s).root + iv, { sub: 0.8, ...p, vel, gain: p.gain ?? 0.26 }, r);
      }
    }
    // Resolve: the final root, held under the swell.
    S.bassNote(B.bass, st('resolve'), SEC.resolve.end - st('resolve'), nm('D2'),
      { gain: 0.2, cut: 140, env: 0, sawMix: 0.25, attack: 0.6, release: 0.7, sustain: 1, decay: 5 }, r);
  }

  // Pads and the airy upper layer
  {
    const r = rngFor('pads');
    const ra = rngFor('air');
    for (let b = 0; b < NBARS; b++) {
      for (const [name, s, len] of CHART[b] ?? []) {
        const t = at(b, s);
        const w = where(b);
        const p = padParams(w.id, w.i);
        const gate = len * STEP + 0.04;
        for (const m of CHORDS[name].pad) S.padNote(B.pad, t, gate, m, { ...p, gain: 0.11 * (p.level ?? 1) }, r);
        for (const [a0, a1] of AIR) {
          const t0 = Math.max(t, a0);
          const t1 = Math.min(t + gate, a1);
          if (t1 - t0 < 0.25) continue;
          for (const m of CHORDS[name].pad.slice(-2)) {
            S.padNote(B.air, t0, t1 - t0, m + 12, { ...p, attack: Math.max(p.attack, 0.25), gain: 0.05, detune: [-7, 0, 8], spread: 0.9, wave: 'pulse' }, ra);
          }
        }
      }
    }
  }

  // Arpeggio
  {
    const r = rngFor('arp');
    for (let b = 0; b < NBARS; b++) {
      const pat = arpFor(b);
      if (!pat) continue;
      const sec = where(b).id;
      const bright = sec === 'lift' || sec === 'bright';
      for (const [s, idx, vel] of pat) {
        const tones = chordAt(b, s).arp;
        S.pluckNote(B.arp, at(b, s), tones[idx % 6] + 12 * Math.floor(idx / 6), {
          gain: 0.24,
          vel: vel * (0.94 + r() * 0.12),
          pan: idx % 2 ? 0.32 : -0.32,
          gate: sec === 'bright' ? 0.06 : 0.1,
          decay: sec === 'dark' ? 0.18 : sec === 'bright' ? 0.15 : 0.22,
          cut: sec === 'dark' ? 420 : bright ? 800 : 620,
          env: sec === 'dark' ? 1900 : bright ? 3800 : 3000,
        }, r);
      }
    }
  }

  // Motif (bell), intro hint, flourish and counter-melody (lead)
  {
    const r = rngFor('bell');
    for (const [t, len, n, vel] of HINT) S.bellNote(B.hint, t, len, n, { gain: 0.16, vel, cut: 1900, bright: 0.6, pan: 0.15 }, r);
    for (const [t, len, n, vel] of BELL) {
      S.bellNote(B.bell, t, len, n, { gain: 0.2, vel, cut: sectionAt(t) === 'bright' ? 5200 : 4200, pan: 0.08 }, r);
    }
    for (const [t, len, n, vel] of FLOURISH) S.bellNote(B.bell, t, len, n, { gain: 0.17, vel, cut: 5000, pan: 0.25 }, r);
    for (const [t, len, n, vel] of BELL_SOFT) {
      S.bellNote(B.bell, t, len, n, { gain: 0.2, vel, cut: 2600, bright: 0.7, release: 0.6, pan: 0.08 }, r);
    }
    const rl = rngFor('lead');
    for (const [t, len, n, vel] of COUNTER) S.leadNote(B.lead, t, len, n, { gain: 0.125, vel, pan: -0.12 }, rl);
  }

  // Transition effects
  {
    const r = rngFor('fx');
    const swell = (t, len, gain, f0 = 1500, f1 = 9000) => S.noiseSweep(B.fx, t - len, t - 0.01, { gain, f0, f1, shape: 3 }, r);
    const fall = (t, len, gain, f0 = 9000) => S.noiseSweep(B.fx, t, t + len, { gain, f0, f1: 300, type: 'lp', mode: 'fall', shape: 1.6, q: 0.8 }, r);
    // Intro riser into the drop, then impact and downlifter.
    const drop = st('drop');
    S.noiseSweep(B.fx, 1.5, drop - 0.04, { gain: 0.2, f0: 220, f1: 6500, q: 1.3, shape: 2.6 }, r);
    S.toneRiser(B.fx, drop - 3, drop - 0.04, { gain: 0.045, m0: nm('A2'), m1: nm('A4'), cut0: 300, cut1: 4000 }, r);
    S.boom(B.fx, drop, { gain: 0.3 }, r);
    fall(drop, 3, 0.11);
    // Reverse swells into the main-groove phrase changes, into bar-aligned scene
    // cuts (not section starts, which have their own transitions), and the lift.
    const phrases = [16, 32, 48].map((d) => st('groove') + d).filter((t) => t < st('breakdown'));
    for (const t of phrases) swell(t, 2, 0.075, 600, 8000);
    const starts = new Set(PLAN.map((p) => p.start));
    for (const { time } of CUES) {
      if (time % BAR || starts.has(time) || phrases.includes(time)) continue;
      swell(time, 1, sectionAt(time) === 'lift' ? 0.04 : 0.05);
    }
    swell(LIFT_CUE, 1.2, 0.07, 900, 8000);
    // Breakdown: drums out with a downlifter, then a riser into the lift.
    const bd = st('breakdown');
    const lift = st('lift');
    S.boom(B.fx, bd, { gain: 0.1, decay: 0.9 }, r);
    S.noiseSweep(B.fx, bd, bd + 2.5, { gain: 0.09, f0: 10000, f1: 500, type: 'lp', mode: 'fall', shape: 1.6, q: 0.8 }, r);
    S.noiseSweep(B.fx, lift - 3, lift - 0.04, { gain: 0.2, f0: 250, f1: 8000, q: 1.3, shape: 2.4 }, r);
    S.toneRiser(B.fx, lift - 2, lift - 0.04, { gain: 0.04, m0: nm('A2'), m1: nm('A4'), cut0: 300, cut1: 4500 }, r);
    S.boom(B.fx, lift, { gain: 0.26 }, r);
    fall(lift, 3, 0.1);
    // Into the darker run-monitor groove.
    swell(st('dark'), 1.5, 0.08, 800, 7000);
    S.boom(B.fx, st('dark'), { gain: 0.16, f0: 55, f1: 30 }, r);
    fall(st('dark'), 2.5, 0.07, 6000);
    // Into the bright workspace-colors section.
    S.noiseSweep(B.fx, st('bright') - 2, st('bright') - 0.01, { gain: 0.12, f0: 400, f1: 9000, q: 1.2, shape: 2.8 }, r);
    S.boom(B.fx, st('bright'), { gain: 0.16 }, r);
    // Into the calm security section, and into the resolve.
    swell(st('calm'), 1.4, 0.07, 600, 6000);
    fall(st('calm'), 3, 0.06, 6000);
    swell(st('resolve'), 1.6, 0.09, 500, 7000);
    S.boom(B.fx, st('resolve'), { gain: 0.17, decay: 1.1, len: 3.5 }, r);
  }

  // ---- Bus processing
  const cut = (pts) => S.bake(pts, N, { log: true });
  const g0 = st('groove');
  const padCut = cut([
    [0, 280], [1.5, 420], [st('drop') - 0.3, 1700], [st('drop'), 2300],
    [g0, 2600], [g0 + 16, 2800], [g0 + 16.01, 3000], [g0 + 32, 3200], [g0 + 32.01, 3500], [g0 + 48, 3600], [g0 + 48.01, 3800],
    [st('breakdown') - 0.1, 3800], [st('breakdown'), 600], [st('lift') - 0.1, 5200], [st('lift'), 3900],
    [LIFT_CUE, 3900], [LIFT_CUE + 0.5, 4400],
    [st('dark') - 0.1, 4400], [st('dark'), 1900], [st('bright') - 0.1, 1800], [st('bright'), 4000],
    [st('calm') - 0.1, 4000], [st('calm'), 1200], [st('resolve') - 0.1, 1000], [st('resolve'), 1100],
    [st('resolve') + 2.5, 3200], [LENGTH, 2600],
  ]);
  const arpCut = cut([
    [0, 14000], [st('breakdown') - 0.05, 14000], [st('breakdown'), 900], [st('lift') - 0.05, 9000], [st('lift'), 14000],
    [st('dark') - 0.05, 14000], [st('dark'), 3800], [st('bright') - 0.05, 3800], [st('bright'), 14000],
  ]);
  const hintCut = cut([[0, 1800], [st('drop') - 0.5, 3500]]);

  const duck = (depth, release = 0.16, attack = 0.006) => S.duckEnvelope(N, kickTimes, { depth, release, attack });

  S.filterBus(B.pad, padCut, 0.75);
  S.eqBus(B.pad, 'highpass', 120, 0.7);
  S.eqBus(B.pad, 'peak', 320, 1.0, -2);
  S.chorus(B.pad, { rate: 0.21, depth: 0.0022, base: 0.011, mix: 0.45 });
  S.applyGain(B.pad, duck(0.3, 0.18));

  S.filterBus(B.air, padCut, 0.7);
  S.eqBus(B.air, 'highpass', 500, 0.7);
  S.chorus(B.air, { rate: 0.33, depth: 0.003, base: 0.014, mix: 0.6 });
  S.applyGain(B.air, duck(0.22, 0.18));

  S.filterBus(B.arp, arpCut, 0.8);
  S.eqBus(B.arp, 'highpass', 160, 0.7);
  S.applyGain(B.arp, duck(0.12, 0.12));

  S.filterBus(B.hint, hintCut, 0.7);
  S.chorus(B.lead, { rate: 0.27, depth: 0.0025, base: 0.012, mix: 0.4 });

  S.eqBus(B.bass, 'highpass', 30, 0.7);
  S.applyGain(B.bass, duck(0.5, 0.11, 0.003));
  S.eqBus(B.kick, 'highpass', 30, 0.7);
  S.eqBus(B.hats, 'highshelf', 9000, 0.7, -2);

  // ---- Sends: ping-pong delay (dotted 8th) and a Freeverb-style hall
  const revIn = bus();
  const dlyIn = bus();
  const SENDS = {
    pad: [0.3, 0], air: [0.35, 0], arp: [0.16, 0.14], bell: [0.28, 0.22], hint: [0.45, 0.55],
    lead: [0.42, 0.16], clap: [0.14, 0], hats: [0.04, 0], fx: [0.35, 0],
  };
  for (const [k, [rv, dl]] of Object.entries(SENDS)) {
    if (rv) B[k].mixInto(revIn, rv);
    if (dl) B[k].mixInto(dlyIn, dl);
  }
  const dly = S.pingPong(dlyIn, { time: 0.375, feedback: 0.34, lp: 3600, hp: 380 });
  dly.mixInto(revIn, 0.2);
  const rev = S.freeverb(revIn, { room: 0.86, damp: 0.45, width: 1, predelay: 0.022, hp: 240, lp: 7500 });

  if (process.env.MUSIC_DEBUG) debugLevels({ ...B, dly, rev });

  // ---- Mix
  const FADERS = { kick: 1, clap: 1, hats: 1, bass: 1, pad: 1, air: 1, arp: 1, bell: 1, hint: 1, lead: 1, fx: 1 };
  const mix = bus();
  for (const [k, g] of Object.entries(FADERS)) B[k].mixInto(mix, g);
  dly.mixInto(mix, 0.55);
  rev.mixInto(mix, 1.0);
  return { mix, kickTimes };
}

/** MUSIC_DEBUG=1: per-bus RMS (dBFS, pre-master) for each section, to balance the mix. */
function debugLevels(buses) {
  const ids = SECTIONS.map((s) => s.id);
  console.log('bus      ' + ids.map((i) => i.slice(0, 7).padStart(8)).join(''));
  for (const [k, b] of Object.entries(buses)) {
    const row = SECTIONS.map((s) => {
      let ss = 0;
      const a = Math.round(s.start * SR);
      const e = Math.min(b.n, Math.round(s.end * SR));
      for (let i = a; i < e; i++) ss += (b.L[i] * b.L[i] + b.R[i] * b.R[i]) / 2;
      const d = 10 * Math.log10(ss / (e - a) + 1e-20);
      return (d < -99 ? '   -' : d.toFixed(1)).padStart(8);
    });
    console.log(k.padEnd(9) + row.join(''));
  }
}

// ---------------------------------------------------------------------------
// Master bus (in JS): EQ, glue compression, soft saturation, tail fade,
// loudness pre-gain and a look-ahead true-peak limiter. ffmpeg loudnorm then does
// the final two-pass normalisation (master.mjs).

export function masterBus(mix, { targetLufs = -14, ceilingDb = -2.0 } = {}) {
  let peak0 = 0;
  for (let i = 0; i < mix.n; i++) peak0 = Math.max(peak0, Math.abs(mix.L[i]), Math.abs(mix.R[i]));
  mix.scale(S.dbToGain(-6) / peak0); // known headroom before the dynamics
  S.eqBus(mix, 'highpass', 28, 0.7);
  S.eqBus(mix, 'highpass', 28, 0.7);
  S.eqBus(mix, 'lowshelf', 70, 0.7, -1.5);
  const comp = S.compressor(mix, { threshold: -18, ratio: 1.8, attack: 0.015, release: 0.2, knee: 6 });
  S.saturate(mix, 1.15);

  // Fade the tail to digital silence.
  const f0 = Math.round((MUSIC_END + 0.8) * SR);
  const f1 = Math.round((MUSIC_END + 2.3) * SR);
  for (let i = f0; i < mix.n; i++) {
    const g = i >= f1 ? 0 : Math.cos(((i - f0) / (f1 - f0)) * (Math.PI / 2)) ** 2;
    mix.L[i] *= g;
    mix.R[i] *= g;
  }

  // Loudness pre-gain + limiter, iterated so the limited result lands on target.
  let gainDb = targetLufs - S.loudness(mix.L, mix.R);
  const peakEnv = S.truePeakEnvelope(mix);
  let out;
  let lim;
  let lufs;
  for (let k = 0; k < 4; k++) {
    out = new S.Bus(mix.n);
    out.L.set(mix.L);
    out.R.set(mix.R);
    out.scale(S.dbToGain(gainDb));
    lim = S.limiter(out, { ceilingDb, lookahead: 0.004, release: 0.09, peakEnv, envScale: S.dbToGain(gainDb) });
    lufs = S.loudness(out.L, out.R);
    if (Math.abs(targetLufs - lufs) < 0.05) break;
    gainDb += targetLufs - lufs;
  }
  return { out, comp, lim, lufs, gainDb };
}

export function markers() {
  return {
    title: 'Lakeline for Databricks launch theme (original, generated)',
    bpm: BPM,
    timeSignature: '4/4',
    beatSeconds: BEAT,
    barSeconds: BAR,
    sampleRate: SR,
    durationSeconds: LENGTH,
    musicEndSeconds: MUSIC_END,
    drop: st('drop'),
    sections: SECTIONS.map((s) => ({ id: s.id, start: s.start, end: s.end, bar: s.start / BAR, scene: s.scene, plan: s.plan })),
    phrases: [0, 16, 32, 48]
      .map((d) => st('groove') + d)
      .filter((t) => t < st('breakdown'))
      .map((t) => ({ start: t, bar: t / BAR, note: 'main-groove 8-bar variation' })),
    cues: CUES.map(({ time, label }) => ({ time, label, bar: Math.floor(time / BAR), beat: (time % BAR) / BEAT + 1, lift: time === LIFT_CUE || undefined })),
    files: {
      master: 'dist/video/music/lakeline-theme.wav',
      raw: 'dist/video/music/lakeline-theme-raw.wav',
      preview: 'dist/video/music/lakeline-theme-preview.mp3',
    },
  };
}

// ---------------------------------------------------------------------------

async function main() {
  const rawOnly = process.argv.includes('--raw-only');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  const { mix } = render();
  const t1 = Date.now();
  const m = masterBus(mix);
  const raw = path.join(OUT_DIR, 'lakeline-theme-raw.wav');
  fs.writeFileSync(raw, S.encodeWav24(m.out.L, m.out.R, SEED));
  const mk = markers();
  fs.writeFileSync(path.join(OUT_DIR, 'markers.json'), JSON.stringify(mk, null, 2) + '\n');
  console.log(
    `rendered ${LENGTH}s in ${((t1 - t0) / 1000).toFixed(1)}s, mastered in ${((Date.now() - t1) / 1000).toFixed(1)}s; ` +
      `glue comp max GR ${m.comp.maxReductionDb.toFixed(1)} dB, limiter max GR ${m.lim.maxReductionDb.toFixed(1)} dB, ` +
      `pre-gain ${m.gainDb.toFixed(1)} dB, JS loudness ${m.lufs.toFixed(2)} LUFS`,
  );
  console.log(`wrote ${path.relative(ROOT, raw)} and markers.json`);
  if (rawOnly) return;
  const wav = path.join(OUT_DIR, 'lakeline-theme.wav');
  const mp3 = path.join(OUT_DIR, 'lakeline-theme-preview.mp3');
  const mres = master({ raw, wav, mp3 });
  console.log(
    `loudnorm pass 1: I ${mres.pass1.input_i} LUFS, TP ${mres.pass1.input_tp} dBTP, LRA ${mres.pass1.input_lra} LU; ` +
      `pass 2 (${mres.pass2.normalization_type}): I ${mres.pass2.output_i} LUFS, TP ${mres.pass2.output_tp} dBTP`,
  );
  console.log(`wrote ${path.relative(ROOT, wav)} and ${path.relative(ROOT, mp3)}`);
  const qc = check({ wav, markers: mk, outDir: OUT_DIR, loudnorm: mres });
  if (!qc.pass) {
    console.error('QC FAILED:', qc.failures.join('; '));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
