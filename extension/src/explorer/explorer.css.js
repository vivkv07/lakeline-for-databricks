/*
 * Explorer styles as a string constant: the Explorer renders inside the banner's shadow root,
 * so explorer.js injects this into its own <style> element. Colors are theme tokens (core/theme.js)
 * set as custom properties on .dcc-x; explorer.js sets data-theme="dark" on that element when the
 * Databricks page behind the banner is dark. White or black surfaces, hairline cards, pill
 * controls, one blue accent, warm amber only for prior-period data and partial coverage.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const T = NODE ? require('../core/theme.js') : root.DCC && root.DCC.theme;
  const vars = (name) => (T ? T.cssVars(name) : '');

  const CSS = `
.dcc-x { ${vars('light')} color-scheme: light; }
.dcc-x[data-theme="dark"] { ${vars('dark')} color-scheme: dark; }
.dcc-x { --danger-soft: color-mix(in srgb, var(--danger) 8%, var(--bg)); --danger-line: color-mix(in srgb, var(--danger) 40%, var(--bg));
  --on-accent: #FFFFFF; --control: #8A8A93; }
.dcc-x[data-theme="dark"] { --on-accent: #000000; --control: #6E6E76; }
.dcc-x { position: relative; container-type: inline-size; padding: 2px 0 4px; color: var(--text); background: var(--bg);
  font: 400 12.5px/1.45 var(--font); }
.dcc-x * { box-sizing: border-box; }
.dcc-x h3, .dcc-x h4 { margin: 0; font-weight: 600; letter-spacing: -0.01em; color: var(--text); }
.dcc-x h3 { font-size: 15px; }
.dcc-x h4 { font-size: 13px; margin-bottom: 6px; }
.dcc-x button { font: inherit; font-size: 12px; font-weight: 500; line-height: 1.2; color: var(--text); background: transparent;
  border: 1px solid var(--line2); border-radius: 999px; padding: 4px 12px; margin: 0; min-height: 28px; min-width: 28px; cursor: pointer; }
.dcc-x button:hover { background: var(--surface); border-color: var(--control); }
.dcc-x button[aria-pressed="true"] { color: var(--accent-text); background: var(--accent-soft); border-color: var(--accent); font-weight: 600; }
.dcc-x button:focus:not(:focus-visible) { outline: none; }
.dcc-x button:focus-visible, .dcc-x summary:focus-visible, .dcc-x input:focus-visible, .dcc-x select:focus-visible,
.dcc-x [tabindex="-1"]:focus-visible, .dcc-x [role="tabpanel"]:focus-visible, .dcc-x a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.dcc-x .pill { display: inline-flex; align-items: center; padding: 0 8px; font-size: 11px; font-weight: 500; line-height: 18px; white-space: nowrap;
  color: var(--accent-text); background: var(--accent-soft); border: 1px solid var(--accent-line); border-radius: 999px; }
.x-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.x-meta { font-family: var(--mono); font-size: 11px; letter-spacing: 0.02em; color: var(--muted); }
.x-head .spacer { flex: 1 1 auto; }
.x-crumbs { margin-top: 8px; }
.x-crumbs ol { list-style: none; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; margin: 0; padding: 0;
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.x-crumbs li + li::before { content: "/"; margin-right: 6px; color: var(--faint); }
.dcc-x .x-crumbs button { border: 0; background: none; color: var(--accent); text-decoration: underline; text-underline-offset: 2px;
  padding: 1px 2px; min-height: 0; min-width: 0; font: inherit; letter-spacing: inherit; border-radius: 4px; }
.x-crumbs [aria-current] { font-weight: 500; color: var(--text); }
.x-chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 0; }
.chip { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; padding: 0 2px 0 10px; font-size: 11.5px;
  color: var(--accent-text); background: var(--accent-soft); border: 1px solid var(--accent-line); border-radius: 999px; }
.chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
.dcc-x .chip button { border: 0; background: none; min-height: 22px; min-width: 22px; padding: 0 6px; color: var(--accent-text); }
.dcc-x .chip button:hover { background: var(--accent-fill); }
.x-tabs { display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 1px solid var(--line); margin: 10px 0 8px; }
.dcc-x .x-tabs [role="tab"] { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: 6px 10px;
  color: var(--body); min-height: 32px; margin-bottom: -1px; }
.dcc-x .x-tabs [role="tab"]:hover { color: var(--text); background: none; }
.dcc-x .x-tabs [role="tab"][aria-selected="true"] { border-bottom-color: var(--accent); color: var(--text); font-weight: 600; }
.x-tools { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; margin-bottom: 8px; }
.x-tools label { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--muted); }
.dcc-x input[type="search"], .dcc-x select { font: inherit; font-family: var(--font); font-size: 12px; letter-spacing: normal; text-transform: none;
  color: var(--text); background: var(--bg); border: 1px solid var(--control); border-radius: 999px; padding: 3px 12px; min-height: 28px; }
.dcc-x input[type="search"] { width: 200px; max-width: 100%; }
.dcc-x input::placeholder { color: var(--muted); }
.dcc-x .seg { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--line2); border-radius: 999px; }
.dcc-x .seg button { border-color: transparent; min-height: 24px; padding: 2px 10px; }
.dcc-x .seg button[aria-pressed="true"] { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
.x-view { min-height: 120px; }
.x-view:focus { outline: none; }
.x-split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.chart-wrap { position: relative; margin: 4px 0; }
svg.chart { display: block; max-width: 100%; height: auto; overflow: visible; font-family: var(--mono); }
svg.chart [role="button"] { cursor: pointer; outline: none; }
svg.chart [role="button"]:focus .hit, svg.chart [role="button"]:hover .hit { stroke: var(--accent); stroke-width: 1.5; stroke-dasharray: none; }
svg.chart [role="button"]:focus .hit { stroke-width: 2.5; }
svg.chart .focus-ring { visibility: hidden; }
svg.chart .cell[role="button"]:focus .focus-ring, svg.chart .cell[role="button"]:hover .focus-ring { visibility: visible; }
svg.chart .cell.selected rect:first-child { stroke: var(--accent); stroke-width: 2; stroke-dasharray: none; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 6px; margin: 4px 0 6px; align-items: center; }
.dcc-x .legend button, .legend .key { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; }
.dcc-x .legend button { min-height: 26px; padding: 2px 10px; }
.legend .key { color: var(--body); padding: 0 4px; }
.swatch { flex: none; }
.inspect { min-height: 1.5em; margin: 2px 0 6px; font-family: var(--mono); font-size: 11.5px; color: var(--text); font-variant-numeric: tabular-nums; }
.inspect:empty::before { content: "Hover, tap or focus a mark for exact values."; font-family: var(--font); color: var(--muted); }
.tip { position: absolute; z-index: 5; pointer-events: none; max-width: 300px; padding: 6px 10px; font-size: 11.5px; line-height: 1.45;
  white-space: pre-line; font-variant-numeric: tabular-nums; color: var(--text); background: var(--bg); border: 1px solid var(--line2);
  border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, .14); transform: translate(-50%, calc(-100% - 8px)); }
.tip[hidden] { display: none; }
.card { margin: 8px 0; padding: 10px 12px; background: var(--bg); border: 1px solid var(--line); border-radius: 12px; }
.card .row { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: baseline; margin-bottom: 4px; color: var(--body); }
.card .big { font-family: var(--mono); font-weight: 500; font-size: 15px; color: var(--text); font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }
.x-note { margin: 4px 0; color: var(--body); font-size: 11.5px; }
.x-warn { margin: 6px 0; padding: 6px 10px; color: var(--text); background: var(--warm-soft); border: 1px solid var(--warm-line); border-radius: 10px; font-size: 11.5px; }
.x-err { margin: 6px 0; padding: 8px 12px; color: var(--text); background: var(--danger-soft); border: 1px solid var(--danger-line); border-radius: 10px; }
.x-err > strong { color: var(--danger); font-weight: 600; }
.x-err ul { margin: 4px 0; padding-left: 18px; }
.x-err details { margin: 4px 0 6px; }
.x-loadcard { margin: 8px 0; padding: 12px 14px; border: 1px dashed var(--line2); border-radius: 12px; }
.x-loadcard p { margin: 0 0 8px; }
.dcc-x .btn-primary { color: var(--pill-text); background: var(--pill-bg); border-color: var(--pill-bg); min-height: 30px; padding: 4px 14px; }
.dcc-x .btn-primary:hover { color: var(--pill-text); background: color-mix(in srgb, var(--pill-bg) 84%, var(--bg)); border-color: var(--pill-bg); }
.tbl-wrap { overflow-x: auto; max-width: 100%; margin: 6px 0; border: 1px solid var(--line); border-radius: 12px; }
.dcc-x table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
.dcc-x caption { text-align: left; font-weight: 600; padding: 8px 10px 6px; color: var(--text); }
.dcc-x th, .dcc-x td { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
.dcc-x tbody tr:last-child > * { border-bottom: 0; }
.dcc-x thead th { font-family: var(--mono); font-size: 10.5px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); white-space: nowrap; }
.dcc-x th.num, .dcc-x td.num { text-align: right; font-family: var(--mono); font-size: 11.5px; }
.dcc-x thead th.num { font-size: 10.5px; }
.dcc-x th button { border: 0; background: none; padding: 0; min-height: 0; min-width: 0; font: inherit; letter-spacing: inherit; text-transform: inherit;
  color: var(--muted); text-decoration: underline dotted; text-underline-offset: 3px; border-radius: 4px; }
.dcc-x th button:hover { background: none; color: var(--text); }
.dcc-x tbody tr.selected > * { background: var(--accent-soft); }
.dcc-x tbody th { font-weight: 400; color: var(--text); white-space: normal; }
.dcc-x .linkish { border: 0; background: none; padding: 0; min-height: 0; min-width: 0; color: var(--accent); text-decoration: underline;
  text-underline-offset: 2px; text-align: left; max-width: 360px; overflow-wrap: anywhere; font-weight: 400; font-size: inherit; border-radius: 4px; }
.dcc-x .linkish:hover { background: none; text-decoration-thickness: 2px; }
.dcc-x .id { font-family: var(--mono); color: var(--muted); font-size: 11px; }
.dcc-x a { color: var(--accent); text-underline-offset: 2px; }
.flagtxt { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: var(--text); }
.status-partial { color: var(--warm); }
.status-unavailable, .status-unpriced { color: var(--muted); font-style: italic; }
.ramp { display: inline-flex; gap: 2px; vertical-align: middle; }
.ramp span { width: 12px; height: 10px; display: inline-block; border-radius: 2px; }
.overlap { margin: 6px 0; padding: 8px 12px; border: 1px solid var(--line); border-radius: 12px; }
.overlap ul { margin: 4px 0; padding-left: 18px; }
.x-about { margin-top: 10px; }
.x-about summary { cursor: pointer; color: var(--accent); font-weight: 500; width: fit-content; }
.x-about ul { margin: 6px 0; padding-left: 18px; color: var(--body); }
.sr-only { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.dcc-x.compact .opt { display: none; }
.dcc-x.compact .x-tools { flex-direction: column; align-items: stretch; }
.dcc-x.compact input[type="search"] { width: 100%; }
.dcc-x.compact .x-tabs [role="tab"] { padding: 6px 8px; }
.dcc-x.expanded .x-split.two { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); }
@container (max-width: 560px) {
  .dcc-x .opt { display: none; }
  .dcc-x .x-split.two { grid-template-columns: minmax(0, 1fr); }
}
@media (forced-colors: active) {
  .dcc-x button[aria-pressed="true"], .dcc-x .seg button[aria-pressed="true"] { forced-color-adjust: none; background: Highlight; color: HighlightText; border-color: Highlight; }
}
`;

  const api = Object.freeze({ CSS });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).explorerCss = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
