// Scene 3 · One-click connect (light). The popup opens under the toolbar icon on the prod
// workspace tab; the cursor hovers and clicks "Connect this workspace" and the popup shows the
// Connected line.
import { productScene, popup } from './product.js';
import { pageWindow, hostFor, union, grow } from './common.js';
import { findState } from '../lib/manifest.js';

export default function build(ctx, { n, t0, t1 }) {
  const sc = productScene(ctx, { n, t0, t1, theme: 'light', enter: 'rise' });
  const L = (x) => t0 + x;
  const popA = sc.S({ kind: 'popup', theme: 'light', hints: ['popup-not-connected', 'not-connected', 'connect', 'default', 'before'], not: ['hover', 'connecting'], index: 0 });
  const popHover = sc.S({ kind: 'popup', theme: 'light', hints: ['connect-hover', 'hover'], strict: true, exclude: [popA] });
  const popMid = sc.S({ kind: 'popup', theme: 'light', hints: ['connecting', 'progress', 'pending', 'signing-in'], strict: true, exclude: [popA, popHover] });
  const popB = sc.S({ kind: 'popup', theme: 'light', hints: ['popup-connected', 'connected', 'after', 'done', 'success'], not: ['not', 'hover', 'connecting', 'before'], exclude: [popA, popHover], index: 2 });
  // The prod tab behind the popup. Until the capture set has its own pre-connect page, borrow the
  // scene 4 capture of the same prod page (warned, so it is visible in render logs).
  let page = sc.S({ kind: 'page', theme: 'light', hints: ['before-connect', 'page', 'prod', 'workspace', 'jobs'], strict: true });
  if (!page) {
    const m4 = ctx.manifests.scenes[4];
    page = findState(m4, { kind: 'page', theme: 'light', hints: ['30d', '7d'] });
    if (page) sc.warn(`scene 3: no page capture behind the popup; borrowing scene 4 state ${page.id}`);
  }
  const host = hostFor(sc, popA, 'prod');
  const { win } = pageWindow(sc, { theme: 'light', states: [page], sched: [{ t: -1e9, i: 0 }], host });

  const tHover = L(3.45), tClick = L(3.95);
  const sched = [{ t: -1e9, i: 0 }];
  if (popHover) sched.push({ t: tHover, i: 1, d: 0.15 });
  if (popMid) sched.push({ t: tClick + 0.12, i: 2, d: 0.22 });
  sched.push({ t: tClick + (popMid ? 0.75 : 0.2), i: 3, d: 0.14 });
  const pop = popup(sc, win, [popA, popHover, popMid, popB], sched, { open: L(1.62), close: Infinity });

  const btn = pop && pop.at(popA, sc.B(popA, ['connect-button', 'connect', 'primary-button', 'primary']));
  const status = pop && popB && pop.at(popB, sc.B(popB, ['connected-line', 'status', 'connected', 'connection-status', 'tab-status']));

  // Camera: the full window, then a push-in on the popup's header, button and status line.
  const head = pop && union(pop.at(popA, sc.Bq(popA, ['header'], [])), btn, status, { x: win.icon.x - 30, y: win.icon.y - 20, w: 60, h: 40 });
  sc.cam.set(sc.full());
  if (head) sc.cam.to(L(1.75), 1.4, sc.focus(grow(head, 70, 50), { k: 1.35 }));
  sc.cam.to(t1 - 1.05, 0.9, sc.full());

  sc.cursor([
    { t: L(0.5), x: win.W * 0.62, y: win.H * 0.62 },
    { t: L(1.5), x: win.icon.x, y: win.icon.y, click: true },
    btn ? { t: tHover, x: btn.x + btn.w * 0.42, y: btn.y + btn.h / 2 } : null,
    btn ? { t: tClick, x: btn.x + btn.w * 0.45, y: btn.y + btn.h / 2 + 1, click: true } : null,
    btn ? { t: L(5.0), x: btn.x + btn.w * 0.72, y: btn.y + btn.h * 3.2 } : null,
  ].filter(Boolean), { vanish: L(6.4) });
  if (status) sc.ring(status, { t0: tClick + (popMid ? 1.0 : 0.55), t1: L(7.6) });

  sc.caps.add({ t0: L(0.25), t1: t1 - 0.05, eyebrow: '01 · Connect', head: 'Connect in one click. Read-only.' });
  return sc;
}
