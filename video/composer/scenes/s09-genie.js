// Scene 9 · Ask Genie: work while you wait (dark). The side panel stays docked while the active
// tab changes: (a) open it from the popup and ask in prod, (b) switch to a video tab while Genie
// works, (c) the answer lands with a subtle attention cue (chart, table, SQL), (d) copy the answer
// and the table into a doc tab, (e) switch Genie Agent, (f) switch workspace; the page follows.
// Page and panel captures are paired as in the manifest (extra.pairing) and cross-fade
// independently. Docked pages are 1180 px wide; the 420 px panel fills the rest of the window.
import { productScene, crossStack, popup, focusRect, E, prog, el } from './product.js';
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
  const W = 1600, H = (firstPage || { vh: 1000 }).vh, PW = 420, DX = W - PW; // docked page width 1180
  const win = browserWindow(sc.world, { theme: 'dark', w: W, h: H, tabs, active: 0 });
  sc.world.insertBefore(win.el, sc.world.firstChild);
  sc.setWindow(win);
  const panelEl = el('div', 'abs', win.frame, { top: win.CH + 'px', width: PW + 1 + 'px', height: H + 'px', overflow: 'hidden', background: 'var(--bg)', borderLeft: '1px solid var(--line2)', isolation: 'isolate', zIndex: 3 });
  const panelRect = { x: DX, y: win.CH, w: PW + 1, h: H };
  const PR = (st, hints, not) => { const b = st ? sc.Bq(st, hints, not) : null; return b ? { x: DX + 1 + b.x, y: win.CH + b.y, w: b.w, h: b.h } : null; };
  const GR = (st, hints, not) => { const b = st ? sc.Bq(st, hints, not) : null; return b ? win.pageRect(b) : null; };
  const tabRect = (i) => { const c = win.tabCenter(i); return { x: c.x - 60, y: c.y - 10, w: 120, h: 20 }; };

  /* ----------------------------------------------------------- schedule */
  const pages = [], pSched = [], tabSched = [];
  const pageAt = (t, st, tab, d = 0.12) => { if (!st) return; pages.push(st); pSched.push({ t, i: pages.length - 1, d }); if (tab != null) tabSched.push({ t, tab }); };
  const panels = [], qSched = [];
  const panelAt = (t, st, d = 0.14) => { if (!st) return; panels.push(st); qSched.push({ t, i: panels.length - 1, d }); };
  const cur = [];
  const click = (t, r, opts = {}) => { if (!r) return false; const fx = opts.fx != null ? opts.fx : 0.5, fy = opts.fy != null ? opts.fy : 0.5; cur.push({ t, x: r.x + r.w * fx, y: r.y + r.h * fy, click: opts.click !== false }); return true; };
  const move = (t, x, y) => cur.push({ t, x, y });

  // (a) 0–5 · open the panel from the popup and ask in prod.
  const tOpen = L(1.15);
  pageAt(-1e9, firstPage, 0);
  if (G.full) pageAt(tOpen + 0.2, G.prod, 0, 0.25);
  panelAt(-1e9, P['01']);
  move(L(0.25), W * 0.6, win.CH + H * 0.55);
  click(L(0.55), { x: win.icon.x - 4, y: win.icon.y - 4, w: 8, h: 8 });
  const pop = askPop ? popup(sc, win, [askPop], [{ t: -1e9, i: 0 }], { open: L(0.62), close: tOpen }) : null;
  const askBtn = pop && pop.at(askPop, sc.Bq(askPop, ['ask-genie'], []));
  click(L(1.05), askBtn);
  const composer = PR(P['01'], ['composer'], []);
  click(L(2.0), PR(P['01'], ['question'], []) || composer, { fx: 0.3 });
  panelAt(L(2.15), P['02'], 0.2);
  click(L(3.0), PR(P['02'], ['send'], []));
  panelAt(L(3.1), P['03'], 0.18);
  const turn = union(PR(P['03'], ['last-turn'], []), PR(P['03'], ['last-chip'], []));
  // (b) 5–9 · another tab: the video keeps playing, the panel keeps working.
  click(L(5.1), tabRect(1));
  pageAt(L(5.15), G.v1, 1, 0.15);
  panelAt(L(5.15), P['04'], 0.15);
  const player = GR(G.v1, ['player'], []);
  if (player) move(L(6.2), player.x + player.w * 0.55, player.y + player.h * 0.62);
  pageAt(L(8.4), G.v2, 1, 0.4);
  // (c) 9–13 · the answer lands in the panel while the video tab is active.
  panelAt(L(9.0), P['05'], 0.45);
  const ansArea = union(PR(P['05'], ['last-answer-text'], []), PR(P['05'], ['last-chart'], []));
  const bar = PR(P['05'], ['first-bar'], []);
  if (bar && P['05b']) { click(L(10.3), bar, { fx: 0.7, click: false }); panelAt(L(10.35), P['05b'], 0.15); }
  const seg = PR(P['05'], ['last-segmented'], []);
  if (click(L(11.2), seg, { fx: 0.75 })) panelAt(L(11.25), P['06'], 0.2);
  if (click(L(12.1), PR(P['06'], ['last-sql'], []), { fx: 0.25 })) panelAt(L(12.15), P['07'], 0.25);
  const sqlBox = PR(P['07'], ['sql-code'], []);
  // (d) 13–17 · copy the answer and the table into the doc.
  click(L(13.4), tabRect(2));
  pageAt(L(13.45), G.d0, 2, 0.15);
  const menuBtn = PR(P['07'], ['last-menu'], ['list']) || PR(P['05'], ['last-menu'], ['list']);
  if (click(L(14.0), menuBtn)) panelAt(L(14.05), P['08'], 0.12);
  if (click(L(14.55), PR(P['08'], ['copy-answer'], []))) panelAt(L(14.6), P['09'], 0.12);
  const paste1 = GR(G.d1, ['paste-1', 'paste1'], []);
  if (click(L(15.15), paste1, { fx: 0.2, fy: 0.15 })) pageAt(L(15.25), G.d1, 2, 0.3);
  if (click(L(15.8), menuBtn)) panelAt(L(15.85), P['08'], 0.12);
  if (click(L(16.3), PR(P['08'], ['copy-table'], []))) panelAt(L(16.35), P['10'], 0.12);
  const appendix = GR(G.d1, ['appendix'], []);
  if (click(L(16.75), appendix, { fx: 0.2, fy: 0.8 })) pageAt(L(16.85), G.d2, 2, 0.3);
  const paste2 = GR(G.d2, ['paste-2', 'paste2'], []);
  // (e) 17–20 · switch Genie Agent: Platform ops → Revenue analytics.
  const agentSel = PR(P['10'] || P['05'], ['agent-select'], []);
  if (click(L(17.5), agentSel, { fx: 0.6 })) panelAt(L(17.6), P['11'], 0.14);
  panelAt(L(18.15), P['12'], 0.2);
  if (click(L(18.7), PR(P['12'], ['send'], []))) panelAt(L(18.8), P['13'], 0.2);
  const kpis = PR(P['13'], ['kpis'], []);
  // (f) 20–24 · switch workspace: northpeak-analytics; the page follows (blue top bar).
  click(L(20.1), tabRect(0));
  pageAt(L(20.15), G.prod, 0, 0.15);
  const wsSel = PR(P['13'] || P['11'], ['workspace-select'], []);
  if (click(L(20.7), wsSel, { fx: 0.6 })) panelAt(L(20.8), P['14'], 0.14);
  pageAt(L(20.9), G.ana, 0, 0.3);
  if (click(L(21.5), PR(P['14'], ['send'], []))) panelAt(L(21.6), P['15'], 0.2);
  panelAt(L(22.4), P['16'], 0.25);
  const line = union(PR(P['16'], ['last-answer-text'], []), PR(P['16'], ['last-chart'], []));
  move(L(23.2), DX - 140, win.CH + H * 0.62);

  const pageStack = crossStack(win.content, pages, pSched);
  const panelStack = crossStack(panelEl, panels, qSched);
  sc.add((t) => {
    pageStack.update(t);
    panelStack.update(t);
    // The panel slides in from the right edge as Ask Genie opens it, then stays docked.
    const o = askPop ? E.camera(prog(t, tOpen, tOpen + 0.55)) : 1;
    panelEl.style.left = (W - (PW + 1) * o).toFixed(3) + 'px';
    panelEl.style.display = o > 0 ? '' : 'none';
    let tab = 0;
    for (const s of tabSched) if (t >= s.t) tab = s.tab;
    win.setActive(tab);
    win.setTab(0, G.ana && t >= L(20.9) ? { title: wsName(anaHost), host: anaHost } : { title: wsName(prodHost), host: prodHost });
  });
  cur.sort((a, b) => a.t - b.t);
  sc.cursor(cur, { vanish: L(23.6) });

  /* ------------------------------------------------------------- camera */
  // Full window to establish each tab change; push-ins on the panel's question, answer, table
  // and SQL, on the doc's pasted blocks, and on the agent and workspace switches.
  const full = sc.full();
  const pv = (r, k = 1.6, minW = 520) => sc.focus(focusRect(grow(r, 30, 30), minW, 0), { k });
  const upper = { x: panelRect.x, y: panelRect.y, w: PW, h: H * 0.55 };
  const lower = { x: panelRect.x, y: panelRect.y + H * 0.45, w: PW, h: H * 0.55 };
  const withPanel = (r) => union(r, { x: panelRect.x + PW - 10, y: r.y, w: 10, h: r.h });
  sc.cam.set(full)
    .to(L(1.45), 1.1, pv(composer ? grow(composer, 0, 200) : lower, 1.7))
    .to(L(3.2), 0.9, pv(turn ? grow(turn, 0, 120) : upper, 1.8))
    .to(L(4.3), 0.9, full)
    .to(L(5.9), 2.6, sc.focus({ x: 0, y: 0, w: win.W, h: win.H }, { k: 1.06 }), E.inOutCubic)
    .to(L(9.3), 1.2, pv(ansArea || upper, 1.75))
    .to(L(11.95), 0.8, pv(sqlBox || ansArea || upper, 1.75))
    .to(L(12.95), 0.8, full)
    .to(L(14.95), 1.0, paste1 ? sc.focus(grow(withPanel(paste1), 20, 60), { k: 1.3 }) : full)
    .to(L(16.55), 0.8, paste2 ? sc.focus(grow(withPanel(paste2), 20, 60), { k: 1.3 }) : full)
    .to(L(17.2), 0.8, pv(upper, 1.8))
    .to(L(18.8), 0.9, pv(kpis || upper, 1.8))
    .to(L(19.85), 0.8, full)
    .to(L(21.85), 1.0, pv(line || upper, 1.75))
    .to(L(23.0), 0.9, full);

  // (c) attention cue: two soft pulses around the docked panel as the answer lands.
  sc.ring(grow(panelRect, -4), { t0: L(9.05), t1: L(10.0), radius: 8 });
  sc.ring(grow(panelRect, -4), { t0: L(10.0), t1: L(11.0), radius: 8 });
  if (kpis) sc.ring(kpis, { t0: L(19.1), t1: L(19.9) });

  /* ----------------------------------------------------------- captions */
  sc.caps.add({ t0: L(0.3), t1: L(8.9), eyebrow: '07 · Ask Genie', head: 'Ask Genie, then watch a video or get other work done.' });
  sc.caps.add({ t0: L(9.1), t1: L(12.95), eyebrow: '07 · Ask Genie', head: 'Your answer is waiting in the side panel.' });
  sc.caps.add({ t0: L(13.1), t1: L(16.95), eyebrow: '07 · Ask Genie', head: 'Copy answers straight into your doc.' });
  sc.caps.add({ t0: L(17.1), t1: t1 - 0.05, eyebrow: '07 · Ask Genie', head: 'Switch workspaces and Genie Agents without leaving your work.' });
  return sc;
}
