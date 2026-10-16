// Scene 4 · Cost banner (light). Prod workspace (red top bar) with the banner at 30 days, then
// the period switches through the three captured states (7 → 30 → 90). Caption numbers are the
// banner's own strings from the manifest: the amount, and the change and period cut from its
// meta line.
import { productScene, rx } from './product.js';
import { pageWindow, hostFor, union, grow } from './common.js';

export default function build(ctx, { n, t0, t1 }) {
  const sc = productScene(ctx, { n, t0, t1, theme: 'light' });
  const L = (x) => t0 + x;
  const s30 = sc.S({ kind: 'page', theme: 'light', hints: ['banner-30d', '30d', '30-days'], not: ['7d', '90d'], index: 1 });
  const s7 = sc.S({ kind: 'page', theme: 'light', hints: ['banner-7d', '7d', '7-days'], not: ['30d', '90d'], index: 0 });
  const s90 = sc.S({ kind: 'page', theme: 'light', hints: ['banner-90d', '90d', '90-days'], not: ['7d', '30d'], index: 2 });
  const host = hostFor(sc, s30, 'prod');
  // 30 days first (the story's month), then 7 → 30 → 90.
  const tc = [L(3.7), L(5.6), L(7.5)];
  const { win } = pageWindow(sc, {
    theme: 'light', states: [s30, s7, s90], host,
    sched: [{ t: -1e9, i: 0 }, { t: tc[0] + 0.1, i: 1, d: 0.15 }, { t: tc[1] + 0.1, i: 0, d: 0.15 }, { t: tc[2] + 0.1, i: 2, d: 0.15 }],
  });
  const P = (st, hints, not) => { const b = sc.B(st, hints, not); return b ? win.pageRect(b) : null; };
  const banner = P(s30, ['banner', 'cost-banner', 'summary']);
  const topbar = P(s30, ['top-nav', 'top-bar', 'topbar', 'color-bar', 'header']);
  const keyOf = (st) => union(P(st, ['amount', 'total'], ['badge']), P(st, ['meta', 'change', 'delta', 'vs-prior']));
  const b7 = P(s30, ['period-7', 'period-7d', '7d']);
  const b30 = P(s7, ['period-30', 'period-30d', '30d']);
  const b90 = P(s30, ['period-90', 'period-90d', '90d']);

  // Camera: full window, push in on the banner row (amount, meta, period control), then on
  // the 90-day amount and change, and pull back before the cut.
  const row = union(P(s30, ['amount'], ['badge']), P(s30, ['meta']), P(s30, ['period-90'])) || banner || { x: 0, y: 0, w: win.W, h: 300 };
  const key = keyOf(s30), key90 = keyOf(s90) || key;
  // The push-in also takes in the first job rows so their 30-day badges (11 px) read too.
  const badges = union(P(s30, ['badge-nightly'], []), P(s30, ['badge-customer-360'], []));
  sc.cam.set(sc.full())
    .to(L(0.8), 1.4, sc.focus(grow(union(row, badges), 40, 40), { k: 1.45 }));
  if (key90) sc.cam.to(L(8.0), 1.2, sc.focus(grow(key90, 60, 60), { k: 1.9 }));
  sc.cam.to(t1 - 0.95, 0.85, sc.full());
  const focus = row;

  if (key) sc.ring(key, { t0: L(2.0), t1: L(3.5) });
  if (key90) sc.ring(key90, { t0: L(8.7), t1: L(9.8) });
  sc.cursor([
    { t: L(2.6), x: (b7 || focus).x + 40, y: (b7 || focus).y + 160 },
    b7 && { t: tc[0], x: b7.x + b7.w / 2, y: b7.y + b7.h / 2, click: true },
    b30 && { t: tc[1], x: b30.x + b30.w / 2, y: b30.y + b30.h / 2, click: true },
    b90 && { t: tc[2], x: b90.x + b90.w / 2, y: b90.y + b90.h / 2, click: true },
    b90 && { t: L(8.3), x: b90.x + b90.w / 2 + 30, y: b90.y + 130 },
  ].filter(Boolean), { vanish: L(8.4) });

  const detail = (st) => {
    const meta = sc.Tq(st, ['meta-source'], []) || sc.T(st, ['meta', 'change'], ['source']);
    return [
      { num: sc.T(st, ['amount', 'total'], ['badge', 'badges']) },
      '·', { num: rx(meta, /([+\-−]\s?\d[\d.,]*\s?%\s+vs\.?\s+prior)/i) },
      '·', { num: rx(meta, /^([^·]+?)\s*·/) },
    ];
  };
  sc.caps.add({
    t0: L(0.25), t1: t1 - 0.05, eyebrow: '02 · Cost banner', head: 'Your spend and its trend, on every page.',
    details: [{ t: L(0.25), parts: detail(s30) }, { t: tc[0] + 0.1, parts: detail(s7) }, { t: tc[1] + 0.1, parts: detail(s30) }, { t: tc[2] + 0.1, parts: detail(s90) }],
  });
  return sc;
}
