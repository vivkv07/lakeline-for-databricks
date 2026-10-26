/*
 * "Sign in with Databricks": OAuth user-to-machine (authorization code + PKCE S256) against the
 * workspace's own endpoints, via chrome.identity.launchWebAuthFlow.
 *
 *   authorize: <workspace>/oidc/v1/authorize   token: <workspace>/oidc/v1/token
 *   redirect:  chrome.identity.getRedirectURL()  → https://<extension-id>.chromiumapp.org/
 *   client_id: a public custom app connection registered once per Databricks account
 *
 * Without a registered app, Lakeline signs in through Databricks' built-in public client
 * `databricks-cli` (the one the Databricks CLI and SDKs use, enabled in every account unless an
 * admin turned it off). Its only redirect is http://localhost:8020, which launchWebAuthFlow cannot
 * complete, so the authorize page opens in a normal tab, the redirect is read from that tab's URL
 * (optional host permission http://localhost:8020/*) and the tab is closed. Nothing listens on that
 * port; the code is useless without the PKCE verifier kept here. Its all-apis token is stored once,
 * under 'apis', and also serves cost queries.
 *
 * Scopes per purpose: costs use `sql offline_access`. Everything that needs other REST APIs (the
 * run monitor and the Genie side panel) shares ONE broader consent, `all-apis offline_access`,
 * under the canonical purpose 'apis'; 'monitor' and 'genie' are aliases of it, so a user grants
 * it once. Tokens live only in chrome.storage.session and are never returned to pages or
 * content scripts.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const errors = dep('errors', '../errors.js');
  const ids = dep('ids', '../core/ids.js');
  const V = dep('validate', '../core/validate.js');

  const SCOPES = Object.freeze({ cost: 'sql offline_access', apis: 'all-apis offline_access' });
  /** Feature names that share a canonical purpose (one consent, one stored token). */
  const PURPOSE_ALIASES = Object.freeze({ monitor: 'apis', genie: 'apis' });

  /** Canonical purpose for a feature name, or null when unknown. */
  function canonicalPurpose(purpose) {
    const p = Object.prototype.hasOwnProperty.call(PURPOSE_ALIASES, purpose) ? PURPOSE_ALIASES[purpose] : purpose;
    return Object.prototype.hasOwnProperty.call(SCOPES, p) ? p : null;
  }
  const KEY = 'dcc.secrets.oauth';
  const BUILTIN = Object.freeze({ clientId: 'databricks-cli', redirectUri: 'http://localhost:8020', redirectPattern: 'http://localhost:8020/*', scope: 'all-apis offline_access' });
  const SIGNIN_TIMEOUT_MS = 5 * 60 * 1000;
  const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/;
  const SKEW_MS = 60 * 1000;

  const isClientId = (v) => typeof v === 'string' && CLIENT_ID.test(v);
  const isBuiltin = (v) => v === BUILTIN.clientId;

  /**
   * Administrator policy (chrome.storage.managed, schema in managed_schema.json):
   *   disableBuiltInSignIn  never sign in through the Databricks CLI's public client
   *   oauthClientId         sign in through the organization's own app connection instead
   * Missing or invalid values mean "no policy".
   */
  async function readPolicy(chromeApi) {
    try {
      const area = chromeApi && chromeApi.storage && chromeApi.storage.managed;
      if (!area || typeof area.get !== 'function') return { disableBuiltInSignIn: false, oauthClientId: null };
      const got = (await area.get(['disableBuiltInSignIn', 'oauthClientId'])) || {};
      return { disableBuiltInSignIn: got.disableBuiltInSignIn === true, oauthClientId: isClientId(got.oauthClientId) && !isBuiltin(got.oauthClientId) ? got.oauthClientId : null };
    } catch (_) {
      return { disableBuiltInSignIn: false, oauthClientId: null };
    }
  }

  /** The client to sign in with: a connection's or the account's registered app, else the built-in one. */
  function effectiveClientId(conn, settings) {
    const own = (conn && conn.oauthClientId) || (settings && settings.oauth && settings.oauth.clientId);
    return isClientId(own) ? own : BUILTIN.clientId;
  }

  /** The stored entry that serves a purpose: its own, or a built-in all-apis sign-in for costs. */
  function slotFor(entries, purpose) {
    if (!entries) return null;
    if (entries[purpose]) return purpose;
    if (purpose === 'cost' && entries.apis && isBuiltin(entries.apis.clientId)) return 'apis';
    return null;
  }

  function b64url(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function pkcePair(cryptoApi) {
    const raw = new Uint8Array(48);
    cryptoApi.getRandomValues(raw);
    const verifier = b64url(raw); // 64 chars from [A-Za-z0-9-_]
    const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier, challenge: b64url(new Uint8Array(digest)) };
  }

  function randomState(cryptoApi) {
    const raw = new Uint8Array(16);
    cryptoApi.getRandomValues(raw);
    return b64url(raw);
  }

  function workspaceOrigin(origin) {
    const cls = ids.classifyOrigin(origin);
    // The local fixture imitates the OIDC endpoints for end-to-end tests.
    if (!cls.ok || cls.origin !== origin) throw new errors.DccError({ code: 'UNKNOWN', message: 'Sign-in needs a supported Databricks workspace URL' });
    return cls.origin;
  }

  /**
   * @param deps {chromeApi, fetch, cryptoApi, now}
   */
  function create({ chromeApi, fetch: doFetch, cryptoApi = root.crypto, now = () => Date.now() }) {
    const area = chromeApi.storage.session;

    /** Entries per origin. A token saved by an earlier version under 'monitor' counts as 'apis'. */
    async function readAll() {
      const got = await area.get(KEY);
      const all = (got && got[KEY]) || {};
      for (const e of Object.values(all)) {
        if (e && typeof e === 'object' && e.monitor && !e.apis) {
          e.apis = e.monitor;
          delete e.monitor;
        }
      }
      return all;
    }
    async function writeEntry(origin, purpose, entry) {
      const all = await readAll();
      all[origin] = Object.assign({}, all[origin], { [purpose]: entry });
      await area.set({ [KEY]: all });
    }

    async function tokenRequest(origin, form) {
      let res;
      try {
        res = await doFetch(origin + '/oidc/v1/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams(form).toString(),
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
        });
      } catch (e) {
        throw new errors.DccError({ network: true, message: e && e.message });
      }
      let json = null;
      try {
        json = await res.json();
      } catch (_) {
        json = null;
      }
      if (!res.ok || !json || typeof json.access_token !== 'string') {
        const desc = json && (json.error_description || json.error);
        throw new errors.DccError({ code: res.status === 400 || res.status === 401 ? 'AUTH_EXPIRED' : 'AUTH_INVALID', httpStatus: res.status, message: 'Sign-in token request failed' + (desc ? ': ' + V.safeText(desc, 200) : '') });
      }
      return json;
    }

    function entryFrom(json, clientId, scope) {
      const ttl = Number(json.expires_in);
      return {
        accessToken: json.access_token,
        refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
        expiresAt: now() + (Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : 3600 * 1000),
        clientId,
        scope,
      };
    }

    /**
     * Built-in client: open the authorize page in a tab and resolve with the redirect URL once the
     * tab heads to http://localhost:8020. Rejects when the tab is closed or after five minutes.
     * Extension API calls keep the service worker alive while the user signs in.
     */
    async function captureInTab(authUrl) {
      const allowed = await chromeApi.permissions.contains({ origins: [BUILTIN.redirectPattern] });
      if (!allowed) throw new errors.DccError({ code: 'PERMISSION_NOT_GRANTED', message: 'Sign-in needs permission to read its redirect on localhost:8020' });
      const isRedirect = (u) => {
        try {
          return new URL(u).origin === BUILTIN.redirectUri;
        } catch (_) {
          return false;
        }
      };
      return new Promise((resolve, reject) => {
        let tabId = null;
        let done = false;
        let keepAlive = null;
        let timer = null;
        const early = [];
        const finish = (fn, value) => {
          if (done) return;
          done = true;
          clearInterval(keepAlive);
          clearTimeout(timer);
          try {
            chromeApi.tabs.onUpdated.removeListener(onUpdated);
            chromeApi.tabs.onRemoved.removeListener(onRemoved);
          } catch (_) {
            /* listeners were never attached */
          }
          fn(value);
        };
        const take = (id, url) => {
          if (!isRedirect(url)) return;
          Promise.resolve(chromeApi.tabs.remove(id)).catch(() => {});
          finish(resolve, url);
        };
        function onUpdated(id, info, t) {
          const u = (info && info.url) || (t && t.url);
          if (!u) return;
          if (tabId === null) early.push([id, u]);
          else if (id === tabId) take(id, u);
        }
        function onRemoved(id) {
          if (id === tabId) finish(reject, new errors.DccError({ code: 'AUTH_CANCELLED', message: 'Sign-in tab was closed' }));
        }
        try {
          chromeApi.tabs.onUpdated.addListener(onUpdated);
          chromeApi.tabs.onRemoved.addListener(onRemoved);
        } catch (e) {
          finish(reject, new errors.DccError({ code: 'AUTH_INVALID', message: 'Sign-in tabs are unavailable here' }));
          return;
        }
        keepAlive = setInterval(() => {
          try {
            chromeApi.runtime.getPlatformInfo(() => {});
          } catch (_) {
            /* best effort */
          }
        }, 20 * 1000);
        timer = setTimeout(() => {
          if (tabId !== null) Promise.resolve(chromeApi.tabs.remove(tabId)).catch(() => {});
          finish(reject, new errors.DccError({ code: 'AUTH_CANCELLED', message: 'Sign-in timed out' }));
        }, SIGNIN_TIMEOUT_MS);
        Promise.resolve()
          .then(() => chromeApi.tabs.create({ url: authUrl, active: true }))
          .then((t) => {
            tabId = t.id;
            for (const [id, u] of early.splice(0)) if (id === tabId) take(id, u);
          })
          .catch((e) => finish(reject, new errors.DccError({ code: 'AUTH_INVALID', message: 'Could not open the sign-in tab: ' + V.safeText(String((e && e.message) || e), 200) })));
      });
    }

    /**
     * Run the authorization-code + PKCE flow. With interactive:false it succeeds only when the
     * browser already has a Databricks session (used for silent reconnects).
     */
    async function signIn({ origin, clientId: requestedClient, purpose: requested = 'cost', interactive = true }) {
      const o = workspaceOrigin(origin);
      let clientId = requestedClient;
      if (isBuiltin(clientId)) {
        // An administrator's app connection replaces the CLI's client; a policy can also forbid it.
        const policy = await readPolicy(chromeApi);
        if (policy.oauthClientId) clientId = policy.oauthClientId;
        else if (policy.disableBuiltInSignIn) throw new errors.DccError({ code: 'BUILTIN_SIGNIN_POLICY', message: 'Sign-in through the Databricks CLI client is turned off by policy' });
      }
      if (!isClientId(clientId)) throw new errors.DccError({ code: 'OAUTH_CLIENT_MISSING', message: 'No OAuth client ID configured' });
      const asked = canonicalPurpose(requested);
      if (!asked) throw new errors.DccError({ code: 'UNKNOWN', message: 'Unknown sign-in purpose' });
      const builtin = isBuiltin(clientId);
      // A silent built-in sign-in would need a visible tab; refresh tokens cover that case instead.
      if (builtin && !interactive) throw new errors.DccError({ code: 'AUTH_EXPIRED', message: 'Sign in with Databricks again' });
      const purpose = builtin ? 'apis' : asked;
      const scope = builtin ? BUILTIN.scope : SCOPES[purpose];
      const redirectUri = builtin ? BUILTIN.redirectUri : chromeApi.identity.getRedirectURL();
      const { verifier, challenge } = await pkcePair(cryptoApi);
      const state = randomState(cryptoApi);
      const url = new URL(o + '/oidc/v1/authorize');
      url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();

      let responseUrl;
      try {
        responseUrl = builtin ? await captureInTab(url.toString()) : await chromeApi.identity.launchWebAuthFlow({ url: url.toString(), interactive });
      } catch (e) {
        if (e && e.dcc) throw e;
        const msg = String((e && e.message) || e);
        if (/did not approve|canceled|cancelled|closed/i.test(msg)) throw new errors.DccError({ code: 'AUTH_CANCELLED', message: 'Sign-in window was closed' });
        throw new errors.DccError({ code: interactive ? 'AUTH_INVALID' : 'AUTH_EXPIRED', message: 'Sign-in did not complete: ' + V.safeText(msg, 200) });
      }
      const back = new URL(responseUrl);
      if (!responseUrl.startsWith(redirectUri)) throw new errors.DccError({ code: 'AUTH_INVALID', message: 'Unexpected sign-in redirect' });
      const p = back.searchParams;
      if (p.get('state') !== state) throw new errors.DccError({ code: 'AUTH_INVALID', message: 'Sign-in state did not match' });
      if (p.get('error')) {
        const err = p.get('error');
        const clientRefused = /invalid_client|unauthorized_client/.test(err) || (builtin && /access_denied/.test(err));
        throw new errors.DccError({ code: clientRefused ? (builtin ? 'BUILTIN_SIGNIN_BLOCKED' : 'OAUTH_CLIENT_INVALID') : 'AUTH_INVALID', message: 'Databricks returned ' + V.safeText(err, 60) + (p.get('error_description') ? ': ' + V.safeText(p.get('error_description'), 200) : '') });
      }
      const code = p.get('code');
      if (!code) throw new errors.DccError({ code: 'AUTH_INVALID', message: 'No authorization code returned' });
      const json = await tokenRequest(o, { client_id: clientId, grant_type: 'authorization_code', scope, redirect_uri: redirectUri, code_verifier: verifier, code });
      await writeEntry(o, purpose, entryFrom(json, clientId, scope));
      return { signedIn: true };
    }

    /** A valid access token for the purpose: cached, refreshed, or silently re-acquired. */
    async function getAccessToken(origin, requested = 'cost', { clientId } = {}) {
      const o = workspaceOrigin(origin);
      const purpose = canonicalPurpose(requested);
      if (!purpose) throw new errors.DccError({ code: 'UNKNOWN', message: 'Unknown sign-in purpose' });
      const all = await readAll();
      const slot = slotFor(all[o], purpose) || purpose;
      const entry = all[o] && all[o][slot];
      if (entry && entry.expiresAt - SKEW_MS > now()) return entry.accessToken;
      if (entry && entry.refreshToken) {
        try {
          const json = await tokenRequest(o, { client_id: entry.clientId, grant_type: 'refresh_token', refresh_token: entry.refreshToken });
          const next = entryFrom(json, entry.clientId, entry.scope);
          if (!next.refreshToken) next.refreshToken = entry.refreshToken;
          await writeEntry(o, slot, next);
          return next.accessToken;
        } catch (_) {
          /* fall through to a silent sign-in */
        }
      }
      const id = (entry && entry.clientId) || clientId;
      if (isClientId(id) && !isBuiltin(id)) {
        try {
          await signIn({ origin: o, clientId: id, purpose, interactive: false });
          const fresh = (await readAll())[o][purpose];
          return fresh.accessToken;
        } catch (_) {
          /* needs an interactive click */
        }
      }
      throw new errors.DccError({ code: 'AUTH_EXPIRED', message: 'Not signed in with Databricks for this workspace' });
    }

    async function signOut(origin) {
      const all = await readAll();
      delete all[origin];
      await area.set({ [KEY]: all });
    }

    /** Which consents exist (never the tokens). monitor and genie mirror the shared 'apis' one. */
    async function describe(origin) {
      const all = await readAll();
      const e = all[origin] || {};
      const apis = Boolean(e.apis);
      return { cost: Boolean(slotFor(e, 'cost')), apis, monitor: apis, genie: apis, builtin: Boolean(e.apis && isBuiltin(e.apis.clientId)) };
    }

    return { signIn, getAccessToken, signOut, describe };
  }

  const api = Object.freeze({ SCOPES, PURPOSE_ALIASES, KEY, BUILTIN, isClientId, isBuiltin, effectiveClientId, readPolicy, pkcePair, canonicalPurpose, create });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).oauth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
