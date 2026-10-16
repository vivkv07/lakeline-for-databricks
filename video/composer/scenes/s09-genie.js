// Scene 9 · Ask Genie: work while you wait (dark), 36 s. The side panel stays docked while the
// active tab changes: (a) open it from the popup and ask in prod, (b) switch to a video tab while
// Genie works, (c) the answer lands with a subtle attention cue (chart, table, SQL), (d) copy the
// answer and the table into a doc tab, (e) switch Genie Agent, (f) switch workspace; the page
// follows. Page and panel captures are paired as in the manifest (extra.pairing). Docked pages are
// 1180 px wide; the 420 px panel fills the rest of the window. The panel reads on the full window,
// so the camera only pushes in once, on the answer, and pulls back for the doc.
import { productScene, crossStack, popup, E, prog, el, PACE } from './product.js';
import { hostFor, wsName, union, grow, HOSTS } from './common.js';
import { browserWindow } from '../lib/kit.js';
import { findState } from '../lib/manifest.js';

export default function build(ctx, { n, t0, t1 }) {
  const sc = productScene(ctx, { n, t0, t1, theme: 'dark' });
  const L = (x) => t0 + x;
  const m = sc.m;
  // States by id (dark preferred), falling back to hint matching for differently named sets.
  const byId = (id, kind, hints) => m.states.find((s) => s.id === id && s.theme === 'dark')
    || m.states.find((s) => s.id === id)
    || (hints ? findState(m, { kind, theme: 'dark', hints, strict: true }) : null);
  const G = {
    full: byId('page-prod-jobs', 'page'),
    prod: byId('page-prod-jobs-docked', 'page', ['prod-docked', 'prod']),
    v1: byId('page-video-1-docked', 'page', ['video-1', 'video']),
    v2: byId('page-video-2-docked', 'page', ['video-2']),
    d0: byId('page-doc-0-before-docked', 'page', ['doc-0', 'doc']),
    d1: byId('page-doc-1-answer-docked', 'page', ['doc-1', 'pasted-answer']),
    d2: byId('page-doc-2-table-docked', 'page', ['doc-2', 'pasted-table']),
    ana: byId('page-analytics-jobs-docked', 'page', ['analytics']),
  };
  const P = {};
  for (const id of ['01-empty-prod', '02-typed', '03-working', '04-working-other-tab', '05-answer-bars', '05b-bar-tooltip', '06-table', '07-show-sql', '08-menu-open', '09-copied-answer', '10-copied-table', '11-agent-revenue', '12-revenue-typed', '13-revenue-kpi', '14-workspace-analytics', '15-analytics-working', '16-analytics-line']) {
    P[id.split('-')[0]] = byId('panel-' + id, 'panel', [id.replace(/^\d+b?-/, '')]);
  }
  const askPop = byId('popup-ask-genie', 'popup', ['ask-genie']);
  const firstPage = G.full || G.prod;
  if (!G.prod || !P['01']) sc.warn('scene 9: expected docked prod page and panel states are missing');

  /* -------------------------------------------------------------- window */
  const prodHost = hostFor(sc, P['01'], 'prod');
  const anaHost = (P['14'] && sc.Tq(P['14'], ['workspace'], [])) || HOSTS.analytics;
  const tabs = [
    { title: wsName(prodHost), host: prodHost, fav: 'var(--faint)' },
    { title: sc.Tq(G.v1, ['title'], []) || 'Recorded tech talk', host: 'videos.example', fav: 'var(--warm)' },
    { title: 'Weekly cost review', host: 'docs.example', fav: 'var(--accent)' },
  ];
  const W = 1600, H = (firstPage || { vh: 900 }).vh, PW = 420, DX = W - PW;
  const win = browserWindow(sc.world, { theme: 'dark', w: W, h: H, tabs, active: 0 });
  sc.world.insertBefore(win.el, sc.world.firstChild);
  sc.setWindow(win);
  const panelEl = el('div', 'abs', win.frame, { top: win.CH + 'px', width: PW + 1 + 'px', height: H + 'px', overflow: 'hidden', background: 'var(--bg)', borderLeft: '1px solid var(--line2)', isolation: 'isolate', zIndex: 3 });
  const panelRect = { x: DX, y: win.CH, w: PW + 1, h: H };
  const PR = (st, name) => { const b = st ? sc.Bq(st, [name], []) : null; return b ? { x: DX + 1 + b.x, y: win.CH + b.y, w: b.w, h: b.h } : null; };
  const GR = (st, name) => { const b = st ? sc.Bq(st, [name], []) : null; return b ? win.pageRect(b) : null; };
  const tabRect = (i) => { const c = win.tabCenter(i); return { x: c.x - 60, y: c.y - 10, w: 120, h: 20 }; };

  /* ----------------------------------------------------------- schedule */
  // Every click is followed by the click pause before the UI changes; page and panel states
  // crossfade over 0.4–0.5 s, tab switches over 0.3 s.
  const pages = [], pSched = [], tabSched = [];
  const pageAt = (t, st, tab, kind = 'state') => { if (!st) return; pages.push(st); pSched.push({ t, i: pages.length - 1, kind }); if (tab != null) tabSched.push({ t, tab }); };
  const panels = [], qSched = [];
  const panelAt = (t, st, d = PACE.hover) => { if (!st) return; panels.push(st); qSched.push({ t, i: panels.length - 1, d }); };
  const cur = [];
  const click = (t, r, fx = 0.5, fy = 0.5) => { if (!r) return null; cur.push({ t, x: r.x + r.w * fx, y: r.y + r.h * fy, click: true }); return t + PACE.click; };
  const hover = (t, r, fx = 0.5, fy = 0.5) => { if (r) cur.push({ t, x: r.x + r.w * fx, y: r.y + r.h * fy }); };
  const at = {};

  // (a) 0–6 · open the panel from the popup and ask in prod.
  pageAt(-1e9, firstPage, 0);
  panelAt(-1e9, P['01']);
  hover(L(0.3), { x: W * 0.62, y: win.CH + H * 0.55, w: 1, h: 1 });
  const tPop = click(L(1.4), { x: win.icon.x - 4, y: win.icon.y - 4, w: 8, h: 8 });
  const pop = askPop ? popup(sc, win, [askPop], [{ t: -1e9, i: 0 }], { open: tPop, close: L(3.1) + 0.18 }) : null;
  const askBtn = pop && pop.at(askPop, sc.Bq(askPop, ['ask-genie'], []));
  at.panel = click(L(2.6), askBtn) || L(3.1);
  sc.log(at.panel, 0.55, 'open', 'side panel');
  if (G.full) pageAt(at.panel, G.prod, 0);
  at.typed = click(L(3.9), PR(P['01'], 'question') || PR(P['01'], 'composer'), 0.3);
  if (at.typed) panelAt(at.typed, P['02']);
  at.working = click(L(5.0), PR(P['02'], 'send'));
  if (at.working) panelAt(at.working, P['03']);
  // (b) 6–12 · another tab: the video keeps playing, the panel keeps working.
  at.video = click(L(6.6), tabRect(1));
  pageAt(at.video, G.v1, 1, 'tab');
  panelAt(at.video, P['04']);
  hover(L(8.0), GR(G.v1, 'player'), 0.55, 0.62);
  pageAt(L(10.4), G.v2, 1);
  // (c) 12–19 · the answer lands in the panel while the video tab is active.
  at.answer = L(12.0);
  panelAt(at.answer, P['05'], PACE.xfade);
  const ansArea = union(PR(P['05'], 'last-chip'), PR(P['05'], 'last-answer-text'), PR(P['05'], 'last-chart'), PR(P['05'], 'last-sql'));
  const bar = PR(P['05'], 'first-bar');
  if (bar && P['05b']) { hover(L(15.4), bar, 0.7); panelAt(L(15.5), P['05b']); }
  const tTable = click(L(16.3), PR(P['05'], 'last-segmented'), 0.75);
  if (tTable) panelAt(tTable, P['06'], PACE.xfade);
  const tSql = click(L(17.5), PR(P['06'], 'last-sql'), 0.25);
  if (tSql) panelAt(tSql, P['07'], PACE.xfade);
  // (d) 19–26 · copy the answer and the table into the doc.
  at.doc = click(L(21.0), tabRect(2));
  pageAt(at.doc, G.d0, 2, 'tab');
  const tMenu = click(L(22.1), PR(P['07'], 'last-menu') || PR(P['05'], 'last-menu'));
  if (tMenu) panelAt(tMenu, P['08']);
  const tCopyA = click(L(23.2), PR(P['08'], 'copy-answer'));
  if (tCopyA) panelAt(tCopyA, P['09']);
  const tPaste1 = click(L(24.3), GR(G.d0, 'notes'), 0.15, 0.5);
  if (tPaste1) pageAt(tPaste1, G.d1, 2);
  const tCopyT = click(L(25.4), PR(P['08'], 'copy-table'));
  if (tCopyT) panelAt(tCopyT, P['10']);
  const tPaste2 = click(L(26.5), GR(G.d1, 'appendix'), 0.15, 0.6);
  if (tPaste2) pageAt(tPaste2, G.d2, 2);
  // (e) 26–31 · switch Genie Agent: Platform ops → Revenue analytics.
  at.agent = click(L(28.1), PR(P['10'] || P['05'], 'agent-select'), 0.6) || L(28.6);
  panelAt(at.agent, P['11']);
  const tTyped = click(L(29.2), PR(P['11'], 'question') || PR(P['11'], 'composer'), 0.3);
  if (tTyped) panelAt(tTyped, P['12']);
  const tKpi = click(L(30.3), PR(P['12'], 'send'));
  if (tKpi) panelAt(tKpi, P['13'], PACE.xfade);
  // (f) 31–36 · back on the Databricks tab, switch workspace: the page follows (blue top bar).
  at.prodTab = click(L(31.4), tabRect(0));
  pageAt(at.prodTab, G.prod, 0, 'tab');
  at.ws = click(L(32.5), PR(P['13'] || P['11'], 'workspace-select'), 0.6) || L(33.0);
  panelAt(at.ws, P['14']);
  pageAt(at.ws, G.ana, 0);
  const tAsk2 = click(L(33.6), PR(P['14'], 'send'));
  if (tAsk2) panelAt(tAsk2, P['15']);
  panelAt(L(35.0), P['16'], PACE.xfade);
  hover(L(35.4), { x: DX - 140, y: win.CH + H * 0.6, w: 1, h: 1 });

  const pageStack = crossStack(win.content, pages, pSched, { log: sc, label: 'page' });
  const panelStack = crossStack(panelEl, panels, qSched, { log: sc, label: 'panel' });
  sc.add((t) => {
    pageStack.update(t);
    panelStack.update(t);
    // The panel slides in from the right edge as Ask Genie opens it, then stays docked.
    const o = askPop ? E.inOutCubic(prog(t, at.panel, at.panel + 0.55)) : 1;
    panelEl.style.left = (W - (PW + 1) * o).toFixed(3) + 'px';
    panelEl.style.display = o > 0 ? '' : 'none';
    let tab = 0;
    for (const s of tabSched) if (t >= s.t) tab = s.tab;
    win.setActive(tab);
    win.setTab(0, G.ana && t >= at.ws ? { title: wsName(anaHost), host: anaHost } : { title: wsName(prodHost), host: prodHost });
  });
  sc.cursor(cur, { appear: L(0.1), vanish: L(35.8) });

  /* ------------------------------------------------------------- camera */
  // Full window throughout, except one push-in on the answer (chart, table and SQL), with a
  // pull-back as the doc beat begins.
  sc.cam.set(sc.full());
  if (ansArea) sc.move(L(13.4), sc.focus(grow(ansArea, 20, 20), { k: 1.4 }));
  sc.move(L(19.0), sc.full());

  // (c) attention cue: two soft pulses around the docked panel as the answer lands.
  sc.ring(grow(panelRect, -4), { t0: at.answer + 0.1, t1: at.answer + 1.0, radius: 8 });
  sc.ring(grow(panelRect, -4), { t0: at.answer + 1.0, t1: at.answer + 1.9, radius: 8 });

  /* ----------------------------------------------------------- captions */
  const steps = { labels: ['Ask', 'Keep working', 'Answer ready', 'Paste into doc', 'Switch agent', 'Switch workspace'], times: [t0, at.video, at.answer, at.doc, at.agent, at.prodTab] };
  sc.caps.add({ t0: L(0.3), t1: L(11.8), head: 'Ask Genie, then watch a video or get other work done.', steps });
  sc.caps.add({ t0: L(12.2), t1: L(18.9), head: 'Your answer is waiting in the side panel.', steps });
  sc.caps.add({ t0: L(20.6), t1: L(27.3), head: 'Copy answers straight into your doc.', steps });
  sc.caps.add({ t0: L(27.5), t1: t1 - 0.05, head: 'Switch workspaces and Genie Agents without leaving your work.', steps });
  return sc;
}
