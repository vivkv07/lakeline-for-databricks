/*
 * "Use my Databricks login" (experimental): runs allowlisted Databricks API requests from inside
 * the workspace tab so the browser attaches the user's existing session. Only our own service
 * worker can ask (chrome.tabs.sendMessage from this extension); page scripts and other
 * extensions cannot reach this listener. Same origin only, the same path allowlist as every other
 * transport, no redirects, size-capped responses. Nothing is read from the page itself.
 */
(function (root) {
  'use strict';
  const DCC = root.DCC;
  if (!DCC || !DCC.http || root.__dccSessionBridge) return;
  if (root.top !== root.self) return;
  const cls = DCC.ids.classifyOrigin(root.location.href);
  if (!cls.ok) return;
  root.__dccSessionBridge = true;

  const MAX_CHARS = 25 * 1024 * 1024;
  const chromeApi = root.chrome;

  function fromOurServiceWorker(sender) {
    return Boolean(sender && sender.id === chromeApi.runtime.id && !sender.tab);
  }

  async function run(msg) {
    const method = msg.method === 'POST' ? 'POST' : 'GET';
    const target = new URL(String(msg.path || ''), cls.origin);
    if (target.origin !== cls.origin) return { ok: false, blocked: 'cross-origin' };
    if (!DCC.http.isAllowed(method, target.pathname)) return { ok: false, blocked: 'path' };
    // Re-validate query parameters with the same rules as the service-worker client.
    const url = DCC.http.buildUrl(cls.origin, target.pathname, Object.fromEntries(target.searchParams));
    let body;
    if (method === 'POST') {
      if (typeof msg.body !== 'string' || msg.body.length > 512 * 1024) return { ok: false, blocked: 'body' };
      body = msg.body;
    }
    let res;
    try {
      res = await root.fetch(url, {
        method,
        headers: Object.assign({ Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}),
        body,
        credentials: 'same-origin',
        redirect: 'error', // an expired login redirects to the sign-in page
        cache: 'no-store',
      });
    } catch (e) {
      return { ok: false, network: true, message: DCC.validate.safeText(e && e.message, 200) };
    }
    const text = await res.text();
    if (text.length > MAX_CHARS) return { ok: false, blocked: 'size' };
    return {
      ok: true,
      status: res.status,
      contentType: DCC.validate.safeText(res.headers.get('content-type') || '', 100),
      orgId: res.headers.get('x-databricks-org-id'),
      text,
    };
  }

  if (!chromeApi || !chromeApi.runtime || !chromeApi.runtime.onMessage) return;
  chromeApi.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'dcc:sessionFetch' || !fromOurServiceWorker(sender)) return false;
    run(msg).then(sendResponse, (e) => sendResponse({ ok: false, message: DCC.validate.safeText(e && e.message, 200) }));
    return true;
  });

  DCC.sessionBridge = Object.freeze({ run });
})(typeof globalThis !== 'undefined' ? globalThis : this);
