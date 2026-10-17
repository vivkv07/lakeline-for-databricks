# Lakeline launch theme (original, generated)

Background music for the Lakeline for Databricks launch video (`notes/VIDEO.md`).
The track is computed from code. It uses no samples, loops, sound fonts or
recordings, and no melodies from existing works.

## Run

```sh
node video/music/compose.mjs              # music: render, master, check (about 15 s)
node video/music/sfx.mjs [--wait]         # SFX from events.json + music, mixed and mastered (about 25 s)
node video/music/compose.mjs --raw-only   # render the raw WAV and markers.json only
node video/music/master.mjs [input.wav]   # re-run the ffmpeg mastering (optionally on another file)
node video/music/check.mjs                # re-run the quality checks on the master
MUSIC_DEBUG=1 node video/music/compose.mjs --raw-only   # print per-bus levels per section
```

Proposed package scripts: `"video:music": "node video/music/compose.mjs"` and
`"video:sfx": "node video/music/sfx.mjs --wait"`.

Needs Node 20+ and ffmpeg with `loudnorm`, `ebur128` and `libmp3lame`. It uses
`/opt/homebrew/bin/ffmpeg` if it exists, otherwise `ffmpeg` on `PATH`. Set
`FFMPEG=/path/to/ffmpeg` to use a different binary.

## Output (`dist/video/music/`, git-ignored)

| File | What |
|---|---|
| `lakeline-theme.wav` | Master: 48 kHz, 24-bit stereo, -14 LUFS integrated, true peak <= -1 dBTP. The composer muxes this file. |
| `lakeline-theme-raw.wav` | Pre-loudnorm render from the JS master bus (24-bit, TPDF-dithered). |
| `lakeline-theme-preview.mp3` | 320 kb/s preview for review. |
| `markers.json` | BPM, bar length, section starts and ends, phrase starts and scene cues. |
| `qc.json`, `spectrum.png`, `waveform.png` | Quality-check results and images (music). |
| `sfx.wav` | The SFX stem alone, at the level it has in the mix (48 kHz, 24-bit). |
| `mix.wav` | Music + SFX, -14 LUFS integrated, true peak <= -1 dBTP (48 kHz, 24-bit). |
| `mix-raw.wav`, `mix-preview.mp3` | The mix before loudnorm, and a 320 kb/s preview. |
| `sfx-placed.json` | Every placed SFX (time, kind, source event, level), counts per kind, skipped events with reasons. |
| `qc-mix.json`, `spectrum-mix.png`, `waveform-mix.png` | Quality checks on the mix. |

## Files

- `compose.mjs`: the arrangement and the entry point. It holds the section plan (`PLAN`), the chord chart, the motif, the counter-melody, and the drum, bass and arp patterns. It also defines the mix (sends, sidechain, filter automation) and the JS master bus. Every part is written relative to its section's first bar. To follow a storyboard change, edit `PLAN`, `LIFT_CUE` and `CUES`; every section must start and end on a bar line (2 s at 120 BPM).
- `synth.mjs`: the DSP, written from scratch.
  - Oscillators: polyBLEP saw, pulse and triangle (band-limited), and sine.
  - Envelopes and filters: closed-form ADSR, a trapezoidal state-variable filter (stable under modulation) and RBJ biquads.
  - Instruments: a detuned-saw pad with slow analog-style drift, a pluck, a mallet/glass bell and an airy lead with delayed vibrato. Also a soft saturated bass, a kick, a clap, hats and a shaker.
  - Effects: risers, swells, downlifters and impacts.
  - Bus effects: stereo chorus, ping-pong delay, a Freeverb-topology reverb and sidechain ducking.
  - Master: a glue compressor, tanh saturation, a look-ahead true-peak limiter (4x windowed-sinc inter-sample peak estimate) and a BS.1770-4 loudness meter.
  - WAV: a reader and a writer.
- `sfx.mjs`: the sound-effects layer. It reads the composer's `dist/video/music/events.json` and maps event kinds to synthesized SFX. Each SFX is levelled against the music around it (3-6 dB above the music's RMS at the SFX's loudest 10 or 50 ms; camera swishes stay below the music). The music ducks 3-4 dB under impacts, chimes and the alert, and 1.5 dB under whooshes. The script renders the stem, the mix and the mix QC. Kinds without a sound are listed in `sfx-placed.json`.

  | SFX | Events | Sound |
  |---|---|---|
  | click | `click` | Soft, crisp UI click: high-passed noise transient plus a 2.3/1.15 kHz "tock". |
  | tick | `step`, `copy` (double tick), `logo-bar` (rising pitch) | Tiny 3.4 kHz ping. |
  | whoosh | `cut`, `transition`, `tab`, `workspace-switch`, `theme-flip` | Airy band-passed noise sweep, 0.35-0.9 s. Pans left to right for cuts, follows the tab direction for tab switches, and stays centred for vertical transitions. Peaks 40 ms before the cut. |
  | swish | `push-in`, `pull-back`, `pan` | Very quiet low noise sweep (rising for push-ins, falling for pull-backs), scaled by the zoom amount. |
  | impact | `cut` at the drop (6.0), `cta-button` | Sub drop (85 to 30 Hz), body thud, noise burst and crack, with a large reverb. |
  | land | `wordmark-land` | Soft low thump. |
  | chime | `answer-land` | Bright two-note bell: A5, then E6. |
  | paste | `paste` | Paper flutter plus a short rising blip. |
  | alert | `notification` | Two falling notes a minor third apart (E5 to C#5). |
  | shimmer | `point` | Staggered high partials (D6 to A7) with tremolo and reverb. |
  | riser | fixed: into 6.0 (ends at the silent gap) and into 80 | Noise sweep plus gliding saws. |
- `master.mjs`: two-pass ffmpeg `loudnorm`. Pass 1 measures; pass 2 applies the measured values with `linear=true`, so the result is a pure gain change. Then the MP3 export.
- `check.mjs`: QC. It checks:
  - ffmpeg `ebur128` (integrated loudness and true peak) and `astats`;
  - clipped samples, and L/R correlation overall and per section;
  - RMS and LUFS per section against the planned energy shape, plus the 1 s before and after each mark;
  - spectral balance by band (Welch FFT), and that the tail decays to silence.

  It writes `spectrum.png` and `waveform.png` for a visual check. If a check fails, the script exits non-zero.

## Structure (120 BPM, 4/4, D major; bar = 2 s)

| Time (s) | Bars | Section | What plays |
|---|---|---|---|
| 0-6 | 0-2 | intro | Filtered pad (Bm9, Gmaj9, Asus), a hint of the motif through a closed filter with long echoes, and a noise and tone riser. No drums. |
| 6 | 3 | drop | Impact, then a light groove: kick on 1 and 3, clap on 2 and 4, offbeat hats, bass, and the full motif statement on the bell. |
| 12-74 | 6-36 | groove | Relaxed, spacious main groove that changes every 8 bars. At 12: kick on 1 and 3, offbeat hats, long bass notes and a sparse arp. At 28: 8th hats, a soft shaker, and the motif returns at 36. At 44: kick adds the 2-and, bass moves in a 3-3-2 rhythm, and the airy upper pad comes in. At 60: a syncopated arp and the motif again, quieter. Soft reverse swells lead into the scene cuts at 22, 34, 48 and 54, and a clap roll leads into the breakdown. |
| 74-80 | 37-39 | breakdown | Drums out, the pad filter closes and sweeps open, the motif inverted (the "theme flip"), an arp build and a riser. |
| 80-116 | 40-57 | lift | Unhurried four-on-the-floor groove with open hats, offbeat bass and a long-note counter-melody. Faint swells mark 86, 92 and 106. At 99 (doc paste) a small lift: a rising bell flourish, 16th hat ghosts, the air pad and brighter pads. |
| 116-126 | 58-62 | dark | Bm9, Gmaj9, Em9, F#m7, A; darker filter, lower arp, no shaker. |
| 126-140 | 63-69 | bright | Playful: bouncy octave-jumping arp, rim ticks, the motif in full, brighter pads. Drums stop before 140. |
| 140-150 | 70-74 | calm | Pads and a soft motif answer, a quiet sustained bass, no drums. |
| 150-154 | 75-76 | resolve | Final Dmaj9 swell with a soft impact and a callback to the opening of the motif. |
| 154-156.5 | | tail | Reverb tail, faded to digital silence by about 156.3 s. |

The sidechain pumping comes from the kick schedule: pads duck by about 50 %, the bass by 65 %, the air pad by 40 % and the arp by 20 %.

**Punch.**
- **Kick:** a tight pitch-swept kick (165 to 50 Hz) with a crisp click, a short punch decay and a controlled sub tail.
- **Snare:** a body layer under the clap on 2 and 4.
- **Drum bus:** parallel compression and saturation on the kick, clap and snare.
- **Drop:** a 0.25 s silent gap (5.75-6.0 s), then a bigger impact at 6.0 with a soft crash.

The calm section has no drums. Loudness stays at -14 LUFS; the punch comes from transients. The checks report the crest factor (peak minus RMS) per section.

## Why it is original

- **Sounds.** Every sound is synthesized at render time from oscillators and seeded noise, using the DSP in `synth.mjs`. Nothing is loaded from disk except this source code.
- **Melodies.** The motif, its inversion, the calm answer phrase and the counter-melody were written for this project. They are spelled out note by note in `compose.mjs`.
- **Harmony and patterns.** The progression (I, vi, IV, V in D, with ii, iii and sus colours) is common diatonic harmony, and the drum patterns are generic genre grammar. Neither is owned by anyone.
- **Determinism.** All randomness comes from a seeded PRNG (mulberry32). Two runs give byte-identical WAV, MP3 and JSON files, which was checked with SHA-256.

## Limitations

- **Synthesized, not produced.** This is a synthesized bed, not a produced record. The instruments are simple subtractive and additive models. There is no human performance, mixing engineer or mastering engineer, and the pads and bell are clean rather than lush. It is designed to sit under narration-free captions without drawing attention to itself.
- **Not checked by ear.** The mix was balanced with meters (per-bus RMS, band energy, spectrogram, EBU R128), not by listening on studio monitors. Listen to the MP3 on a few systems, including laptop speakers and headphones, before publishing.
- **Timeline coupling.** The track follows the section marks in `notes/VIDEO.md`. If the storyboard changes, update `PLAN` and the cues in `compose.mjs` and re-run.

## Swapping in a licensed track

The composer muxes whatever WAV is at `dist/video/music/lakeline-theme.wav`.

1. Use a track whose licence covers this use (commercial video, online distribution).
2. Edit or arrange it so its hits land on the marks in `markers.json`: the drop at 6.0 s, the breakdown at 74, the lift at 80, the calm at 140 and the resolve at 150.
3. Master it into place: `node video/music/master.mjs path/to/licensed.wav`. This writes the -14 LUFS / -1 dBTP master and the preview. Or place a 48 kHz, 24-bit stereo WAV there directly.
4. Optionally run `node video/music/check.mjs`. Its section-energy plan is written for this score, so a different track may "fail" those rows without being wrong.

Do not re-run `compose.mjs` afterwards, because it overwrites the file.
