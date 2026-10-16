// Helpers shared by the product scenes: workspace hosts, page windows and cursor points.
import { browserWindow } from '../lib/kit.js';
import { crossStack } from './product.js';

/** Synthetic workspace hosts (notes/VIDEO.md); a manifest "host" text wins when present. */
export const HOSTS = {
  prod: 'northpeak-prod.cloud.databricks.com',
  analytics: 'northpeak-analytics.cloud.databricks.com',
  dev: 'northpeak-dev.cloud.databricks.com',
  stage: 'northpeak-stage.cloud.databricks.com',
};

export function hostFor(sc, state, which) {
  const h = sc.m && state ? sc.T(state, ['host', 'workspace-host', 'origin', 'address', 'url'], ['path']) : null;
  if (h && /[a-z0-9-]+\.[a-z]/i.test(h) && !/127\.0\.0\.1|localhost/.test(h)) return h.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return HOSTS[which] || HOSTS.prod;
}

export const wsName = (host) => host.split('.')[0];

/**
 * A browser window whose page content is a cross-fading stack of page captures.
 * opts: { theme, states, sched, tabs?, active?, panelW?, host?, size? }
 */
export function pageWindow(sc, { theme, states, sched, tabs, active = 0, panelW = 0, host, size }) {
  const first = size || states.find(Boolean) || { vw: 1600, vh: 1000 };
  const win = browserWindow(sc.world, {
    theme, w: first.vw, h: first.vh, panelW,
    tabs: tabs || [{ title: wsName(host || HOSTS.prod), host: host || HOSTS.prod }],
    active,
  });
  // Keep the window behind popups, rings and the cursor.
  sc.world.insertBefore(win.el, sc.world.firstChild);
  const stack = crossStack(win.content, states, sched);
  sc.add((t) => stack.update(t));
  return { win, stack };
}

/** Cursor point at the center of a world rect, or a fallback point (no click when the box is missing). */
export function at(rect, fallback) {
  if (rect) return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, ok: true };
  return fallback ? Object.assign({ ok: false }, fallback) : null;
}

/** Union of world rects (nulls ignored). */
export function union(...rs) {
  const v = rs.filter(Boolean);
  if (!v.length) return null;
  const x0 = Math.min(...v.map((r) => r.x)), y0 = Math.min(...v.map((r) => r.y));
  const x1 = Math.max(...v.map((r) => r.x + r.w)), y1 = Math.max(...v.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Grow a rect by pad on every side. */
export const grow = (r, px, py = px) => (r ? { x: r.x - px, y: r.y - py, w: r.w + 2 * px, h: r.h + 2 * py } : null);
