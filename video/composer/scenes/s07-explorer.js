// Scene 7 · Cost Explorer (light), 14 s. Products stacked bars → Top drivers → Calendar heatmap
// with the spike flag. The cursor clicks the real tab positions (found from each state's accent
// underline) and hovers marks; hover states show the Explorer's own tooltip and inspect line.
// Camera: full window, one push-in on the Explorer (it holds through all three views), one
// pull-back before the cut so the theme flip opens on the same full window.
import { productScene, rx, accentRun, PACE } from './product.js';
import { pageWindow, hostFor, union, grow } from './common.js';

export default function build(ctx, { n, t0, t1 }) {
  const sc = productScene(ctx, { n, t0, t1, theme: 'light' });
  const L = (x) => t0 + x;
  const used = [];
  const pick = (spec) => { const s = sc.S(Object.assign({ kind: 'page', theme: 'light', exclude: used.slice() }, spec)); if (s) used.push(s); return s; };
  const prod = pick({ hints: ['products', 'product', 'stacked'], not: ['hover', 'drivers', 'calendar'], index: 0 });
  const prodHover = pick({ hints: ['products-hover'], strict: true });
  const drv = pick({ hints: ['top-drivers', 'drivers'], not: ['calendar', 'products'], index: 1 });
  const cal = pick({ hints: ['calendar', 'heatmap'], not: ['hover', 'drivers', 'products'], index: 2 });
  const calHover = pick({ hints: ['calendar-spike-hover', 'spike-hover', 'calendar-hover'], strict: true });
  const host = hostFor(sc, prod, 'prod');
  const raw = (st, name) => (st ? sc.Bq(st, [name], []) : null);
  // The real tab positions: the selected tab's underline in the state that selects it.
  const tabD = accentRun(drv, raw(drv, 'tabs')), tabC = accentRun(cal, raw(cal, 'tabs'));
  const T = {
    hover: L(3.5),                       // cursor arrives on the tallest bar
    drvClick: L(5.0), cal: L(8.7),
    calHover: L(10.3),
  };
  T.drv = T.drvClick + PACE.click;
  T.calClick = T.cal - PACE.click;
  const sched = [{ t: -1e9, i: 0 }];
  if (prodHover) sched.push({ t: T.hover, i: 1, d: PACE.hover });
  sched.push({ t: T.drv, i: 2 }, { t: T.cal, i: 3 });
  if (calHover) sched.push({ t: T.calHover, i: 4, d: PACE.hover });
  const { win } = pageWindow(sc, { theme: 'light', states: [prod, prodHover, drv, cal, calHover], host, sched });
  const P = (st, name) => { const b = raw(st, name); return b && b.w > 4 ? win.pageRect(b) : null; };
  const W = (b) => (b ? win.pageRect(b) : null);
  const panel = P(prod, 'panel');
  const tabs = P(prod, 'tabs');
  const markP = P(prodHover, 'hovered-mark'), markC = P(calHover, 'hovered-mark') || P(cal, 'spike-cell');
  const inspectC = P(calHover, 'inspect');

  // Camera: full window, a push-in on the Explorer (it holds through Products and Top drivers),
  // a closer push-in on the calendar heatmap, which is already in frame, and a pull-back before
  // the cut so the theme flip opens on the same full window.
  sc.cam.set(sc.full());
  if (panel && tabs) sc.move(L(1.5), sc.focus({ x: panel.x, y: panel.y - 4, w: panel.w, h: panel.h + 40 }, { at: { x: 960, y: 450 } }));
  const tabsC = P(cal, 'tabs'), inspectCal = P(cal, 'inspect');
  if (tabsC && inspectCal) {
    const y0 = tabsC.y + tabsC.h + 4;
    sc.move(L(8.9), sc.focus({ x: tabsC.x + 14, y: y0, w: 760, h: inspectCal.y + inspectCal.h + 6 - y0 }), 1.2);
  }
  sc.move(L(12.6), sc.full(), 1.2);

  if (inspectC) sc.ring(inspectC, { t0: T.calHover + 0.4, t1: L(12.5), warm: true, label: 'spike inspect line' });
  if (prodHover) sc.event(T.hover, 'tooltip', 'tallest day tooltip');
  if (calHover) sc.event(T.calHover, 'tooltip', 'spike day tooltip');
  const ptOf = (r, fx = 0.5, fy = 0.5) => (r ? { x: r.x + r.w * fx, y: r.y + r.h * fy } : null);
  const path = [];
  const add = (t, r, click, label, fx, fy) => { const p = ptOf(r, fx, fy); if (p) path.push({ t, x: p.x, y: p.y, click, label }); };
  add(L(2.6), markP ? { x: markP.x + 160, y: markP.y + 120, w: 1, h: 1 } : null, false, '');
  add(T.hover, markP, false, 'tallest day bar', 0.5, 0.35);
  add(T.drvClick, W(tabD), true, 'Top drivers tab');
  add(T.calClick, W(tabC), true, 'Calendar tab');
  add(T.calHover, markC, false, 'spike day cell', 0.55, 0.5);
  if (path.length) sc.cursor(path, { appear: L(2.3), vanish: L(12.0) });

  const spikeLine = sc.Tq(calHover, ['inspect'], []);
  const drvRow = sc.Tq(drv, ['first-row', 'top-row', 'top-driver'], []);
  sc.caps.add({
    t0: L(0.3), t1: t1 - 0.05, head: 'Explore what drives spend.',
    steps: { labels: ['Products', 'Top drivers', 'Calendar'], times: [t0, T.drv, T.cal] },
    details: [
      { t: L(0.3), parts: [] },
      { t: T.drv, parts: [{ label: 'Top driver', num: rx(drvRow, /^([^\n·]+)/) }] },
      { t: T.calHover, parts: [{ label: 'Spike flagged', num: rx(spikeLine, /^([^·]+?)\s*·/) }, '·', { num: rx(spikeLine, /Cost:\s*(\$[\d,]+(?:\.\d+)?)/) }, '·', { num: rx(spikeLine, /Change:[^(]*\(([+\-−]\d[\d.,]*%)\)/), suffix: 'vs the aligned prior day' }] },
    ],
  });
  return sc;
}
