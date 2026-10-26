// Scene 11 · Workspace colors (light), 14 s. (a) Three tabs, dev, stage and prod, with identical
// default top bars. (b) The real Workspace colors section of the popup: prod gets the Red preset,
// stage a custom hex, each saved; open tabs update. (c) Switching tabs again, each top bar in its
// own color (dev was set the same way, offscreen). Everything reads on the full window: no camera
// move. Chrome closes the popup when a tab is clicked, so the popup closes and reopens per tab.
import { productScene, popup, crossStack, PACE } from './product.js';
import { wsName, union, HOSTS } from './common.js';
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
  const first = D.dev || { vw: 1600, vh: 900 };
  const win = browserWindow(sc.world, {
    theme: 'light', w: first.vw, h: first.vh, active: 0, tabW: 250,
    tabs: WS.map((w) => ({ title: (D[w] && sc.Tq(D[w], ['switcher'], [])) || wsName(hosts[w]), host: hosts[w], fav: 'var(--faint)' })),
  });
  sc.world.insertBefore(win.el, sc.world.firstChild);
  sc.setWindow(win);

  /* -------------------------------------------------------- schedule */
  const pages = [], sched = [], tabs = [];
  const pageAt = (t, st, tab, kind) => { if (!st) return; pages.push(st); sched.push({ t, i: pages.length - 1, kind }); tabs.push({ t, tab }); };
  const cur = [];
  const tabRect = (i) => { const c = win.tabCenter(i); return { x: c.x - 40, y: c.y - 8, w: 80, h: 16 }; };
  const click = (t, p, label = '') => {
    if (p) cur.push({ t, x: p.x, y: p.y, click: true, label });
    else sc.warn(`scene 11: no target for the "${label}" click`);
    return t + PACE.click;
  };
  const mid = (r, fx = 0.5, fy = 0.5) => (r ? { x: r.x + r.w * fx, y: r.y + r.h * fy } : null);
  const iconPt = { x: win.icon.x, y: win.icon.y };

  // (a) identical default top bars: dev → stage → prod.
  pageAt(-1e9, D.dev, 0);
  cur.push({ t: L(0.5), x: mid(tabRect(0)).x + 60, y: 200 });
  pageAt(click(L(1.2), mid(tabRect(1)), 'northpeak-stage tab'), D.stage, 1, 'tab');
  pageAt(click(L(2.3), mid(tabRect(2)), 'northpeak-prod tab'), D.prod, 2, 'tab');
  // (b) prod: open the popup's Workspace colors, pick the Red preset, save; then stage: custom hex.
  const popStates = [], popSched = [];
  const popAt = (t, st) => { if (!st) return; popStates.push(st); popSched.push({ t: popStates.length === 1 ? -1e9 : t, i: popStates.length - 1, d: PACE.hover }); };
  const span = union(...WS.flatMap((w) => POP[w]).filter(Boolean).map((st) => union(sc.Bq(st, ['url'], []), sc.Bq(st, ['status'], []), sc.Bq(st, ['save'], []))));
  const tOpenProd = click(L(3.4), iconPt, 'Lakeline toolbar icon');
  popAt(tOpenProd, POP.prod[0]);
  // Swatch centers on the real preset row: named boxes when the manifest has them, otherwise six
  // 38.5 px steps from 31 px (red, amber, green, blue, violet, slate) measured on the capture.
  let pop = null;
  const P = (st, key) => (pop && st ? pop.at(st, sc.Bq(st, [key], [])) : null);
  const swatch = (st, name, i) => {
    const b = P(st, `preset-${name}`);
    if (b) return mid(b);
    const row = P(st, 'presets');
    return row ? { x: row.x + (31 + 38.5 * i - 16) * pop.k, y: row.y + row.h / 2 } : null;
  };
  // The popup is created after its schedule is known; positions only depend on its geometry.
  const tRed = L(4.5), tSaveProd = L(5.6), tStageTab = L(6.7), tOpenStage = L(7.8), tHex = L(8.9), tSaveStage = L(10.0);
  popAt(tRed + PACE.click, POP.prod[1]);
  popAt(tSaveProd + PACE.click, POP.prod[2]);
  popAt(tOpenStage + PACE.click, POP.stage[0] || POP.stage[1]);
  popAt(tHex + PACE.click, POP.stage[1]);
  popAt(tSaveStage + PACE.click, POP.stage[2]);
  // Clicking a tab closes the popup: after the click pause it fades out over 0.18 s.
  const closeProd = tStageTab + PACE.click + 0.18, closeStage = L(11.1) + PACE.click + 0.18;
  // Two popup instances (prod, then stage), each opened by a click on the toolbar icon.
  const split = popStates.findIndex((st) => WS.indexOf('stage') >= 0 && POP.stage.includes(st));
  const prodPart = split > 0 ? [popStates.slice(0, split), popSched.slice(0, split)] : [popStates, popSched];
  const stagePart = split > 0 ? [popStates.slice(split), popSched.slice(split).map((x, i) => Object.assign({}, x, { i, t: i === 0 ? -1e9 : x.t }))] : null;
  // Show the URL through the save status; a taller panel is drawn smaller, so it never takes more of
  // the frame than 600 CSS px at 1.4×.
  const opts = (open, close) => {
    const maxH = span ? span.h + 24 : 600;
    return { open, close, maxH, scale: 1.4 * Math.min(1, 600 / maxH), focusFor: () => span };
  };
  pop = prodPart[0].length ? popup(sc, win, prodPart[0], prodPart[1], opts(tOpenProd, closeProd)) : null;
  const popStage = stagePart && stagePart[0].length ? popup(sc, win, stagePart[0], stagePart[1], opts(tOpenStage + PACE.click, closeStage)) : null;
  click(tRed, swatch(POP.prod[0], 'red', 0), 'Red preset');
  const saveProd = click(tSaveProd, mid(P(POP.prod[1], 'save')), 'Save');
  pageAt(saveProd, C.prod, 2); // open tabs on this workspace update automatically
  pageAt(click(tStageTab, mid(tabRect(1)), 'northpeak-stage tab'), D.stage, 1, 'tab');
  click(tOpenStage, iconPt, 'Lakeline toolbar icon');
  const PS = (st, key) => (popStage && st ? popStage.at(st, sc.Bq(st, [key], [])) : null);
  click(tHex, mid(PS(POP.stage[0] || POP.stage[1], 'hex'), 0.6), 'Hex field (custom color)');
  const saveStage = click(tSaveStage, mid(PS(POP.stage[1], 'save')), 'Save');
  pageAt(saveStage, C.stage, 1);
  // (c) switch tabs: each top bar in its own color.
  const tDev = click(L(11.1), mid(tabRect(0)), 'northpeak-dev tab');
  pageAt(tDev, C.dev, 0, 'tab');
  pageAt(click(L(12.2), mid(tabRect(2)), 'northpeak-prod tab'), C.prod, 2, 'tab');
  sc.event(saveProd, 'top-bar-color', `prod top bar turns ${sc.Tq(POP.prod[2], ['hex'], []) || 'red'}`);
  sc.event(saveStage, 'top-bar-color', `stage top bar turns ${sc.Tq(POP.stage[2], ['hex'], []) || 'amber'}`);
  cur.push({ t: L(13.3), x: mid(tabRect(2)).x + 90, y: 240 });

  const stack = crossStack(win.content, pages, sched, { log: sc, label: 'page' });
  sc.add((t) => {
    stack.update(t);
    let tab = 0;
    for (const s of tabs) if (t >= s.t) tab = s.tab;
    win.setActive(tab);
  });
  sc.cursor(cur, { appear: L(0.2), vanish: L(13.8) });

  // Camera: the full window throughout (tabs, top bars and the magnified popup all read there).
  sc.cam.set(sc.full());

  const steps = { labels: ['Same-looking tabs', 'Pick colors', 'Switch tabs'], times: [t0, tOpenProd, tDev] };
  sc.caps.add({ t0: L(0.3), t1: L(3.3), head: 'Dev, stage, prod. They all look the same.', steps });
  sc.caps.add({ t0: L(3.5), t1: t1 - 0.05, head: 'Pick any color. Know where you are at a glance.', steps });
  return sc;
}
