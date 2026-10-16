// Scene 5 · Run costs (light), 14 s. The nightly_sales_etl runs list with a badge on every run and
// a push-in on the spike (backfill) run; a pan to the title total, then the customer_360_refresh
// detail page whose title total includes the pipeline it triggers (its keyboard-focus state shows
// the real focus ring). Camera: push-in, one pure pan at the same zoom, pull-back before the cut.
import { productScene, rx, PACE } from './product.js';
import { pageWindow, hostFor, union, grow } from './common.js';

export default function build(ctx, { n, t0, t1 }) {
  const sc = productScene(ctx, { n, t0, t1, theme: 'light' });
  const L = (x) => t0 + x;
  const runs = sc.S({ kind: 'page', theme: 'light', hints: ['runs-list', 'runs', 'job-runs', 'nightly-sales-etl', 'list'], not: ['detail', 'focus'], index: 0 });
  const det = sc.S({ kind: 'page', theme: 'light', hints: ['customer-360-detail', 'detail', 'customer-360'], not: ['focus'], exclude: [runs], index: 1 });
  const focusSt = sc.S({ kind: 'page', theme: 'light', hints: ['title-focus', 'focus'], strict: true, exclude: [runs, det] });
  const host = hostFor(sc, runs, 'prod');
  const tNav = L(8.7), tFocus = L(10.7);
  const sched = [{ t: -1e9, i: 0 }, { t: tNav, i: 1 }];
  if (focusSt) sched.push({ t: tFocus, i: 2 });
  const { win } = pageWindow(sc, { theme: 'light', states: [runs, det, focusSt], host, sched });
  const P = (st, hints, not) => { const b = st ? sc.Bq(st, hints, not) : null; return b ? win.pageRect(b) : null; };
  const spike = P(runs, ['spike-row'], []);
  const spikeBadge = P(runs, ['spike-badge'], []);
  const spikeDur = P(runs, ['spike-duration'], []);
  const title = union(P(runs, ['page-title'], []), P(runs, ['title-badge'], ['aria']), P(det, ['page-title'], []), P(det, ['title-badge'], ['aria']));
  const titleBadge = P(det, ['title-badge'], ['aria']);

  // Camera: full window, push-in on the spike run (the rows above it for context), a pure pan
  // (same zoom) to the title area before the page changes, pull-back before the cut.
  sc.cam.set(sc.full());
  let k = null;
  if (spike) {
    const r = union(spike, spikeBadge, spikeDur);
    const v = sc.focus({ x: r.x, y: r.y - 190, w: Math.min(r.w, 1160), h: r.h + 190 });
    k = v.s / sc.full().s;
    sc.move(L(1.5), v);
  }
  if (title && k) sc.move(L(7.0), sc.focus(grow(title, 40, 60), { k }));
  sc.move(L(12.0), sc.full());

  if (spikeBadge || spike) sc.ring(spikeBadge || spike, { t0: L(3.3), t1: L(6.8), warm: true });
  if (titleBadge && !focusSt) sc.ring(titleBadge, { t0: tFocus, t1: L(11.9) });

  const spikeAmt = sc.T(runs, ['spike-run-badge', 'spike-badge', 'spike-run-cost'], []);
  const spikeDay = sc.T(runs, ['spike-run-start', 'spike-start', 'spike-date'], []);
  const totalText = sc.T(det, ['title-badge', 'title-total', 'job-total'], ['aria']);
  const ariaText = sc.Tq(det, ['title-badge-aria', 'aria'], []);
  const jobTotal = rx(totalText, /(\$[\d,]+(?:\.\d+)?)/);
  const pipe = rx(ariaText, /Includes\s+(\$[\d,]+(?:\.\d+)?)\s+from triggered pipeline/i);
  const steps = { labels: ['Every run', 'Job total'], times: [t0, tNav] };
  sc.caps.add({ t0: L(0.3), t1: L(8.5), head: 'Every run, priced.', steps, detail: [{ label: 'Backfill run', num: spikeDay }, '·', { num: spikeAmt }] });
  sc.caps.add({ t0: tNav, t1: t1 - 0.05, head: 'Job totals include the pipelines they trigger.', steps, detail: [{ label: 'Job total', num: jobTotal }, '·', { label: 'includes', num: pipe, suffix: 'from triggered pipelines' }] });
  return sc;
}
