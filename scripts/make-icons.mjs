// Generates the extension's original toolbar icons (rounded accent square with three bars).
// Usage: node scripts/make-icons.mjs  → extension/icons/icon-{16,32,48,128}.png
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const ACCENT = [15, 118, 110]; // #0F766E
const WHITE = [255, 255, 255];

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
  const bars = [ // x0, x1, top (fractions of size), bottom 0.78
    [0.24, 0.36, 0.52], [0.44, 0.56, 0.34], [0.64, 0.76, 0.22],
  ];
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
        const onBar = bars.some(([a, b, t]) => fx >= a && fx <= b && fy >= t && fy <= 0.78);
        const col = onBar ? WHITE : ACCENT;
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
console.log('icons written');
