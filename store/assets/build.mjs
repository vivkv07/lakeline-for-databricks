#!/usr/bin/env node
/*
 * Chrome Web Store images, composed from the REAL extension captures in dist/video/captures/
 * (run `npm run video:capture` first). The UI images are placed unmodified: scaled and cropped
 * only. Headlines, frames, the promo tile and the marquee use the house style (notes/STYLE.md).
 *
 *   npm run store:assets   (or: node store/assets/build.mjs)
 *
 * Writes store/assets/*.png at exact store sizes as 24-bit PNG without alpha:
 *   screenshot-light-1..5.png, screenshot-dark-1..5.png   1280×800
 *   promo-small-440x280.png                                440×280
 *   promo-marquee-1400x560.png                             1400×560
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CAP = path.join(ROOT, 'dist/video/captures');
const OUT = path.join(ROOT, 'store/assets');
const FONTS = pathToFileURL(path.join(ROOT, 'extension/fonts')).href;
const ICON = pathToFileURL(path.join(ROOT, 'extension/icons/icon-128.png')).href;

const T = {
  light: { bg: '#FFFFFF', text: '#0A0A0A', body: '#52525B', muted: '#6B6B74', line: '#E4E4E7', surface: '#F6F6F7', chrome: '#F2F2F4', pill: '#FFFFFF', accent: '#2F5BEA' },
  dark: { bg: '#000000', text: '#F5F5F4', body: '#A1A1AA', muted: '#8A8A93', line: '#232326', surface: '#0F0F10', chrome: '#141416', pill: '#0F0F10', accent: '#5B8CFF' },
};

const cap = (rel) => {
  const p = path.join(CAP, rel);
  if (!existsSync(p)) throw new Error('Missing capture ' + rel + ' (run npm run video:capture)');
  return pathToFileURL(p).href;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Deterministic wave lines (same family as the video's navy panel). */
function waves(w, h, n = 16) {
  let out = '';
  for (let i = 0; i < n; i++) {
    const base = h * 0.62 + i * (h * 0.018);
    const amp = h * 0.035 + i * 0.6;
    const ph = i * 0.38;
    let d = '';
    for (let x = 0; x <= w; x += 8) {
      const y = base + amp * Math.sin(x * (6 / w) + ph) + (h * 0.012) * Math.sin(x * (15 / w) + i);
      d += (x ? 'L' : 'M') + x + ' ' + y.toFixed(1);
    }
    out += `<path d="${d}" fill="none" stroke="${i % 3 === 0 ? '#7FA6FF' : '#5B8CFF'}" stroke-width="1.3" opacity="${(0.16 + 0.5 * (i / n)).toFixed(2)}"/>`;
  }
  return `<svg class="waves" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${out}</svg>`;
}

const baseCss = (t) => `
@font-face { font-family: Inter; font-weight: 400; src: url(${FONTS}/inter-latin-400-normal.woff2); }
@font-face { font-family: Inter; font-weight: 500; src: url(${FONTS}/inter-latin-500-normal.woff2); }
@font-face { font-family: Inter; font-weight: 600; src: url(${FONTS}/inter-latin-600-normal.woff2); }
@font-face { font-family: Inter; font-weight: 700; src: url(${FONTS}/inter-latin-700-normal.woff2); }
@font-face { font-family: Plex; font-weight: 500; src: url(${FONTS}/ibm-plex-mono-latin-500-normal.woff2); }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; background: ${t.bg}; color: ${t.text}; font-family: Inter, sans-serif; -webkit-font-smoothing: antialiased; overflow: hidden; }
.eyebrow { font: 500 12.5px/1 Plex, monospace; letter-spacing: .14em; text-transform: uppercase; color: ${t.accent}; }
.frame { position: absolute; border: 1px solid ${t.line}; border-radius: 12px; overflow: hidden; background: ${t.bg}; }
.bar { height: 32px; background: ${t.chrome}; border-bottom: 1px solid ${t.line}; display: flex; align-items: center; gap: 7px; padding: 0 12px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: ${t.line}; }
.addr { margin-left: 14px; height: 20px; border-radius: 999px; background: ${t.pill}; border: 1px solid ${t.line}; padding: 0 12px; font: 500 11px/20px Inter; color: ${t.muted}; min-width: 280px; }
.tab { margin-left: 12px; font: 500 11px/1 Inter; color: ${t.muted}; }
.content { position: relative; overflow: hidden; }
.content img { display: block; width: 100%; height: auto; }
.row { display: flex; height: 100%; }
`;

/** One 1280×800 screenshot: eyebrow + headline over a framed real capture (cropped from the top). */
function shot({ theme, eyebrow, headline, url = '', body }) {
  const t = T[theme];
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss(t)}
.head { position: absolute; left: 50px; right: 50px; top: 34px; }
.head h1 { margin-top: 12px; font-size: 33px; line-height: 1.12; font-weight: 650; letter-spacing: -0.02em; }
.brand { position: absolute; right: 50px; top: 30px; display: flex; align-items: center; gap: 8px; font: 600 13px/1 Inter; color: ${t.muted}; }
.brand img { width: 20px; height: 20px; border-radius: 5px; }
.frame.main { left: 50px; top: 128px; width: 1180px; height: 640px; }
.frame.main .content { height: 608px; }
.fine { position: absolute; left: 50px; right: 50px; bottom: 9px; font: 500 11px/1 Inter; color: ${t.muted}; }
</style></head><body>
<div class="head"><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(headline)}</h1></div>
<div class="brand"><img src="${ICON}" alt="">Lakeline for Databricks</div>
<div class="frame main"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>${url ? `<span class="addr">${esc(url)}</span>` : ''}</div>
<div class="content">${body}</div></div>
<p class="fine">Synthetic sample workspace and data. Independent project, not affiliated with Databricks, Inc.</p>
</body></html>`;
}

const img = (rel, style = '') => `<img src="${cap(rel)}" alt="" style="${style}">`;

/**
 * Show a region of a capture: x, y and w are CSS px of the captured page (DPR 2 source, so up to
 * about 2× zoom stays sharp). The region is scaled to fill the container width CW.
 */
function crop(rel, { x = 0, y = 0, w, natW = 1600 }, CW = 1180) {
  const k = CW / w;
  return `<div style="position:absolute;inset:0;overflow:hidden"><img src="${cap(rel)}" alt="" style="position:absolute;max-width:none;width:${(natW * k).toFixed(1)}px;left:${(-x * k).toFixed(1)}px;top:${(-y * k).toFixed(1)}px"></div>`;
}

/** Page and side panel side by side, as Chrome lays them out; pageX trims the page's left side. */
function docked(page, panel, { pageX = 0, y = 0 } = {}, CW = 1180) {
  const pageW = 1180 - pageX;
  const k = CW / (pageW + 420);
  return `<div style="position:absolute;inset:0;display:flex;overflow:hidden">
    <div style="position:relative;flex:none;width:${(pageW * k).toFixed(1)}px;overflow:hidden"><img src="${cap(page)}" alt="" style="position:absolute;max-width:none;width:${(1180 * k).toFixed(1)}px;left:${(-pageX * k).toFixed(1)}px;top:${(-y * k).toFixed(1)}px"></div>
    <div style="position:relative;flex:none;width:${(420 * k).toFixed(1)}px;overflow:hidden"><img src="${cap(panel)}" alt="" style="position:absolute;max-width:none;width:${(420 * k).toFixed(1)}px;left:0;top:${(-y * k).toFixed(1)}px"></div></div>`;
}

const PROD = 'northpeak-prod.cloud.databricks.com';

const SHOTS = [
  { file: 'screenshot-light-1.png', theme: 'light', eyebrow: 'Cost banner', headline: 'Your Databricks spend, right where you work.', url: PROD, body: crop('04-banner/light/02-banner-30d.png', { x: 0, y: 0, w: 1290 }) },
  { file: 'screenshot-light-2.png', theme: 'light', eyebrow: 'Run costs', headline: 'Every job run priced. Spikes stand out.', url: PROD + '/jobs', body: crop('05-run-costs/light/01-runs-list.png', { x: 250, y: 185, w: 1330 }) },
  { file: 'screenshot-light-3.png', theme: 'light', eyebrow: 'Sizing', headline: 'Know the hourly cost before you scale.', url: PROD + '/sql/warehouses', body: crop('06-queries-sizing/light/03-size-picker.png', { x: 240, y: 150, w: 1000 }) },
  { file: 'screenshot-light-4.png', theme: 'light', eyebrow: 'Cost Explorer', headline: 'See what drives spend, down to the job.', url: PROD, body: crop('07-explorer/light/03-top-drivers.png', { x: 245, y: 110, w: 1340 }) },
  { file: 'screenshot-light-5.png', theme: 'light', eyebrow: 'Workspace colors', headline: 'Dev, stage or prod? Know at a glance.', url: '', body: colorsTrio('light') },
  { file: 'screenshot-dark-1.png', theme: 'dark', eyebrow: 'Ask Genie', headline: 'Ask Genie in the side panel. Keep working.', url: PROD + '/jobs', body: docked('09-genie/dark/page-prod-jobs-docked.png', '09-genie/dark/panel-05-answer-bars.png', { pageX: 233, y: 40 }) },
  { file: 'screenshot-dark-2.png', theme: 'dark', eyebrow: 'Ask Genie', headline: 'Copy answers straight into your doc.', url: 'docs.example', body: docked('09-genie/dark/page-doc-2-table-docked.png', '09-genie/dark/panel-10-copied-table.png', { pageX: 20, y: 0 }) },
  { file: 'screenshot-dark-3.png', theme: 'dark', eyebrow: 'Cost Explorer', headline: 'Spot the spike day in seconds.', url: PROD, body: crop('07-explorer/dark/05-calendar-spike-hover.png', { x: 240, y: 40, w: 1030 }) },
  { file: 'screenshot-dark-4.png', theme: 'dark', eyebrow: 'Run monitor', headline: 'Runs and compute at a glance. Failures flagged.', url: PROD + '/jobs', body: monitorOverlay() },
  { file: 'screenshot-dark-5.png', theme: 'dark', eyebrow: 'Security and privacy', headline: 'Nothing leaves your Databricks workspace and your browser.', url: '', body: privacyCard() },
];

function colorsTrio(theme) {
  const t = T[theme];
  const strips = [
    ['northpeak-dev', '11-colors/light/21-colored-dev.png'],
    ['northpeak-stage', '11-colors/light/22-colored-stage.png'],
    ['northpeak-prod', '11-colors/light/23-colored-prod.png'],
  ];
  // Each strip shows the real top of the page (top bar + cost banner), cropped, at full width.
  return `<div style="padding:22px 26px;display:grid;gap:16px;background:${t.surface};height:100%">${strips
    .map(([name, rel]) => `<div style="border:1px solid ${t.line};border-radius:10px;overflow:hidden;background:${t.bg}">
      <div class="bar" style="height:28px"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="tab">${esc(name)}</span></div>
      <div style="height:124px;overflow:hidden">${img(rel, 'width:' + (1600 / 1240 * 100).toFixed(2) + '%;max-width:none')}</div></div>`)
    .join('')}</div>`;
}

function monitorOverlay() {
  return `<div style="position:relative;height:100%">${img('09-genie/dark/page-prod-jobs.png')}
  <div style="position:absolute;inset:0;background:rgba(0,0,0,.35)"></div>
  <div style="position:absolute;right:28px;top:22px;width:356px;border:1px solid #2A2A2E;border-radius:12px;overflow:hidden;background:#000;box-shadow:0 18px 50px rgba(0,0,0,.55)">
    <div class="bar" style="height:26px"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="tab">Lakeline · Run monitor</span></div>
    ${img('10-monitor/dark/02-monitor-failed.png', 'width:100%')}
  </div></div>`;
}

function privacyCard() {
  const points = [
    'Read-only SQL on your own system tables.',
    'Talks only to your workspace. No Lakeline servers, no analytics.',
    'Sign-in stays in this browser. Genie chats clear when it closes.',
    'Your full chat history stays in Genie in Databricks.',
    'Access is granted one workspace at a time.',
  ];
  return `<div style="position:relative;height:100%;background:#0B1A3A;overflow:hidden">${waves(1180, 616)}
  <ul style="position:absolute;left:64px;top:70px;right:64px;list-style:none;display:grid;gap:22px">${points
    .map((p) => `<li style="display:flex;gap:16px;align-items:baseline;font:500 22px/1.35 Inter;color:#F5F5F4"><span style="flex:none;width:10px;height:10px;border-radius:50%;background:#8FB0FF;transform:translateY(-3px)"></span>${esc(p)}</li>`)
    .join('')}</ul></div>`;
}

function promo({ w, h, big }) {
  const t = T.dark;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss(t)}
body { background: #0B1A3A; }
.waves { position: absolute; left: 0; top: 0; }
.wrap { position: absolute; left: ${big ? 88 : 30}px; top: ${big ? 150 : 52}px; }
.mark { width: ${big ? 76 : 50}px; height: ${big ? 76 : 50}px; border-radius: ${big ? 18 : 12}px; display: block; }
.name { margin-top: ${big ? 26 : 16}px; font: 700 ${big ? 64 : 38}px/1 Inter; letter-spacing: -0.03em; color: #F5F5F4; }
.sub { margin-top: ${big ? 12 : 8}px; font: 500 ${big ? 26 : 16}px/1.2 Inter; color: #C7D5FF; }
.tag { margin-top: ${big ? 22 : 12}px; font: 500 ${big ? 15 : 10.5}px/1 Plex, monospace; letter-spacing: .14em; text-transform: uppercase; color: #8FB0FF; }
.shot { position: absolute; right: 70px; top: 70px; width: 640px; height: 420px; border: 1px solid #2E4A85; border-radius: 14px; overflow: hidden; background: #000; box-shadow: 0 24px 60px rgba(0,0,0,.45); }
</style></head><body>${waves(w, h, big ? 22 : 14)}
<div class="wrap"><img class="mark" src="${ICON}" alt=""><p class="name">Lakeline</p><p class="sub">for Databricks</p><p class="tag">Costs · Runs · Genie</p></div>
${big ? `<div class="shot"><div style="position:absolute;inset:0">${docked('09-genie/dark/page-prod-jobs-docked.png', '09-genie/dark/panel-05-answer-bars.png', { pageX: 830, y: 120 }, 640)}</div></div>` : ''}
</body></html>`;
}

async function render(page, html, file, w, h, dir) {
  const htmlPath = path.join(dir, file + '.html');
  writeFileSync(htmlPath, html);
  await page.setViewportSize({ width: w, height: h });
  await page.goto(pathToFileURL(htmlPath).href);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
  });
  const raw = path.join(dir, file);
  await page.screenshot({ path: raw, type: 'png' });
  // Store requirement: 24-bit PNG without alpha.
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-pix_fmt', 'rgb24', path.join(OUT, file)]);
}

const dir = mkdtempSync(path.join(tmpdir(), 'lakeline-store-'));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const s of SHOTS) await render(page, shot(s), s.file, 1280, 800, dir);
  await render(page, promo({ w: 440, h: 280, big: false }), 'promo-small-440x280.png', 440, 280, dir);
  await render(page, promo({ w: 1400, h: 560, big: true }), 'promo-marquee-1400x560.png', 1400, 560, dir);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log('Wrote ' + (SHOTS.length + 2) + ' images to store/assets/');
