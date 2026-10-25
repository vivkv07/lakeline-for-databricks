# Security review: Lakeline for Databricks (pre open-source)

Scope: the MV3 extension in `extension/` at 0.1.1 (commit 959bb0c), the optional local helper
(`local/server.mjs`, `local/oauth-bridge.mjs`, `local/setup.*`), packaging (`scripts/package.mjs`)
and repo hygiene. Reviewed 2026-10-25 by reading the code and running the simulated suites. Nothing
was run against a real Databricks workspace, so OAuth and API behavior is checked against the code
and the fixture only.

Question asked: what could an outside contributor or an attacker exploit, especially around
Databricks tokens?

## Summary

The design is careful. Tokens stay in the service worker. Every network call goes through one
constrained client (origin classifier, path allowlist, `redirect: 'error'`, `credentials: 'omit'`).
Nothing renders HTML from data. SQL is fully parameterized. The local helper defends against DNS
rebinding and CSRF.

There is no remotely exploitable token leak. The most important open item is that tokens saved
with **Remember on this computer** sit in `chrome.storage.local`, which every content script can
read and write (M1). Most of the other findings are about keeping the code safe once other people
start sending pull requests.

| ID | Severity | Finding | Status |
|----|----------|---------|--------|
| M1 | Medium | Remembered PATs are stored in `chrome.storage.local`, which content scripts can read and write | Open |
| M2 | Medium | Router trust check failed open for unknown trust classes, and add-ons could replace handlers | **Fixed** |
| L1 | Low | The built-in sign-in asks for `all-apis` even when the user only wants costs | Open |
| L2 | Low | Redaction ran after truncation and missed tokens glued to other characters | **Fixed** |
| L3 | Low | No `connect-src` in the extension CSP, so the network allowlist relied only on code | **Fixed** |
| L4 | Low | Any process on 127.0.0.1:8766 can silently re-pair the helper | Open |
| L5 | Low | Store ZIP ships every file in the allowlisted folders, tracked or not; the secret scan is narrow | Open |
| L6 | Low | Nothing enforces "read-only SQL" when the code runs | Open |
| I1–I8 | Info | Smaller hardening notes | Open |
| H1–H6 | Hygiene | Repo setup for outside contributions | Open |

Tests after the fixes: `npm test` 506/506 pass (502 before plus 4 new). `npm run test:browser`:
24 of 25 pass. The one failure is a time-of-day flake that already fails on the untouched commit
(see "Verification"). All suites are simulated (DuckDB fixture, jsdom, Playwright against the
fixture server).

---

## Medium

### M1. Remembered PATs are readable (and writable) by content scripts. Open

- `extension/src/background/secrets.js:15,28-39,40-49`: with "Remember on this computer", the PAT
  is written to `dcc.secrets.patRemembered` in `persistArea`.
- `extension/src/background/service-worker.js:53`: `persistArea` is `chrome.storage.local`.
- Content scripts use `chrome.storage.local` directly (`extension/src/content/workspace-theme.js:66`)
  and listen to `chrome.storage.onChanged` (`extension/src/content/content-main.js:488`).
  `storage.onChanged` hands every listener the new value of any changed local key, including the
  remembered-token map.

**Impact.** Chrome cannot limit `storage.local` to trusted contexts (`setAccessLevel` only works on
`storage.session`). Every Databricks tab that runs the content script can read the remembered PATs
for *all* workspaces. If the content-script world is ever compromised (a renderer exploit in one
workspace tab, or a future content-script bug), every remembered token is exposed, not only the
one for that workspace. The same access can also *write* the map, which would plant a token. The
browser login itself is not affected, and page JavaScript cannot reach the isolated world. So this
is defense in depth, not an exploitable bug today. Session PATs and OAuth tokens are fine: they
live in `chrome.storage.session`, which content scripts cannot access (no code calls
`setAccessLevel`).

**Fix (recommended, not done here: storage migration plus real-browser testing).** Keep
remembered tokens out of `storage.local`:

1. Store them in IndexedDB of the extension origin, which only the service worker and extension
   pages can open. Content scripts get the page's IndexedDB, not the extension's. Or keep
   ciphertext in `storage.local` and encrypt with a non-extractable AES-GCM `CryptoKey` stored in
   extension-origin IndexedDB (a `CryptoKey` survives structured clone, and the raw key never
   exists in JS).
2. On first start after the update, migrate `dcc.secrets.patRemembered` into the new store and
   delete the local key.
3. Add a contract test that no key under `dcc.secrets.*` is ever written to the local area.

### M2. Router trust check failed open; add-on handlers could replace built-ins. **Fixed**

- Before: `extension/src/background/router.js` `dispatch()` ran a sender check only for the five
  known trust strings. Any other value (`'content-hello'`, a typo like `'pages'`, a missing
  `trust`) reached `h.handle()` with **no sender validation**. `dcc:hello` was only safe because it
  repeated the check inside its handler.
- Before: `Object.assign(handlers, deps.extra)` (router) and `Object.assign(acc, make(...))`
  (service worker) let a later add-on silently replace any message type, including `admin:*`,
  with a weaker trust class.

**Impact.** No handler was exposed in 0.1.1. With outside contributions, though, one typo or one
quiet override in a large pull request would turn an admin-only handler (`admin:setPat`, pairing,
connection changes) into one any extension context can call, and nothing would fail.

**Fix applied.**
- `router.js:20`: `TRUST_CLASSES = ['content', 'content-origin', 'page', 'admin', 'external']`.
- `router.js:328-335`: `create()` throws if an add-on registers an existing type, or if any handler
  lacks a known trust class or a `handle()` function.
- `router.js:385`: `dispatch()` rejects any other trust value (second layer, for handlers added
  after creation).
- `router.js:72`: `dcc:hello` now uses `trust: 'content-origin'`, so the router runs the check. The
  duplicate check inside the handler is gone. Behavior is the same.
- `service-worker.js:89-97`: a message type registered twice by two add-ons stops the router at
  startup instead of silently winning.
- `notes/CONTRACTS.md` lists the trust classes and the new rule.
- Tests: `local/test-background.mjs`, "router fails closed…" and "dcc:hello is checked by the
  router…".

---

## Low

### L1. The built-in sign-in grants `all-apis` for cost-only users. Open

- `extension/src/background/oauth.js:41` (`BUILTIN.scope = 'all-apis offline_access'`) and
  `:240-241`: with the built-in `databricks-cli` client, every sign-in (costs included) asks for
  `all-apis` and stores it under `apis`.

**Impact.** Least privilege. The extension itself only calls allowlisted paths
(`databricks/http.js:20-34`), but if the token is ever stolen it carries the user's full REST API
power for its lifetime, plus a refresh token in session storage. Cost-only users never need more
than `sql`.

**Fix.** Request `sql offline_access` for purpose `cost` with the built-in client, and ask for
`all-apis` only when the user turns on the run monitor or Genie (one extra consent, like the
registered-app path already does). The helper already signs the same CLI client in with
`--scopes sql` (`local/oauth-bridge.mjs:13`), so the client should accept it. Check on a real
workspace before shipping.

### L2. Redaction ran after truncation; tokens glued to word characters were missed. **Fixed**

- Before: `extension/src/errors.js` `redact()` cut the text to 2000 characters **before** it applied
  the patterns. A PAT or JWT straddling the cut kept its first characters (for example
  `dapi0123456789a…`). The PAT pattern also needed `\b` on both sides, so `xdapi…` or `dapi…abc`
  stayed unredacted.

**Impact.** Partial tokens could reach diagnostics (`chrome.storage.local`, shown in Options) and
error payloads. The input has to be an error message longer than about 1.9 KB with a token near
the cut, or a token glued to text. Unlikely, but this is the last line of defense.

**Fix applied.** `errors.js:11-32` redacts a 16 KB window first and then cuts to 2000. The PAT and
`dose/dkea/dsapi` patterns match anywhere. Test: `local/test-contracts.mjs`, "redaction runs before
truncation…".

### L3. No `connect-src` in the extension CSP. **Fixed**

- Before: `extension/manifest.json` CSP had `script-src`, `object-src`, `base-uri` and
  `frame-ancestors`, but no `connect-src`. The rule "the extension talks only to the user's
  workspace and the local helper" was enforced only by `http.js` and code review.

**Impact.** A pull request (or a later bug) that adds a `fetch` to another host from the service
worker or any extension page would just work, including from the Genie side panel, which renders
the least trusted text.

**Fix applied.**
- `manifest.json:57`: `connect-src 'self' https://*.cloud.databricks.com https://*.azuredatabricks.net https://*.gcp.databricks.com http://127.0.0.1:8766 http://127.0.0.1:8765`.
  MV3 applies `extension_pages` to the service worker too.
- `scripts/package.mjs:155-158`: the store build strips the dev-only test workspace
  (`127.0.0.1:8765`) from the CSP and refuses to build if that entry is missing. So the store build
  cannot reach the fixture origin at all (see I1).
- Tests: `local/test-package.mjs` checks that `connect-src` in the dev and store manifests matches
  the origins `ids.classifyOrigin` accepts plus the helper. `local/browser/test-e2e.mjs` "CSP
  connect-src…" shows in real Chromium that the service worker reaches the fixture but cannot reach
  an unlisted loopback port (zero requests arrive).
- Content scripts are not covered by this CSP. Their only `fetch` is the same-origin session bridge
  (`content/session-bridge.js:40`).
- Shipping this needs a new store upload; the 0.1.1 ZIP under review is unchanged.

### L4. Silent re-pairing by any local process on 127.0.0.1:8766. Open

- `extension/src/background/router.js:319-325` (`setup:pair`), `sender.js:62-70`, `secrets.js:73-88`.
  Any page served from `http://127.0.0.1:8766/setup` can send `setup:pair` with a key. The extension
  checks the key against whatever answers on 8766, then **replaces** the stored bridge and opens
  Options. The user never confirms.

**Impact.** Only an attacker who can already run code on the machine can do this, which mostly
puts it out of scope. In that case it would: get every helper-mode request (workspace origins,
workspace IDs, resource IDs in `args.refs`), return spoofed cost numbers, and open Options again and
again. Tokens are not exposed: in helper mode the extension sends none.

**Fix.** Make `setup:pair` a *pending* pairing that the Options page confirms ("Pair with the local
helper started at <time>?"). At minimum, never replace an existing bridge without that
confirmation.

### L5. Store packaging trusts the working tree; the secret scan is narrow. Open

- `scripts/package.mjs:61-79`: `collect()` walks allowlisted folders by file extension, so any
  untracked `.js` dropped into `extension/src/` or `extension/ui/` ships.
- `scripts/package.mjs:51-57`: `SECRET_CONTENT` catches `dapi…`, JWTs, JSON `access_token` and
  `refresh_token`, private keys and real workspace hosts. It misses `dose/dkea/dsapi` secrets,
  `Bearer <token>` strings and pairing-key-shaped values.

**Fix.** In `--store` mode, refuse to build when `git status --porcelain -- extension/` is not
empty, and record the commit SHA in the output name. Build store ZIPs only from a clean, tagged
checkout (later, in CI). Reuse the patterns from `errors.js` `REDACTIONS` in `SECRET_CONTENT`.

### L6. "Read-only SQL" is a convention, not a runtime check. Open

- `extension/src/databricks/http.js:27,112-158`: the POST allowlist allows
  `/api/2.0/sql/statements`, and `executeStatement` sends whatever `statement` the query kind built.
  Today every builder emits `SELECT`/`WITH … SELECT` with named parameters only (see "Verified" below).

**Impact.** A pull request that adds or edits a query kind could send DDL/DML under the user's
identity. Review is the only control.

**Fix.** In `executeStatement`, and in the helper's `exec`, refuse a statement unless it starts
with `SELECT` or `WITH` (after whitespace and comments) and contains no `;`. Add a test that builds
every kind in `queries/index.js` `KINDS` and asserts this. It is a tripwire against honest
mistakes and obvious changes, not a full parser.

---

## Informational

- **I1. The test-workspace origin is accepted in every build.** `extension/src/core/ids.js:15,41-43`
  classifies `http://127.0.0.1:8765` as a workspace even in the store build, and the
  `admin:setPat`/`admin:saveConnection` handlers accept it. Since L3, the store CSP blocks every
  connection to it, and the store manifest has no host permission for it. Optional: gate it on
  `flags.devTools` in the service worker.
- **I2. The session-bridge content script ships in the store build.** `registration.js:21` always
  injects `content/session-bridge.js`, but the store build disables the method
  (`data-service.js:36-37`, `connect-handlers.js:54-55`). The bridge only answers our own service
  worker (`session-bridge.js:20-22`), so it is dead code. Optional: leave it out of `CONTENT_JS`
  when `flags.sessionLogin` is false.
- **I3. The side panel shares the `page` trust class with the popup.** `sender.js:14`. The side
  panel renders Genie text, the least trusted input, yet it can call `connect:oneClick` (save a PAT,
  change the OAuth client ID), `connect:signOut` and `page:updateSettings`. CSP `script-src 'self'`
  and text-only rendering make this hard to abuse. A `sidepanel` trust class limited to `genie:*`,
  `page:open` and `page:state` would shrink what a rendering bug could reach.
- **I4. Genie answers can link to any https host.** `core/mini-markdown.js:33-45` keeps https links
  without credentials and opens them with `rel="noopener noreferrer"`. Data seen by Genie could
  steer it into printing a phishing link. Optional: show the host next to links that leave the
  workspace origin.
- **I5. The built-in OAuth code reaches `http://localhost:8020`.** `oauth.js:157-226`. The tab
  really navigates there, so any local process listening on 8020 (for example a running
  `databricks auth login`) gets `code` and `state`. PKCE S256 (verifier held in service-worker
  memory, `oauth.js:243`) and the state check (`:260`) make the code useless to it. Nothing to
  change; worth keeping in mind if PKCE handling is ever touched.
- **I6. Diagnostics live in `chrome.storage.local`.** `store.js:178-188`. They are redacted (now
  more strictly, L2) and capped at 20, but content scripts can read them. They hold Databricks
  error text (table names, warehouse names). Acceptable.
- **I7. Edge store builds and the helper.** `local/setup.js:12` hard-codes the Chrome item ID, and
  `local/server.mjs:82-86` allows `extension/EXTENSION_ID`. Edge Add-ons assigns its own ID, so
  helper pairing from an Edge store install fails closed. Not a security issue; note it for the
  Edge listing.
- **I8. Workspace ID seeding from URLs.** `router.js:76-80` records `?o=` from a tab URL as the
  observed workspace ID. A crafted link can at most cause a mismatch prompt, because the saved
  connection and the API's `x-databricks-org-id` header win (`connect-handlers.js:32-38`).

## Repo hygiene for outside contributions

- **H1. No CI.** There is no `.github/` folder. Add a workflow that runs `npm ci --ignore-scripts`,
  `npm test`, and `node scripts/package.mjs --store` (which runs the secret scan) on every pull
  request. Never run the tests of an untrusted pull request on the maintainer machine: `npm test`
  executes PR code with your user's rights.
- **H2. No CODEOWNERS or branch protection.** Require owner review for `extension/manifest.json`,
  `extension/src/background/**`, `extension/src/databricks/**`, `extension/src/errors.js`,
  `scripts/package.mjs`, `local/server.mjs`, `local/oauth-bridge.mjs`, `local/setup.js` and
  `package*.json`. Turn on branch protection for `main`.
- **H3. No `SECURITY.md`.** Add one with a private reporting channel (GitHub private vulnerability
  reporting) before announcing the repo.
- **H4. License.** `package.json:6` says `"UNLICENSED"`, and there is no LICENSE file. Pick a license
  (and decide whether contributors sign a DCO or CLA) before accepting contributions.
- **H5. Dependencies.** Dev-only (`@duckdb/node-api`, `jsdom`, `playwright`). The lockfile resolves
  all 52 packages from `registry.npmjs.org`, and none has an install script. Keep it that way:
  `npm ci --ignore-scripts`, Dependabot for the lockfile, and review any new dependency. The
  extension itself has no runtime dependencies.
- **H6. Review checklist for pull requests.** For any new message handler, check its trust class.
  For any `fetch`, `chrome.tabs.create` or `href`, check the destination (now also enforced by
  CSP). For any `chrome.storage.local` write, make sure it holds no secrets (M1). For SQL, check
  parameters and quoted identifiers (L6). Watch for `innerHTML`, `insertAdjacentHTML`, `eval`,
  `new Function` and remote scripts. And check `manifest.json` changes (permissions,
  `externally_connectable`, `web_accessible_resources`, CSP).

---

## Verified: no finding

- **Tokens never leave the service worker.** OAuth entries (`oauth.js:94-112`) and session PATs
  (`secrets.js:28-32`) live in `chrome.storage.session`. Responses use `publicConnection()`
  (`router.js:49-64`) and `describe()` booleans (`secrets.js:97-106`, `oauth.js:313-318`). The
  `connect:status` payloads are classified errors. Logs carry only codes or redacted messages
  (`genie.js:88`, `monitor.js:114`, `service-worker.js:96,116,119`). No `console.log` anywhere in
  `extension/`. Bearer headers are built only in `http.js:72`.
- **OAuth.** PKCE S256 with a 64-character verifier (`oauth.js:69-75`), a 128-bit `state` checked
  before the code is read (`:244,260`), the redirect prefix checked (`:258`), and the token request
  uses `redirect: 'error'` and `credentials: 'omit'` (`:117-124`). The built-in flow only accepts
  redirects from the tab it opened (`:191-196`) and gives up after 5 minutes (`:214-217`). Refresh
  keeps the old refresh token if none comes back (`:286`). Silent reconnect is never attempted for
  the built-in client (`:239`).
- **Message trust.** Content handlers re-derive the origin from `sender.url` and check
  `frameId === 0`, the extension ID and the workspace ID (`sender.js:34-49`). Pages are checked by
  exact extension origin and path (`sender.js:51-59`). `externally_connectable` matches only
  `http://127.0.0.1:8766/*` with no `ids`, so other extensions cannot connect. The setup sender must
  have no `id`, the exact origin and the `/setup` path (`sender.js:62-70`). External messages can
  reach only `external` handlers and the reverse (`router.js:369`).
- **Network.** The service worker fetches only through `http.js` (`buildUrl` re-classifies the
  origin and rejects path changes and odd query values, `:45-56`), the token endpoint on the same
  origin, and the helper on `127.0.0.1:<paired port>` (port validated 1024-65535,
  `secrets.js:75`). `web_accessible_resources` is absent and `frame-ancestors 'none'` is set.
- **Rendering.** `extension/` contains no `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
  `document.write`, `eval` or `new Function`. Genie Markdown is parsed into nodes and built with
  `createElement`/`textContent` (`mini-markdown.js:500-530`). Run links are re-validated against
  the monitored origin, job and run IDs (`monitor-api.js:175-190`). The only CSS built from data is
  a strict `#RRGGBB` with a fixed foreground (`workspace-theme.js:39-41`).
- **SQL.** Every value is a named parameter (`pricing.js:37-39`). Identifiers are validated
  three-part names quoted with backticks (`validate.js:50-62`); approved views must sit outside
  `system` (`config.js:21-28`). Price tables come from an enum. Type tags in `row-data.js:116` are
  code constants. Refs and targets are capped at 40 (`router.js:18`, `query-history.js:24`). The
  helper accepts only named kinds and never SQL text (`server.mjs:63,362-393`).
- **Local helper.** Binds `127.0.0.1` and checks `Host` (`server.mjs:490,518`). Uses a 96-bit random
  key compared in constant time (`:242,264`), handed over only in the URL fragment, which
  `setup.js:18-26` strips at once. Requires the exact extension `Origin` (`:420-434`). The launcher
  endpoint refuses browsers (`:462-466`). The CLI runs with argument arrays and `shell: false`
  (`oauth-bridge.mjs:92-101`). `/bridge/api` reuses the GET allowlist and refuses statement paths
  (`:395-405`).

## Verification

- `npm test`: 506 tests, 506 pass, 0 fail (simulated). New: two router tests, one redaction test
  and one CSP/packaging test.
- `npm run test:browser`: 25 tests, 24 pass, 1 fail (simulated fixture in headless Chromium).
  - New, passing: "CSP connect-src…". Run against the old manifest, the same test fails: the
    unlisted host answered `reached 200`.
  - Failing, already broken before this change: "monitor page: … refresh lists runs including the
    failed one". `local/fixture-data.mjs:412` puts the only failed job 102 run at 06:00-07:00 UTC
    *yesterday*, but the monitor lists only the last 24 hours (`monitor-api.js:31`). The test can
    pass only between 00:00 and 06:00 UTC. It failed the same way on an untouched checkout of
    959bb0c at 17:58 UTC. Follow-up: make the failed run relative to `nowMs`, for example
    `nowMs - 3 h`.
- `node scripts/package.mjs --store`: builds. The store manifest's `connect-src` has no
  `127.0.0.1:8765`.
