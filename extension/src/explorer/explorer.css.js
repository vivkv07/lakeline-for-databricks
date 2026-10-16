/*
 * Explorer styles as a string constant: the Explorer renders inside the banner's shadow root,
 * so explorer.js injects this into its own <style> element. Neutral, light surfaces, dark text,
 * one accent (#0f766e), visible focus states.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;

  const CSS = `
.dcc-x { position: relative; container-type: inline-size; color: #1f2933; font-size: 12px; }
.dcc-x * { box-sizing: border-box; }
.dcc-x h3, .dcc-x h4 { margin: 0; font-weight: 650; color: #1f2933; }
.dcc-x h3 { font-size: 14px; }
.dcc-x h4 { font-size: 12.5px; margin-bottom: 4px; }
.x-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.x-meta { color: #52606d; }
.x-head .spacer { flex: 1 1 auto; }
.x-crumbs { margin-top: 6px; }
.x-crumbs ol { list-style: none; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 4px; margin: 0; padding: 0; }
.x-crumbs li + li::before { content: "\\203A"; margin-right: 4px; color: #7b8794; }
.x-crumbs button { border: 0; background: none; color: #0f766e; text-decoration: underline; padding: 1px 2px; min-height: 0; }
.x-crumbs [aria-current] { font-weight: 600; color: #1f2933; }
.x-chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 0; }
.chip { display: inline-flex; align-items: center; gap: 2px; border: 1px solid #9fd3cb; background: #ecf7f5; color: #0b4f4a; border-radius: 999px; padding: 0 2px 0 8px; font-size: 11px; max-width: 100%; }
.chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
.chip button { border: 0; background: none; min-height: 20px; padding: 0 6px; border-radius: 999px; color: #0b4f4a; }
.chip button:hover { background: #d3eee9; }
.x-tabs { display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 1px solid #d9dee3; margin: 8px 0 6px; }
.x-tabs [role="tab"] { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: 4px 10px; color: #3e4c59; min-height: 28px; }
.x-tabs [role="tab"][aria-selected="true"] { border-bottom-color: #0f766e; color: #0f766e; font-weight: 600; }
.x-tools { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin-bottom: 6px; }
.x-tools label { display: inline-flex; align-items: center; gap: 4px; color: #52606d; }
.dcc-x input[type="search"], .dcc-x select { font: inherit; font-size: 12px; color: #1f2933; background: #fff; border: 1px solid #c4ccd4; border-radius: 6px; padding: 2px 6px; min-height: 26px; }
.dcc-x input[type="search"] { width: 200px; max-width: 100%; }
.dcc-x input:focus-visible, .dcc-x select:focus-visible, .dcc-x [tabindex="-1"]:focus-visible, .dcc-x [role="tabpanel"]:focus-visible { outline: 2px solid #0f766e; outline-offset: 2px; }
.x-view { min-height: 120px; }
.x-view:focus { outline: none; }
.x-split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.chart-wrap { position: relative; margin: 4px 0; }
svg.chart { display: block; max-width: 100%; height: auto; overflow: visible; font-family: inherit; }
svg.chart [role="button"] { cursor: pointer; outline: none; }
svg.chart [role="button"]:focus .hit, svg.chart [role="button"]:hover .hit { stroke: #0f766e; stroke-width: 1.5; stroke-dasharray: none; }
svg.chart [role="button"]:focus .hit { stroke-width: 2.5; }
svg.chart .focus-ring { visibility: hidden; }
svg.chart .cell[role="button"]:focus .focus-ring, svg.chart .cell[role="button"]:hover .focus-ring { visibility: visible; }
svg.chart .cell.selected rect:first-child { stroke: #0f766e; stroke-width: 2; stroke-dasharray: none; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 6px; margin: 4px 0; align-items: center; }
.legend button, .legend .key { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; }
.legend .key { color: #52606d; }
.legend button[aria-pressed="true"] { background: #e6f4f1; color: #0b4f4a; border-color: #0f766e; }
.swatch { flex: none; }
.inspect { min-height: 1.5em; margin: 2px 0 4px; color: #1f2933; font-variant-numeric: tabular-nums; }
.inspect:empty::before { content: "Hover, tap or focus a mark for exact values."; color: #7b8794; }
.tip { position: absolute; z-index: 5; pointer-events: none; background: #ffffff; color: #1f2933; border: 1px solid #9aa5b1; border-radius: 6px; box-shadow: 0 2px 8px rgba(31, 41, 51, .18); padding: 4px 8px; font-size: 11px; line-height: 1.45; max-width: 300px; white-space: pre-line; font-variant-numeric: tabular-nums; transform: translate(-50%, calc(-100% - 8px)); }
.tip[hidden] { display: none; }
.card { border: 1px solid #e4e7eb; border-radius: 6px; padding: 6px 8px; margin: 6px 0; background: #fbfcfd; }
.card .row { display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: baseline; }
.card .big { font-weight: 650; font-size: 13px; font-variant-numeric: tabular-nums; }
.muted { color: #616e7c; }
.x-note { margin: 4px 0; color: #52606d; font-size: 11px; }
.x-warn { margin: 4px 0; padding: 3px 8px; border-left: 3px solid #9a6700; background: #fff8e6; color: #5c3d00; font-size: 11.5px; }
.x-err { margin: 4px 0; padding: 4px 8px; border-left: 3px solid #8a1c1c; background: #fdf0f0; color: #5e1313; }
.x-loadcard { border: 1px dashed #c4ccd4; border-radius: 6px; padding: 8px 10px; margin: 6px 0; }
.x-loadcard p { margin: 0 0 6px; }
.btn-primary { background: #0f766e !important; color: #fff !important; border-color: #0f766e !important; }
.btn-primary:hover { background: #0b5f58 !important; }
.tbl-wrap { overflow-x: auto; max-width: 100%; }
.dcc-x table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
.dcc-x caption { text-align: left; font-weight: 600; padding: 2px 0 4px; color: #3e4c59; }
.dcc-x th, .dcc-x td { text-align: left; padding: 3px 6px; border-bottom: 1px solid #eef1f4; vertical-align: top; }
.dcc-x th { color: #52606d; font-weight: 600; white-space: nowrap; }
.dcc-x th.num, .dcc-x td.num { text-align: right; }
.dcc-x th button { border: 0; background: none; padding: 0; min-height: 0; font-weight: 600; color: #52606d; text-decoration: underline dotted; }
.dcc-x tbody tr.selected { background: #e6f4f1; }
.dcc-x tbody th { font-weight: 400; color: #1f2933; white-space: normal; }
.dcc-x .linkish { border: 0; background: none; padding: 0; min-height: 0; min-width: 0; color: #0f766e; text-decoration: underline; text-align: left; max-width: 360px; overflow-wrap: anywhere; font-weight: 400; }
.dcc-x .linkish:hover { background: none; color: #0b4f4a; }
.dcc-x .id { color: #616e7c; font-size: 11px; }
.dcc-x a { color: #0f766e; }
.dcc-x a:focus-visible { outline: 2px solid #0f766e; outline-offset: 2px; }
.flagtxt { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: #1f2933; }
.status-partial { color: #7a5200; }
.status-unavailable, .status-unpriced { color: #616e7c; font-style: italic; }
.ramp { display: inline-flex; gap: 1px; vertical-align: middle; }
.ramp span { width: 12px; height: 10px; display: inline-block; border-radius: 1px; }
.overlap { border: 1px solid #c4ccd4; border-radius: 6px; padding: 4px 8px; margin: 4px 0; }
.overlap ul { margin: 4px 0; padding-left: 18px; }
.x-about { margin-top: 8px; }
.x-about summary { cursor: pointer; color: #0f766e; }
.x-about ul { margin: 4px 0; padding-left: 18px; color: #3e4c59; }
.sr-only { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.dcc-x.compact .opt { display: none; }
.dcc-x.compact .x-tools { flex-direction: column; align-items: stretch; }
.dcc-x.compact input[type="search"] { width: 100%; }
.dcc-x.compact .x-tabs [role="tab"] { padding: 4px 6px; }
.dcc-x.expanded .x-split.two { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); }
@container (max-width: 560px) {
  .dcc-x .opt { display: none; }
  .dcc-x .x-split.two { grid-template-columns: minmax(0, 1fr); }
}
`;

  const api = Object.freeze({ CSS });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).explorerCss = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
