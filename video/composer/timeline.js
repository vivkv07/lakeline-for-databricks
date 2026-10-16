// Storyboard timeline, "Pacing v2" (notes/VIDEO.md). Scene code is written relative to each
// scene's start, so retiming the video means editing this table. Music markers are compared
// against the scene starts by render.mjs.
//
// beats (product scenes): camera beats in seconds from the scene start. The pacing check
// (render.mjs --info) allows at most one camera move to start in each beat. They follow the
// storyboard's beats, plus an 'intro' (the establishing full-window shot, at least 1.5 s) and,
// where a scene ends zoomed in, an 'outro' that holds only the pull-back before the cut.
export const FPS = 30;

export const TIMELINE = [
  { n: 1, key: 'hook', t0: 0, t1: 6 },
  { n: 2, key: 'reveal', t0: 6, t1: 12 },
  { n: 3, key: 'connect', t0: 12, t1: 22, beats: [['intro', 0], ['popup', 1.5], ['connect', 4.6], ['outro', 8.0]] },
  { n: 4, key: 'banner', t0: 22, t1: 34, beats: [['intro', 0], ['7d', 1.5], ['30d', 5.4], ['90d', 8.8], ['outro', 10.3]] },
  { n: 5, key: 'runs', t0: 34, t1: 48, beats: [['intro', 0], ['runs', 1.5], ['total', 7.0], ['outro', 12.0]] },
  { n: 6, key: 'queries', t0: 48, t1: 60, beats: [['intro', 0], ['query', 1.5], ['picker', 5.5]] },
  { n: 7, key: 'explorer', t0: 60, t1: 74, beats: [['intro', 0], ['products', 1.5], ['drivers', 5.0], ['calendar', 8.5], ['outro', 12.3]] },
  { n: 8, key: 'theme', t0: 74, t1: 80, beats: [['intro', 0], ['flip', 1.5]] },
  { n: 9, key: 'genie', t0: 80, t1: 116, beats: [['intro', 0], ['ask', 1.5], ['video', 6], ['answer', 12], ['doc', 19], ['agent', 26], ['workspace', 31]] },
  { n: 10, key: 'monitor', t0: 116, t1: 126, beats: [['intro', 0], ['failure', 1.5], ['compute', 6.5], ['outro', 8.1]] },
  { n: 11, key: 'colors', t0: 126, t1: 140, beats: [['intro', 0], ['same', 1.5], ['pick', 3.4], ['switch', 11.1]] },
  { n: 12, key: 'security', t0: 140, t1: 150 },
  { n: 13, key: 'cta', t0: 150, t1: 154 },
];

/** Total length including the music tail after the CTA. */
export const DURATION = 156;
/** The CTA holds, then the frame fades to black over the last second. */
export const FADE_OUT = { t0: 155, t1: 156 };

export const T = Object.fromEntries(TIMELINE.map((s) => [s.n, s]));

/**
 * Scene 8 light→dark crossfade, swept radially from the top right with a wide feathered edge.
 * Shared by the background canvas and the scene layers so stage and window flip together.
 */
export const FLIP = { t0: T[8].t0 + 1.8, d: 1.8, cx: 2150, cy: -250, feather: 520, r0: 340, rMax: 3100 };
/** Sweep radius at time t (origin off-frame, top right). */
export const flipRadius = (t, ease) => FLIP.r0 + (FLIP.rMax - FLIP.r0) * ease(Math.min(1, Math.max(0, (t - FLIP.t0) / FLIP.d)));

/**
 * Comprehension rules (notes/VIDEO.md, Pacing v2), shared by the scenes and the pacing check.
 *   establish: full-window shot before the first move; move: [min, max] camera move duration;
 *   hold: minimum still time after a move; maxZoom: relative to the full-window shot;
 *   reZoom: minimum gap between a zoom-out and the next zoom-in; capIn: caption entrance time
 *   (no camera motion during it); capMin: minimum caption time on screen; cursorMove: minimum
 *   cursor travel time; clickPause: ripple, then this pause before the UI changes;
 *   xfade: [min, max] crossfade between states of one page; tab: tab-switch crossfade.
 */
export const RULES = {
  establish: 1.5, move: [1.2, 1.8], hold: 2.5, maxZoom: 1.8, reZoom: 3, capIn: 1.0, capMin: 3,
  cursorMove: 0.6, clickPause: 0.5, xfade: [0.4, 0.6], tab: 0.3,
};
