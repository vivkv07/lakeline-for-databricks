/*
 * Helper setup page. The one-time pairing key arrives in the URL fragment (#k=<24 hex>), which
 * browsers never send to the server. It is read and removed from the address bar immediately,
 * then kept only in this closure. "Connect workspace" hands it to the extension through
 * externally_connectable; the extension verifies it against the helper before storing it in
 * session storage and opening Connection preferences.
 */
(function () {
  'use strict';

  // Public identifier of the unpacked extension (stable via the manifest `key`). Not a secret.
  var EXTENSION_ID = 'jfhjmnhnmkgknkjhmchcjddonpngcgna';
  var KEY_RE = /^#k=([0-9a-f]{24})$/;
  var PAIR_TIMEOUT_MS = 20000;

  var key = null;
  var hadFragment = false;
  (function takeKey() {
    var hash = window.location.hash || '';
    if (/^#k=/.test(hash)) {
      hadFragment = true;
      var m = KEY_RE.exec(hash);
      if (m) key = m[1];
      // Remove the fragment before anything else can read or record it.
      window.history.replaceState(null, '', '/setup');
    }
  })();

  function $(id) {
    return document.getElementById(id);
  }

  function runtime() {
    var c = window.chrome;
    return c && c.runtime && typeof c.runtime.sendMessage === 'function' ? c.runtime : null;
  }

  function show(id, on) {
    var el = $(id);
    if (el) el.hidden = !on;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function setStatus(kind, title, steps) {
    var el = $('status');
    clear(el);
    el.className = 'status ' + (kind || '');
    if (!title) return;
    var p = document.createElement('p');
    p.className = 'status-title';
    p.textContent = title;
    el.appendChild(p);
    if (steps && steps.length) {
      var ul = document.createElement('ul');
      steps.slice(0, 6).forEach(function (s) {
        var li = document.createElement('li');
        li.textContent = String(s).slice(0, 400);
        ul.appendChild(li);
      });
      el.appendChild(ul);
    }
  }

  function showNoExtension(reason) {
    show('state-no-extension', true);
    if (reason) $('noext-reason').textContent = reason;
  }

  function onPairResponse(resp) {
    var btn = $('connect');
    if (resp && resp.ok === true) {
      key = null; // paired; nothing left to hand over
      btn.disabled = true;
      btn.textContent = 'Connected';
      show('state-no-extension', false);
      var version = resp.data && typeof resp.data.helperVersion === 'string' ? ' (helper ' + resp.data.helperVersion.slice(0, 40) + ')' : '';
      setStatus('ok', 'Paired' + version + '. The extension opened Connection preferences in a new tab; continue there.', [
        'Choose your workspace, select Sign in with browser, then pick a SQL warehouse.',
        'You can close this page. Keep the helper window open while you use browser sign-in.',
      ]);
      return;
    }
    btn.disabled = false;
    var err = (resp && resp.error) || {};
    var steps = Array.isArray(err.steps) ? err.steps : [];
    setStatus('error', typeof err.title === 'string' && err.title ? err.title : 'The extension could not pair with the helper.', steps.length ? steps : ['Run the start script again, then select Connect workspace.']);
  }

  function connect() {
    var rt = runtime();
    if (!key) return;
    if (!rt) {
      showNoExtension(null);
      return;
    }
    var btn = $('connect');
    btn.disabled = true;
    setStatus('busy', 'Connecting to the extension…');
    var done = false;
    var timer = window.setTimeout(function () {
      if (done) return;
      done = true;
      btn.disabled = false;
      setStatus('error', 'The extension did not answer.', ['Reload the extension from the extensions page, then run the start script again.']);
    }, PAIR_TIMEOUT_MS);
    try {
      rt.sendMessage(EXTENSION_ID, { type: 'setup:pair', key: key }, function (resp) {
        var lastError = window.chrome && window.chrome.runtime && window.chrome.runtime.lastError;
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        if (lastError) {
          btn.disabled = false;
          setStatus('error', 'The Databricks Cost Companion extension is not installed in this browser, or it is disabled.');
          showNoExtension('This browser answered, but not with the Databricks Cost Companion extension. Load the extension (below), or enter the key manually.');
          return;
        }
        onPairResponse(resp);
      });
    } catch (_) {
      done = true;
      window.clearTimeout(timer);
      btn.disabled = false;
      showNoExtension(null);
    }
  }

  function reveal() {
    var btn = $('reveal');
    var box = $('manual');
    var open = box.hidden;
    if (open && !key) return;
    $('manual-key').textContent = open ? key : '';
    box.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? 'Hide key' : 'Show key for manual entry';
  }

  function copyKey() {
    if (!key || !navigator.clipboard) return;
    navigator.clipboard.writeText(key).then(
      function () {
        $('copy').textContent = 'Copied';
      },
      function () {
        $('copy').textContent = 'Copy failed; select the key instead';
      }
    );
  }

  function init() {
    $('connect').addEventListener('click', connect);
    $('reveal').addEventListener('click', reveal);
    $('copy').addEventListener('click', copyKey);
    if (!key) {
      show('state-missing', true);
      if (hadFragment) $('missing-title').textContent = 'This setup link is not valid';
      return;
    }
    show('state-ready', true);
    if (!runtime()) showNoExtension(null);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
