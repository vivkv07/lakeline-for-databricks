// Popup → Workspace colors panel. SIMULATED: jsdom with a fake `chrome` (storage, runtime
// messaging, permissions, tabs). Not proof of Chrome's permission prompt behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const EXT = new URL('../extension/', import.meta.url);
const SCRIPTS = ['src/core/validate.js', 'src/core/ids.js', 'src/content/workspace-color.js', 'ui/workspace-appearance.js'];
const ORIGIN = 'https://dbc-1.cloud.databricks.com';
const KEY = 'dcc.appearance';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {object} [o.storage]   initial chrome.storage.local
 * @param {string[]} [o.granted] origin patterns already granted
 * @param {boolean} [o.allow]    answer to permissions.request
 * @param {object} [o.state]     page:state data
 * @param {string} [o.activeUrl] active tab URL
 * @param {boolean} [o.section]  include <section id="appearance-panel">
 */
async function openPopup({ storage = {}, granted = [], allow = true, state = { connections: {}, observed: {} }, activeUrl = null, section = true } = {}) {
  const html = '<!doctype html><html><head></head><body>' + (section ? '<section id="appearance-panel" aria-label="Workspace colors"></section>' : '') + '</body></html>';
  const dom = new JSDOM(html, { url: 'http://localhost/ui/popup.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const data = structuredClone(storage);
  const listeners = [];
  const log = { messages: [], contains: [], requests: [], writes: [] };
  const grantedSet = new Set(granted);
  w.chrome = {
    runtime: {
      async sendMessage(msg) {
        log.messages.push(structuredClone(msg));
        if (msg.type === 'page:state') return { ok: true, data: structuredClone(state) };
        if (msg.type === 'appearance:applyAccess') return { ok: true, data: { origin: msg.origin, granted: true, registered: true, injected: 2 } };
        return { ok: false, error: { code: 'UNKNOWN' } };
      },
    },
    storage: {
      local: {
        async get(key) {
          const out = {};
          for (const k of [].concat(key)) if (k in data) out[k] = structuredClone(data[k]);
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            log.writes.push(k);
            changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
            data[k] = structuredClone(v);
          }
          for (const fn of listeners) fn(changes, 'local');
        },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    permissions: {
      async contains(p) {
        log.contains.push(structuredClone(p));
        return p.origins.every((o) => grantedSet.has(o));
      },
      request(p) {
        log.requests.push(structuredClone(p));
        if (allow) for (const o of p.origins) grantedSet.add(o);
        return Promise.resolve(allow);
      },
    },
    tabs: {
      async query() {
        return activeUrl ? [{ id: 1, url: activeUrl }] : [];
      },
    },
  };
  for (const f of SCRIPTS) w.eval(readFileSync(new URL(f, EXT), 'utf8') + '\n//# sourceURL=' + f);
  await settle(30); // DOMContentLoaded → mount
  const ctl = w.DCC.workspaceAppearance.current();
  if (ctl) await ctl.ready;
  await settle(10);
  const q = (sel) => w.document.querySelector(sel);
  const el = {
    saved: q('#dcc-ap-saved'),
    url: q('#dcc-ap-url'),
    urlMsg: q('#dcc-ap-url-msg'),
    picker: q('#dcc-ap-picker'),
    hex: q('#dcc-ap-hex'),
    hexMsg: q('#dcc-ap-hex-msg'),
    previewBar: q('.dcc-ap-preview-bar'),
    preview: q('#dcc-ap-preview'),
    contrast: q('#dcc-ap-contrast'),
    applies: q('#dcc-ap-applies'),
    save: q('#dcc-ap-save'),
    reset: q('#dcc-ap-reset'),
    status: q('#dcc-ap-status'),
  };
  const input = async (node, value) => {
    node.value = value;
    node.dispatchEvent(new w.Event('input', { bubbles: true }));
    await settle(10);
  };
  const select = async (value) => {
    el.saved.value = value;
    el.saved.dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle(10);
  };
  return { dom, w, doc: w.document, ctl, el, data, log, input, select, close: () => w.close() };
}

test('popup: no section → no-op; with section the panel mounts once with a local-only note (simulated)', async () => {
  const none = await openPopup({ section: false });
  assert.equal(none.ctl, null);
  assert.equal(none.doc.querySelector('.dcc-ap-body'), null);
  none.close();

  const p = await openPopup();
  assert.ok(p.ctl);
  assert.equal(p.doc.querySelectorAll('.dcc-ap-body').length, 1);
  p.w.DCC.workspaceAppearance.init(); // a second init does nothing
  assert.equal(p.doc.querySelectorAll('.dcc-ap-body').length, 1);
  assert.match(p.doc.querySelector('.dcc-ap-note').textContent, /only in this browser profile/);
  assert.equal(p.doc.querySelector('#dcc-ap-title').textContent, 'Workspace colors');
  assert.equal(p.doc.querySelectorAll('.dcc-ap-preset').length, 6);
  for (const b of p.doc.querySelectorAll('.dcc-ap-preset')) assert.match(b.getAttribute('aria-label'), /^\w+ #[0-9A-F]{6}$/);
  // Nothing is written until the user saves.
  assert.deepEqual(p.log.writes, []);
  p.close();
});

test('popup: hex field and native picker stay in sync; presets and preview follow (simulated)', async () => {
  const p = await openPopup();
  await p.input(p.el.picker, '#b42318');
  assert.equal(p.el.hex.value, '#B42318');
  assert.equal(p.el.previewBar.style.backgroundColor, 'rgb(180, 35, 24)');
  assert.equal(p.el.previewBar.style.color, 'rgb(255, 255, 255)');
  assert.match(p.el.contrast.textContent, /White text · contrast 6\.57:1/);
  assert.match(p.el.preview.getAttribute('aria-label'), /white text on #B42318/);
  assert.equal(p.doc.querySelector('.dcc-ap-preset[data-color="#B42318"]').getAttribute('aria-pressed'), 'true');

  await p.input(p.el.hex, '#f79009');
  assert.equal(p.el.picker.value, '#f79009');
  assert.equal(p.el.previewBar.style.color, 'rgb(0, 0, 0)');
  assert.match(p.el.contrast.textContent, /Black text/);
  assert.equal(p.doc.querySelector('.dcc-ap-preset[data-color="#B42318"]').getAttribute('aria-pressed'), 'false');

  p.doc.querySelector('.dcc-ap-preset[data-color="#067647"]').click();
  await settle(10);
  assert.equal(p.el.hex.value, '#067647');
  assert.equal(p.el.picker.value, '#067647');
  assert.equal(p.doc.querySelector('.dcc-ap-preset[data-color="#067647"]').getAttribute('aria-pressed'), 'true');
  p.close();
});

test('popup: invalid hex disables Save and never reaches the preview or storage (simulated)', async () => {
  const p = await openPopup();
  await p.input(p.el.url, ORIGIN + '/?o=42');
  await p.input(p.el.hex, '#B42318');
  assert.equal(p.el.save.disabled, false);
  for (const bad of ['#12345', '#GGGGGG', 'B42318', '#123456;}body{background:red}', 'red', '']) {
    await p.input(p.el.hex, bad);
    assert.equal(p.el.save.disabled, true, bad);
    assert.equal(p.el.hex.getAttribute('aria-invalid'), 'true', bad);
    assert.match(p.el.hexMsg.textContent, /^Enter exactly six hex digits after #/);
    assert.match(p.el.hexMsg.className, /dcc-ap-error/);
    assert.equal(p.el.previewBar.style.backgroundColor, '', bad);
    assert.equal(p.el.picker.value, '#b42318', 'picker keeps the last valid color');
  }
  p.el.save.click();
  await settle(20);
  assert.deepEqual(p.log.writes, []);
  assert.deepEqual(p.log.requests, []);
  p.close();
});

test('popup: unsupported or ambiguous URLs disable Save with a plain message (simulated)', async () => {
  const p = await openPopup();
  for (const [url, re] of [
    ['https://accounts.cloud.databricks.com/', /account console/],
    ['https://example.com/', /supported Databricks workspace host/],
    [ORIGIN + '/?o=1&o=2', /conflicting workspace IDs/],
    ['http://dbc-1.cloud.databricks.com/', /https:\/\//],
  ]) {
    await p.input(p.el.url, url);
    assert.match(p.el.urlMsg.textContent, re, url);
    assert.equal(p.el.url.getAttribute('aria-invalid'), 'true');
    assert.equal(p.el.save.disabled, true, url);
  }
  p.close();
});

test('popup: Save requests exactly that origin in the click, stores the color, then asks the background to apply access (simulated)', async () => {
  const p = await openPopup({ storage: { 'dcc.settings': { mode: 'demo' }, 'dcc.connections': {} } });
  await p.input(p.el.url, ORIGIN + '/jobs/12?o=42');
  assert.match(p.el.urlMsg.textContent, /Workspace 42 on dbc-1\.cloud\.databricks\.com/);
  assert.deepEqual(p.log.contains, [{ origins: [ORIGIN + '/*'] }]);
  assert.match(p.el.applies.textContent, /will be requested when you save/);
  await p.input(p.el.hex, '#b42318');

  p.el.save.click();
  // The request happens synchronously inside the click (user activation is still valid).
  assert.deepEqual(p.log.requests, [{ origins: [ORIGIN + '/*'] }]);
  await settle(30);
  assert.deepEqual(p.data[KEY].entries, { [ORIGIN + '|42']: { color: '#B42318', savedAt: p.data[KEY].entries[ORIGIN + '|42'].savedAt } });
  assert.equal(p.data[KEY].version, 1);
  assert.deepEqual(p.log.writes, [KEY], 'only the appearance key is written');
  assert.deepEqual(p.data['dcc.settings'], { mode: 'demo' });
  assert.deepEqual(p.data['dcc.connections'], {});
  const apply = p.log.messages.filter((m) => m.type === 'appearance:applyAccess');
  assert.deepEqual(apply, [{ type: 'appearance:applyAccess', origin: ORIGIN }]);
  assert.match(p.el.status.textContent, /Saved #B42318 for workspace 42/);
  assert.match(p.el.status.textContent, /applied to 2 open tabs/);
  assert.equal(p.el.reset.disabled, false);
  // The new entry appears in the saved list.
  assert.ok([...p.el.saved.options].some((o) => o.value === ORIGIN + '|42' && /workspace 42 · #B42318/.test(o.textContent)));
  p.close();
});

test('popup: with access already granted, Save neither prompts nor re-injects (simulated)', async () => {
  const p = await openPopup({ granted: [ORIGIN + '/*'] });
  await p.input(p.el.url, ORIGIN + '/?o=42');
  await p.input(p.el.hex, '#1D4ED8');
  p.el.save.click();
  await settle(30);
  assert.deepEqual(p.log.requests, []);
  assert.equal(p.log.messages.filter((m) => m.type === 'appearance:applyAccess').length, 0);
  assert.equal(p.data[KEY].entries[ORIGIN + '|42'].color, '#1D4ED8');
  assert.match(p.el.status.textContent, /update automatically/);
  p.close();
});

test('popup: when site access is declined the color is saved and the user is told it cannot show yet (simulated)', async () => {
  const p = await openPopup({ allow: false });
  await p.input(p.el.url, ORIGIN + '/?o=42');
  await p.input(p.el.hex, '#6941C6');
  p.el.save.click();
  await settle(30);
  assert.equal(p.log.requests.length, 1);
  assert.equal(p.data[KEY].entries[ORIGIN + '|42'].color, '#6941C6');
  assert.equal(p.log.messages.filter((m) => m.type === 'appearance:applyAccess').length, 0);
  assert.match(p.el.status.textContent, /wasn’t allowed/);
  assert.match(p.el.status.className, /dcc-ap-warn/);
  p.close();
});

test('popup: a URL without an ID saves the host default (simulated)', async () => {
  const p = await openPopup({ granted: [ORIGIN + '/*'] });
  await p.input(p.el.url, 'dbc-1.cloud.databricks.com');
  assert.match(p.el.urlMsg.textContent, /Host default for dbc-1\.cloud\.databricks\.com/);
  assert.match(p.el.applies.textContent, /default for every workspace/);
  await p.input(p.el.hex, '#344054');
  p.el.save.click();
  await settle(30);
  assert.deepEqual(Object.keys(p.data[KEY].entries), [ORIGIN + '|*']);
  assert.match(p.el.status.textContent, /host default for dbc-1\.cloud\.databricks\.com/);
  p.close();
});

test('popup: Reset of an ID override says when the host default still applies (simulated)', async () => {
  const storage = { [KEY]: { version: 1, entries: { [ORIGIN + '|42']: { color: '#B42318', savedAt: 1 }, [ORIGIN + '|*']: { color: '#344054', savedAt: 1 } } } };
  const p = await openPopup({ storage, granted: [ORIGIN + '/*'] });
  await p.select(ORIGIN + '|42');
  assert.equal(p.el.url.value, ORIGIN + '/?o=42');
  assert.equal(p.el.hex.value, '#B42318');
  assert.equal(p.el.reset.disabled, false);
  p.el.reset.click();
  await settle(30);
  assert.deepEqual(Object.keys(p.data[KEY].entries), [ORIGIN + '|*']);
  assert.match(p.el.status.textContent, /The host default #344054 for dbc-1\.cloud\.databricks\.com still applies to this workspace/);
  assert.equal(p.el.reset.disabled, true);
  assert.match(p.el.applies.textContent, /host default #344054 applies now/);

  // Resetting the host default too returns the bar to its native color.
  await p.select(ORIGIN + '|*');
  p.el.reset.click();
  await settle(30);
  assert.deepEqual(p.data[KEY].entries, {});
  assert.match(p.el.status.textContent, /returns to its native color/);
  assert.deepEqual(p.log.requests, []);
  p.close();
});

test('popup: saved list merges saved colors, cost connections and observed tabs; invalid entries are dropped (simulated)', async () => {
  const storage = { [KEY]: { version: 1, entries: { [ORIGIN + '|42']: { color: '#B42318', savedAt: 1 }, ['https://evil.example.com|1']: { color: '#000000' } } } };
  const state = {
    connections: { 'https://dbc-2.cloud.databricks.com': { workspaceId: '77' }, 'https://evil.example.com': { workspaceId: '1' }, [ORIGIN]: { workspaceId: '42' } },
    observed: { 'https://adb-5555.12.azuredatabricks.net': { workspaceId: '5555', seenAt: 1 }, 'https://dbc-3.cloud.databricks.com': { workspaceId: 'x' } },
  };
  const p = await openPopup({ storage, state });
  const opts = [...p.el.saved.options].map((o) => [o.value, o.textContent]);
  assert.deepEqual(opts, [
    ['', 'Choose a workspace…'],
    [ORIGIN + '|42', 'dbc-1.cloud.databricks.com · workspace 42 · #B42318'],
    ['https://adb-5555.12.azuredatabricks.net|5555', 'adb-5555.12.azuredatabricks.net · workspace 5555 (seen in a tab)'],
    ['https://dbc-2.cloud.databricks.com|77', 'dbc-2.cloud.databricks.com · workspace 77 (cost connection)'],
  ]);
  assert.deepEqual(p.log.messages.map((m) => m.type), ['page:state']);
  p.close();
});

test('popup: active workspace tab prefills origin and ID only (simulated)', async () => {
  const storage = { [KEY]: { version: 1, entries: { [ORIGIN + '|42']: { color: '#067647', savedAt: 1 } } } };
  const p = await openPopup({ storage, activeUrl: ORIGIN + '/sql/history?o=42&queryId=01234567-89ab-cdef-0123-456789abcdef' });
  assert.equal(p.el.url.value, ORIGIN + '/?o=42');
  assert.equal(p.el.saved.value, ORIGIN + '|42');
  assert.equal(p.el.hex.value, '#067647');
  p.close();
  const other = await openPopup({ activeUrl: 'https://example.com/?o=42' });
  assert.equal(other.el.url.value, '');
  other.close();
});

test('popup: the sidebar checkbox is saved with the color and restored with the saved entry (simulated)', async () => {
  const storage = { [KEY]: { version: 1, entries: { [ORIGIN + '|43']: { color: '#067647', savedAt: 1, sidebar: true } } } };
  const p = await openPopup({ storage, granted: [ORIGIN + '/*'] });
  const box = p.doc.querySelector('#dcc-ap-sidebar');
  assert.equal(box.type, 'checkbox');
  assert.equal(p.doc.querySelector('label[for="dcc-ap-sidebar"]').textContent, 'Also color the sidebar');
  assert.equal(box.getAttribute('aria-describedby'), 'dcc-ap-sidebar-msg');
  assert.equal(box.checked, false, 'off by default');

  await p.input(p.el.url, ORIGIN + '/?o=42');
  await p.input(p.el.hex, '#B42318');
  box.click();
  await settle(10);
  p.el.save.click();
  await settle(30);
  assert.deepEqual(p.data[KEY].entries[ORIGIN + '|42'], { color: '#B42318', savedAt: p.data[KEY].entries[ORIGIN + '|42'].savedAt, sidebar: true });
  assert.match(p.el.status.textContent, /Saved #B42318 for workspace 42 on dbc-1\.cloud\.databricks\.com \(top bar and sidebar\)\./);
  assert.match(p.el.applies.textContent, /top bar and sidebar/);

  // Unchecked and saved again: the flag is dropped, not stored as false.
  box.click();
  await settle(10);
  p.el.save.click();
  await settle(30);
  assert.deepEqual(Object.keys(p.data[KEY].entries[ORIGIN + '|42']).sort(), ['color', 'savedAt']);
  assert.match(p.el.status.textContent, /\(top bar only\)\./);

  // Choosing a saved entry restores its choice along with its color.
  await p.select(ORIGIN + '|43');
  assert.equal(p.el.hex.value, '#067647');
  assert.equal(box.checked, true);
  await p.select(ORIGIN + '|42');
  assert.equal(box.checked, false);
  p.close();
});

test('popup: the preview shows the sidebar strip and blended search only from validated tones (simulated)', async () => {
  const p = await openPopup();
  const box = p.doc.querySelector('#dcc-ap-sidebar');
  const side = p.doc.querySelector('.dcc-ap-pv-side');
  const search = p.doc.querySelector('.dcc-ap-pv-search');
  await p.input(p.el.hex, '#1D4ED8');
  const t = p.w.DCC.workspaceColor.themeFor('#1D4ED8');
  const rgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
  assert.equal(search.style.backgroundColor, rgb(t.surface));
  assert.equal(search.style.color, rgb(t.muted));
  assert.equal(side.style.backgroundColor, '', 'sidebar strip stays neutral while the option is off');
  assert.match(p.el.preview.getAttribute('aria-label'), /top bar only/);
  assert.match(p.el.contrast.textContent, /darker shade of the same color/);

  box.click();
  await settle(10);
  assert.equal(side.style.backgroundColor, 'rgb(29, 78, 216)');
  assert.equal(p.doc.querySelector('.dcc-ap-pv-item--on').style.backgroundColor, rgb(t.surface));
  assert.match(p.el.preview.getAttribute('aria-label'), /top bar and sidebar/);

  await p.input(p.el.hex, '#F79009');
  assert.match(p.el.contrast.textContent, /lighter shade of the same color/);

  // An invalid color clears every inline tone.
  await p.input(p.el.hex, '#12345');
  assert.equal(side.style.backgroundColor, '');
  assert.equal(search.style.backgroundColor, '');
  assert.equal(search.style.color, '');
  p.close();
});
