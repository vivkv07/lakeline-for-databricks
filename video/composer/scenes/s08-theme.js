// Scene 8 · Theme flip (light → dark), 6 s. The same Explorer view in both themes on the full
// window; the dark copy is revealed by a soft radial crossfade that the background canvas mirrors
// (timeline FLIP), so stage, window chrome, capture and caption all flip together. No camera move.
import { productScene } from './product.js';
import { pageWindow, hostFor } from './common.js';
import { el } from '../lib/kit.js';
import { E } from '../lib/ease.js';
import { FLIP, flipRadius } from '../timeline.js';
import { findState } from '../lib/manifest.js';

export default function build(ctx, { n, t0, t1 }) {
  const root = el('div', 'layer', ctx.root);
  const sub = Object.assign({}, ctx, { root });
  const L = (x) => t0 + x;
  const m = ctx.manifests.scenes[n];
  // The light state leads (first listed); the dark state is the one with the same id.
  const lightSt = findState(m, { kind: 'page', theme: 'light', hints: [] });
  const darkSt = (lightSt && m.states.find((s) => s.theme === 'dark' && s.id === lightSt.id)) || findState(m, { kind: 'page', theme: 'dark', hints: [] });
  if (lightSt && darkSt && lightSt.id !== darkSt.id) ctx.warn(`scene 8: light ${lightSt.id} and dark ${darkSt.id} differ`);
  const mk = (theme, st) => {
    const sc = productScene(sub, { n, t0, t1, theme, enter: 'fade', exit: 'sink' });
    const host = hostFor(sc, st, 'prod');
    pageWindow(sc, { theme, states: [st], host, sched: [{ t: -1e9, i: 0 }] });
    sc.cam.set(sc.full());
    sc.caps.add({ t0: L(0.3), t1: t1 - 0.05, eyebrow: '06 · Light and dark', head: 'Light or dark, it fits in.', side: 'left' });
    return { sc, st };
  };
  const A = mk('light', lightSt);
  const B = mk('dark', darkSt);
  return {
    t0, t1, pre: 0.6, post: 0.5, layer: root,
    update(t) {
      A.sc.update(t);
      B.sc.update(t);
      const r = t < FLIP.t0 ? 0 : flipRadius(t, E.inOutCubic);
      const inner = Math.max(0, r - FLIP.feather);
      const mask = r >= FLIP.rMax ? 'none' : `radial-gradient(circle at ${FLIP.cx}px ${FLIP.cy}px, #000 ${inner.toFixed(2)}px, transparent ${r.toFixed(2)}px)`;
      B.sc.layer.style.webkitMaskImage = mask;
      B.sc.layer.style.maskImage = mask;
      B.sc.layer.style.display = r > 0.5 ? '' : 'none';
      A.sc.layer.style.display = r < FLIP.rMax ? '' : 'none';
    },
    pacing: () => A.sc.pacing(),
    events: () => A.sc.events().concat([{ t: FLIP.t0, kind: 'theme-flip', scene: n, label: 'light to dark (radial crossfade)', dur: FLIP.d }]),
    async ready() { await A.sc.ready(); await B.sc.ready(); },
  };
}
