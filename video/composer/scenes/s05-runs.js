// Scene 5 · Run costs (light). The nightly_sales_etl runs list with a badge on every run and a
// zoom on the spike (backfill) run; then the customer_360_refresh detail page whose title total
// includes the pipeline it triggers (its keyboard-focus state shows the real focus ring).
import { productScene, focusRect, rx } from './product.js';
import { pageWindow, hostFor, union, grow } from './common.js';

export default function build(ctx, { n, t0, t1 }) {
  const sc = productScene(ctx, { n, t0, t1, theme: 'light' });
  const L = (x) => t0 + x;
  const runs = sc.S({ kind: 'page', theme: 'light', hints: ['runs-list', 'runs', 'job-runs', 'nightly-sales-etl', 'list'], not: ['detail', 'focus'], index: 0 });
  const det = sc.S({ kind: 'page', theme: 'light', hints: ['customer-360-detail', 'detail', 'customer-360'], not: ['focus'], exclude: [runs], index: 1 });
  const focusSt = sc.S({ kind: 'page', theme: 'light', hints: ['title-focus', 'focus'], strict: true, exclude: [runs, det] });
  const host = hostFor(sc, runs, 'prod');
  const tNav = L(5.15), tFocus = L(7.1);
  const sched = [{ t: -1e9, i: 0 }, { t: tNav, i: 1, d: 0.4 }];
  if (focusSt) sched.push({ t: tFocus, i: 2, d: 0.2 });
  const { win } = pageWindow(sc, { theme: 'light', states: [runs, det, focusSt], host, sched });
  const P = (st, hints, not) => { const b = st ? sc.B(st, hints, not) : null; return b ? win.pageRect(b) : null; };
  const list = P(runs, ['runs-table', 'run-list', 'runs-list', 'table']);
  const spike = P(runs, ['spike-row', 'spike-run', 'backfill', 'spike'], ['badge', 'duration']);
  const spikeBadge = P(runs, ['spike-badge', 'backfill-badge'], []);
  const title = P(det, ['title-badge', 'title-total', 'job-total'], ['aria']);
  const titleRow = P(det, ['page-title', 'title', 'heading'], ['badge']);

  // Camera: full window, push in on the runs list, then the spike row; pull back for the page
  // change; push in on the detail page's title total; pull back before the cut.
  sc.cam.set(sc.full());
  if (list) sc.cam.to(L(0.8), 1.3, sc.focus(grow(list, 20, 20), { k: 1.3 }));
  if (spike) sc.cam.to(L(2.45), 1.2, sc.focus(focusRect(grow(spike, 20, 60), 1000, 0), { k: 1.8 }));
  sc.cam.to(tNav - 0.45, 0.9, sc.full());
  const tf = union(title, titleRow);
  if (tf) sc.cam.to(L(6.0), 1.3, sc.focus(focusRect(grow(tf, 40, 60), 900, 0), { k: 1.9 }));
  sc.cam.to(t1 - 1.0, 0.9, sc.full());

  if (spike || spikeBadge) sc.ring(spike || spikeBadge, { t0: L(3.1), t1: L(4.9), warm: true });
  // The focus state draws the product's own focus ring; only ring the title total without it.
  if (title && !focusSt) sc.ring(title, { t0: L(7.0), t1: L(9.1) });

  const spikeAmt = sc.T(runs, ['spike-run-badge', 'spike-badge', 'spike-run-cost'], []);
  const spikeDay = sc.T(runs, ['spike-run-start', 'spike-start', 'spike-date'], []);
  const totalText = sc.T(det, ['title-badge', 'title-total', 'job-total'], ['aria']);
  const ariaText = sc.Tq(det, ['title-badge-aria', 'aria'], []);
  const jobTotal = rx(totalText, /(\$[\d,]+(?:\.\d+)?)/);
  const pipe = rx(ariaText, /Includes\s+(\$[\d,]+(?:\.\d+)?)\s+from triggered pipeline/i);
  sc.caps.add({ t0: L(0.25), t1: tNav - 0.1, eyebrow: '03 · Run costs', head: 'Every run, priced.', detail: [{ label: 'Backfill run', num: spikeDay }, '·', { num: spikeAmt }] });
  sc.caps.add({ t0: tNav + 0.2, t1: t1 - 0.05, eyebrow: '03 · Run costs', head: 'Job totals include the pipelines they trigger.', detail: [{ label: 'Job total', num: jobTotal }, '·', { label: 'includes', num: pipe, suffix: 'from triggered pipelines' }] });
  return sc;
}
