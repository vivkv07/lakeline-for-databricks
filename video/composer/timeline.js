// Storyboard timeline (notes/VIDEO.md). Scene code is written relative to each scene's start, so
// retiming the video means editing this table only. Music markers are compared against it by
// render.mjs.
export const FPS = 30;

export const TIMELINE = [
  { n: 1, key: 'hook', t0: 0, t1: 6 },
  { n: 2, key: 'reveal', t0: 6, t1: 12 },
  { n: 3, key: 'connect', t0: 12, t1: 20 },
  { n: 4, key: 'banner', t0: 20, t1: 30 },
  { n: 5, key: 'runs', t0: 30, t1: 40 },
  { n: 6, key: 'queries', t0: 40, t1: 48 },
  { n: 7, key: 'explorer', t0: 48, t1: 58 },
  { n: 8, key: 'theme', t0: 58, t1: 62 },
  { n: 9, key: 'genie', t0: 62, t1: 86 },
  { n: 10, key: 'monitor', t0: 86, t1: 94 },
  { n: 11, key: 'colors', t0: 94, t1: 104 },
  { n: 12, key: 'security', t0: 104, t1: 112 },
  { n: 13, key: 'cta', t0: 112, t1: 116 },
];

/** Total length including the music tail after the CTA. */
export const DURATION = 118;
/** The CTA holds, then the frame fades to black over the last second. */
export const FADE_OUT = { t0: 117, t1: 118 };

export const T = Object.fromEntries(TIMELINE.map((s) => [s.n, s]));

/**
 * Scene 8 light→dark crossfade, swept radially from the top right with a wide feathered edge.
 * Shared by the background canvas and the scene layers so stage and window flip together.
 */
export const FLIP = { t0: T[8].t0 + 0.85, d: 1.7, cx: 2150, cy: -250, feather: 520, r0: 340, rMax: 3100 };
/** Sweep radius at time t (origin off-frame, top right). */
export const flipRadius = (t, ease) => FLIP.r0 + (FLIP.rMax - FLIP.r0) * ease(Math.min(1, Math.max(0, (t - FLIP.t0) / FLIP.d)));
