// Scene 7 · Cost Explorer (light). Products stacked bars → Top drivers → Calendar heatmap with the
// spike flag. Hover states show the Explorer's own inspect line; the caption quotes it.
import { productScene, focusRect, rx } from './product.js';
import { pageWindow, hostFor, union, grow } from './common.js';

export default function build(ctx, { n, t0, t1 }) {
  const sc = productScene(ctx, { n, t0, t1, theme: 'light' });
  const L = (x) => t0 + x;
  const used = [];
  const pick = (spec) => { const s = sc.S(Object.assign({ kind: 'page', theme: 'light', exclude: used.slice() }, spec)); if (s) used.push(s); return s; };
  const prod = pick({ hints: ['products', 'product', 'stacked'], not: ['hover', 'drivers', 'calendar'], index: 0 });
  // Hover states are only used when the manifest says where the pointer is (a hover-target box).
  const hoverOk = (st) => st && sc.Bq(st, ['hovered-mark', 'hover-target', 'pointer', 'hovered', 'spike-cell'], []);
  let prodHover = pick({ hints: ['products-hover'], strict: true });
  if (prodHover && !hoverOk(prodHover)) prodHover = null;
  const drv = pick({ hints: ['top-drivers', 'drivers'], not: ['calendar', 'products'], index: 1 });
  const cal = pick({ hints: ['calendar', 'heatmap'], not: ['hover', 'drivers', 'products'], index: 2 });
  const calHover = pick({ hints: ['calendar-spike-hover', 'spike-hover', 'calendar-hover'], strict: true });
  const host = hostFor(sc, prod, 'prod');
  const T = { hover: L(2.0), drv: L(3.4), cal: L(6.3), spike: L(7.3) };
  const sched = [{ t: -1e9, i: 0 }];
  if (prodHover) sched.push({ t: T.hover, i: 1, d: 0.2 });
  sched.push({ t: T.drv, i: 2, d: 0.18 }, { t: T.cal, i: 3, d: 0.18 });
  if (calHover) sched.push({ t: T.spike, i: 4, d: 0.2 });
  const { win } = pageWindow(sc, { theme: 'light', states: [prod, prodHover, drv, cal, calHover], host, sched });
  const P = (st, hints, not) => { const b = st ? sc.B(st, hints, not) : null; return b && b.w > 20 && b.h > 12 ? win.pageRect(b) : null; };
  const Pq = (st, hints, not) => { const b = sc.Bq(st, hints, not); return b && b.w > 4 ? win.pageRect(b) : null; };
  const panelP = P(prod, ['panel', 'explorer', 'cost-explorer'], ['tab']);
  const panelC = P(cal, ['panel', 'explorer'], ['tab']) || panelP;
  const firstRow = Pq(drv, ['first-row', 'top-row'], []);
  const inspectP = Pq(prodHover, ['inspect'], []);
  const inspectC = Pq(calHover, ['inspect'], []);
  const tabD = Pq(prod, ['tab-top-drivers', 'top-drivers-tab', 'tab-drivers'], []);
  const tabC = Pq(drv, ['tab-calendar', 'calendar-tab'], []);
  const hoverP = Pq(prodHover, ['hovered-mark', 'hover-target', 'pointer', 'hovered'], []);
  const hoverC = Pq(calHover, ['hovered-mark', 'hover-target', 'pointer', 'hovered'], []) || Pq(cal, ['spike-cell'], []);

  // Camera: full window, push in on the Explorer, pan to each view's content, then the spike
  // line; pull back before the cut (the theme flip opens on the full window).
  const panelD = P(drv, ['panel', 'explorer'], ['tab']);
  sc.cam.set(sc.full());
  if (panelP) sc.cam.to(L(0.8), 1.2, sc.focus(grow(panelP, 10, 10), { k: 1.3 }));
  // Top drivers: the ranked bars from the first row down, at the panel's full width.
  if (panelD) {
    const y0 = firstRow ? firstRow.y - 70 : panelD.y + panelD.h * 0.4;
    sc.cam.to(T.drv + 0.3, 1.1, sc.focus({ x: panelD.x, y: y0, w: panelD.w, h: Math.min(panelD.y + panelD.h, y0 + 420) - y0 }));
  }
  if (panelC) sc.cam.to(T.cal - 0.1, 1.0, sc.focus(grow(panelC, 10, 10), { k: 1.4 }));
  const tipC = Pq(calHover, ['tooltip'], []);
  const spikeFocus = union(tipC, hoverC, inspectC && { x: inspectC.x, y: inspectC.y, w: Math.min(inspectC.w, 900), h: inspectC.h });
  if (spikeFocus) sc.cam.to(T.spike + 0.2, 1.1, sc.focus(grow(spikeFocus, 30, 30)));
  sc.cam.to(t1 - 0.95, 0.85, sc.full());

  if (inspectP) sc.ring(inspectP, { t0: T.hover + 0.2, t1: T.drv - 0.1 });
  if (firstRow) sc.ring(firstRow, { t0: T.drv + 0.9, t1: T.cal - 0.2 });
  if (inspectC) sc.ring(inspectC, { t0: T.spike + 0.3, t1: L(9.6), warm: true });
  const path = [
    tabD && { t: T.drv - 0.05, x: tabD.x + tabD.w / 2, y: tabD.y + tabD.h / 2, click: true },
    hoverP && { t: T.hover - 0.05, x: hoverP.x + hoverP.w / 2, y: hoverP.y + hoverP.h / 2 },
    tabC && { t: T.cal - 0.05, x: tabC.x + tabC.w / 2, y: tabC.y + tabC.h / 2, click: true },
    hoverC && { t: T.spike - 0.05, x: hoverC.x + hoverC.w / 2, y: hoverC.y + hoverC.h / 2 },
  ].filter(Boolean).sort((a, b) => a.t - b.t);
  if (path.length) sc.cursor(path, { vanish: L(9.4) });

  const spikeLine = sc.Tq(calHover, ['inspect'], []);
  const drvRow = sc.Tq(drv, ['first-row', 'top-row', 'top-driver'], []);
  sc.caps.add({
    t0: L(0.25), t1: t1 - 0.05, eyebrow: '05 · Cost Explorer', head: 'Explore what drives spend.',
    details: [
      { t: L(0.25), parts: [] },
      { t: T.drv + 0.4, parts: [{ label: 'Top driver', num: rx(drvRow, /^([^\n·]+)/) }] },
      { t: T.spike + 0.3, parts: [{ label: 'Spike flagged', num: rx(spikeLine, /^([^·]+?)\s*·/) }, '·', { num: rx(spikeLine, /Cost:\s*(\$[\d,]+(?:\.\d+)?)/) }, '·', { num: rx(spikeLine, /Change:[^(]*\(([+\-−]\d[\d.,]*%)\)/), suffix: 'vs the aligned prior day' }] },
    ],
  });
  return sc;
}
