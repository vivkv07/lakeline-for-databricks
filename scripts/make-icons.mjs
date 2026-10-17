// Generates the extension's toolbar icons: a pure black rounded square with three bars, two in
// white and the tallest in the accent blue. Geometry sits on a 16-unit grid, so every size that is
// a multiple of 16 has pixel-aligned bar edges (crisp at 16px).
// Usage: node scripts/make-icons.mjs  → extension/icons/icon-{16,32,48,128}.png
//        node scripts/make-icons.mjs --store-logo  → also store/assets/store-logo-300.png (Edge Add-ons)
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];
const ACCENT = [91, 140, 255]; // #5B8CFF

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const ss = 4; // supersampling
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const r = size * 0.22;
  const u = 1 / 16; // grid unit
  const bars = [ // x0, x1, top (fractions of size); bottom at 13/16
    [3 * u, 5 * u, 9 * u, WHITE], [7 * u, 9 * u, 6 * u, WHITE], [11 * u, 13 * u, 3 * u, ACCENT],
  ];
  const bottom = 13 * u;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const px = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss;
        const cx = Math.min(Math.max(px, r), size - r), cy = Math.min(Math.max(py, r), size - r);
        const inside = (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
        if (!inside) continue;
        const fx = px / size, fy = py / size;
        const bar = bars.find(([a, b, t]) => fx >= a && fx < b && fy >= t && fy < bottom);
        const col = bar ? bar[3] : BLACK;
        acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255;
      }
      const n = ss * ss, o = y * (size * 4 + 1) + 1 + x * 4;
      const a = acc[3] / n;
      raw[o] = a ? Math.round(acc[0] / (acc[3] / 255)) : 0;
      raw[o + 1] = a ? Math.round(acc[1] / (acc[3] / 255)) : 0;
      raw[o + 2] = a ? Math.round(acc[2] / (acc[3] / 255)) : 0;
      raw[o + 3] = Math.round(a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const dir = new URL('../extension/icons/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(new URL(`icon-${s}.png`, dir), png(s));
if (process.argv.includes('--store-logo')) {
  const assets = new URL('../store/assets/', import.meta.url);
  mkdirSync(assets, { recursive: true });
  writeFileSync(new URL('store-logo-300.png', assets), png(300));
}
console.log('icons written');
