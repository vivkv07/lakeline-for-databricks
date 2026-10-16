// Scene 3 · One-click connect (light), 10 s. The popup opens under the toolbar icon on the prod
// workspace tab; the cursor hovers and clicks "Connect this workspace" and the popup shows the
// Connected line. Camera: full window, one push-in on the popup, one pull-back before the cut.
import { productScene, popup, PACE } from './product.js';
import { pageWindow, hostFor, union, grow } from './common.js';
import { findState } from '../lib/manifest.js';

export default function build(ctx, { n, t0, t1 }) {
  const sc = productScene(ctx, { n, t0, t1, theme: 'light', enter: 'rise' });
  const L = (x) => t0 + x;
  const popA = sc.S({ kind: 'popup', theme: 'light', hints: ['popup-not-connected', 'not-connected', 'connect', 'default', 'before'], not: ['hover', 'connecting'], index: 0 });
  const popHover = sc.S({ kind: 'popup', theme: 'light', hints: ['connect-hover', 'hover'], strict: true, exclude: [popA] });
  const popB = sc.S({ kind: 'popup', theme: 'light', hints: ['popup-connected', 'connected', 'after', 'done', 'success'], not: ['not', 'hover', 'connecting', 'before'], exclude: [popA, popHover], index: 2 });
  // The prod tab behind the popup. Until the capture set has its own pre-connect page, borrow the
  // scene 4 capture of the same prod page (warned, so it is visible in render logs).
  let page = sc.S({ kind: 'page', theme: 'light', hints: ['before-connect', 'page', 'prod', 'workspace', 'jobs'], strict: true });
  if (!page) {
    page = findState(ctx.manifests.scenes[4], { kind: 'page', theme: 'light', hints: ['30d', '7d'] });
    if (page) sc.warn(`scene 3: no page capture behind the popup; borrowing scene 4 state ${page.id}`);
  }
  const host = hostFor(sc, popA, 'prod');
  const { win } = pageWindow(sc, { theme: 'light', states: [page], sched: [{ t: -1e9, i: 0 }], host });

  // Choreography (seconds from the scene start).
  const tIcon = L(1.1), tOpen = tIcon + PACE.click;   // click the toolbar icon → popup
  const tHover = L(4.5), tClick = L(5.2), tDone = tClick + PACE.click;
  const sched = [{ t: -1e9, i: 0 }];
  if (popHover) sched.push({ t: tHover, i: 1, d: PACE.hover });
  sched.push({ t: tDone, i: 2, d: PACE.xfade });
  const pop = popup(sc, win, [popA, popHover, popB], sched, { open: tOpen });

  const btn = pop && pop.at(popA, sc.B(popA, ['connect-button', 'connect', 'primary-button', 'primary']));
  const status = pop && popB && pop.at(popB, sc.B(popB, ['connected-line', 'status', 'connected', 'tab-status']));
  const head = pop && union(pop.at(popA, sc.Bq(popA, ['header'], [])), btn, status);

  // Camera: the full window (≥ 1.5 s), one push-in on the popup, one pull-back before the cut.
  sc.cam.set(sc.full());
  if (head) sc.move(L(2.1), sc.focus(grow(head, 40, 40)));
  sc.move(L(8.1), sc.full());

  sc.cursor([
    { t: L(0.3), x: win.W * 0.62, y: win.H * 0.6 },
    { t: tIcon, x: win.icon.x, y: win.icon.y, click: true },
    btn ? { t: tHover, x: btn.x + btn.w * 0.42, y: btn.y + btn.h / 2 } : null,
    btn ? { t: tClick, x: btn.x + btn.w * 0.42, y: btn.y + btn.h / 2, click: true } : null,
    btn ? { t: L(6.6), x: btn.x + btn.w * 0.75, y: btn.y + btn.h * 4 } : null,
  ].filter(Boolean), { appear: L(0.1), vanish: L(7.6) });
  if (status) sc.ring(status, { t0: tDone + 0.6, t1: L(7.9) });

  sc.caps.add({ t0: L(0.3), t1: t1 - 0.05, eyebrow: '01 · Connect', head: 'Connect in one click. Read-only.' });
  return sc;
}
