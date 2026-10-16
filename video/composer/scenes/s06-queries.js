// Scene 6 · Queries and sizing (light), 12 s. Query History rows with per-query estimates and the
// explanatory note (push-in, the heavy BI query highlighted), then the warehouse size picker with
// "≈ $X/h per cluster · DBU only" for each size, on the full window.
import { productScene, rx, PACE } from './product.js';
import { pageWindow, hostFor, union, grow } from './common.js';

export default function build(ctx, { n, t0, t1 }) {
  const sc = productScene(ctx, { n, t0, t1, theme: 'light' });
  const L = (x) => t0 + x;
  const qh = sc.S({ kind: 'page', theme: 'light', hints: ['query-history', 'queries', 'history'], not: ['tooltip', 'size', 'picker'], index: 0 });
  const size = sc.S({ kind: 'page', theme: 'light', hints: ['size-picker', 'warehouse-size', 'sizing', 'picker'], not: ['query-history', 'tooltip'], exclude: [qh], index: 2 });
  const host = hostFor(sc, qh, 'prod');
  const tNav = L(7.3);
  const { win } = pageWindow(sc, { theme: 'light', states: [qh, size], host, sched: [{ t: -1e9, i: 0 }, { t: tNav, i: 1 }] });
  const P = (st, hints, not) => { const b = st ? sc.Bq(st, hints, not) : null; return b ? win.pageRect(b) : null; };
  const note = P(qh, ['note'], []);
  const heavy = P(qh, ['heavy-row'], []);
  const heavyEst = P(qh, ['heavy-estimate'], []);
  const optXL = P(size, ['option-x-large'], []);

  // Camera: full window, push-in on the note and the rows down to the heavy query, pull-back
  // for the page change; the size picker reads on the full window.
  sc.cam.set(sc.full());
  const qf = union(note, heavy);
  if (qf) sc.move(L(1.5), sc.focus(grow(qf, 10, 20)));
  sc.move(L(5.6), sc.full());

  if (heavy) sc.ring(heavy, { t0: L(3.7), t1: L(5.5), warm: true });
  if (optXL) sc.ring(optXL, { t0: L(8.9), t1: L(11.7) });
  if (heavyEst) sc.cursor([
    { t: L(2.2), x: heavyEst.x + 260, y: heavyEst.y + 150 },
    { t: L(3.5), x: heavyEst.x + heavyEst.w * 0.5, y: heavyEst.y + heavyEst.h * 0.6 },
  ], { appear: L(1.9), vanish: L(5.4) });
  if (optXL) sc.cursor([
    { t: L(7.9), x: optXL.x + optXL.w + 120, y: optXL.y + 140 },
    { t: L(8.7), x: optXL.x + optXL.w * 0.8, y: optXL.y + optXL.h * 0.55 },
  ], { appear: L(7.6), vanish: L(11.6) });

  // Caption numbers: the heavy query's estimate, then the current and next size from the open list.
  const qCost = sc.T(qh, ['heavy-estimate', 'heavy-query-cost', 'heavy'], ['duration']);
  const sizeName = (i) => sc.Tx(size, `options.${i}.size`);
  const sizePrev = (i) => rx(sc.Tx(size, `options.${i}.preview`), /(≈\s*\$[\d,.]+\/h)/);
  const trig = sc.Tx(size, 'trigger');
  let iCur = -1;
  for (let i = 0; sc.Tx(size, `options.${i}.size`) != null; i++) if (sc.Tx(size, `options.${i}.preview`) === trig) iCur = i;
  const rateParts = iCur >= 0 && sizeName(iCur + 1)
    ? [{ label: sizeName(iCur), num: sizePrev(iCur) }, ' → ', { label: sizeName(iCur + 1), num: sizePrev(iCur + 1), suffix: rx(sc.Tx(size, `options.${iCur + 1}.preview`), /\/h\s+(.+)$/) }]
    : [{ label: 'Warehouse size', num: trig }];
  sc.caps.add({
    t0: L(0.3), t1: t1 - 0.05, eyebrow: '04 · Queries and sizing', head: 'Know the cost before you scale.',
    details: [{ t: L(0.3), parts: [{ label: 'Heavy BI query', num: qCost }] }, { t: tNav, parts: rateParts }],
  });
  return sc;
}
