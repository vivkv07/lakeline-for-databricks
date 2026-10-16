// Scene 6 · Queries and sizing (light). Query History rows with per-query estimates and the
// explanatory note (the heavy BI query's estimate tooltip on hover), then the warehouse size picker
// with "≈ $X/h per cluster · DBU only" for each size.
import { productScene, focusRect, rx } from './product.js';
import { pageWindow, hostFor, union, grow } from './common.js';

export default function build(ctx, { n, t0, t1 }) {
  const sc = productScene(ctx, { n, t0, t1, theme: 'light' });
  const L = (x) => t0 + x;
  const qh = sc.S({ kind: 'page', theme: 'light', hints: ['query-history', 'queries', 'history'], not: ['tooltip', 'size', 'picker'], index: 0 });
  const tip = sc.S({ kind: 'page', theme: 'light', hints: ['query-history-tooltip', 'tooltip', 'hover'], strict: true, exclude: [qh] });
  const size = sc.S({ kind: 'page', theme: 'light', hints: ['size-picker', 'warehouse-size', 'sizing', 'picker'], not: ['query-history'], exclude: [qh, tip], index: 2 });
  const host = hostFor(sc, qh, 'prod');
  const tHover = L(2.75), tNav = L(4.0);
  const sched = [{ t: -1e9, i: 0 }];
  if (tip) sched.push({ t: tHover, i: 1, d: 0.12 });
  sched.push({ t: tNav, i: 2, d: 0.4 });
  const { win } = pageWindow(sc, { theme: 'light', states: [qh, tip, size], host, sched });
  const P = (st, hints, not) => { const b = st ? sc.B(st, hints, not) : null; return b ? win.pageRect(b) : null; };
  const Pq = (st, hints, not) => { const b = sc.Bq(st, hints, not); return b ? win.pageRect(b) : null; };
  const rows = P(qh, ['table', 'rows', 'estimates'], ['heavy']);
  const heavy = P(qh, ['heavy-row', 'heavy'], ['estimate', 'duration']);
  const heavyEst = Pq(qh, ['heavy-estimate'], []);
  const note = P(qh, ['note', 'explanation', 'callout']);
  const tipBox = Pq(tip, ['tooltip'], []);
  const list = P(size, ['listbox', 'options', 'menu'], []);
  const trigger = Pq(size, ['trigger'], ['preview']);
  const cur = Pq(size, ['preview-large'], []), next = Pq(size, ['preview-x-large', 'preview-xlarge'], []);
  const optNext = Pq(size, ['option-x-large', 'option-xlarge'], []);

  // Camera: full window, push in on the note and the rows, then the heavy query and its
  // estimate tooltip; pull back for the page change; push in on the size picker.
  sc.cam.set(sc.full());
  const qf = union(note, rows);
  if (qf) sc.cam.to(L(0.8), 1.2, sc.focus(grow(qf, 20, 20), { k: 1.3 }));
  if (heavy) sc.cam.to(L(2.15), 1.0, sc.focus(focusRect(grow(union(heavy, tipBox), 30, 30), 1000, 0)));
  sc.cam.to(tNav - 0.4, 0.85, sc.full());
  const sf = union(trigger, list);
  if (sf) sc.cam.to(L(4.65), 1.2, sc.focus(focusRect(grow(sf, 60, 40), 800, 0), { k: 1.9 }));
  sc.cam.to(t1 - 0.95, 0.85, sc.full());

  if (note) sc.ring(note, { t0: L(1.5), t1: L(2.5) });
  if (heavy || heavyEst) sc.ring(heavy || heavyEst, { t0: L(2.4), t1: L(3.8), warm: true });
  if (optNext || next || list) sc.ring(optNext || next || list, { t0: L(5.8), t1: L(7.7) });
  const hov = heavyEst || heavy;
  sc.cursor([
    hov && { t: L(2.0), x: hov.x + hov.w + 120, y: hov.y + 80 },
    hov && { t: tHover - 0.05, x: hov.x + hov.w * 0.5, y: hov.y + hov.h * 0.55 },
    (optNext || next) && { t: L(5.3), x: (optNext || next).x + (optNext || next).w * 0.82, y: (optNext || next).y + (optNext || next).h * 0.55 },
  ].filter(Boolean), { appear: L(1.8), vanish: L(7.2) });

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
    t0: L(0.25), t1: t1 - 0.05, eyebrow: '04 · Queries and sizing', head: 'Know the cost before you scale.',
    details: [{ t: L(0.25), parts: [{ label: 'Heavy BI query', num: qCost }] }, { t: tNav + 0.4, parts: rateParts }],
  });
  return sc;
}
