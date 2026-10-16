// Scene 4 · Cost banner (light), 12 s. Prod workspace (red top bar): the banner at 7 days, then
// 30 and 90 (three captured states, about 3.5 s each). Caption numbers are the banner's own
// strings: the amount, and the change and period cut from its meta line. Step labels are the
// period buttons' own text from the manifest.
import { productScene, rx, PACE } from './product.js';
import { pageWindow, hostFor, union, grow } from './common.js';

export default function build(ctx, { n, t0, t1 }) {
  const sc = productScene(ctx, { n, t0, t1, theme: 'light' });
  const L = (x) => t0 + x;
  const s7 = sc.S({ kind: 'page', theme: 'light', hints: ['banner-7d', '7d', '7-days'], not: ['30d', '90d'], index: 0 });
  const s30 = sc.S({ kind: 'page', theme: 'light', hints: ['banner-30d', '30d', '30-days'], not: ['7d', '90d'], index: 1 });
  const s90 = sc.S({ kind: 'page', theme: 'light', hints: ['banner-90d', '90d', '90-days'], not: ['7d', '30d'], index: 2 });
  const host = hostFor(sc, s30, 'prod');
  // 7 days, then 30, then 90: a click, the click pause, then a 0.5 s crossfade.
  const c30 = L(4.9), c90 = L(8.3);
  const at30 = c30 + PACE.click, at90 = c90 + PACE.click;
  const { win } = pageWindow(sc, {
    theme: 'light', states: [s7, s30, s90], host,
    sched: [{ t: -1e9, i: 0 }, { t: at30, i: 1 }, { t: at90, i: 2 }],
  });
  const P = (st, hints, not) => { const b = st ? sc.Bq(st, hints, not) : null; return b ? win.pageRect(b) : null; };
  const keyOf = (st) => union(P(st, ['amount'], ['badge']), P(st, ['meta'], []));
  const b30 = P(s7, ['period-30'], []), b90 = P(s30, ['period-90'], []);
  // Push-in: the banner row (amount, meta, period buttons) plus the first job badges below it.
  const row = union(P(s7, ['amount'], ['badge']), P(s7, ['meta'], []), P(s7, ['period-90'], []), P(s7, ['badge-nightly'], []), P(s7, ['badge-customer-360'], []));

  sc.cam.set(sc.full());
  if (row) sc.move(L(1.5), sc.focus(grow(row, 30, 30)));
  sc.move(L(10.3), sc.full());

  [[s7, L(3.2), c30 - 0.3], [s30, at30 + 0.6, c90 - 0.3], [s90, at90 + 0.6, L(10.2)]].forEach(([st, a, b]) => {
    const k = keyOf(st);
    if (k) sc.ring(k, { t0: a, t1: b });
  });
  sc.cursor([
    b30 && { t: L(3.4), x: b30.x + b30.w / 2 + 40, y: b30.y + 150 },
    b30 && { t: c30, x: b30.x + b30.w / 2, y: b30.y + b30.h / 2, click: true },
    b90 && { t: c90, x: b90.x + b90.w / 2, y: b90.y + b90.h / 2, click: true },
    b90 && { t: L(9.6), x: b90.x + b90.w / 2 + 30, y: b90.y + 150 },
  ].filter(Boolean), { appear: L(3.0), vanish: L(10.0) });

  const detail = (st) => {
    const meta = sc.Tq(st, ['meta-source'], []) || sc.T(st, ['meta', 'change'], ['source']);
    return [
      { num: sc.T(st, ['amount', 'total'], ['badge', 'badges']) },
      '·', { num: rx(meta, /([+\-−]\s?\d[\d.,]*\s?%\s+vs\.?\s+prior)/i) },
      '·', { num: rx(meta, /^([^·]+?)\s*·/) },
    ];
  };
  const label = (st, fb) => sc.Tx(st, 'periodPressed') || fb;
  sc.caps.add({
    t0: L(0.3), t1: t1 - 0.05, head: 'Your spend and its trend, on every page.',
    steps: { labels: [label(s7, '7d'), label(s30, '30d'), label(s90, '90d')], times: [t0, at30, at90] },
    details: [{ t: L(0.3), parts: detail(s7) }, { t: at30, parts: detail(s30) }, { t: at90, parts: detail(s90) }],
  });
  return sc;
}
