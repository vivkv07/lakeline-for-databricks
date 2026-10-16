// Stage background: base color (with optional wipes) and the navy panel with blue wave lines,
// drawn on a canvas as a pure function of t. The navy region rises from the bottom with a soft
// wave-shaped front; wave lines live inside it and drift slowly.
import { clamp, lerp, prog, E } from './ease.js';

const NAVY = '#0B1A3A';
const LINES = [
  // [fraction of navy height, amp1, k1, w1, amp2, k2, w2, phase, color, alpha, width]
  [0.30, 26, 0.0021, 0.35, 12, 0.0057, -0.22, 0.4, '#C7D5FF', 0.16, 1.4],
  [0.38, 34, 0.0018, -0.28, 14, 0.0049, 0.31, 1.7, '#8FB0FF', 0.30, 1.6],
  [0.46, 30, 0.0016, 0.24, 18, 0.0062, -0.18, 2.6, '#5B8CFF', 0.44, 1.8],
  [0.54, 38, 0.0019, -0.2, 12, 0.0044, 0.27, 3.9, '#C7D5FF', 0.14, 1.3],
  [0.62, 28, 0.0015, 0.31, 20, 0.0058, -0.25, 5.1, '#8FB0FF', 0.34, 1.7],
  [0.70, 36, 0.0017, -0.26, 14, 0.0051, 0.2, 0.9, '#5B8CFF', 0.5, 2.0],
  [0.78, 30, 0.0020, 0.22, 16, 0.0047, -0.3, 2.2, '#C7D5FF', 0.15, 1.3],
  [0.86, 34, 0.0014, -0.3, 18, 0.0060, 0.24, 4.4, '#8FB0FF', 0.3, 1.6],
  [0.94, 26, 0.0018, 0.27, 12, 0.0053, -0.21, 3.3, '#5B8CFF', 0.4, 1.8],
];

export function createWaves(canvas, dpr) {
  const Wd = 1920, Ht = 1080;
  canvas.width = Wd * dpr;
  canvas.height = Ht * dpr;
  canvas.style.width = Wd + 'px';
  canvas.style.height = Ht + 'px';
  const g = canvas.getContext('2d');

  function front(x, t, yb, amp) {
    return yb + amp * (0.62 * Math.sin(x * 0.0024 + t * 0.55 + 0.8) + 0.38 * Math.sin(x * 0.0061 - t * 0.38 + 2.1));
  }

  /**
   * p: { base, sheet?: {color, y}, circle?: {color, cx, cy, r}, level, linesIn, lineAlpha, drift }
   *  - base: page color under everything
   *  - sheet: a second color covering y >= sheet.y (a rising sheet wipe)
   *  - circle: a radial wipe in another color
   *  - level: 0 = no navy, 1 = full frame
   *  - linesIn: 0..1 left-to-right draw-in of the wave lines
   */
  function draw(t, p) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalAlpha = 1;
    g.fillStyle = p.base;
    g.fillRect(0, 0, Wd, Ht);
    if (p.sheet && p.sheet.y < Ht) {
      g.fillStyle = p.sheet.color;
      g.fillRect(0, Math.max(0, p.sheet.y), Wd, Ht);
    }
    if (p.circle && p.circle.r > 0) {
      g.fillStyle = p.circle.color;
      g.beginPath();
      g.arc(p.circle.cx, p.circle.cy, p.circle.r, 0, Math.PI * 2);
      g.fill();
    }
    const level = clamp(p.level || 0);
    if (level <= 0) return;
    const yb = lerp(Ht + 70, -70, level);
    const amp = 30 * Math.sin(Math.PI * clamp(level * 1.4, 0, 1)) + 6;
    const tt = t * (p.drift == null ? 1 : p.drift);
    // Navy body.
    g.beginPath();
    g.moveTo(0, Ht);
    for (let x = 0; x <= Wd; x += 12) g.lineTo(x, front(x, tt, yb, amp));
    g.lineTo(Wd, Ht);
    g.closePath();
    g.fillStyle = NAVY;
    g.fill();
    // Wave lines, clipped to the navy body.
    g.save();
    g.clip();
    const top = Math.max(yb, -70);
    const span = Ht - top;
    const linesIn = p.linesIn == null ? 1 : p.linesIn;
    const la = p.lineAlpha == null ? 1 : p.lineAlpha;
    LINES.forEach(([f, a1, k1, w1, a2, k2, w2, ph, color, alpha, width], i) => {
      const reveal = E.inOutCubic(clamp(linesIn * 1.35 - i * 0.04));
      if (reveal <= 0) return;
      const y0 = top + span * f;
      g.beginPath();
      const xEnd = Wd * reveal;
      for (let x = 0; x <= xEnd + 8; x += 8) {
        const y = y0 + a1 * Math.sin(x * k1 + tt * w1 + ph) + a2 * Math.sin(x * k2 + tt * w2 + ph * 1.7);
        if (x === 0) g.moveTo(x, y); else g.lineTo(Math.min(x, xEnd), y);
      }
      g.strokeStyle = color;
      g.globalAlpha = alpha * la;
      g.lineWidth = width;
      g.lineCap = 'round';
      g.stroke();
    });
    g.restore();
    g.globalAlpha = 1;
  }

  return { draw };
}
