// Motion-graphics-only scenes: 1 hook, 2 reveal, 12 security and privacy, 13 call to action.
// The navy panel and wave lines are drawn by the background canvas (lib/waves.js); these scenes
// add type, the icon mark build and the security points on top.
import { E, clamp, prog, env, ep, lerp } from '../lib/ease.js';
import { el, op, show, kinetic, iconMark, svg, LINE_ICONS } from '../lib/kit.js';

const ACCENT = '#5B8CFF';
const SUB = '#C7D5FF';

/* ---------------------------------------------------------------- 1 · hook */

export function hook(ctx, { t0, t1 }) {
  const layer = el('div', 'layer', ctx.root);
  const a = kinetic(layer, [
    { text: 'Your' }, { text: 'Databricks' }, { text: 'bill' }, { br: true },
    { text: "shouldn't" }, { text: 'be' }, { text: 'a' }, { text: 'mystery.', color: ACCENT },
  ], { size: 112, stagger: 0.075, dur: 1.0, style: { left: '150px', top: '268px' } });
  const b = kinetic(layer, [
    { text: 'Spend' }, { text: 'hides' }, { text: 'across' }, { br: true },
    { text: 'jobs,', color: SUB }, { text: 'warehouses,', color: SUB }, { text: 'queries', color: SUB }, { text: 'and' }, { text: 'Genie.', color: SUB },
  ], { size: 84, stagger: 0.085, dur: 0.95, style: { left: '150px', top: '300px' } });
  return {
    t0, t1, pre: 0, post: 0.1, layer,
    update(t) {
      const ta = t0 + 0.35;
      a.update(t, ta);
      const ax = E.exit(prog(t, t0 + 2.55, t0 + 2.95));
      op(a.el, t < t0 + 2.95 ? 1 - ax : 0);
      a.el.style.transform = `translateY(${(-34 * ax).toFixed(3)}px)`;
      const tb = t0 + 3.0;
      b.update(t, tb);
      const bx = E.exit(prog(t, t1 - 0.55, t1 - 0.1));
      op(b.el, t >= tb - 0.05 && t < t1 - 0.1 ? 1 - bx : 0);
      b.el.style.transform = `translateY(${(-30 * bx).toFixed(3)}px)`;
    },
  };
}

/* -------------------------------------------------------------- 2 · reveal */

export function reveal(ctx, { t0, t1 }) {
  const layer = el('div', 'layer', ctx.root);
  const glow = el('div', 'abs', layer, { width: '1100px', height: '1100px', borderRadius: '50%', background: 'radial-gradient(closest-side, rgba(91,140,255,0.26), rgba(91,140,255,0.08) 55%, rgba(91,140,255,0) 100%)' });
  const S0 = 184, S1 = 128;
  const holder = el('div', 'abs', layer, { width: S0 + 'px', height: S0 + 'px', transformOrigin: '0 0' });
  const icon = iconMark(holder, S0);
  const word = el('div', 'kt abs', layer, { fontSize: '92px', letterSpacing: '-0.04em', color: '#F5F5F4' });
  const wspans = [];
  [['Lakeline', '#F5F5F4'], ['for', SUB], ['Databricks', SUB]].forEach(([w, c], i) => {
    const wrap = el('span', 'w', word);
    const s = el('span', null, wrap, { color: c });
    s.textContent = w;
    wspans.push(s);
    if (i < 2) word.appendChild(document.createTextNode(' '));
  });
  const tag = el('div', 'abs', layer, { fontSize: '36px', fontWeight: 500, color: SUB, letterSpacing: '-0.01em', whiteSpace: 'nowrap' });
  tag.textContent = 'Costs, runs and Genie answers, right where you work.';
  let geo = null;
  function measure() {
    const ww = word.offsetWidth, wh = word.offsetHeight;
    const gap = 40;
    const total = S1 + gap + ww;
    const gx = 960 - total / 2;
    const cy = 452;
    geo = { ww, wh, gx, cy, wordX: gx + S1 + gap, tagW: tag.offsetWidth };
  }
  return {
    t0, t1, pre: 0, post: 0.2, layer,
    update(t) {
      if (!geo) measure();
      const fadeOut = E.exit(prog(t, t1 - 0.65, t1 - 0.1));
      layer.style.opacity = (1 - fadeOut).toFixed(4);
      layer.style.transform = `translateY(${(-36 * fadeOut).toFixed(3)}px)`;
      // Glow breathes in behind the icon.
      const gp = ep(t, t0 - 0.2, 1.6, E.outCubic);
      const move = E.camera(prog(t, t0 + 1.35, t0 + 2.25));
      const size = lerp(S0, S1, move);
      const cx = lerp(960, geo.gx + S1 / 2, move);
      const cy = lerp(500, geo.cy, move);
      glow.style.opacity = (gp * 0.95).toFixed(4);
      glow.style.transform = `translate(${(cx - 550).toFixed(2)}px, ${(cy - 550).toFixed(2)}px) scale(${lerp(0.7, 1, gp).toFixed(4)})`;
      // Icon: the square lands with a small overshoot, then the bars grow left to right.
      const sp = prog(t, t0 + 0.02, t0 + 0.72);
      const sq = sp <= 0 ? 0.5 : lerp(0.5, 1, E.outBack(sp, 1.1));
      const bars = [0, 1, 2].map((i) => {
        const p = prog(t, t0 + 0.42 + i * 0.13, t0 + 1.02 + i * 0.13);
        return i === 2 ? (p <= 0 ? 0 : E.outBack(p, 1.6)) : E.outExpo(p);
      });
      icon.set(sq, clamp(sp * 3), bars);
      const k = size / S0;
      holder.style.transform = `translate(${(cx - size / 2).toFixed(3)}px, ${(cy - size / 2).toFixed(3)}px) scale(${k.toFixed(5)})`;
      // Wordmark and tagline.
      word.style.left = geo.wordX + 'px';
      word.style.top = geo.cy - geo.wh / 2 - 4 + 'px';
      wspans.forEach((s, i) => {
        const p = ep(t, t0 + 1.75 + i * 0.09, 1.0);
        s.style.transform = `translateY(${((1 - p) * 105).toFixed(3)}%)`;
      });
      const tp = ep(t, t0 + 2.55, 1.0);
      tag.style.left = 960 - geo.tagW / 2 + 'px';
      tag.style.top = geo.cy + 112 + (1 - tp) * 18 + 'px';
      tag.style.opacity = tp.toFixed(4);
    },
  };
}

/* ----------------------------------------------------- 12 · security, privacy */

export const SECURITY_POINTS = [
  ['database', 'Read-only SQL on your own system tables.'],
  ['route', 'Talks only to your workspace, with no Lakeline servers or analytics.'],
  ['session', 'Sign-in and Genie chats live in your browser session and clear when it closes.'],
  ['history', 'Your full chat history stays in Genie in Databricks.'],
  ['key', 'Access granted one workspace at a time.'],
];

export function security(ctx, { t0, t1 }) {
  const layer = el('div', 'layer', ctx.root);
  const eb = el('div', 'eyebrow abs', layer, { left: '120px', top: '112px', fontSize: '18px', color: '#8FB0FF' });
  eb.textContent = 'Security and privacy';
  const head = kinetic(layer, 'Nothing leaves your Databricks and your browser.', { size: 66, stagger: 0.05, dur: 0.9, tracking: -0.03, style: { left: '120px', top: '150px' } });
  const rows = SECURITY_POINTS.map(([icon, text], i) => {
    const y = 318 + i * 116;
    const row = el('div', 'abs', layer, { left: '120px', top: y + 'px', width: '1380px', height: '116px' });
    const line = el('div', 'abs', row, { left: '0px', top: '0px', width: '1380px', height: '1px', background: 'rgba(143,176,255,0.28)', transformOrigin: '0 0' });
    const tile = el('div', 'abs', row, { left: '0px', top: '30px', width: '56px', height: '56px', borderRadius: '14px', border: '1px solid rgba(143,176,255,0.45)', background: 'rgba(91,140,255,0.10)', color: '#8FB0FF', display: 'flex', alignItems: 'center', justifyContent: 'center' });
    const ic = svg(LINE_ICONS[icon], tile);
    ic.setAttribute('width', '28');
    ic.setAttribute('height', '28');
    const tx = el('div', 'abs', row, { left: '88px', top: '38px', fontSize: '34px', fontWeight: 500, color: '#F5F5F4', letterSpacing: '-0.012em', whiteSpace: 'nowrap' });
    tx.textContent = text;
    return { row, line, tile, tx };
  });
  return {
    t0, t1, pre: 0, post: 0.05, layer,
    update(t) {
      const out = E.exit(prog(t, t1 - 0.45, t1));
      layer.style.opacity = (1 - out).toFixed(4);
      const ep0 = ep(t, t0 + 0.25, 0.8);
      eb.style.opacity = ep0.toFixed(4);
      eb.style.transform = `translateX(${((1 - ep0) * -16).toFixed(3)}px)`;
      head.update(t, t0 + 0.35);
      rows.forEach((r, i) => {
        const ts = t0 + 1.35 + i * 0.5;
        const p = ep(t, ts, 0.9);
        r.line.style.transform = `scaleX(${E.camera(prog(t, ts - 0.1, ts + 0.8)).toFixed(5)})`;
        r.tile.style.opacity = p.toFixed(4);
        r.tile.style.transform = `scale(${lerp(0.7, 1, E.outBack(prog(t, ts, ts + 0.55), 1.3)).toFixed(5)})`;
        r.tx.style.opacity = p.toFixed(4);
        r.tx.style.transform = `translateX(${((1 - p) * -22).toFixed(3)}px)`;
      });
    },
  };
}

/* ------------------------------------------------------------------ 13 · CTA */

export function cta(ctx, { t0, t1, end }) {
  const layer = el('div', 'layer', ctx.root);
  const S = 128;
  const holder = el('div', 'abs', layer, { left: 960 - S / 2 + 'px', top: '226px', width: S + 'px', height: S + 'px' });
  const icon = iconMark(holder, S);
  const word = kinetic(layer, [{ text: 'Lakeline', color: '#F5F5F4' }, { text: 'for', color: SUB }, { text: 'Databricks', color: SUB }], { size: 84, stagger: 0.08, dur: 0.9, tracking: -0.04 });
  const btn = el('div', 'abs', layer, { padding: '0 44px', height: '76px', lineHeight: '76px', borderRadius: '999px', background: '#F5F5F4', color: '#0A0A0A', fontSize: '30px', fontWeight: 600, letterSpacing: '-0.01em', whiteSpace: 'nowrap' });
  btn.textContent = 'Add to Chrome';
  const fine = el('div', 'abs', layer, { fontSize: '22px', fontWeight: 400, color: '#A1A1AA', whiteSpace: 'nowrap' });
  fine.textContent = 'Independent project; not affiliated with Databricks, Inc.';
  let geo = null;
  return {
    t0, t1: end, pre: 0, post: 0, layer,
    update(t) {
      if (!geo) {
        geo = { ww: word.el.offsetWidth, bw: btn.offsetWidth, fw: fine.offsetWidth };
        word.el.style.left = 960 - geo.ww / 2 + 'px';
        word.el.style.top = '392px';
        btn.style.left = 960 - geo.bw / 2 + 'px';
        btn.style.top = '548px';
        fine.style.left = 960 - geo.fw / 2 + 'px';
        fine.style.top = '690px';
      }
      const sp = prog(t, t0 + 0.15, t0 + 0.8);
      const bars = [0, 1, 2].map((i) => E.outExpo(prog(t, t0 + 0.35 + i * 0.1, t0 + 0.9 + i * 0.1)));
      icon.set(sp <= 0 ? 0.6 : lerp(0.6, 1, E.outBack(sp, 1.1)), clamp(sp * 3), bars);
      word.update(t, t0 + 0.45);
      const bp = prog(t, t0 + 0.95, t0 + 1.6);
      btn.style.opacity = clamp(bp * 2.5).toFixed(4);
      btn.style.transform = `scale(${(bp <= 0 ? 0.9 : lerp(0.9, 1, E.outBack(bp, 1.4))).toFixed(5)})`;
      const fp = ep(t, t0 + 1.3, 0.9);
      fine.style.opacity = fp.toFixed(4);
      fine.style.transform = `translateY(${((1 - fp) * 10).toFixed(3)}px)`;
    },
  };
}
