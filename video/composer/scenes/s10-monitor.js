// Scene 10 · Run monitor (dark). The floating monitor window over the dark workspace shows
// running and failed runs; a failed customer_360_refresh run raises a desktop notification,
// rendered here as a stylized house-style card from the real notification title and message.
import { productScene, crossStack, E, ep, prog, env, lerp, el, op } from './product.js';
import { pageWindow, hostFor, union, grow } from './common.js';
import { notification } from '../lib/kit.js';
import { findState } from '../lib/manifest.js';

export default function build(ctx, { n, t0, t1 }) {
  const sc = productScene(ctx, { n, t0, t1, theme: 'dark' });
  const L = (x) => t0 + x;
  // The dark prod workspace behind the floating monitor; borrowed from scene 9 when this scene
  // has no page capture of its own (same real capture, warned in the render log).
  let page = sc.S({ kind: 'page', theme: 'dark', hints: ['workspace', 'page', 'prod', 'jobs', 'background'], strict: true });
  if (!page) {
    const m9 = ctx.manifests.scenes[9];
    page = (m9.states || []).find((s) => s.id === 'page-prod-jobs' && s.theme === 'dark') || findState(m9, { kind: 'page', theme: 'dark', hints: ['prod-jobs', 'prod'], not: ['docked'], strict: true });
    if (page) sc.warn(`scene 10: no page capture behind the monitor; borrowing scene 9 state ${page.id}`);
  }
  const monA = sc.S({ kind: 'monitor', theme: 'dark', hints: ['monitor-running', 'running', 'before'], not: ['failed', 'after'], index: 0 });
  const monB = sc.S({ kind: 'monitor', theme: 'dark', hints: ['monitor-failed', 'failed', 'failure', 'after'], not: ['before', 'running', 'full'], exclude: [monA], strict: true });
  // Warehouses and clusters, shown after the failure (the storyboard's "warehouses, clusters").
  const monC = sc.S({ kind: 'monitor', theme: 'dark', hints: ['monitor-compute', 'compute', 'warehouses', 'clusters'], not: ['full'], exclude: [monA, monB], strict: true });
  const host = hostFor(sc, page, 'prod');
  const { win } = pageWindow(sc, { theme: 'dark', states: [page], sched: [{ t: -1e9, i: 0 }], host });

  // Floating "Float on top" window with a minimal neutral title bar, magnified K× from its
  // top-right corner (anchored near the window's right edge) so the monitor reads at 1080p.
  const K = 1.4;
  const mw = (monA || monB).vw, mh = Math.min((monA || monB).vh, 760);
  const BAR = 30;
  const right = win.W - 40, top = win.CH + 18;
  const mx = right - mw, my = top;
  const fw = el('div', 'floatwin t-dark', sc.world, { left: mx + 'px', top: my + 'px', width: mw + 'px', height: mh + BAR + 'px', transformOrigin: '100% 0' });
  const bar = el('div', 'bar', fw);
  const dots = el('div', 'dots', bar);
  for (let i = 0; i < 3; i++) el('i', null, dots);
  const body = el('div', 'abs', fw, { top: BAR + 'px', width: mw + 'px', height: mh + 'px', overflow: 'hidden' });
  // Running → failed (next poll) → warehouses and clusters (the monitor scrolled down).
  const tFail = L(3.6), tCompute = L(6.7);
  const stack = crossStack(body, [monA, monB, monC], [{ t: -1e9, i: 0 }, { t: tFail, i: 1 }, { t: tCompute, i: 2 }], { log: sc, label: 'monitor' });
  const toWorld = (b) => (b ? { x: right - (mw - b.x) * K, y: top + (BAR + b.y) * K, w: b.w * K, h: b.h * K } : null);
  const mRect = { x: right - mw * K, y: top, w: mw * K, h: (mh + BAR) * K };
  const fin = monB || monA;
  const failed = toWorld(sc.B(fin, ['failed-run', 'customer-360-refresh', 'failure'], ['count', 'tile']));
  const head = toWorld(sc.Bq(fin, ['header'], []));
  sc.add((t) => {
    const o = ep(t, L(0.55), 0.5, E.outCubic);
    fw.style.opacity = o.toFixed(4);
    fw.style.transform = `translateY(${((1 - o) * 24).toFixed(3)}px) scale(${(K * lerp(0.97, 1, o)).toFixed(5)})`;
    stack.update(t);
  });

  // Notification card in stage space (top-right), from the manifest's real notification text.
  const nt = sc.m.notification || {};
  const title = nt.title || sc.Tq(fin, ['notification-title'], []);
  const message = nt.message || sc.Tq(fin, ['notification-message'], []);
  const context = nt.context || sc.Tq(fin, ['notification-context-message', 'notification-context'], []);
  let card = null;
  if (title || message) {
    card = notification(sc.layer, { title, message, context });
    card.style.zIndex = 60;
  } else sc.warn('scene 10: no notification text in the manifest; notification card omitted');
  const nIn = tFail + 0.5, nOut = L(7.6);
  sc.add((t) => {
    if (!card) return;
    const vis = t >= nIn - 0.01 && t <= nOut + 0.4;
    op(card, vis ? 1 : 0);
    if (!vis) return;
    const p = prog(t, nIn, nIn + 0.75);
    // Lands inside the title-safe area (96 px from the right edge, 64 px from the top).
    const x = lerp(1920 + 20, 1920 - 440 - 96, p <= 0 ? 0 : E.outBack(p, 0.9));
    const q = E.exit(prog(t, nOut, nOut + 0.4));
    card.style.left = '0px';
    card.style.top = '0px';
    card.style.transform = `translate(${(x + q * 520).toFixed(3)}px, 64px)`;
    card.style.opacity = (Math.min(1, p * 3) * (1 - q)).toFixed(4);
  });

  // Camera: full window with the monitor floating at the right, one push-in on the monitor from
  // its counts down to the failed run (warehouses and clusters scroll into the same area), one
  // pull-back before the cut.
  sc.cam.set(sc.full());
  const y0 = head ? head.y + head.h : mRect.y;
  const y1 = failed ? failed.y + failed.h : mRect.y + mRect.h * 0.7;
  sc.move(L(1.5), sc.focus({ x: mRect.x, y: y0, w: mRect.w, h: y1 - y0 }));
  sc.move(L(8.2), sc.full());
  if (failed) sc.ring(failed, { t0: tFail + 0.6, t1: tCompute - 0.2 });

  sc.caps.add({ t0: L(0.25), t1: t1 - 0.05, eyebrow: '08 · Run monitor', head: 'A run fails, you know.' });
  return sc;
}
