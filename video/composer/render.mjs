#!/usr/bin/env node
// Lakeline launch video renderer.
//
// Serves the composer (video/composer/), the fonts (extension/fonts/), the real captures
// (dist/video/captures/) and dev placeholders, drives Playwright Chromium (Chrome for Testing, new
// headless) at 1920×1080 CSS with deviceScaleFactor 2, and steps a virtual clock frame by frame:
// performance.now, Date.now and requestAnimationFrame are replaced in the page, and every frame is
// computed from t = frame / 30 by window.__composer.seek(t). Frames are captured with CDP
// Page.captureScreenshot as JPEG (quality ≥ 95) and piped straight into ffmpeg (image2pipe), so no
// frame PNGs touch the disk.
//
// Usage:
//   node video/composer/render.mjs                 full 4K + 1080p with music (final deliverables)
//   node video/composer/render.mjs --preview       960×540, every 2nd frame (15 fps), music optional
//   node video/composer/render.mjs --from 62 --to 86 [--preview]   spot render of a time range
//   node video/composer/render.mjs --stills 3,15,24 --out-dir /tmp/stills [--preview]  PNG stills
//   node video/composer/render.mjs --info          load captures and print sources and warnings
//   node video/composer/render.mjs --serve         dev server; open the printed URL (?dev=1&t=12)
// Options: --workers N (parallel pages, default 4), --crf 15, --quality 95, --no-music,
//   --allow-placeholder (write the final file names even with placeholders), --port N,
//   --placeholder-root DIR (env LAKELINE_PLACEHOLDER_ROOT), --keep (keep the video-only file),
//   --review (stills only: placeholder tag without the full-frame watermark grid, for layout review).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const OUT = path.join(REPO, 'dist/video');
const CAPTURES = path.join(OUT, 'captures');
const MUSIC = path.join(OUT, 'music/lakeline-theme.wav');
const MARKERS = path.join(OUT, 'music/markers.json');
const FONTS = path.join(REPO, 'extension/fonts');
const DEFAULT_PH = '/private/tmp/claude-501/-Users-vivekkv-dbx-ext/1ec54e49-6a51-4764-b576-143b4dfd1ee2/scratchpad';

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const a = { workers: 4, crf: 15, quality: 95, port: 0 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    switch (k) {
      case '--preview': a.preview = true; break;
      case '--from': a.from = parseFloat(v()); break;
      case '--to': a.to = parseFloat(v()); break;
      case '--stills': a.stills = v().split(',').map(Number).filter(Number.isFinite); break;
      case '--out-dir': a.outDir = path.resolve(v()); break;
      case '--info': a.info = true; break;
      case '--serve': a.serve = true; break;
      case '--workers': a.workers = Math.max(1, parseInt(v(), 10)); break;
      case '--crf': a.crf = parseFloat(v()); break;
      case '--quality': a.quality = Math.max(95, Math.min(100, parseInt(v(), 10))); break;
      case '--port': a.port = parseInt(v(), 10); break;
      case '--no-music': a.noMusic = true; break;
      case '--allow-placeholder': a.allowPlaceholder = true; break;
      case '--placeholder-root': a.phRoot = path.resolve(v()); break;
      case '--keep': a.keep = true; break;
      case '--review': a.review = true; break;
      case '-h': case '--help': a.help = true; break;
      default: throw new Error('unknown option ' + k);
    }
  }
  if ((a.crf > 16 || a.crf < 14) && !a.preview) throw new Error('--crf must be within 14–16 for deliverables');
  a.phRoot = a.phRoot || process.env.LAKELINE_PLACEHOLDER_ROOT || DEFAULT_PH;
  return a;
}

/* ---------------------------------------------------------------- server */

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

function scanCaptures() {
  const out = [];
  if (!fs.existsSync(CAPTURES)) return out;
  const walk = (dir, depth) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 2) walk(p, depth + 1);
      else if (e.isFile() && e.name === 'manifest.json') out.push(path.relative(CAPTURES, p).split(path.sep).join('/'));
    }
  };
  walk(CAPTURES, 0);
  return out.sort();
}

function startServer(phRoot, port) {
  const roots = [['/fonts/', FONTS], ['/captures/', CAPTURES], ['/ph-img/', phRoot], ['/', HERE]];
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (url === '/__scan') {
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
      res.end(JSON.stringify(scanCaptures()));
      return;
    }
    const [prefix, root] = roots.find(([p]) => url.startsWith(p));
    let rel = url.slice(prefix.length) || 'index.html';
    const file = path.resolve(root, rel);
    if (!file.startsWith(path.resolve(root) + path.sep) && file !== path.resolve(root)) { res.writeHead(403); res.end(); return; }
    if (prefix === '/ph-img/' && !/\.(png|jpe?g|webp)$/i.test(file)) { res.writeHead(403); res.end(); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/* ----------------------------------------------------------- virtual clock */

// Runs before any page script: time only advances when the renderer says so.
const VCLOCK = () => {
  const realRAF = window.requestAnimationFrame.bind(window);
  const EPOCH = Date.UTC(2026, 9, 15, 9, 0, 0);
  let nowMs = 0;
  let id = 0;
  const queue = new Map();
  const RealDate = Date;
  performance.now = () => nowMs;
  Date.now = () => EPOCH + nowMs;
  function VDate(...a) {
    if (!new.target) return new RealDate(EPOCH + nowMs).toString();
    return Reflect.construct(RealDate, a.length ? a : [EPOCH + nowMs], new.target);
  }
  VDate.prototype = RealDate.prototype;
  VDate.now = () => EPOCH + nowMs;
  VDate.UTC = RealDate.UTC;
  VDate.parse = RealDate.parse;
  window.Date = VDate;
  window.requestAnimationFrame = (cb) => { queue.set(++id, cb); return id; };
  window.cancelAnimationFrame = (k) => queue.delete(k);
  window.__vclock = {
    set(ms) {
      nowMs = ms;
      const cbs = [...queue.values()];
      queue.clear();
      for (const cb of cbs) { try { cb(nowMs); } catch (e) { console.error(e); } }
    },
    /** Resolve after the compositor has produced a frame with the latest DOM. */
    frame: () => new Promise((r) => realRAF(() => realRAF(r))),
  };
};

/* --------------------------------------------------------------- browser */

async function openPage(browser, base, dsf, query = '') {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: dsf, colorScheme: 'dark', reducedMotion: 'no-preference' });
  await context.addInitScript(VCLOCK);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  // Missing captures (404) are expected before delivery; the composer reports them itself.
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) console.error('[page console]', m.text()); });
  await page.goto(base + '/index.html?render=1' + query, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__composer && window.__composer.ready, null, { timeout: 30000 });
  await page.evaluate(() => window.__composer.ready);
  const err = await page.evaluate(() => window.__composerError || null);
  if (err) throw new Error('composer failed to boot: ' + err);
  const cdp = await context.newCDPSession(page);
  return { context, page, cdp, dsf };
}

async function renderFrame(w, t, { format = 'jpeg', quality = 95 } = {}) {
  await w.page.evaluate(async (tt) => {
    window.__vclock.set(tt * 1000);
    window.__composer.seek(tt);
    await window.__vclock.frame();
  }, t);
  // Playwright applies the device-metrics override on its own CDP session, so this session's
  // capture is asked for the device scale explicitly (verified pixel-identical to page.screenshot).
  const clip = { x: 0, y: 0, width: 1920, height: 1080, scale: w.dsf };
  const opts = format === 'jpeg' ? { format: 'jpeg', quality, fromSurface: true, captureBeyondViewport: false, clip } : { format: 'png', fromSurface: true, captureBeyondViewport: false, clip };
  const { data } = await w.cdp.send('Page.captureScreenshot', opts);
  return Buffer.from(data, 'base64');
}

/* ---------------------------------------------------------------- ffmpeg */

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'pipe'], maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${label || cmd} failed (${r.status}):\n${String(r.stderr).slice(-3000)}`);
}

const COLOR = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv'];
const X264 = (crf, preset) => ['-c:v', 'libx264', '-profile:v', 'high', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709'];

function ffprobe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,avg_frame_rate,color_range,color_space,color_primaries,color_transfer,sample_rate,channels,bit_rate,nb_frames:format=duration,size,bit_rate', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffprobe failed: ' + r.stderr);
  return JSON.parse(r.stdout);
}

function describe(file) {
  const j = ffprobe(file);
  const lines = [path.relative(REPO, file)];
  for (const s of j.streams) {
    if (s.codec_type === 'video') lines.push(`  video: ${s.codec_name} ${s.profile} ${s.width}x${s.height} ${s.pix_fmt} ${s.r_frame_rate} fps, range ${s.color_range}, matrix ${s.color_space}, primaries ${s.color_primaries}, trc ${s.color_transfer}, frames ${s.nb_frames}`);
    if (s.codec_type === 'audio') lines.push(`  audio: ${s.codec_name} ${s.profile || ''} ${s.sample_rate} Hz ${s.channels} ch ${Math.round((s.bit_rate || 0) / 1000)} kb/s`);
  }
  lines.push(`  duration ${(+j.format.duration).toFixed(3)} s, size ${(j.format.size / 1048576).toFixed(1)} MiB, ${Math.round(j.format.bit_rate / 1000)} kb/s`);
  return lines.join('\n');
}

/* ---------------------------------------------------------------- markers */

function checkMarkers(timeline) {
  if (!fs.existsSync(MARKERS)) { console.log('music markers: none yet (' + path.relative(REPO, MARKERS) + ')'); return; }
  let j;
  try { j = JSON.parse(fs.readFileSync(MARKERS, 'utf8')); } catch (e) { console.log('music markers: unreadable: ' + e.message); return; }
  const times = [];
  const visit = (v, key) => {
    if (typeof v === 'number' && /start|time|t$|^t\d*$|at|sec|^\d+$/i.test(String(key))) times.push({ key: String(key), t: v });
    else if (Array.isArray(v)) v.forEach((x, i) => visit(x, key + '[' + i + ']'));
    else if (v && typeof v === 'object') {
      const t = v.start ?? v.time ?? v.t ?? v.at ?? v.seconds;
      if (typeof t === 'number') times.push({ key: v.name || v.label || v.section || v.id || key, t });
      else for (const [k, x] of Object.entries(v)) visit(x, k);
    }
  };
  visit(j, 'root');
  console.log('music markers vs timeline (scene start):');
  for (const s of timeline) {
    const near = times.reduce((b, m) => (!b || Math.abs(m.t - s.t0) < Math.abs(b.t - s.t0) ? m : b), null);
    const d = near ? near.t - s.t0 : NaN;
    const flag = Number.isFinite(d) && Math.abs(d) <= 1 / 30 + 1e-6 ? 'ok' : 'OFF';
    console.log(`  ${String(s.n).padStart(2)} ${s.key.padEnd(9)} ${s.t0.toFixed(2).padStart(7)}  marker ${near ? near.t.toFixed(3).padStart(8) + ' (' + near.key + ')' : 'n/a'}  ${Number.isFinite(d) ? (d >= 0 ? '+' : '') + d.toFixed(3) + ' s' : ''} ${flag}`);
  }
}

/* ------------------------------------------------------------------ main */

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 25).join('\n')); return; }
  const server = await startServer(a.phRoot, a.port);
  const base = 'http://127.0.0.1:' + server.address().port;
  if (a.serve) {
    console.log(`composer: ${base}/index.html?dev=1   (seek with &t=SECONDS)`);
    return; // keep serving
  }
  const dsf = a.preview ? 1 : 2;
  const browser = await chromium.launch({
    channel: 'chromium', headless: true,
    args: ['--force-color-profile=srgb', '--hide-scrollbars', '--disable-lcd-text', '--font-render-hinting=none', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  try {
    // --review (stills only) shows the placeholder tag without the full-frame watermark grid.
    const first = await openPage(browser, base, dsf, a.review && a.stills ? '&wm=tag' : '');
    const info = await first.page.evaluate(() => window.__composer.info());
    console.log(`browser: ${browser.version()} · stage 1920×1080 CSS · deviceScaleFactor ${dsf}`);
    console.log('captures:');
    for (const [n, src] of Object.entries(info.sources)) console.log(`  scene ${String(n).padStart(2)}: ${src}`);
    if (info.placeholders.length) console.log(`PLACEHOLDERS IN USE (watermarked): scenes ${info.placeholders.join(', ')}`);
    for (const w of info.warnings) console.log('  warning: ' + w);
    checkMarkers(info.timeline);
    if (a.info) return;

    if (a.stills) {
      const dir = a.outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'lakeline-stills-'));
      fs.mkdirSync(dir, { recursive: true });
      for (const t of a.stills) {
        const buf = await renderFrame(first, t, { format: 'png' });
        const f = path.join(dir, `still-${t.toFixed(2).padStart(6, '0')}.png`);
        fs.writeFileSync(f, buf);
        console.log('still ' + f);
      }
      return;
    }

    const duration = info.duration;
    const fps = info.fps;
    const step = a.preview ? 2 : 1;
    const f0 = Math.max(0, Math.round((a.from || 0) * fps));
    const f1 = Math.min(Math.round(duration * fps), a.to != null ? Math.round(a.to * fps) : Math.round(duration * fps));
    const frames = [];
    for (let f = f0; f < f1; f += step) frames.push(f);
    const outFps = fps / step;
    const spot = a.from != null || a.to != null;
    const hasMusic = fs.existsSync(MUSIC) && !a.noMusic;
    if (!a.preview && !spot && !hasMusic && !a.noMusic) throw new Error('music missing: ' + MUSIC + ' (use --no-music to render without it)');
    if (!a.preview && !spot && info.placeholders.length && !a.allowPlaceholder) throw new Error('placeholders in use for scenes ' + info.placeholders.join(', ') + '; final deliverables need real captures (or pass --allow-placeholder)');
    fs.mkdirSync(OUT, { recursive: true });
    const tag = spot ? `lakeline-spot-${(a.from || 0).toFixed(1)}-${(f1 / fps).toFixed(1)}` : 'lakeline-launch';
    const finalName = a.preview ? `${tag}-preview.mp4` : spot ? `${tag}-4k.mp4` : 'lakeline-launch-4k.mp4';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lakeline-render-'));
    const videoOnly = path.join(tmp, 'video.mp4');

    // Encoder: JPEG frames (full-range BT.601 YCbCr from sRGB) → limited-range BT.709 yuv420p.
    const vf = [`scale=${a.preview ? '960:540' : 'iw:ih'}:flags=lanczos+accurate_rnd+full_chroma_int:in_range=full:out_range=limited:in_color_matrix=bt601:out_color_matrix=bt709`, 'format=yuv420p'].join(',');
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(outFps), '-c:v', 'mjpeg', '-i', '-',
      '-vf', vf, ...X264(a.preview ? 20 : a.crf, a.preview ? 'veryfast' : 'slow'), '-r', String(outFps), ...COLOR, '-movflags', '+faststart', videoOnly], { stdio: ['pipe', 'inherit', 'inherit'] });
    const ffDone = once(ff, 'exit');

    // Parallel pages render interleaved frames; an ordered writer feeds ffmpeg.
    const workers = [first];
    const nW = Math.min(a.workers, frames.length || 1);
    for (let i = 1; i < nW; i++) workers.push(await openPage(browser, base, dsf));
    const done = new Map();
    let next = 0, written = 0;
    const started = Date.now();
    let waiters = [];
    const wake = () => { const w = waiters; waiters = []; w.forEach((r) => r()); };
    async function writer() {
      while (written < frames.length) {
        if (!done.has(written)) { await new Promise((r) => waiters.push(r)); continue; }
        const buf = done.get(written);
        done.delete(written);
        if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
        written++;
        wake();
        if (written % 150 === 0 || written === frames.length) {
          const el = (Date.now() - started) / 1000;
          const rate = written / el;
          process.stdout.write(`\r  frame ${written}/${frames.length}  ${rate.toFixed(2)} fps  eta ${Math.round((frames.length - written) / rate)} s   `);
        }
      }
      ff.stdin.end();
    }
    async function worker(w) {
      for (;;) {
        const k = next++;
        if (k >= frames.length) return;
        while (k - written > 48) await new Promise((r) => waiters.push(r));
        const buf = await renderFrame(w, frames[k] / fps, { quality: a.quality });
        done.set(k, buf);
        wake();
      }
    }
    console.log(`rendering ${frames.length} frames (${(f0 / fps).toFixed(2)}–${(f1 / fps).toFixed(2)} s) at ${a.preview ? '960×540 preview' : '3840×2160'}, ${outFps} fps, ${nW} workers`);
    await Promise.all([writer(), ...workers.map(worker)]);
    const [code] = await ffDone;
    process.stdout.write('\n');
    if (code !== 0) throw new Error('ffmpeg encode failed: ' + code);
    const secs = frames.length / outFps;

    // Mux music (AAC 320 kb/s, 48 kHz) with a short fade-out, trimmed or padded to the video length.
    const final = path.join(OUT, finalName);
    if (hasMusic) {
      const startS = (f0 / fps).toFixed(3);
      const fade = Math.min(1.2, secs / 4);
      run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoOnly, '-ss', startS, '-i', MUSIC, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
        '-af', `atrim=0:${secs.toFixed(3)},afade=t=out:st=${(secs - fade).toFixed(3)}:d=${fade.toFixed(3)},apad=whole_dur=${secs.toFixed(3)}`,
        '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2', '-t', secs.toFixed(3), '-movflags', '+faststart', final], 'mux');
    } else {
      fs.copyFileSync(videoOnly, final);
    }
    console.log(describe(final));
    if (!a.preview && !spot) {
      const hd = path.join(OUT, 'lakeline-launch-1080p.mp4');
      run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', final, '-map', '0', '-vf', 'scale=1920:1080:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p',
        ...X264(16, 'slow'), ...COLOR, '-c:a', 'copy', '-movflags', '+faststart', hd], '1080p');
      console.log(describe(hd));
    }
    if (a.keep) console.log('video-only: ' + videoOnly); else fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`done in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
