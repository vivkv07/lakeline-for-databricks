/*
 * Popup → Workspace colors panel. Independent of billing: no sign-in, helper or SQL. Colors are
 * saved in chrome.storage.local ('dcc.appearance') of this browser profile only.
 *
 * Mounts into <section id="appearance-panel"> after DOMContentLoaded; does nothing when the
 * section is missing. Needs these scripts loaded first (classic, in this order):
 *   ../src/core/validate.js, ../src/core/ids.js, ../src/content/workspace-color.js
 *
 * On Save, site access for exactly that workspace origin is requested inside the click handler
 * when it isn't already granted; after a new grant the service worker is asked to register the
 * content scripts and inject them into open tabs ('appearance:applyAccess').
 */
(function (root) {
  'use strict';
  const PANEL_ID = 'appearance-panel';
  const DEFAULT_COLOR = '#1D4ED8';
  let lastMounted = null;

  function h(doc, tag, attrs, children) {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of [].concat(children === undefined ? [] : children)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    }
    return el;
  }

  function hostOf(origin) {
    try {
      return new URL(origin).host;
    } catch (_) {
      return String(origin);
    }
  }

  /**
   * @param {HTMLElement} section  the <section id="appearance-panel"> element
   * @param {{chromeApi: object, DCC?: object, now?: () => number}} opts
   */
  function mount(section, opts) {
    const doc = section.ownerDocument;
    const chromeApi = opts.chromeApi;
    const C = (opts.DCC || root.DCC).workspaceColor;
    const now = opts.now || (() => Date.now());
    const area = chromeApi.storage.local;
    const sendMessage = (msg) => Promise.resolve().then(() => chromeApi.runtime.sendMessage(msg));
    const el = (tag, attrs, children) => h(doc, tag, attrs, children);

    let appearance = C.emptyAppearance();
    let state = { connections: {}, observed: {} };
    const access = new Map(); // origin → true | false (from permissions.contains / request)
    let busy = false;

    /* ---------------------------------------------------------------- markup */

    section.classList.add('dcc-ap');
    let heading = section.querySelector('h1, h2, h3');
    if (!heading) {
      heading = el('h2', { class: 'dcc-ap-title', id: 'dcc-ap-title' }, 'Workspace colors');
      section.appendChild(heading);
    }
    if (!heading.id) heading.id = 'dcc-ap-title';
    if (!section.hasAttribute('aria-labelledby') && !section.hasAttribute('aria-label')) section.setAttribute('aria-labelledby', heading.id);

    const savedSelect = el('select', { id: 'dcc-ap-saved', class: 'dcc-select' });
    const urlInput = el('input', {
      id: 'dcc-ap-url',
      class: 'dcc-input',
      type: 'url',
      inputmode: 'url',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'https://dbc-1234.cloud.databricks.com/?o=1234',
      'aria-describedby': 'dcc-ap-url-msg',
    });
    const urlMsg = el('p', { id: 'dcc-ap-url-msg', class: 'dcc-ap-hint' });
    const picker = el('input', { id: 'dcc-ap-picker', class: 'dcc-ap-picker', type: 'color', value: DEFAULT_COLOR.toLowerCase() });
    const hexInput = el('input', {
      id: 'dcc-ap-hex',
      class: 'dcc-input dcc-input--mono dcc-ap-hex',
      type: 'text',
      value: DEFAULT_COLOR,
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-describedby': 'dcc-ap-hex-msg',
    });
    const hexMsg = el('p', { id: 'dcc-ap-hex-msg', class: 'dcc-ap-hint' }, 'Six hex digits, like #1D4ED8.');
    const presetButtons = C.PRESETS.map((p) => {
      const swatch = el('span', { class: 'dcc-ap-swatch', 'aria-hidden': 'true' });
      swatch.style.backgroundColor = p.color; // static, validated constant
      return el('button', { type: 'button', class: 'dcc-ap-preset', 'data-color': p.color, 'aria-pressed': 'false', 'aria-label': p.name + ' ' + p.color, title: p.name + ' ' + p.color, onclick: () => setColor(p.color, true) }, swatch);
    });
    const previewBar = el('div', { class: 'dcc-ap-preview-bar' }, [
      el('span', { class: 'dcc-ap-pv-mark', 'aria-hidden': 'true' }),
      el('span', { class: 'dcc-ap-pv-name' }, 'Workspace'),
      el('span', { class: 'dcc-ap-pv-search' }, 'Search'),
      el('span', { class: 'dcc-ap-pv-icon', 'aria-hidden': 'true' }, '?'),
    ]);
    const previewName = previewBar.querySelector('.dcc-ap-pv-name');
    const preview = el('div', { id: 'dcc-ap-preview', class: 'dcc-ap-preview', role: 'img' }, previewBar);
    const contrastLine = el('p', { id: 'dcc-ap-contrast', class: 'dcc-ap-hint' });
    const appliesLine = el('p', { id: 'dcc-ap-applies', class: 'dcc-ap-applies' });
    const saveBtn = el('button', { type: 'button', id: 'dcc-ap-save', class: 'dcc-btn dcc-btn--primary', onclick: onSave }, 'Save');
    const resetBtn = el('button', { type: 'button', id: 'dcc-ap-reset', class: 'dcc-btn', onclick: onReset }, 'Reset');
    const statusLine = el('p', { id: 'dcc-ap-status', class: 'dcc-ap-status', role: 'status', 'aria-live': 'polite' });

    section.appendChild(
      el('div', { class: 'dcc-ap-body' }, [
        el('p', { class: 'dcc-ap-intro' }, 'Tint the Databricks top bar per workspace so environments are easy to tell apart. Works without a cost connection.'),
        el('div', { class: 'dcc-ap-field' }, [el('label', { for: 'dcc-ap-saved', class: 'dcc-ap-label' }, 'Saved workspace'), savedSelect]),
        el('div', { class: 'dcc-ap-field' }, [el('label', { for: 'dcc-ap-url', class: 'dcc-ap-label' }, 'Workspace URL'), urlInput, urlMsg]),
        el('fieldset', { class: 'dcc-fieldset dcc-ap-colors' }, [
          el('legend', { class: 'dcc-ap-label' }, 'Top-bar color'),
          el('div', { class: 'dcc-ap-row' }, [
            picker,
            el('label', { for: 'dcc-ap-picker', class: 'dcc-visually-hidden' }, 'Color picker'),
            el('label', { for: 'dcc-ap-hex', class: 'dcc-ap-hex-label' }, 'Hex'),
            hexInput,
          ]),
          hexMsg,
          el('div', { class: 'dcc-ap-presets', role: 'group', 'aria-label': 'Preset colors' }, presetButtons),
        ]),
        el('div', { class: 'dcc-ap-field' }, [el('span', { class: 'dcc-ap-label', id: 'dcc-ap-preview-label' }, 'Preview'), preview, contrastLine]),
        appliesLine,
        el('div', { class: 'dcc-ap-actions' }, [saveBtn, resetBtn]),
        statusLine,
        el('p', { class: 'dcc-ap-note' }, 'Colors are stored only in this browser profile. They aren’t synced, shared, or sent anywhere, and changing the cost connection never changes them.'),
      ])
    );

    /* ---------------------------------------------------------------- state helpers */

    const target = () => C.targetFromUrl(urlInput.value);
    const currentColor = () => C.parseHexInput(hexInput.value);

    function canonicalUrl(t) {
      return t.origin + '/' + (t.workspaceId ? '?o=' + t.workspaceId : '');
    }

    function describeKey(key) {
      const p = C.parseKey(key);
      if (!p) return null;
      return hostOf(p.origin) + (p.workspaceId ? ' · workspace ' + p.workspaceId : ' · all workspaces (host default)');
    }

    function setStatus(text, kind) {
      statusLine.textContent = text || '';
      statusLine.className = 'dcc-ap-status' + (kind ? ' dcc-ap-' + kind : '');
    }

    function setColor(color, fromUser) {
      const c = C.normalizeColor(color);
      if (!c) return;
      hexInput.value = c;
      picker.value = c.toLowerCase();
      if (fromUser) setStatus('');
      refresh();
    }

    function rebuildOptions() {
      const keep = savedSelect.value;
      savedSelect.textContent = '';
      savedSelect.appendChild(el('option', { value: '' }, 'Choose a workspace…'));
      const savedKeys = Object.keys(appearance.entries).sort();
      if (savedKeys.length) {
        const g = el('optgroup', { label: 'Saved colors' });
        for (const k of savedKeys) g.appendChild(el('option', { value: k }, describeKey(k) + ' · ' + appearance.entries[k].color));
        savedSelect.appendChild(g);
      }
      const others = new Map();
      for (const [origin, c] of Object.entries(state.connections || {})) {
        const k = C.entryKey(origin, c && c.workspaceId);
        if (k && C.parseKey(k).workspaceId && !appearance.entries[k] && !others.has(k)) others.set(k, describeKey(k) + ' (cost connection)');
      }
      for (const [origin, o] of Object.entries(state.observed || {})) {
        const k = C.entryKey(origin, o && o.workspaceId);
        if (k && C.parseKey(k).workspaceId && !appearance.entries[k] && !others.has(k)) others.set(k, describeKey(k) + ' (seen in a tab)');
      }
      if (others.size) {
        const g = el('optgroup', { label: 'Other workspaces' });
        for (const [k, label] of [...others.entries()].sort()) g.appendChild(el('option', { value: k }, label));
        savedSelect.appendChild(g);
      }
      savedSelect.value = [...savedSelect.options].some((o) => o.value === keep) ? keep : '';
    }

    function renderPreview(theme, t) {
      previewName.textContent = t && t.ok ? (t.workspaceId ? 'Workspace ' + t.workspaceId : t.host) : 'Workspace';
      if (!theme) {
        previewBar.style.backgroundColor = '';
        previewBar.style.color = '';
        previewBar.classList.add('dcc-ap-preview-empty');
        preview.setAttribute('aria-label', 'Preview unavailable until a valid color is entered');
        contrastLine.textContent = '';
        return;
      }
      previewBar.classList.remove('dcc-ap-preview-empty');
      previewBar.style.backgroundColor = theme.bg; // validated #RRGGBB
      previewBar.style.color = theme.fg; // black or white
      const fgLabel = theme.fgName === 'white' ? 'White' : 'Black';
      preview.setAttribute('aria-label', 'Preview: ' + theme.fgName + ' text on ' + theme.bg + ', contrast ' + theme.contrast.toFixed(2) + ' to 1');
      contrastLine.textContent = fgLabel + ' text · contrast ' + theme.contrast.toFixed(2) + ':1. Search fields stay light so they remain readable.';
    }

    function describeApplies(t) {
      if (!t.ok) return '';
      const own = appearance.entries[t.key];
      const hostKey = C.entryKey(t.origin, null);
      const hostDefault = appearance.entries[hostKey];
      let text;
      if (t.scope === 'host') {
        const overrides = Object.keys(appearance.entries).filter((k) => k !== hostKey && C.parseKey(k).origin === t.origin).length;
        text = 'No workspace ID in this URL, so the color becomes the default for every workspace on ' + t.host + ' that has no color of its own.';
        if (own) text += ' Saved host default: ' + own.color + '.';
        if (overrides) text += ' ' + overrides + ' workspace-specific color' + (overrides === 1 ? '' : 's') + ' on this host take' + (overrides === 1 ? 's' : '') + ' priority.';
      } else if (own) {
        text = 'Saved color for workspace ' + t.workspaceId + ': ' + own.color + '.';
      } else if (hostDefault) {
        text = 'No color saved for workspace ' + t.workspaceId + '. The host default ' + hostDefault.color + ' applies now.';
      } else {
        text = 'No color saved for workspace ' + t.workspaceId + ' yet. The top bar keeps its native color.';
      }
      const granted = access.get(t.origin);
      if (granted === false) text += ' Site access for ' + t.host + ' will be requested when you save.';
      return text;
    }

    function refresh() {
      const t = target();
      const color = currentColor();
      const urlTyped = urlInput.value.trim() !== '';

      urlMsg.textContent = t.ok ? (t.scope === 'host' ? 'Host default for ' + t.host + '.' : 'Workspace ' + t.workspaceId + ' on ' + t.host + '.') : urlTyped ? t.message : 'Paste a workspace URL. Include ?o=<workspace ID> to color one workspace; leave it out to set a default for the whole host.';
      urlMsg.classList.toggle('dcc-ap-error', urlTyped && !t.ok);
      urlInput.setAttribute('aria-invalid', String(urlTyped && !t.ok));

      hexInput.setAttribute('aria-invalid', String(!color));
      hexMsg.textContent = color ? 'Six hex digits, like #1D4ED8.' : 'Enter exactly six hex digits after #, like #1D4ED8.';
      hexMsg.classList.toggle('dcc-ap-error', !color);
      for (const b of presetButtons) b.setAttribute('aria-pressed', String(b.getAttribute('data-color') === color));

      renderPreview(color ? C.themeFor(color) : null, t);
      appliesLine.textContent = describeApplies(t);

      saveBtn.disabled = busy || !t.ok || !color;
      resetBtn.disabled = busy || !t.ok || !appearance.entries[t.key];
    }

    async function checkAccess(t) {
      if (!t.ok || access.has(t.origin) || !chromeApi.permissions) return;
      try {
        const ok = await chromeApi.permissions.contains({ origins: [C.sitePattern(t.origin)] });
        access.set(t.origin, Boolean(ok));
      } catch (_) {
        /* unknown: Save will ask */
      }
      refresh();
    }

    async function readAppearance() {
      const got = await area.get(C.STORAGE_KEY);
      return C.sanitizeAppearance(got && got[C.STORAGE_KEY]);
    }

    /** Read-modify-write from the latest stored value so concurrent edits elsewhere aren't lost. */
    async function writeAppearance(change) {
      const next = change(await readAppearance());
      await area.set({ [C.STORAGE_KEY]: next });
      appearance = next;
      rebuildOptions();
      return next;
    }

    /* ---------------------------------------------------------------- events */

    function onUrlInput() {
      const t = target();
      savedSelect.value = t.ok && [...savedSelect.options].some((o) => o.value === t.key) ? t.key : '';
      setStatus('');
      refresh();
      checkAccess(t);
    }

    function onSelect() {
      const p = C.parseKey(savedSelect.value);
      if (!p) return;
      urlInput.value = p.origin + '/' + (p.workspaceId ? '?o=' + p.workspaceId : '');
      const saved = appearance.entries[savedSelect.value];
      if (saved) setColor(saved.color);
      setStatus('');
      refresh();
      checkAccess(target());
    }

    async function onSave() {
      const t = target();
      const color = currentColor();
      if (!t.ok || !color || busy) {
        refresh();
        return;
      }
      busy = true;
      refresh();
      let granted = access.get(t.origin) === true;
      let newlyGranted = false;
      if (!granted) {
        // Called before any other await so the click's user activation is still valid.
        try {
          granted = Boolean(await chromeApi.permissions.request({ origins: [C.sitePattern(t.origin)] }));
        } catch (_) {
          granted = false;
        }
        newlyGranted = granted;
        access.set(t.origin, granted);
      }
      try {
        await writeAppearance((app) => C.withEntry(app, t.key, color, now()));
      } catch (_) {
        busy = false;
        setStatus('The color couldn’t be saved. Try again.', 'error');
        refresh();
        return;
      }
      const what = t.scope === 'host' ? 'the host default for ' + t.host : 'workspace ' + t.workspaceId + ' on ' + t.host;
      let text = 'Saved ' + color + ' for ' + what + '.';
      let kind = 'ok';
      if (!granted) {
        text += ' Site access for ' + t.host + ' wasn’t allowed, so the color can’t show yet. Select Save again to allow it.';
        kind = 'warn';
      } else if (newlyGranted) {
        const res = await sendMessage({ type: 'appearance:applyAccess', origin: t.origin }).catch(() => null);
        if (res && res.ok && res.data && res.data.injected > 0) text += ' Site access allowed; applied to ' + res.data.injected + ' open tab' + (res.data.injected === 1 ? '' : 's') + '.';
        else if (res && res.ok) text += ' Site access allowed. Open or reload a tab on this workspace to see it.';
        else text += ' Site access allowed. Reload open tabs on this workspace to see the color.';
      } else {
        text += ' Open tabs on this workspace update automatically.';
      }
      busy = false;
      setStatus(text, kind);
      refresh();
    }

    async function onReset() {
      const t = target();
      if (!t.ok || busy) return;
      busy = true;
      refresh();
      let outcome = null;
      try {
        await writeAppearance((app) => {
          outcome = C.resetOutcome(app, t.key);
          return C.withoutEntry(app, t.key);
        });
      } catch (_) {
        busy = false;
        setStatus('The color couldn’t be reset. Try again.', 'error');
        refresh();
        return;
      }
      busy = false;
      if (!outcome.removed) {
        setStatus('No color was saved for this ' + (t.scope === 'host' ? 'host' : 'workspace') + '.');
      } else if (outcome.hostDefault) {
        setStatus('Removed the color for workspace ' + t.workspaceId + '. The host default ' + outcome.hostDefault + ' for ' + t.host + ' still applies to this workspace. Reset the host default to remove it too.', 'warn');
      } else if (t.scope === 'host' && outcome.overridesLeft) {
        setStatus('Removed the host default for ' + t.host + '. ' + outcome.overridesLeft + ' workspace-specific color' + (outcome.overridesLeft === 1 ? '' : 's') + ' on this host still appl' + (outcome.overridesLeft === 1 ? 'ies' : 'y') + '.', 'ok');
      } else {
        setStatus('Removed the color for ' + (t.scope === 'host' ? 'the host default for ' + t.host : 'workspace ' + t.workspaceId) + '. The top bar returns to its native color.', 'ok');
      }
      refresh();
    }

    urlInput.addEventListener('input', onUrlInput);
    savedSelect.addEventListener('change', onSelect);
    picker.addEventListener('input', () => setColor(picker.value, true));
    picker.addEventListener('change', () => setColor(picker.value, true));
    hexInput.addEventListener('input', () => {
      const c = currentColor();
      if (c) picker.value = c.toLowerCase();
      setStatus('');
      refresh();
    });
    hexInput.addEventListener('change', () => {
      const c = currentColor();
      if (c) hexInput.value = c; // canonical uppercase once the edit is committed
      refresh();
    });

    if (chromeApi.storage.onChanged && chromeApi.storage.onChanged.addListener) {
      chromeApi.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !changes[C.STORAGE_KEY]) return;
        appearance = C.sanitizeAppearance(changes[C.STORAGE_KEY].newValue);
        rebuildOptions();
        refresh();
      });
    }

    /* ---------------------------------------------------------------- initial load */

    async function activeTabUrl() {
      try {
        if (!chromeApi.tabs || !chromeApi.tabs.query) return null;
        const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
        return tabs && tabs[0] && typeof tabs[0].url === 'string' ? tabs[0].url : null;
      } catch (_) {
        return null;
      }
    }

    rebuildOptions();
    refresh();
    const ready = (async () => {
      const [app, res, activeUrl] = await Promise.all([
        readAppearance().catch(() => C.emptyAppearance()),
        sendMessage({ type: 'page:state' }).catch(() => null),
        activeTabUrl(),
      ]);
      appearance = app;
      if (res && res.ok && res.data) state = { connections: res.data.connections || {}, observed: res.data.observed || {} };
      rebuildOptions();
      // Start from the active workspace tab when there is one (origin and ID only, no path).
      const t = activeUrl ? C.targetFromUrl(activeUrl) : null;
      if (t && t.ok && !urlInput.value.trim()) {
        urlInput.value = canonicalUrl(t);
        if ([...savedSelect.options].some((o) => o.value === t.key)) savedSelect.value = t.key;
        const saved = appearance.entries[t.key];
        if (saved) setColor(saved.color);
        await checkAccess(t);
      }
      refresh();
    })();

    return { ready, refresh, elements: { savedSelect, urlInput, picker, hexInput, presetButtons, preview, previewBar, contrastLine, appliesLine, saveBtn, resetBtn, statusLine } };
  }

  function init() {
    const doc = root.document;
    const section = doc && doc.getElementById(PANEL_ID);
    if (!section || section.getAttribute('data-dcc-mounted') === 'appearance') return null;
    if (!root.DCC || !root.DCC.workspaceColor || !root.chrome || !root.chrome.storage) return null;
    section.setAttribute('data-dcc-mounted', 'appearance');
    lastMounted = mount(section, { chromeApi: root.chrome });
    return lastMounted;
  }

  const api = Object.freeze({ PANEL_ID, mount, init, current: () => lastMounted });
  (root.DCC || (root.DCC = {})).workspaceAppearance = api;

  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
