// ffmpeg mastering for the Lakeline theme: two-pass EBU R128 loudnorm (linear
// mode) to -14 LUFS integrated with true peak <= -1 dBTP, 48 kHz 24-bit WAV,
// plus a 320 kb/s MP3 preview for review.
//
// Standalone: node video/music/master.mjs   (re-masters the existing raw WAV)

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const FFMPEG = process.env.FFMPEG || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');

/** Run ffmpeg, return stderr (where it logs). Throws on a non-zero exit. */
export function ff(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', ...args], { encoding: 'utf8', maxBuffer: 256 << 20 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed:\n${r.stderr.slice(-2000)}`);
  return r.stderr;
}

function lastJson(text) {
  const end = text.lastIndexOf('}');
  const start = text.lastIndexOf('{', end);
  return JSON.parse(text.slice(start, end + 1));
}

export function master({ raw, wav, mp3, I = -14, TP = -1.0, LRA = 20 }) {
  // Pass 1: measure.
  const p1 = lastJson(ff(['-i', raw, '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`, '-f', 'null', '-']));
  // Pass 2: apply with the measured values; linear=true keeps it a pure gain
  // change (no dynamic processing) when the material allows it.
  const af = [
    `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}`,
    `measured_I=${p1.input_i}:measured_TP=${p1.input_tp}:measured_LRA=${p1.input_lra}`,
    `measured_thresh=${p1.input_thresh}:offset=${p1.target_offset}`,
    'linear=true:print_format=json',
  ].join(':');
  const p2 = lastJson(
    ff(['-y', '-i', raw, '-af', af, '-ar', '48000', '-c:a', 'pcm_s24le', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', wav]),
  );
  if (mp3) {
    ff([
      '-y', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '320k', '-map_metadata', '-1',
      '-metadata', 'title=Lakeline for Databricks theme (preview)', '-fflags', '+bitexact', '-flags:a', '+bitexact', mp3,
    ]);
  }
  return { pass1: p1, pass2: p2 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/video/music');
  const res = master({
    raw: path.join(dir, 'lakeline-theme-raw.wav'),
    wav: path.join(dir, 'lakeline-theme.wav'),
    mp3: path.join(dir, 'lakeline-theme-preview.mp3'),
  });
  console.log(JSON.stringify(res, null, 2));
}
