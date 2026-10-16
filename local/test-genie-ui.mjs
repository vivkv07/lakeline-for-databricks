// Genie side panel page and the popup's "Ask Genie" entry point. SIMULATED: the real HTML and
// scripts run in jsdom with a fake `chrome`. Most tests answer messages with a stand-in service
// worker; the demo test wires the REAL background module and router behind the page (demo mode,
// so no network). This checks page logic and DOM output, not a real browser side panel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { load, fakeArea } from './support/load.mjs';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension');
const demoMod = load('core/genie-demo.js');
const HTML = readFileSync(path.join(EXT, 'ui/sidepanel.html'), 'utf8');
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
/** Text of each element child, for elements whose children carry no spaces between them. */
const parts = (el, sel = ':scope > *') => (el ? [...el.querySelectorAll(sel)].map((c) => text(c)) : []);

const A = 'https://dbc-aaa.cloud.databricks.com';
const B = 'https://dbc-bbb.cloud.databricks.com';
const SALES = 'aaaa0000000000000000000000000001';
const OPS = 'aaaa0000000000000000000000000002';
const EVIL = '<img src=x onerror="window.__pwned=1">';
const SQL = 'SELECT region, SUM(amount) AS revenue\nFROM sales\nGROUP BY region';

// Panels still open after a failed assertion are closed, so their timers can't keep the run alive.
const OPEN = new Set();
test.afterEach(() => {
  for (const env of [...OPEN]) env.close();
});

function event() {
  const fns = [];
  return { addListener: (fn) => fns.push(fn), fns, fire: (...a) => fns.forEach((f) => f(...a)) };
}

/**
 * @param o {respond(msg) → data | {__error}, tabs, clipboard, route?(msg, sender) → full response}
 */
async function openPanel({ respond, tabs = [], route = null } = {}) {
  const jsdomErrors = [];
  const virtualConsole = new VirtualConsole();
  // jsdom can't navigate to blob: URLs (the CSV download click); everything else is reported.
  virtualConsole.on('jsdomError', (e) => {
    if (!/Not implemented: navigation/.test(e.message)) jsdomErrors.push(e.message);
  });
  const dom = new JSDOM(HTML, { url: 'chrome-extension://testext/ui/sidepanel.html', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window;
  const messages = [];
  const ports = [];
  const clipboard = [];
  const downloads = [];
  // Every HTML-parsing entry point is spied before the page scripts run.
  const htmlCalls = [];
  for (const [proto, prop] of [[w.Element.prototype, 'innerHTML'], [w.Element.prototype, 'outerHTML'], [w.ShadowRoot.prototype, 'innerHTML']]) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    Object.defineProperty(proto, prop, { configurable: true, get: desc.get, set(v) { htmlCalls.push(prop); return desc.set.call(this, v); } });
  }
  const iah = w.Element.prototype.insertAdjacentHTML;
  w.Element.prototype.insertAdjacentHTML = function (...a) { htmlCalls.push('insertAdjacentHTML'); return iah.apply(this, a); };
  const ccf = w.Range.prototype.createContextualFragment;
  w.Range.prototype.createContextualFragment = function (...a) { htmlCalls.push('createContextualFragment'); return ccf.apply(this, a); };
  w.URL.createObjectURL = (blob) => (downloads.push(blob), 'blob:chrome-extension://testext/' + downloads.length);
  w.URL.revokeObjectURL = () => {};
  w.chrome = {
    runtime: {
      id: 'testext',
      async sendMessage(msg) {
        messages.push(structuredClone(msg));
        if (route) return structuredClone(await route(structuredClone(msg), { id: 'testext', url: 'chrome-extension://testext/ui/sidepanel.html' }));
        const data = await respond(structuredClone(msg));
        if (data && data.__error) return { ok: false, error: data.__error };
        return { ok: true, data: data === undefined ? null : structuredClone(data) };
      },
      connect({ name }) {
        const port = { name, onMessage: event(), onDisconnect: event(), disconnect() {}, postMessage() {} };
        ports.push(port);
        return port;
      },
    },
    tabs: { query: async () => structuredClone(tabs) },
  };
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t) => clipboard.push(t) }, configurable: true });
  for (const src of [...w.document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'))) {
    w.eval(readFileSync(path.join(EXT, 'ui', src), 'utf8') + '\n//# sourceURL=' + src);
  }
  await w.DCC.sidePanel.ready;
  await settle();
  const $ = (id) => w.document.getElementById(id);
  const env = { dom, window: w, document: w.document, $, messages, ports, clipboard, downloads, htmlCalls, jsdomErrors };
  env.close = () => {
    if (!OPEN.delete(env)) return;
    w.DCC.sidePanel.stop();
    w.close();
  };
  OPEN.add(env);
  return env;
}

const ready = (origin = A) => ({ origin, host: new URL(origin).host, workspaceId: '1001', authMode: 'pat', status: 'ready' });
const initData = (o = {}) => Object.assign({ mode: 'connected', modeError: null, workspaces: [ready(A), ready(B)], defaultOrigin: A, fromActiveTab: true, lastSpace: {}, notify: false, notificationsGranted: false, monitorEnabled: false, inflight: 0 }, o);
const spacesData = { spaces: [{ id: SALES, title: 'Sales analytics', description: 'Orders and revenue' }, { id: OPS, title: 'Operations', description: null }], more: false, demo: false, lastSpace: OPS };

const T = Date.now();
function turn(phase, o = {}) {
  return Object.assign({ id: 'q-' + phase, question: 'Question in ' + phase, askedAt: T - 5000, finishedAt: phase === 'done' || phase === 'failed' ? T - 1000 : null, phase, status: null, step: null, texts: [], query: null, table: null, tableState: 'none', tableError: null, suggested: [], error: null }, o);
}
const doneTurn = (o = {}) =>
  turn('done', Object.assign({
    texts: [{ content: 'Revenue grew **6%**. ' + EVIL, purpose: 'answer' }],
    query: { title: 'Revenue by region', description: 'Sum of orders', sql: SQL, rowCount: 1234, truncated: false, canRerun: true },
    table: { columns: [{ name: 'region', type: 'STRING', numeric: false }, { name: 'revenue', type: 'DECIMAL', numeric: true }], rows: [['EMEA', '412300'], [EVIL, null], ['APAC', '301750']], totalRows: 1234, shown: 3, clipped: true, serverTruncated: false, columnsHidden: 0 },
    tableState: 'ready',
    suggested: ['By month?', 'Top products?'],
  }, o));

/** A finished turn holding one canned DEMO answer (same data the demo agents return). */
function demoTurn(i, o = {}) {
  const a = demoMod.ANSWERS[i];
  return turn('done', Object.assign({
    id: 'q' + i,
    question: 'Demo question ' + i,
    texts: [{ content: a.text, purpose: 'answer' }],
    query: { title: a.title, description: a.description, sql: a.sql, rowCount: a.rows.length, truncated: false, canRerun: true },
    table: { columns: a.columns.map(([name, type]) => ({ name, type, numeric: /INT|LONG|DOUBLE|DECIMAL/.test(type) })), rows: a.rows.map((r) => r.slice()), totalRows: a.rows.length, shown: a.rows.length, clipped: false, serverTruncated: false, columnsHidden: 0 },
    tableState: 'ready',
    suggested: a.suggested,
  }, o));
}

function worker({ init = initData(), spaces = spacesData, thread = null, hooks = {} } = {}) {
  const state = { thread, rev: 1 };
  const fn = async (msg) => {
    if (hooks[msg.type]) return hooks[msg.type](msg, state);
    if (msg.type === 'genie:init') return init;
    if (msg.type === 'genie:spaces') return spaces;
    if (msg.type === 'genie:state') return { rev: state.rev, thread: state.thread, inflight: 0, unseen: 0 };
    if (msg.type === 'genie:remember') return { remembered: true };
    if (msg.type === 'genie:ask') return { threadId: 'c1', turnId: 'q1' };
    if (msg.type === 'genie:new') return { rev: 2, thread: null };
    return { __error: { code: 'UNKNOWN', title: 'Unexpected ' + msg.type, steps: [] } };
  };
  return { fn, state };
}

test('side panel page is CSP-safe: external scripts only, no inline handlers, no innerHTML', () => {
  const dom = new JSDOM(HTML);
  for (const s of dom.window.document.querySelectorAll('script')) {
    assert.ok(s.getAttribute('src'));
    assert.equal(s.textContent.trim(), '');
  }
  for (const el of dom.window.document.querySelectorAll('*')) for (const a of el.getAttributeNames()) assert.ok(!/^on/i.test(a), 'inline handler ' + a);
  let all = HTML;
  for (const f of ['ui/sidepanel.js', 'ui/genie-chart.js', 'src/core/mini-markdown.js', 'src/core/genie-viz.js', 'src/core/genie-demo.js']) {
    const js = readFileSync(path.join(EXT, f), 'utf8');
    assert.doesNotMatch(js, /\.(innerHTML|outerHTML)\b|insertAdjacentHTML|createContextualFragment|document\.write|\beval\(|new Function|DOMParser/, f);
    all += js;
  }
  const css = readFileSync(path.join(EXT, 'ui/sidepanel.css'), 'utf8');
  assert.doesNotMatch(css, /--dcc-[a-z0-9-]+\s*:/, 'no token redefinitions; brand.css owns them');
  assert.ok(!/—/.test(all + css), 'no em dashes in copy');
  // Scripts the panel needs, in dependency order, all local (CSP script-src 'self').
  const srcs = [...dom.window.document.querySelectorAll('script')].map((s) => s.getAttribute('src'));
  assert.deepEqual(srcs, ['../src/core/validate.js', '../src/core/ids.js', '../src/errors.js', '../src/explorer/csv.js', '../src/explorer/charts.js', '../src/core/mini-markdown.js', '../src/core/genie-viz.js', 'genie-chart.js', 'sidepanel.js']);
});

test('opens on the active tab workspace, remembers the last agent, connects the presence port', async () => {
  const sw = worker();
  const env = await openPanel({ respond: sw.fn, tabs: [{ id: 3, url: A + '/jobs?o=1001' }] });
  const init = env.messages.find((m) => m.type === 'genie:init');
  assert.equal(init.activeUrl, A + '/jobs?o=1001');
  assert.equal(env.$('ws').value, A);
  assert.equal(env.$('space').value, OPS, 'last used agent');
  assert.deepEqual([...env.$('space').options].map((o) => o.textContent), ['Sales analytics', 'Operations']);
  assert.deepEqual(env.ports.map((p) => p.name), ['dcc-genie-panel']);
  assert.match(text(env.$('thread')), /Ask Operations/);
  assert.equal(env.$('composer-hint').classList.contains('dcc-visually-hidden'), true, 'the idle keyboard hint is for screen readers only');
  assert.equal(env.$('question').disabled, false);
  assert.equal(env.$('send').disabled, true, 'nothing typed yet');
  // Switching agents remembers the choice and reloads that agent's conversation.
  env.$('space').value = SALES;
  env.$('space').dispatchEvent(new env.window.Event('change'));
  await settle();
  assert.ok(env.messages.some((m) => m.type === 'genie:remember' && m.spaceId === SALES));
  assert.equal(text(env.$('space-desc')), 'Orders and revenue');
  assert.equal(env.$('space').title, 'Sales analytics\nOrders and revenue', 'full agent name and description in the select tooltip');
  assert.equal(text(env.document.querySelector('.gp-empty-desc')), 'Orders and revenue', 'a new conversation shows the agent description');
  assert.equal(env.$('space-desc').hidden, true, 'the description is disclosed on demand (tooltip, screen readers, new conversation)');
  assert.equal(env.$('space').getAttribute('aria-describedby'), 'space-desc');
  assert.equal(env.$('ws').title, new URL(A).host);
  env.close();
});

test('per-message statuses: Sending, Genie is working, Running query, Answer ready, Failed with a plain reason', async () => {
  const thread = {
    id: 'c1',
    turns: [
      turn('sending'),
      turn('working', { step: 'Finding relevant context' }),
      turn('query', { step: 'Running the query', query: { title: 'Revenue', description: null, sql: SQL, rowCount: null, truncated: false, canRerun: true } }),
      doneTurn({ suggested: [] }),
      turn('failed', { error: { code: 'GENIE_RATE_LIMITED', title: 'Genie is busy right now', steps: ['Wait a minute, then ask again.'], detail: 'Too many requests' } }),
    ],
  };
  const env = await openPanel({ respond: worker({ thread }).fn });
  const chips = [...env.document.querySelectorAll('.gp-chip')].map((c) => [c.getAttribute('data-phase'), c.textContent]);
  assert.deepEqual(chips, [
    ['sending', 'Sending'],
    ['working', 'Genie is working'],
    ['query', 'Running query'],
    ['done', 'Answer ready'],
    ['failed', 'Failed'],
  ]);
  const arts = [...env.document.querySelectorAll('article.gp-turn')];
  assert.match(text(arts[1]), /Finding relevant context · \d+s/);
  assert.match(text(arts[2].querySelector('.gp-result-msg')), /The query is running/);
  assert.match(text(arts[3]), /in 4s/);
  assert.match(text(arts[4]), /Genie is busy right now.*Wait a minute.*Details: Too many requests/);
  assert.equal(arts[0].getAttribute('aria-busy'), 'true');
  assert.equal(arts[3].getAttribute('aria-busy'), 'false');
  assert.ok(arts[4].querySelector('button'), 'the last failed question offers Ask again');
  // The panel says Genie is answering and keeps Send disabled; it doesn't poll.
  assert.match(text(env.$('composer-hint')), /Genie is answering/);
  env.$('question').value = 'x';
  env.$('question').dispatchEvent(new env.window.Event('input'));
  assert.equal(env.$('send').disabled, true);
  const stateReads = env.messages.filter((m) => m.type === 'genie:state').length;
  await settle(1200);
  assert.equal(env.messages.filter((m) => m.type === 'genie:state').length, stateReads, 'no polling from the page');
  env.close();
});

test('answer card: Markdown text as DOM, formatted table behind Chart | Table, "Showing N of M", SQL disclosure, copy and CSV', async () => {
  const sw = worker({ thread: { id: 'c1', turns: [doneTurn()] } });
  const env = await openPanel({ respond: sw.fn });
  const art = env.document.querySelector('article.gp-turn');
  assert.equal(env.document.querySelector('img'), null, 'markup in answers and cells is shown as text');
  assert.equal(env.window.__pwned, undefined);
  const md = art.querySelector('.gp-answer .gp-md');
  assert.equal(md.querySelector('strong').textContent, '6%', 'Markdown bold');
  assert.match(text(md), /Revenue grew 6%\. <img src=x/);
  // One category + one measure: a bar chart first, the table one click away.
  const seg = art.querySelector('.gp-seg');
  assert.deepEqual([...seg.querySelectorAll('label')].map((l) => l.textContent), ['Chart', 'Table']);
  assert.equal(art.querySelector('.gp-view[data-view="chart"]').hidden, false);
  assert.equal(art.querySelector('.gp-view[data-view="table"]').hidden, true);
  assert.equal(art.querySelector('.gp-fig').getAttribute('data-chart'), 'bar');
  art.querySelector('[data-view-option="table"]').click();
  assert.equal(art.querySelector('.gp-view[data-view="table"]').hidden, false);
  assert.equal(art.querySelector('.gp-view[data-view="chart"]').hidden, true);
  const table = art.querySelector('table');
  assert.deepEqual([...table.querySelectorAll('thead th')].map((th) => [th.textContent, th.getAttribute('data-col'), th.getAttribute('title'), th.className]), [['Region', 'region', 'region (string)', ''], ['Revenue', 'revenue', 'revenue (decimal)', 'num']]);
  const cells = [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent));
  assert.deepEqual(cells, [['EMEA', '412,300'], [EVIL, 'n/a'], ['APAC', '301,750']]);
  assert.ok(table.querySelector('tbody tr:nth-child(2) td:nth-child(2) .gp-na'), 'null is labeled n/a, never blank, 0 or "null"');
  assert.equal(text(table.querySelector('caption')), 'Revenue by region');
  assert.match(text(art.querySelector('.gp-count')), /^Showing 3 of 1,234 rows$/);
  const wrap = art.querySelector('.gp-table-wrap');
  assert.deepEqual([wrap.getAttribute('tabindex'), wrap.getAttribute('role')], ['0', 'region'], 'the scrollable table is keyboard reachable');
  const details = art.querySelector('details.gp-sql');
  assert.equal(details.open, false, 'SQL hidden until asked');
  assert.deepEqual(parts(details.querySelector('summary')), ['Show SQL', '3 lines']);
  assert.equal(details.querySelector('pre code').textContent, SQL);
  details.open = true;
  details.dispatchEvent(new env.window.Event('toggle'));
  // Copy SQL sits in a toolbar above the code (never inside the scrolling block); Wrap lines toggles.
  const bar = details.querySelector('.gp-sql-bar');
  assert.ok(bar.nextElementSibling.matches('pre.gp-code'));
  bar.querySelector('[data-wrap]').click();
  assert.ok(details.querySelector('pre').classList.contains('is-wrapped'));
  assert.equal(bar.querySelector('[data-wrap]').getAttribute('aria-pressed'), 'true');
  bar.querySelector('[data-copy-sql]').click();
  await settle();
  assert.equal(env.clipboard.at(-1), SQL);
  // A re-render (a follow-up question arrives) keeps the disclosure open, wrapped, and the Table view.
  sw.state.thread = { id: 'c1', turns: [doneTurn(), turn('working', { id: 'q-next' })] };
  env.ports[0].onMessage.fire({ type: 'genie:changed', rev: 99 });
  await settle();
  const again = env.document.querySelector('article.gp-turn');
  assert.notEqual(again, art, 're-rendered');
  assert.equal(again.querySelector('details.gp-sql').open, true);
  assert.ok(again.querySelector('pre.gp-code').classList.contains('is-wrapped'));
  assert.equal(again.querySelector('.gp-view[data-view="table"]').hidden, false);
  // Secondary actions sit behind one menu button; it closes on Escape and on a click elsewhere.
  const menu = again.querySelector('details.gp-menu');
  assert.deepEqual([...menu.querySelectorAll('.gp-menu-item')].map((b) => b.textContent), ['Copy answer', 'Copy table', 'Download CSV']);
  assert.equal(menu.querySelector('summary').getAttribute('aria-label'), 'More actions for this answer');
  menu.open = true;
  env.document.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(menu.open, false);
  assert.equal(env.document.activeElement, menu.querySelector('summary'), 'focus returns to the menu button');
  menu.open = true;
  env.document.body.click();
  assert.equal(menu.open, false);
  // Copy table: raw values with raw names (TSV); Copy answer: the Markdown text plus that TSV.
  again.querySelector('[data-copy-table]').click();
  await settle();
  const tsv = 'region\trevenue\nEMEA\t412300\n' + EVIL + '\t\nAPAC\t301750';
  assert.equal(env.clipboard.at(-1), tsv);
  again.querySelector('[data-copy]').click();
  await settle();
  assert.equal(env.clipboard.at(-1), 'Revenue grew **6%**. ' + EVIL + '\n\n' + tsv);
  assert.equal(env.document.querySelector('[data-copy]').textContent, 'Copied');
  // Download CSV: a Blob through explorer/csv.js (BOM, CRLF, quoting), named after the result.
  again.querySelector('[data-download]').click();
  assert.equal(env.downloads.length, 1);
  const bytes = new Uint8Array(await env.downloads[0].arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for spreadsheet apps');
  assert.equal(await env.downloads[0].text(), 'region,revenue\r\nEMEA,412300\r\n"<img src=x onerror=""window.__pwned=1"">",\r\nAPAC,301750\r\n');
  assert.equal(env.document.querySelector('[data-download]').textContent, 'Downloaded');
  assert.deepEqual(env.htmlCalls, [], 'no HTML parsing anywhere while rendering');
  assert.deepEqual(env.jsdomErrors, []);
  env.close();
});

test('charts per result shape (DEMO answers): bars with a measure picker, multi-series line with gaps, KPI summary, scatter, table only', async () => {
  const thread = { id: 'c1', turns: [0, 1, 2, 3, 4, 5, 6].map((i) => demoTurn(i)) };
  const env = await openPanel({ respond: worker({ thread }).fn });
  const arts = [...env.document.querySelectorAll('article.gp-turn')];
  const kind = (a) => (a.querySelector('.gp-kpis') ? 'kpi' : a.querySelector('.gp-fig') ? a.querySelector('.gp-fig').getAttribute('data-chart') : 'table');
  assert.deepEqual(arts.map(kind), ['bar', 'bar', 'line', 'kpi', 'scatter', 'table', 'line']);

  // Bars: largest first, value at the tip, accessible summary and per-bar labels; measure picker.
  const bars = arts[0];
  assert.match(bars.querySelector('.gp-svg [role="img"]').getAttribute('aria-label'), /^Bar chart of Revenue \(USD\) by Region, 5 of 5 bars, largest first\. Highest EMEA \$412,300\./);
  const marks = [...bars.querySelectorAll('.gp-marks [tabindex]')];
  assert.deepEqual(marks.map((m) => m.getAttribute('aria-label')), ['EMEA: $412,300', 'North America: $398,900', 'APAC: $301,750', 'LATAM: $96,200', 'Other: $31,850']);
  assert.deepEqual(marks.map((m) => [m.getAttribute('role'), m.getAttribute('tabindex')]), [['img', '0'], ['img', '-1'], ['img', '-1'], ['img', '-1'], ['img', '-1']], 'one Tab stop per chart');
  marks[0].focus();
  const tip = bars.querySelector('.gp-tip');
  assert.equal(tip.hidden, false);
  const tipText = () => parts(tip, '.gp-tip-head, strong, .gp-tip-row span');
  assert.deepEqual(tipText(), ['EMEA', '$412,300', 'Revenue (USD)'], 'the value leads, the measure name follows');
  marks[0].dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(env.document.activeElement, marks[1], 'arrow keys move between bars');
  assert.deepEqual(tipText(), ['North America', '$398,900', 'Revenue (USD)']);
  marks[1].dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(tip.hidden, true);
  const pick = bars.querySelector('select[data-measure]');
  assert.deepEqual([...pick.options].map((o) => o.textContent), ['Revenue (USD)', 'Orders', 'Change %']);
  pick.value = '2';
  pick.dispatchEvent(new env.window.Event('change'));
  assert.equal(text(bars.querySelector('.gp-fig-cap')), 'Change % by Region');
  const changed = [...bars.querySelectorAll('.gp-marks [tabindex]')].map((m) => m.getAttribute('aria-label'));
  assert.deepEqual(changed, ['EMEA: 9.4%', 'APAC: 6.8%', 'North America: 4.2%', 'LATAM: 2.1%', 'Other: n/a'], 'a missing value is n/a, sorted last, never 0');
  assert.ok(bars.querySelector('.gp-bar-row[data-label="Other"] .gp-bar') === null, 'no bar drawn for a missing value');

  // Line: three comparable series share one axis with a legend; the missing partner day is a gap.
  const line = arts[2];
  assert.deepEqual([...line.querySelectorAll('.gp-legend li')].map((li) => text(li)), ['Web', 'Store', 'Partner']);
  assert.equal(line.querySelector('select[data-measure]'), null);
  assert.equal(line.querySelectorAll('[data-series="m3"] polyline').length, 2, 'the gap splits the partner line');
  assert.equal(text(line.querySelector('.gp-fig-note')), '1 missing value shown as gaps');
  const lm = [...line.querySelectorAll('.gp-marks [tabindex]')];
  assert.equal(lm.length, 14);
  assert.equal(lm[3].getAttribute('aria-label'), 'Oct 4, 2026: Web $45,020, Store $30,250, Partner n/a');
  lm[0].focus();
  lm[0].dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(env.document.activeElement, lm[13]);
  assert.equal(line.querySelector('.gp-cross').getAttribute('visibility'), 'visible');

  // KPI: Summary | Table, compact big numbers with the exact value, percent from a fraction.
  const kpi = arts[3];
  assert.deepEqual([...kpi.querySelectorAll('.gp-seg label')].map((l) => l.textContent), ['Summary', 'Table']);
  assert.deepEqual([...kpi.querySelectorAll('.gp-kpi')].map((t) => [text(t.querySelector('.gp-kpi-label')), text(t.querySelector('.gp-kpi-value')), text(t.querySelector('.gp-kpi-exact'))]), [
    ['Total Revenue (USD)', '$1.24M', '$1,240,512.40'],
    ['Orders', '10.8K', '10,831'],
    ['Avg Order Value (USD)', '$114.53', ''],
    ['Change Ratio', '6.1%', ''],
  ]);
  assert.match(kpi.querySelector('.gp-kpi:nth-child(4)').getAttribute('title'), /fractions \(0 to 1\)/);
  assert.deepEqual(parts(kpi.querySelector('.gp-kpi-context')), ['Month', 'Sep 1, 2026']);

  // Scatter: run IDs label the points, never an axis; the incomplete run is left out and said so.
  const sc = arts[4];
  assert.equal(sc.querySelectorAll('.gp-marks [tabindex]').length, 17);
  assert.equal(sc.querySelector('.gp-marks [tabindex]').getAttribute('aria-label'), '801104417: Duration (min) 4.2, DBUs 3.9');
  assert.equal(text(sc.querySelector('.gp-fig-note')), '1 row without both values not shown');

  // Wide record table: no chart and no switch; humanized headers, UTC timestamps, n/a cells.
  const wide = arts[5];
  assert.equal(wide.querySelector('.gp-seg'), null);
  assert.deepEqual([...wide.querySelectorAll('thead th')].map((th) => th.textContent), ['Update ID', 'Pipeline Name', 'State', 'Started at (UTC)', 'Duration (min)', 'Rows Written', 'Error Ratio', 'Cost (USD)', 'Compute', 'Cause']);
  assert.deepEqual([...wide.querySelectorAll('tbody tr:nth-child(3) td')].map((td) => td.textContent), ['9f2c41d0-demo-0006', 'inventory_gold', 'FAILED', 'Oct 14, 2026, 21:05:17', '30.0', '0', 'n/a', 'n/a', 'Pipelines cluster', 'Timed out waiting for compute']);
  assert.equal(wide.querySelectorAll('tbody .gp-na').length, 9);
  assert.equal([...wide.querySelectorAll('tbody tr:nth-child(1) td')][6].textContent, '0.00%');
  assert.equal([...wide.querySelectorAll('tbody tr:nth-child(1) td')][6].getAttribute('title'), '0');
  assert.match(wide.querySelector('th[data-col="error_ratio"]').getAttribute('title'), /fractions \(0 to 1\) and shown as percents/);
  assert.equal(wide.querySelector('.gp-md blockquote').textContent, 'Cost is n/a where the update was still being priced.');

  assert.deepEqual(env.htmlCalls, [], 'no HTML parsing anywhere while rendering');
  assert.deepEqual(env.jsdomErrors, []);
  env.close();
});

test('charts redraw at the new width when the panel resizes (window resize fallback in jsdom)', async () => {
  const env = await openPanel({ respond: worker({ thread: { id: 'c1', turns: [demoTurn(6)] } }).fn });
  const host = env.document.querySelector('.gp-chart');
  assert.equal(env.window.ResizeObserver, undefined, 'jsdom has no ResizeObserver, so the fallback path runs');
  assert.equal(host.querySelector('svg.gp-svg').getAttribute('width'), '320', 'detached first drawing uses the fallback width');
  Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => 412 });
  env.window.dispatchEvent(new env.window.Event('resize'));
  await settle(200);
  assert.equal(env.document.querySelector('.gp-chart svg.gp-svg').getAttribute('width'), '412');
  env.close();
});

test('keyboard: Enter sends, Shift+Enter does not, suggestions send as follow-ups, New conversation clears', async () => {
  const sw = worker({ thread: { id: 'c1', turns: [doneTurn()] } });
  const env = await openPanel({ respond: sw.fn });
  const input = env.$('question');
  const key = (o) => input.dispatchEvent(new env.window.KeyboardEvent('keydown', Object.assign({ key: 'Enter', bubbles: true, cancelable: true }, o)));
  input.value = 'Revenue by month?';
  input.dispatchEvent(new env.window.Event('input'));
  assert.equal(env.$('send').disabled, false);
  key({ shiftKey: true });
  await settle();
  assert.equal(env.messages.filter((m) => m.type === 'genie:ask').length, 0, 'Shift+Enter is a newline');
  key({});
  await settle();
  const asks = env.messages.filter((m) => m.type === 'genie:ask');
  assert.deepEqual(asks.map((m) => [m.origin, m.spaceId, m.question, m.spaceTitle]), [[A, OPS, 'Revenue by month?', 'Operations']]);
  assert.equal(input.value, '', 'cleared after sending');
  const sugg = [...env.document.querySelectorAll('.gp-suggest-list button')];
  assert.deepEqual(sugg.map((b) => b.textContent), ['By month?', 'Top products?']);
  sugg[1].click();
  await settle();
  assert.equal(env.messages.filter((m) => m.type === 'genie:ask').at(-1).question, 'Top products?');
  env.$('new-conv').click();
  await settle();
  assert.ok(env.messages.some((m) => m.type === 'genie:new' && m.spaceId === OPS));
  assert.match(text(env.$('thread')), /New conversation/);
  env.close();
});

test('notices: Allow Genie for sign-in, helper mode, missing token, no workspace, import mode, errors with retry', async () => {
  let signedIn = false;
  const sw = worker({
    init: initData({ workspaces: [Object.assign(ready(A), { authMode: 'oauth', status: 'signin' })] }),
    hooks: { 'genie:signIn': () => ((signedIn = true), { signedIn: true }) },
  });
  const env = await openPanel({ respond: sw.fn });
  assert.match(text(env.$('notice')), /Allow Genie for this workspace/);
  assert.equal(env.$('question').disabled, true);
  assert.equal(env.messages.filter((m) => m.type === 'genie:spaces').length, 0, 'no agent listing before consent');
  const btn = env.$('notice').querySelector('[data-action="signin"]');
  assert.equal(btn.textContent, 'Allow Genie and run status');
  btn.click();
  await settle();
  assert.equal(signedIn, true);
  assert.equal(env.$('notice').hidden, true);
  assert.equal(env.$('question').disabled, false);
  env.close();

  const helper = await openPanel({ respond: worker({ init: initData({ workspaces: [Object.assign(ready(A), { authMode: 'helper', status: 'helper' })] }) }).fn });
  assert.match(text(helper.$('notice')), /Genie needs Sign in with Databricks or a personal access token/);
  assert.match(text(helper.$('ws')), /helper not supported/);
  helper.close();

  const pat = await openPanel({ respond: worker({ init: initData({ workspaces: [Object.assign(ready(A), { status: 'pat' })] }) }).fn });
  assert.match(text(pat.$('notice')), /Save a personal access token first/);
  pat.close();

  const none = await openPanel({ respond: worker({ init: initData({ workspaces: [], defaultOrigin: null }) }).fn });
  assert.match(text(none.$('notice')), /No connected workspace/);
  none.close();

  const imp = await openPanel({ respond: worker({ init: initData({ mode: 'import', workspaces: [], modeError: { code: 'GENIE_MODE', title: 'Genie is off in Local import mode', steps: ['Switch modes.'] } }) }).fn });
  assert.match(text(imp.$('notice')), /Genie is off in Local import mode/);
  assert.equal(imp.$('question').disabled, true);
  imp.close();

  let calls = 0;
  const failing = await openPanel({ respond: worker({ hooks: { 'genie:spaces': () => (++calls === 1 ? { __error: { code: 'GENIE_ACCESS_DENIED', title: 'No access to this Genie Agent', steps: ['Ask the owner.'] } } : spacesData) } }).fn });
  assert.match(text(failing.$('notice')), /No access to this Genie Agent/);
  failing.$('notice').querySelector('[data-action="retry"]').click();
  await settle();
  assert.equal(failing.$('notice').hidden, true);
  assert.equal(failing.$('space').disabled, false);
  failing.close();

  const empty = await openPanel({ respond: worker({ spaces: { spaces: [], more: false, lastSpace: null } }).fn });
  assert.match(text(empty.$('notice')), /No Genie Agents here yet/);
  empty.close();
});

test('port: a change signal re-reads state; a dropped port reconnects', async () => {
  const sw = worker();
  const env = await openPanel({ respond: sw.fn });
  const before = env.messages.filter((m) => m.type === 'genie:state').length;
  sw.state.thread = { id: 'c1', turns: [doneTurn()] };
  env.ports[0].onMessage.fire({ type: 'genie:changed', rev: 7 });
  await settle();
  assert.equal(env.messages.filter((m) => m.type === 'genie:state').length, before + 1);
  assert.equal(env.document.querySelectorAll('article.gp-turn').length, 1);
  env.ports[0].onDisconnect.fire();
  await settle(1100);
  assert.equal(env.ports.length, 2, 'reconnected after the service worker went away');
  env.close();
});

test('demo mode end to end in jsdom: real background + router, ask with Enter, DEMO answer with a table', async () => {
  // The REAL genie background module and router, in demo mode (synthetic, no network).
  const genieMod = load('background/genie.js');
  const storeMod = load('background/store.js');
  const routerMod = load('background/router.js');
  const secretsMod = load('background/secrets.js');
  const chromeBg = { runtime: { id: 'testext', getURL: (p) => 'chrome-extension://testext/' + p }, storage: { local: fakeArea(), session: fakeArea() }, permissions: { contains: async () => false }, alarms: { get: async () => null, create: async () => {}, clear: async () => {} }, action: null };
  const store = storeMod.create(chromeBg.storage.local);
  await store.migrate();
  await store.updateSettings({ mode: 'demo' });
  let fetched = 0;
  const g = genieMod.create({ store, secrets: secretsMod.create(chromeBg.storage.session), chromeApi: chromeBg, fetch: async () => (fetched++, null), log: () => {} });
  const router = routerMod.create({ store, secrets: null, data: { cache: { clear() {} } }, chromeApi: chromeBg, extensionId: 'testext', extensionOrigin: 'chrome-extension://testext', helperPort: 8766, openPage: async () => {}, extra: g.handlers });
  const env = await openPanel({ route: (msg, sender) => router.dispatch(msg, sender) });
  assert.equal(env.$('demo-chip').hidden, false);
  assert.equal(text(env.$('ws')), 'Demo workspace');
  assert.match(env.$('space').selectedOptions[0].textContent, /DEMO/);
  const revenue = [...env.$('space').options].find((o) => /Revenue/.test(o.textContent)).value;
  env.$('space').value = revenue;
  env.$('space').dispatchEvent(new env.window.Event('change'));
  await settle();
  const starters = [...env.document.querySelectorAll('.gp-starters button')].map((b) => b.textContent);
  assert.ok(starters.includes('What was revenue by region last month?'));
  // Connect the panel port to the background so it gets change signals.
  const bgPort = { name: 'dcc-genie-panel', sender: { id: 'testext', url: 'chrome-extension://testext/ui/sidepanel.html' }, postMessage: (m) => env.ports[0].onMessage.fire(m), onDisconnect: { addListener() {} } };
  assert.equal(g.onConnect(bgPort), true);
  env.$('question').value = 'What was revenue by region last month?';
  env.$('question').dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle(50);
  assert.equal(env.$('notice').hidden, true, text(env.$('notice')));
  assert.match(text(env.document.querySelector('.gp-chip')), /Sending|Genie is working/);
  for (let i = 0; i < 80 && !env.document.querySelector('.gp-turn[data-phase="done"]'); i++) await settle(100);
  const done = env.document.querySelector('.gp-turn[data-phase="done"]');
  assert.ok(done, 'the DEMO answer arrived through the port signal');
  assert.match(text(done.querySelector('.gp-md')), /DEMO answer \(synthetic\)/);
  assert.equal(done.querySelector('.gp-md strong').textContent, 'DEMO answer (synthetic).');
  assert.equal(done.querySelector('.gp-fig').getAttribute('data-chart'), 'bar');
  assert.equal(done.querySelectorAll('tbody tr').length, 5);
  assert.equal(text(done.querySelector('.gp-count')), 'Showing 5 of 5 rows');
  assert.equal(fetched, 0, 'demo mode makes no requests');
  env.close();
});

/* ------------------------------------------------------------------ popup entry point */

function openPopup({ sidePanel = true, permissionAnswer = true } = {}) {
  const html = readFileSync(path.join(EXT, 'ui/popup.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'chrome-extension://testext/ui/popup.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const log = [];
  let closed = false;
  w.chrome = {
    runtime: {
      id: 'testext',
      async sendMessage(msg) {
        log.push(['message', msg.type, structuredClone(msg)]);
        if (msg.type === 'page:state') return { ok: true, data: { settings: { mode: 'connected', periodDays: 30, showCosts: true, monitor: {}, genie: { notify: false, lastSpace: {} }, oauth: {}, revision: 1 }, connections: {}, diagnostics: [], observed: {} } };
        if (msg.type === 'genie:settings') return { ok: true, data: { notify: msg.notify } };
        return { ok: true, data: null };
      },
      getURL: (p) => 'chrome-extension://testext/' + p,
    },
    tabs: { query: async () => [{ id: 5, windowId: 77, url: 'https://example.com/' }] },
    windows: { WINDOW_ID_CURRENT: -2 },
    permissions: {
      request(req) {
        log.push(['permission', structuredClone(req)]);
        return Promise.resolve(permissionAnswer);
      },
      contains: async () => false,
    },
  };
  if (sidePanel) w.chrome.sidePanel = { open: (o) => (log.push(['sidePanel.open', structuredClone(o)]), Promise.resolve()) };
  w.close = () => {
    closed = true;
  };
  for (const s of [...w.document.querySelectorAll('script[src]')]) {
    const src = s.getAttribute('src');
    const file = path.resolve(EXT, 'ui', src);
    if (src === 'workspace-appearance.js' || !existsSync(file)) continue;
    w.eval(readFileSync(file, 'utf8') + '\n//# sourceURL=' + src);
  }
  return { w, d: w.document, log, isClosed: () => closed };
}

test('popup: Ask Genie opens the side panel inside the click (no await before it), then closes', async () => {
  const p = openPopup();
  await p.w.DCC.popupPage.ready;
  await settle();
  const before = p.log.length;
  p.d.getElementById('genie-open').click();
  // Synchronously, in the same task as the click: sidePanel.open is the very next call.
  assert.deepEqual(p.log[before], ['sidePanel.open', { windowId: 77 }]);
  await settle();
  assert.equal(p.isClosed(), true);

  const old = openPopup({ sidePanel: false });
  await old.w.DCC.popupPage.ready;
  old.d.getElementById('genie-open').click();
  await settle();
  assert.match(text(old.d.getElementById('genie-status')), /side panel isn't available/);
});

test('popup: "Notify me when Genie answers" asks for the optional permission first, then saves', async () => {
  const p = openPopup();
  await p.w.DCC.popupPage.ready;
  await settle();
  const sw = p.d.getElementById('genie-notify');
  assert.equal(sw.checked, false);
  sw.checked = true;
  sw.dispatchEvent(new p.w.Event('change'));
  await settle();
  const i = p.log.findIndex((e) => e[0] === 'permission');
  assert.deepEqual(p.log[i][1], { permissions: ['notifications'] });
  const save = p.log.findIndex((e) => e[0] === 'message' && e[1] === 'genie:settings');
  assert.ok(save > i, 'permission requested before the setting is saved');
  assert.equal(p.log[save][2].notify, true);
  assert.equal(sw.checked, true);

  const no = openPopup({ permissionAnswer: false });
  await no.w.DCC.popupPage.ready;
  await settle();
  const sw2 = no.d.getElementById('genie-notify');
  sw2.checked = true;
  sw2.dispatchEvent(new no.w.Event('change'));
  await settle();
  assert.equal(sw2.checked, false);
  assert.ok(!no.log.some((e) => e[1] === 'genie:settings'));
  assert.match(text(no.d.getElementById('genie-status')), /Notifications were not allowed/);
});
