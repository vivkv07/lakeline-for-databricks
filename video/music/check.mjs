// Quality checks for the mastered Lakeline theme.
//
// Standalone: node video/music/check.mjs
//
// Reports and asserts:
//   - ffmpeg ebur128: integrated loudness (target -14 LUFS +/- 0.5) and true peak (<= -1.0 dBTP)
//   - sample peak and clipped-sample count (must be 0)
//   - L/R correlation (must be positive overall and per section; never inverted)
//   - RMS / loudness per section, compared against the planned energy shape
//   - spectral balance by band (from an averaged FFT) plus spectrum and waveform images
// Writes dist/video/music/qc.json, spectrum.png and waveform.png.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav, loudness, SR } from './synth.mjs';
import { ff } from './master.mjs';

const db = (x) => 10 * Math.log10(Math.max(x, 1e-20));

// Planned relative energy (rough loudness ranking): quiet intro, groove sections
// loud, breakdown and calm clearly lower, lift and bright the peaks.
const PLAN = {
  intro: { min: -30, max: -16 },
  drop: { min: -18, max: -11 },
  groove: { min: -16, max: -10 },
  breakdown: { min: -24, max: -13 },
  lift: { min: -15, max: -10 },
  dark: { min: -16, max: -10 },
  bright: { min: -15, max: -10 },
  calm: { min: -26, max: -15 },
  resolve: { min: -24, max: -12 },
};

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Welch-averaged power spectrum of the mid signal, summed into bands (dB relative to total). */
function bands(L, R) {
  const N = 8192;
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const acc = new Float64Array(N / 2);
  for (let o = 0; o + N <= L.length; o += N / 2) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = ((L[o + i] + R[o + i]) / 2) * win[i];
    fft(re, im);
    for (let k = 0; k < N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
  }
  const edges = [
    ['sub 20-60', 20, 60],
    ['bass 60-150', 60, 150],
    ['low-mid 150-500', 150, 500],
    ['mid 500-2k', 500, 2000],
    ['upper-mid 2k-5k', 2000, 5000],
    ['presence 5k-10k', 5000, 10000],
    ['air 10k-20k', 10000, 20000],
  ];
  const total = acc.reduce((a, b) => a + b, 0);
  return edges.map(([name, lo, hi]) => {
    let s = 0;
    for (let k = 0; k < N / 2; k++) {
      const f = (k * SR) / N;
      if (f >= lo && f < hi) s += acc[k];
    }
    return { band: name, dB: +db(s / total).toFixed(1) };
  });
}

function sectionStats(L, R, s) {
  const a = Math.round(s.start * SR);
  const b = Math.min(L.length, Math.round(s.end * SR));
  let ss = 0;
  let pk = 0;
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = a; i < b; i++) {
    const l = L[i];
    const r = R[i];
    ss += (l * l + r * r) / 2;
    pk = Math.max(pk, Math.abs(l), Math.abs(r));
    lr += l * r;
    ll += l * l;
    rr += r * r;
  }
  const n = b - a;
  const lufs = s.end - s.start >= 0.5 ? loudness(L.subarray(a, b), R.subarray(a, b)) : -Infinity;
  const rmsDb = db(ss / n);
  const peakDb = 20 * Math.log10(Math.max(pk, 1e-10));
  return {
    rmsDb: +rmsDb.toFixed(1),
    peakDb: +peakDb.toFixed(1),
    crestDb: +(peakDb - rmsDb).toFixed(1),
    lufs: Number.isFinite(lufs) ? +lufs.toFixed(1) : null,
    corr: ll > 0 && rr > 0 ? +(lr / Math.sqrt(ll * rr)).toFixed(2) : null,
  };
}

export function check({ wav, markers, outDir, loudnorm = null, name = '' }) {
  const suffix = name ? `-${name}` : '';
  const failures = [];
  const { sr, bits, channels } = decodeWav(fs.readFileSync(wav));
  const [L, R] = channels;
  if (sr !== 48000) failures.push(`sample rate ${sr}`);
  if (bits !== 24) failures.push(`bit depth ${bits}`);

  // ffmpeg EBU R128 (integrated loudness, LRA, true peak)
  const e = ff(['-nostats', '-i', wav, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-']);
  const summary = e.slice(e.lastIndexOf('Summary:'));
  const num = (re) => Number((re.exec(summary) || [])[1]);
  const ebu = { I: num(/I:\s+(-?[\d.]+) LUFS/), LRA: num(/LRA:\s+(-?[\d.]+) LU/), truePeak: num(/Peak:\s+(-?[\d.]+) dBFS/) };
  if (!(Math.abs(ebu.I + 14) <= 0.5)) failures.push(`integrated ${ebu.I} LUFS (want -14 +/- 0.5)`);
  if (!(ebu.truePeak <= -1.0)) failures.push(`true peak ${ebu.truePeak} dBTP (want <= -1.0)`);

  // ffmpeg astats (overall sample peak, RMS, DC)
  const a = ff(['-nostats', '-i', wav, '-af', 'astats=measure_perchannel=none', '-f', 'null', '-']);
  const ov = a.slice(a.lastIndexOf('Overall'));
  const anum = (key) => Number((new RegExp(`${key}:\\s+(-?[\\d.]+|-inf)`).exec(ov) || [])[1]);
  const astats = { peakDb: anum('Peak level dB'), rmsDb: anum('RMS level dB'), dcOffset: anum('DC offset'), flatFactor: anum('Flat factor') };

  // Sample peak and clipping (JS, from the decoded file)
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < L.length; i++) {
    const p = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (p > peak) peak = p;
    if (p >= 0.99999) clipped++;
  }
  if (clipped) failures.push(`${clipped} clipped samples`);

  // Per-section energy and correlation
  const overall = sectionStats(L, R, { start: 0, end: L.length / SR });
  if (!(overall.corr > 0.2)) failures.push(`overall L/R correlation ${overall.corr}`);
  const sections = markers.sections.map((s) => {
    const st = sectionStats(L, R, s);
    const plan = PLAN[s.id];
    const ref = st.lufs ?? st.rmsDb;
    const ok = !plan || (ref >= plan.min && ref <= plan.max);
    if (!ok) failures.push(`section ${s.id} at ${ref} dB (plan ${plan.min}..${plan.max})`);
    if (st.corr !== null && st.corr < 0) failures.push(`section ${s.id} correlation ${st.corr}`);
    return { id: s.id, start: s.start, end: s.end, ...st, plan: plan ? `${plan.min}..${plan.max}` : '', ok };
  });

  // Transitions: loudness of the 1 s before and after each section mark, so the
  // marks are audible where the storyboard expects them.
  const transitions = markers.sections.slice(1).map((s) => {
    const before = sectionStats(L, R, { start: s.start - 1, end: s.start });
    const after = sectionStats(L, R, { start: s.start, end: s.start + 1 });
    return { at: s.start, into: s.id, beforeRmsDb: before.rmsDb, afterRmsDb: after.rmsDb, deltaDb: +(after.rmsDb - before.rmsDb).toFixed(1) };
  });

  // The tail must decay: the last 0.5 s far below the music, and the last
  // 0.2 s digitally silent (the fade ends before the file does).
  const end = L.length / SR;
  const tailEnd = sectionStats(L, R, { start: end - 0.5, end });
  if (!(tailEnd.rmsDb < -55)) failures.push(`tail not decayed: last 0.5 s at ${tailEnd.rmsDb} dBFS RMS`);
  // The last 0.2 s must be silent.
  let tailPk = 0;
  for (let i = L.length - Math.round(0.2 * SR); i < L.length; i++) tailPk = Math.max(tailPk, Math.abs(L[i]), Math.abs(R[i]));
  if (tailPk > 1e-4) failures.push(`file end not silent (peak ${tailPk})`);

  // Spectrum
  const spectrum = bands(L, R);
  const get = (k) => spectrum.find((b) => b.band.startsWith(k)).dB;
  if (get('presence') - get('mid') > -6) failures.push('presence band too hot vs mids (harsh)');
  if (get('air') - get('mid') > -12) failures.push('air band too hot vs mids (harsh)');
  if (get('low-mid') - get('mid') > 8) failures.push('low-mids dominate (muddy)');

  // Images for a visual check
  const spec = path.join(outDir, `spectrum${suffix}.png`);
  const wave = path.join(outDir, `waveform${suffix}.png`);
  ff(['-y', '-i', wav, '-lavfi', 'showspectrumpic=s=1600x600:legend=1:scale=log:fscale=log:color=intensity:stop=20000', spec]);
  ff(['-y', '-i', wav, '-lavfi', 'showwavespic=s=1600x300:split_channels=1:colors=0x4f8cff|0xf5a524', '-frames:v', '1', wave]);

  const qc = {
    file: path.basename(wav),
    sampleRate: sr,
    bits,
    durationSeconds: +(L.length / SR).toFixed(3),
    ebur128: ebu,
    astats,
    samplePeakDb: +(20 * Math.log10(peak)).toFixed(2),
    clippedSamples: clipped,
    correlation: overall.corr,
    loudnorm: loudnorm ? { type: loudnorm.pass2.normalization_type, input_i: loudnorm.pass1.input_i, input_tp: loudnorm.pass1.input_tp, output_i: loudnorm.pass2.output_i, output_tp: loudnorm.pass2.output_tp } : null,
    sections,
    transitions,
    spectrum,
    pass: failures.length === 0,
    failures,
  };
  fs.writeFileSync(path.join(outDir, `qc${suffix}.json`), JSON.stringify(qc, null, 2) + '\n');

  console.log(`\nEBU R128: I ${ebu.I} LUFS, LRA ${ebu.LRA} LU, true peak ${ebu.truePeak} dBTP`);
  console.log(`astats: sample peak ${astats.peakDb} dBFS, RMS ${astats.rmsDb} dBFS, DC ${astats.dcOffset}; clipped samples ${clipped}`);
  console.log(`L/R correlation (overall) ${overall.corr}`);
  console.log('\nsection     start   end    RMS dBFS  LUFS   peak  crest   corr  plan(LUFS)  ok');
  for (const s of sections) {
    console.log(
      `${s.id.padEnd(10)} ${String(s.start).padStart(6)} ${String(s.end).padStart(6)} ${String(s.rmsDb).padStart(8)} ${String(s.lufs).padStart(6)} ${String(s.peakDb).padStart(6)} ${String(s.crestDb).padStart(6)} ${String(s.corr).padStart(6)}  ${s.plan.padEnd(10)} ${s.ok ? 'yes' : 'NO'}`,
    );
  }
  console.log('\ntransitions (RMS dBFS, 1 s before -> 1 s after each mark):');
  for (const t of transitions) console.log(`  ${String(t.at).padStart(5)} s  ${t.into.padEnd(10)} ${String(t.beforeRmsDb).padStart(6)} -> ${String(t.afterRmsDb).padStart(6)}  (${t.deltaDb > 0 ? '+' : ''}${t.deltaDb})`);
  console.log('\nspectrum (share of total power):');
  for (const b of spectrum) console.log(`  ${b.band.padEnd(18)} ${String(b.dB).padStart(6)} dB`);
  console.log(`\nQC ${qc.pass ? 'PASS' : 'FAIL'}${failures.length ? ': ' + failures.join('; ') : ''}`);
  return qc;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/video/music');
  // node video/music/check.mjs [file.wav] [name]   (defaults: the music master)
  const markers = JSON.parse(fs.readFileSync(path.join(dir, 'markers.json'), 'utf8'));
  const wav = process.argv[2] ? path.resolve(process.argv[2]) : path.join(dir, 'lakeline-theme.wav');
  const qc = check({ wav, markers, outDir: dir, name: process.argv[3] ?? '' });
  if (!qc.pass) process.exitCode = 1;
}
