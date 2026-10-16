// Scene 3 · One-click connect (light). The popup opens under the toolbar icon on the prod
// workspace tab; the cursor clicks "Connect this workspace" and the popup shows Connected.
import { productScene, popup, overview, view, E } from './product.js';
import { pageWindow, hostFor, at, union, grow } from './common.js';

export default function build(ctx, { n, t0, t1 }) {
  const sc = productScene(ctx, { n, t0, t1, theme: 'light', mode: 'top', enter: 'rise' });
  const L = (x) => t0 + x;
  const page = sc.S({ kind: 'page', theme: 'light', hints: ['prod', 'page', 'workspace', 'background', 'before', 'jobs'] });
  const popA = sc.S({ kind: 'popup', theme: 'light', hints: ['connect', 'not-connected', 'default', 'disconnected', 'before'], not: ['connecting'] });
  const popMid = sc.S({ kind: 'popup', theme: 'light', hints: ['connecting', 'progress', 'pending', 'signing-in'], strict: true, exclude: [popA] });
  const popB = sc.S({ kind: 'popup', theme: 'light', hints: ['connected', 'after', 'done', 'success'], not: ['not', 'disconnected', 'default', 'before', 'connecting'], exclude: [popA], index: 1 });
  const host = hostFor(sc, page, 'prod');
  const { win } = pageWindow(sc, { theme: 'light', states: [page], sched: [{ t: -1e9, i: 0 }], host });

  const tClick = L(3.9);
  const sched = [{ t: -1e9, i: 0 }];
  if (popMid) sched.push({ t: tClick + 0.12, i: 1, d: 0.22 });
  sched.push({ t: tClick + (popMid ? 0.75 : 0.15), i: 2, d: 0.3 });
  const pop = popup(sc, win, [popA, popMid, popB], sched, { open: L(1.62), close: Infinity });

  const btn = pop && pop.at(popA, sc.B(popA, ['connect-button', 'connect', 'primary-button', 'primary', 'button']));
  const status = pop && popB && pop.at(popB, sc.B(popB, ['status', 'connected', 'connection-status', 'state', 'workspace-status']));

  // Camera: establishing shot, then into the popup and its toolbar icon.
  const area = sc.area;
  const ov = overview(win, area);
  const popRect = pop ? union(pop.rect(L(2)), { x: win.icon.x - 20, y: win.icon.y - 20, w: 40, h: 40 }) : win.rect();
  const zoom = view(grow(popRect, 90, 40), area, { maxS: 1.22 });
  const wide = view(grow(popRect, 380, 120), area, { maxS: 1.0 });
  sc.cam.set(ov).to(L(1.25), 1.5, zoom).to(L(6.6), 1.2, wide);

  sc.cursor([
    { t: L(0.5), x: win.W * 0.62, y: win.H * 0.62 },
    { t: L(1.5), x: win.icon.x, y: win.icon.y, click: true },
    btn ? { t: L(3.9), x: btn.x + btn.w / 2, y: btn.y + btn.h / 2, click: true } : null,
    btn ? { t: L(5.0), x: btn.x + btn.w * 0.72, y: btn.y + btn.h * 2.4 } : null,
  ].filter(Boolean), { vanish: L(6.4) });
  if (status) sc.ring(grow(status, 4), { t0: tClick + (popMid ? 1.0 : 0.5), t1: L(7.6) });

  sc.caps.add({ t0: L(0.25), t1: t1 - 0.05, eyebrow: '01 · Connect', head: 'Connect in one click. Read-only.' });
  return sc;
}
