// Composer entry point. Boots the stage, loads manifests and captures, builds every scene and
// exposes window.__composer = { ready, seek(t), info() } for render.mjs. Rendering is a pure
// function of t: seek(t) writes every style and redraws the background canvas for that instant.
import { TIMELINE, DURATION, FPS, T, FLIP, FADE_OUT } from './timeline.js';
import { E, clamp, prog, keys, lerp } from './lib/ease.js';
import { loadAll, loadImages, SCENES } from './lib/manifest.js';
import { createWaves } from './lib/waves.js';
import { el, show } from './lib/kit.js';
import { hook, reveal, security, cta } from './scenes/mg.js';
import connect from './scenes/s03-connect.js';
import banner from './scenes/s04-banner.js';
import runs from './scenes/s05-runs.js';
import queries from './scenes/s06-queries.js';
import explorer from './scenes/s07-explorer.js';
import themeflip from './scenes/s08-theme.js';
import genie from './scenes/s09-genie.js';
import monitor from './scenes/s10-monitor.js';
import colors from './scenes/s11-colors.js';

const BUILDERS = { 1: hook, 2: reveal, 3: connect, 4: banner, 5: runs, 6: queries, 7: explorer, 8: themeflip, 9: genie, 10: monitor, 11: colors, 12: security, 13: cta };
const params = new URLSearchParams(location.search);
const RENDER = params.has('render');

/* --------------------------------------------------------------- background */

function bgParams(t) {
  const flipR = E.inOutCubic(prog(t, FLIP.t0, FLIP.t0 + FLIP.d)) * 2100;
  const p = { base: '#000000', level: 0, linesIn: 1, lineAlpha: 1, drift: 1 };
  if (t < T[3].t0 - 0.7) p.base = '#000000';
  else if (t < FLIP.t0) p.base = '#FFFFFF';
  else if (t < FLIP.t0 + FLIP.d) { p.base = '#FFFFFF'; p.circle = { color: '#000000', cx: FLIP.cx, cy: FLIP.cy, r: flipR }; }
  else if (t < T[11].t0 - 0.55) p.base = '#000000';
  else if (t < T[11].t0 + 0.25) { p.base = '#000000'; p.sheet = { color: '#FFFFFF', y: lerp(1080, 0, E.camera(prog(t, T[11].t0 - 0.55, T[11].t0 + 0.25))) }; }
  else if (t < T[12].t0 + 0.3) p.base = '#FFFFFF';
  else p.base = '#000000';
  p.level = keys(t, [
    [0, 0], [0.5, 0], [3.3, 0.3, E.camera], [4.7, 0.36], [5.95, 1, E.camera],
    [T[3].t0 - 0.6, 1], [T[3].t0 + 0.4, 0, E.camera],
    [T[12].t0 - 0.62, 0], [T[12].t0 + 0.3, 1, E.camera],
    [T[13].t0 - 0.05, 1], [T[13].t0 + 0.95, 0.27, E.camera],
  ]);
  p.linesIn = prog(t, 0.6, 3.2);
  p.lineAlpha = t >= T[12].t0 && t < T[13].t0 ? 0.6 : 1;
  return p;
}

/* -------------------------------------------------------------------- boot */

async function fontsReady() {
  const specs = ['400 20px Inter', '500 20px Inter', '600 20px Inter', '700 20px Inter', '400 20px "IBM Plex Mono"', '500 20px "IBM Plex Mono"', '600 20px "IBM Plex Mono"'];
  await Promise.all(specs.map((s) => document.fonts.load(s)));
  await document.fonts.ready;
}

async function boot() {
  const stage = document.getElementById('stage');
  const dpr = window.devicePixelRatio || 1;
  const waves = createWaves(document.getElementById('bg'), dpr);
  await fontsReady();
  const manifests = await loadAll();
  const warnings = manifests.warnings;
  const warn = (w) => { if (!warnings.includes(w)) warnings.push(w); };
  for (const n of Object.keys(SCENES).map(Number)) {
    const m = manifests.scenes[n];
    const failures = await loadImages(m);
    if (failures.length) {
      warn(`scene ${n}: images failed to load: ${failures.join(', ')}`);
      if (!m.placeholder) {
        const ph = manifests.fallback(n);
        const f2 = await loadImages(ph);
        if (f2.length) warn(`scene ${n}: placeholder images failed too: ${f2.join(', ')}`);
      }
    }
  }
  const placeholders = Object.keys(SCENES).map(Number).filter((n) => manifests.scenes[n].placeholder);
  const root = el('div', 'abs', stage, { width: '1920px', height: '1080px' });
  const ctx = { root, manifests, warn, stage };
  const built = [];
  for (const def of TIMELINE) {
    const sc = await BUILDERS[def.n](ctx, Object.assign({}, def, { end: DURATION }));
    sc.def = def;
    sc.layer.dataset.scene = def.n + '-' + def.key;
    if (sc.ready) await sc.ready();
    built.push(sc);
  }
  // Fade to black at the very end.
  const fade = el('div', 'abs', stage, { width: '1920px', height: '1080px', background: '#000', zIndex: 900, opacity: 0 });
  // Loud watermark whenever any placeholder is in use.
  const wm = document.getElementById('wm');
  if (placeholders.length) {
    wm.style.display = 'block';
    const grid = el('div', 'grid', wm);
    for (let i = 0; i < 40; i++) el('span', null, grid).textContent = 'PLACEHOLDER';
    el('div', 'tag', wm).textContent = `PLACEHOLDER CAPTURES · NOT FOR RELEASE · scenes ${placeholders.join(', ')}`;
  }

  function seek(t) {
    t = clamp(t, 0, DURATION);
    waves.draw(t, bgParams(t));
    for (const sc of built) {
      const a = sc.t0 - (sc.pre || 0), b = sc.t1 + (sc.post || 0);
      const on = t >= a && t < b;
      show(sc.layer, on);
      if (on) sc.update(t);
    }
    const f = prog(t, FADE_OUT.t0, FADE_OUT.t1);
    fade.style.opacity = E.inOutCubic(f).toFixed(4);
    show(fade, f > 0);
  }

  window.__composer = Object.assign(window.__composer || {}, {
    seek,
    info: () => ({ duration: DURATION, fps: FPS, timeline: TIMELINE, placeholders, sources: manifests.sources, warnings }),
  });
  return { seek };
}

/* ---------------------------------------------------------------- dev mode */

const readyPromise = boot().then((api) => {
  if (!RENDER) {
    const t0 = parseFloat(params.get('t') || '0');
    api.seek(t0);
    if (params.has('dev')) devBar(api, t0);
  }
  return true;
});
window.__composer = Object.assign(window.__composer || {}, { ready: readyPromise });
readyPromise.catch((e) => { window.__composerError = String(e && e.stack || e); console.error(e); });

function devBar(api, t0) {
  const bar = document.getElementById('dev');
  bar.style.display = 'flex';
  const play = el('button', null, bar);
  play.textContent = 'Play';
  const r = el('input', null, bar);
  r.type = 'range'; r.min = 0; r.max = DURATION; r.step = 1 / FPS; r.value = t0;
  const lab = el('span', null, bar);
  let playing = false, start = 0, from = t0;
  const set = (t) => { r.value = t; lab.textContent = t.toFixed(2) + 's'; api.seek(t); };
  r.oninput = () => set(parseFloat(r.value));
  play.onclick = () => { playing = !playing; play.textContent = playing ? 'Pause' : 'Play'; start = performance.now(); from = parseFloat(r.value); if (playing) loop(); };
  function loop() { if (!playing) return; const t = from + (performance.now() - start) / 1000; set(Math.min(t, DURATION)); if (t < DURATION) requestAnimationFrame(loop); }
  set(t0);
}
