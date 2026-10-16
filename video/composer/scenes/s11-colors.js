// Scene 11 · Workspace colors (light). (a) Three tabs, dev, stage and prod, with identical default
// top bars. (b) The real Workspace colors section of the popup: dev gets a preset, stage a custom
// hex, prod a preset, each saved (a compressed montage: the popup's captured states cross-fade while
// the active tab follows). (c) Switching tabs again, each top bar in its own color.
import { productScene, popup, crossStack } from './product.js';
import { hostFor, wsName, union, grow, HOSTS } from './common.js';
import { browserWindow } from '../lib/kit.js';

const WS = ['dev', 'stage', 'prod'];

export default function build(ctx, { n, t0, t1 }) {
  const sc = productScene(ctx, { n, t0, t1, theme: 'light', sheet: { color: '#FFFFFF', t0: t0 - 0.6, t1: t0 + 0.35 } });
  sc.pre = 0.65;
  sc.post = 0; // the navy curtain into scene 12 covers the exit; nothing may outlive it
  const L = (x) => t0 + x;
  const m = sc.m;
  const byHints = (kind, hints, not = []) => sc.S({ kind, theme: 'light', hints, not, strict: true });
  const D = {}, C = {}, POP = {};
  for (const w of WS) {
    D[w] = byHints('page', [`default-${w}`, `${w}-default`], ['colored']);
    C[w] = byHints('page', [`colored-${w}`, `${w}-colored`], ['default']);
    POP[w] = ['open', 'chosen', 'saved'].map((k) => byHints('popup', [`colors-${w}-${k}`, `${w}-${k}`]));
  }
  const anyPage = m.states.find((s) => s.kind === 'page');
  for (const w of WS) { D[w] = D[w] || C[w] || anyPage; C[w] = C[w] || D[w]; }
  const hosts = Object.fromEntries(WS.map((w) => [w, HOSTS[w]]));
  const first = D.dev || { vw: 1600, vh: 1000 };
  const win = browserWindow(sc.world, {
    theme: 'light', w: first.vw, h: first.vh, active: 0, tabW: 250,
    tabs: WS.map((w) => ({ title: (D[w] && sc.Tq(D[w], ['switcher'], [])) || wsName(hosts[w]), host: hosts[w], fav: 'var(--faint)' })),
  });
  sc.world.insertBefore(win.el, sc.world.firstChild);
  sc.setWindow(win);

  /* -------------------------------------------------------- schedule */
  const pages = [], sched = [], tabs = [];
  const pageAt = (t, st, tab) => { if (!st) return; pages.push(st); sched.push({ t, i: pages.length - 1, d: 0.12 }); tabs.push({ t, tab }); };
  const cur = [];
  const tabPt = (i) => win.tabCenter(i);
  const clickTab = (t, i) => { const c = tabPt(i); cur.push({ t, x: c.x, y: c.y, click: true }); };
  // (a) identical default bars.
  pageAt(-1e9, D.dev, 0);
  cur.push({ t: L(0.5), x: tabPt(0).x + 40, y: 190 });
  clickTab(L(0.95), 1); pageAt(L(1.0), D.stage, 1);
  clickTab(L(1.75), 2); pageAt(L(1.8), D.prod, 2);
  // (b) Workspace colors, one workspace after another.
  clickTab(L(2.65), 0); pageAt(L(2.7), D.dev, 0);
  const tOpen = L(3.15), tClose = L(6.55);
  cur.push({ t: L(3.05), x: win.icon.x, y: win.icon.y, click: true });
  const seq = [
    [L(-1e9), POP.dev[0]], [L(3.75), POP.dev[1]], [L(4.2), POP.dev[2]],
    [L(4.75), POP.stage[1]], [L(5.2), POP.stage[2]],
    [L(5.7), POP.prod[1]], [L(6.1), POP.prod[2]],
  ].filter(([, st]) => st);
  const popStates = seq.map(([, st]) => st);
  const popSched = seq.map(([t], i) => ({ t: i === 0 ? -1e9 : t, i, d: 0.16 }));
  // A fixed crop of the tall popup: from the workspace URL field to the save status line.
  const span = union(...popStates.map((st) => union(sc.Bq(st, ['url'], []), sc.Bq(st, ['status'], []), sc.Bq(st, ['save'], []))));
  const pop = popStates.length ? popup(sc, win, popStates, popSched, { open: tOpen, close: tClose, maxH: span ? Math.min(600, span.h + 24) : 600, focusFor: () => span }) : null;
  const P = (st, key) => (pop && st ? pop.at(st, sc.Bq(st, [key], [])) : null);
  const pt = (r, fx = 0.5, fy = 0.5) => (r ? { x: r.x + r.w * fx, y: r.y + r.h * fy } : null);
  const push = (t, p, click) => { if (p) cur.push({ t, x: p.x, y: p.y, click }); };
  // Preset swatches: named boxes when the manifest has them (preset-green, ...); otherwise the
  // swatch centers measured on the captured preset row (six 38.5 px steps from 31 px in a 328 px
  // row starting at 16 px: red, amber, green, blue, violet, slate).
  const swatch = (st, name, i) => {
    const b = P(st, `preset-${name}`);
    if (b) return pt(b);
    const row = P(st, 'presets');
    return row ? { x: row.x + (31 + 38.5 * i - 16), y: row.y + row.h / 2 } : null;
  };
  push(L(3.7), swatch(POP.dev[0], 'green', 2), true);
  push(L(4.15), pt(P(POP.dev[1], 'save')), true);
  // Stage, prod: the active tab follows the workspace the popup shows.
  pageAt(L(4.75), D.stage, 1); push(L(4.7), pt(P(POP.stage[0] || POP.stage[1], 'hex'), 0.6), true);
  push(L(5.15), pt(P(POP.stage[1], 'save')), true);
  pageAt(L(5.7), D.prod, 2); push(L(5.65), swatch(POP.prod[0] || POP.prod[1], 'red', 0), true);
  push(L(6.05), pt(P(POP.prod[1], 'save')), true);
  // (c) after saving, open tabs update; switch through them.
  pageAt(tClose - 0.05, C.prod, 2);
  clickTab(L(7.1), 0); pageAt(L(7.15), C.dev, 0);
  clickTab(L(7.95), 1); pageAt(L(8.0), C.stage, 1);
  clickTab(L(8.8), 2); pageAt(L(8.85), C.prod, 2);
  cur.push({ t: L(9.4), x: tabPt(2).x + 80, y: 240 });

  const stack = crossStack(win.content, pages, sched);
  sc.add((t) => {
    stack.update(t);
    let tab = 0;
    for (const s of tabs) if (t >= s.t) tab = s.tab;
    win.setActive(tab);
  });
  cur.sort((a, b) => a.t - b.t);
  sc.cursor(cur, { vanish: L(9.6) });

  /* ---------------------------------------------------------- camera */
  // Full window, then a push-in on the tab strip and top bars; the magnified popup reads at the
  // full shot; back to the top bars for the colored tabs; pull back before the cut.
  const nav = sc.Bq(D.dev, ['top-nav'], []);
  // Tabs, address and the workspace top bar, anchored at the window's left edge.
  const topRect = { x: 0, y: 0, w: 1240, h: win.CH + (nav ? nav.y + nav.h : 50) + 120 };
  const bars = sc.focus(topRect, { k: 1.3, at: { x: 960, y: 300 } });
  sc.cam.set(sc.full())
    .to(L(0.6), 1.0, bars)
    .to(L(2.9), 0.9, sc.full())
    .to(tClose - 0.1, 0.9, bars)
    .to(t1 - 0.95, 0.85, sc.full());

  sc.caps.add({ t0: L(0.25), t1: L(2.85), eyebrow: '09 · Workspace colors', head: 'Dev, stage, prod. They all look the same.' });
  sc.caps.add({ t0: L(3.0), t1: t1 - 0.05, eyebrow: '09 · Workspace colors', head: 'Pick any color. Know where you are at a glance.' });
  return sc;
}
