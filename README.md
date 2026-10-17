# Lakeline for Databricks

A Chrome and Edge extension (Manifest V3) that shows estimated Databricks costs inside your existing
Databricks workspace. It adds a cost banner, badges on jobs, pipelines, warehouses, notebooks and
apps, per-run and per-query estimates, DBU-only previews in compute size pickers, an expandable Cost
Explorer, workspace top-bar colors, and an optional run monitor.

> **Estimated costs. Billing can be delayed; final invoices may differ.**
>
> This is an independent project. It is not affiliated with, endorsed by, or sponsored by
> Databricks, Inc. Databricks and related marks are trademarks of Databricks, Inc.

Status: version 0.1.0, unreleased. See [CHANGELOG.md](CHANGELOG.md).

**How the numbers are calculated:** [`extension/docs/calculation-guide.html`](extension/docs/calculation-guide.html).
The guide is also linked from the banner (**How costs work**), the popup and Connection preferences.

## Contents

- [What it does](#what-it-does)
- [Screenshots](#screenshots)
- [Requirements](#requirements)
- [Install](#install)
- [Modes](#modes)
- [Connect a workspace](#connect-a-workspace)
- [Using it](#using-it)
- [Monitor widget](#monitor-widget)
- [Genie side panel](#genie-side-panel)
- [Local fixture and tests](#local-fixture-and-tests)
- [Updating: reload or restart?](#updating-reload-or-restart)
- [Known limitations](#known-limitations)
- [Removing and resetting](#removing-and-resetting)
- [Security model](#security-model)
- [Privacy](#privacy)
- [Project layout](#project-layout)

## What it does

- **Workspace banner.** Shows the estimated total, or a labeled *priced subtotal*, for the last 7,
  30 or 90 complete UTC days. It compares with the previous period and shows the age of the latest
  usage and the pricing basis. It has Refresh, Settings and **How costs work** buttons, and expands
  into the Cost Explorer.
- **Native badges.** Show period totals next to jobs, pipelines, SQL warehouses, notebooks and
  Databricks Apps, and next to job and pipeline titles. Each job run and pipeline update shows its
  own recorded cost. Job totals include pipeline updates that the job triggered.
- **SQL Query History estimates.** Each execution gets an allocated estimate based on time overlap
  with warehouse billing. The extension never reads SQL text or result rows.
- **Compute previews.** Shows a prospective "DBU only" hourly cost beside SQL warehouse sizes and
  interactive compute options.
- **Cost Explorer.** Six views: Products, Top drivers, Runs, Calendar, SKUs and Daily detail. It
  offers drilldowns, heuristic flags and CSV export.
- **Workspace colors.** Tints the Databricks top bar per workspace so you can tell workspaces apart.
  This works without any billing connection.
- **Monitor widget (optional).** A compact window that shows job runs, pipeline updates, warehouses
  and clusters. It uses read-only REST calls only, and desktop notifications for failed runs are
  opt-in.

- **Genie side panel.** Ask your Genie Agents from a browser side panel and keep working. The
  answer, with its result table and the generated SQL, waits in the panel, and an opt-in desktop
  notification says when it's ready.

Every amount is labeled as an estimate, and missing data is never shown as zero.

## Screenshots

No screenshots are included yet. If you add any, take them only from **Demo mode** or the
**local fixture**, which use synthetic data. Never use a real workspace, real costs, real
names or real IDs.

## Requirements

- **Browser:** Google Chrome or Microsoft Edge, version 116 or newer, on desktop.
- **Connected mode:**
  - A Unity Catalog-enabled workspace with system tables available.
  - A SQL warehouse you can use.
  - The grants listed under [Databricks permissions](#databricks-permissions).
- **Sign-in:** nothing to install or register. **Sign in with Databricks** uses Databricks'
  built-in sign-in app, the one the Databricks CLI uses. If an admin turned that app off, paste a
  personal access token (PAT), or have an account admin register an app connection once.
- **Optional local helper:** [Node.js](https://nodejs.org) 20 or newer and the
  [Databricks CLI](https://docs.databricks.com/aws/en/dev-tools/cli/install) v1.12 or newer.
- **Development and tests:** Node.js 20 or newer and npm.

## Install

Lakeline is in review on the Chrome Web Store. Until it is listed, load it unpacked:

**Chrome**

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder, the one that contains `manifest.json`.

**Microsoft Edge**

1. Open `edge://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.

Once Lakeline is listed on the Chrome Web Store, Edge users can install it from there too: open the
listing in Edge, select **Allow extensions from other stores**, then **Get**. Ask Genie opens in
Edge's sidebar, and the run monitor's Float on top works the same as in Chrome.

Pin the toolbar icon so the popup is one click away.

**Stable extension ID.** `manifest.json` carries the Chrome Web Store item's public `key`, so an
unpacked copy loads with the same ID as the store release: `gcadffgngihfjameoafjagofiompdngo`. The ID
is also stored in `extension/EXTENSION_ID`. The local helper accepts requests only from this
extension ID, so keep the `key` in the manifest. Remove an unpacked copy before you install the
store release, because both use the same ID.

The extension asks for no site access at install. It requests access for one workspace at a time,
when you connect it or save a color for it.

## Modes

Choose a mode in the popup under **Data source**.

| Mode | What it does | Network |
|---|---|---|
| **Demo** | Synthetic data, labeled DEMO | No Databricks requests |
| **Local import** | Shows summaries from a `costs.json` file you import under Connection preferences. See `costs.example.json` for a synthetic example. | No Databricks requests |
| **Connected** | Runs read-only SQL against system tables on a SQL warehouse you choose | Your workspace, directly or through the local helper |

Imported summaries contain only what you imported. They have no query history and no run detail.
Query History estimates, compute previews and the Explorer's detail queries need Connected mode.

## Connect a workspace

Open a Databricks workspace tab, open the popup, and select **Connect this workspace**.

1. Chrome asks once for access to that workspace and to `localhost:8020`.
2. A tab opens on your workspace's own sign-in page. If you're already signed in, it closes by
   itself after a moment.
3. Lakeline reads the workspace ID, picks a SQL warehouse and shows costs on the page.

Why `localhost:8020`: Databricks' built-in sign-in app (`databricks-cli`) only sends you back to
that address. Nothing runs there; Lakeline reads the one-time code from its own sign-in tab and
closes it. Tokens stay in browser session storage.

**Other ways to sign in** (in the popup):

- **Personal access token.** Select **Create a token in Databricks** (Settings, Developer, Access
  tokens), paste it, and optionally tick **Remember on this computer**. Lakeline checks the token
  with Databricks before saving it.
- **Your organization's app connection.** If an account admin registered Lakeline under App
  connections, paste its client ID. The sign-in screen then names your app.

**Connection preferences** (the options page) covers everything else, including the local helper.
If several workspaces are open, you choose one. The extension never switches workspace silently.

1. **Workspace.** Confirm the workspace URL and its numeric workspace ID. The ID is read from the
   page URL (`?o=…`), from documented host names, or from tabs the extension has already seen.
2. **Site access.** Select **Allow access to this workspace**. The browser asks you to confirm.
3. **Sign-in.** Use the local helper (option A) or a personal access token (option B).
4. **SQL warehouse.** Choose **Automatic** or a specific warehouse.
5. **Billing source.** Choose the price table and currency.
6. Select **Save connection**.

### Option A: local helper (browser sign-in)

The helper is a small Node program that listens only on `127.0.0.1:8766`. It runs the Databricks
CLI's browser sign-in (OAuth) and executes the same named, read-only cost queries as the extension.
The CLI keeps its own credentials. The helper holds only a short-lived access token in memory, and
the extension never sees any OAuth token.

1. Start the helper:
   - **macOS:** double-click `start-helper.command`.
   - **macOS or Linux terminal:** `./start-helper.sh`.
   - **Windows:** from the project folder, run `node local/server.mjs --open`.

   The script checks for Node.js 20+. If the same helper version is already running, it reuses it.
   If an older helper is running, it tells you how to stop that one. Otherwise it starts
   `node local/server.mjs --open` in that window. The setup page opens in Microsoft Edge if it is
   installed, otherwise in your default browser.
2. **Pairing.** On the setup page, select **Connect workspace**.
   - The helper creates a random 24-character hexadecimal pairing key each time it starts.
   - The key reaches the page only in the URL fragment, which the page removes immediately.
   - The setup page hands the key to the extension. The extension verifies it with the helper
     before saving it, then opens Connection preferences.
   - The key is never put in a query string, page HTML, logs or the options URL.
3. **Fallback.** If the extension isn't reachable from the setup page, for example because you use a
   different browser for the extension, select **Show key for manual entry** on the setup page. Then
   paste the key into **Pairing key** in Connection preferences and select **Pair**.
4. In Connection preferences, select **Sign in**. The helper uses a dedicated Databricks CLI profile
   for that workspace, named `dcc-<host>-<hash>`, with the `sql` scope. It never uses your
   `DEFAULT` profile or any other existing profile. It reuses a valid session, or opens the browser
   sign-in (your SSO and a consent screen may appear).

The pairing is kept in memory-only session storage. After a browser restart or an extension reload,
run the start script again, or reopen the setup page, to pair again. To stop the helper, press
`Ctrl+C` in its terminal window or close the window.

### Option B: personal access token

PAT mode works without the helper or CLI.

1. In your workspace, open **Settings → Developer → Access tokens** and generate a token. Give it a
   short lifetime.
2. In Connection preferences, choose **Personal access token**, paste it into **Token**, and select
   **Save token**.

The token is kept only in session storage. It is never written to disk by the extension, and
content scripts can't read it. Enter it again after a browser restart or an extension reload.
Workspace admins can disable PATs, and Databricks recommends OAuth where possible.

### Workspace and warehouse selection

Select **List warehouses** to see the warehouses your identity can see, with name, ID, state and
size. Then choose one of two options:

- **Automatic** prefers a usable running warehouse. Among those it prefers the smallest size, then
  sorts by name and ID. The choice is made when you save or reconnect, never per query.
- **A specific warehouse** is used as chosen. If it later disappears, it is shown as unavailable
  and is never replaced silently.

Editing a connection keeps your saved Automatic or explicit choice. A warehouse appearing in the
list doesn't prove you have `CAN USE` on it or can read the billing tables. The first query reveals
access problems, and you get a specific message.

**Cost queries run on that warehouse and are billed like any other query.** If the warehouse is
stopped, the first cost query starts it. Prefer a small warehouse that is usually running, or turn
off **Show costs inside Databricks** in the popup when you don't need costs.

### Price table

Choose exactly one of these two tables. There is no free-text price table and no fallback between
them.

| Price table | Field read | Not included |
|---|---|---|
| `system.billing.list_prices` (default) | `pricing.effective_list.default` | Private or negotiated discounts, and cloud-provider charges |
| `system.billing.account_prices` | `pricing.default` | Invoice adjustments not in that table, and cloud-provider charges |

`account_prices` isn't in the official system-table reference, and it may be unavailable for your
account or cloud. Azure in particular is reported to lack it. If it's missing, you get a specific
error and can switch to `list_prices` yourself. Prices are matched by account, SKU, cloud, usage
unit, currency and a half-open validity window. Currency is never converted. The guide's
[Prices section](extension/docs/calculation-guide.html#prices) has the details.

**Currency** defaults to USD. **Usage source** and **Query history source** default to the system
tables. You can instead name an approved `catalog.schema.view` outside the `system` catalog, as long
as it has the same columns.

### Databricks permissions

| Feature | Needs |
|---|---|
| Any SQL | `CAN USE` on the selected SQL warehouse |
| Banner, badges, Explorer | `USE CATALOG` on `system`, `USE SCHEMA` on `system.billing`, and `SELECT` on `system.billing.usage` and on the selected price table |
| Query History estimates | `USE SCHEMA` on `system.query` and `SELECT` on `system.query.history` (admin-only by default) |
| Job–pipeline attribution, run durations | `USE SCHEMA` on `system.lakeflow` and `SELECT` on `pipeline_update_timeline`, `job_task_run_timeline` and `job_run_timeline`. Without these, jobs show "Direct job cost". |
| Monitor | Permission to view the jobs, pipelines, warehouses and clusters you want to see |

## Using it

- **Banner.** Choose 7, 30 or 90 days. Periods are complete UTC dates and exclude today. Select
  **Refresh** to re-run the summary, or **Explore** to expand the Cost Explorer. A *Priced subtotal*
  means some usage had no matching price. The details list the affected SKUs and dates.
- **Badges and run rows.** These appear on native job, pipeline, warehouse, notebook and app pages
  and lists. A run or update row shows that execution's cost. Billing is searched over 365 UTC dates,
  and the amount can be incomplete while billing is delayed.
- **Query History.** Each row gets an "approx." estimate or a label that explains why there is none,
  such as *Waiting for billing* or *Match ambiguous*. Hover or focus the label to see the reason.
- **Compute previews.** Size options show `≈ $X/h per cluster · DBU only`. VM, disk and network
  costs are not included.
- **Pause.** Turn off **Show costs inside Databricks** in the popup to stop new cost requests from
  pages. Workspace colors stay on.
- **Workspace colors.** In the popup, open **Workspace colors**. Choose a workspace or URL, then pick
  a color, enter `#RRGGBB` or use a preset. Select **Save**. **Reset** removes the color. Colors are
  stored separately from cost connections and need no sign-in.

## Monitor widget

1. In the popup, turn on **Monitor runs and compute**. In Connected mode, the monitor follows one
   saved workspace.
2. Sign in for the monitor:
   - **Helper:** select **Sign in for monitor (broader access)** in Connection preferences. This is
     a separate one-time sign-in with the `all-apis` scope on its own `dcc-mon-<host>-<hash>`
     profile. The helper forwards only an allowlist of read-only `GET` requests, and cost queries
     keep their SQL-only sign-in.
   - **PAT mode:** the same token is used.
3. Select **Open monitor**. The compact window lists active and recent runs, pipeline updates,
   warehouses and clusters.

Details:

- **Polling.** Every 60 seconds by default, or every 2 or 5 minutes, using read-only REST `GET`
  calls. After errors it backs off up to 30 minutes.
- **No background SQL.** Background polling never sends SQL, so it never starts a stopped warehouse.
  The cost line uses the cached summary, and the monitor asks before running a query that would
  start a stopped warehouse.
- **Toolbar badge.** Shows the number of active runs. A different color plus "!" marks recent
  failures you haven't seen yet.
- **Desktop notification when a run fails.** Opt-in. The browser asks for the `notifications`
  permission when you turn it on.
- **Open the monitor when the browser starts.** Opt-in.
- **Float on top.** Moves the monitor into a Document Picture-in-Picture window that stays above
  other windows. It needs a click each time and closes when the monitor window closes.
  Picture-in-Picture from an extension page is **not yet verified**. If it doesn't work in your
  browser, keep using the normal monitor window.
- **Demo mode.** The monitor is off in Demo mode.

## Genie side panel

Ask a Genie Agent (formerly a Genie space) in a side panel, then go back to what you were doing.
The service worker sends the question, waits for Genie and keeps the answer for you.

1. Open the popup and select **Ask Genie**. The side panel opens on the right.
2. Pick a **Workspace** (the active tab's workspace when it's connected) and a **Genie Agent**.
   The panel remembers your last agent per workspace.
3. Type a question. **Enter** sends, **Shift + Enter** adds a line. Each message shows its status:
   Sending, Genie is working, Running query, Answer ready or Failed (with a plain reason).
4. The answer shows Genie's text, the result table (up to 200 rows, with "showing N of M") and
   **Show SQL**. **Copy answer** copies the text and the shown rows. Suggested follow-ups appear
   as buttons. **New** starts a new conversation.
5. Close the panel at any time. When the answer lands, the toolbar badge counts it (while the run
   monitor is off; the monitor owns the badge when it's on). Turn on **Notify me when Genie
   answers** in the popup for a desktop notification that says "Answer ready in <agent>" and
   nothing else.

**Sign-in.** Connected workspaces only:

- **Sign in with Databricks:** the panel asks once with **Allow Genie and run status**. That is the
  broader `all-apis` consent, shared with the run monitor; cost queries keep their SQL-only
  sign-in. Every Genie API needs the `genie` scope, which `all-apis` includes.
- **Personal access token:** the token is used. A scoped token needs the `genie` scope.
- **Local helper** and **Use my Databricks login** aren't supported for Genie; the panel says so.
- **Demo mode** shows synthetic agents and canned answers, labeled DEMO, with no requests.
  **Local import** mode has no Genie.

**What is sent where.** Only your question text, to your own workspace's Genie Conversation API
(`/api/2.0/genie/spaces/...`: list agents, start a conversation, send a follow-up, read the
message, read the query result, and re-run an expired result). The HTTP client allows exactly
these paths for Genie, and the local helper can't forward them.

**Data handling.** Answers can contain business data. Conversations stay in `chrome.storage.session`
(memory only, cleared when the browser closes, hidden from content scripts), capped at 8
conversations, 20 messages each and about 1.5 MB in total (older tables are dropped first). They
are never written to local storage, diagnostics, logs or notification text. **Clear now** in the
panel removes them at once. Text is rendered as plain text, never as HTML.

**Limits and cost.** The panel polls only while a question is in flight: every 1 s, slowing to
every 10 s (up to 60 s after errors), and it stops after 10 minutes. A restarted service worker
resumes in-flight questions within about 30 seconds. Up to three questions run at once, one per
conversation. Databricks documents no fixed questions-per-minute limit for this API; when it
answers "rate limited", the panel says so and doesn't resend. Genie usage beyond a free monthly
allowance is billed by Databricks, and its SQL runs on the agent's warehouse (a stopped warehouse
starts). Verified API facts and sources are in `notes/GENIE.md`.

## Local fixture and tests

The fixture is a synthetic, Databricks-like page for development. It uses no real data.

```sh
npm install                                  # dev-only test dependencies (jsdom, DuckDB)
node local/server.mjs --fixture              # helper on 127.0.0.1:8766 + fixture on 127.0.0.1:8765
# or: npm run fixture                        # fixture only (node local/server.mjs --fixture-only)
```

Then:

1. Open <http://127.0.0.1:8765/workspace.html>. The popup also has a **Local test workspace** link.
2. Grant site access to the fixture origin when the extension asks.
3. Connect it in one of two ways. The fixture workspace ID is `1234567890`.
   - **Helper:** when started with `--fixture`, the helper accepts the fixture origin and uses the
     fake fixture token itself, so no sign-in is needed.
   - **Personal access token:** paste the fake fixture token
     `dapi-fixture-0000000000000000000000000000`. It isn't a credential, and only the local fixture
     server accepts it.

**Tests**

```sh
npm test            # node --test local/test-*.mjs
```

- These tests are **simulated**. SQL runs against an in-process DuckDB database with
  system-table-shaped tables (`local/support/sqlengine.mjs`), not against Databricks.
- Content-script tests run in **jsdom**, not a real browser.
- Query-history fixture rows hold a sentinel value in the SQL-text column, so any accidental read of
  SQL text fails the tests.
- `npm run test:browser` runs the disposable-profile browser tests (Playwright) one file at a
  time, because each starts the fixture on port 8765. `local/browser/test-genie-e2e.mjs` drives the
  Genie panel page in a tab against the fixture's simulated Genie API.
- `npm run test:edge` runs the same browser tests in an installed Microsoft Edge (Playwright
  channel `msedge`). Last run: Edge 155, 24 of 24 passed.
- Live SQL against a real workspace is never part of the automated tests.
- `npm run package` builds a sanitized ZIP in `dist/` from an explicit allowlist. It refuses files
  that look like tokens, keys, CLI config or real workspace hosts.

## Updating: reload or restart?

| What changed | Restart the helper | Reload the extension |
|---|---|---|
| Helper code (`local/*.mjs`), helper capabilities | Yes | No |
| Price adapter or SQL query builders (`extension/src/databricks/`) | **Yes.** The helper loads these files when it starts. | **Yes** |
| `manifest.json`, background service worker (`extension/src/background/`) | No | Yes |
| Content scripts (`extension/src/content/`, banner, badges, colors) | No | Yes, then refresh open Databricks tabs |
| Popup, options, monitor or the guide (`extension/ui/`, `extension/docs/`) | No | Reopening the page is enough |
| Shared core (`extension/src/core/`, `extension/src/errors.js`) | Yes. The helper loads some of these. | Yes |

- **Reload the extension:** open `chrome://extensions` or `edge://extensions` and select the reload
  button (Chrome) or **Reload** (Edge) on the extension's card.
- **Restart the helper:** stop it with `Ctrl+C`, then run the start script again. The script refuses
  to start while an older helper still holds port 8766, and tells you how to stop it.

A reload or a browser restart clears session storage. Pair the helper again, or re-enter your PAT,
afterwards. When the running helper lacks a capability a request needs, the extension says
*The running local helper is outdated* and blocks only that request. The capabilities are the
account-price adapter, price adapter version 2 or later, job–pipeline attribution and the monitor.
A version difference alone doesn't force a restart.

## Known limitations

- **Estimates, not invoices.** Amounts come from system tables and price tables. Delayed billing and
  later corrections change recent and past amounts.
- **No cloud-provider costs.** VM, disk, network and storage charges are excluded. Compute previews
  are DBU only.
- **`account_prices` availability.** The table may be missing for your account or cloud, Azure in
  particular. There is no automatic fallback to list prices.
- **Native page changes.** Badges, previews and colors rely on the Databricks web interface. The DOM
  selectors are best-effort and may need updates when Databricks changes its pages.
- **Bounded history.** Run search covers 365 UTC dates and query history 90 UTC dates.
- **Visibility.** Estimates depend on what your identity can see. Query History estimates can be
  overstated when other users' executions are hidden from you.
- **Shared clusters.** Usage on shared all-purpose clusters isn't split among jobs or notebooks.
- **Float on top** (Picture-in-Picture) isn't verified on extension pages yet.

## Removing and resetting

| What | How |
|---|---|
| Pause cost display | Popup: turn off **Show costs inside Databricks**. |
| Disconnect one workspace | Connection preferences: **Disconnect this workspace**. This removes the saved connection and its token. |
| Forget secrets | Connection preferences: **Remove token** and **Forget helper pairing**. Both are also cleared on browser restart. |
| Remove site access | Connection preferences: **Remove site access**, or the extension's **Details → Site access** in `chrome://extensions`. |
| Clear imported data and diagnostics | Connection preferences: **Clear import** and **Clear diagnostics**. |
| Reset workspace colors | Popup: **Workspace colors → Reset**. |
| Remove everything in the browser | Remove the extension. This clears its local storage (settings, connections, imports, diagnostics, colors) and its session storage (tokens, pairing, monitor state). |
| Stop the helper | `Ctrl+C` in its window. The helper writes nothing to disk. |
| Revoke a PAT | Workspace **Settings → Developer → Access tokens**. |

**Databricks CLI profiles created by the helper.** These live outside the extension: in
`~/.databrickscfg` (`%USERPROFILE%\.databrickscfg` on Windows), with tokens in the CLI's own
credential store. Their names start with `dcc-` (costs) or `dcc-mon-` (monitor).

```sh
databricks auth profiles                         # list profiles; look for names starting with dcc-
databricks auth logout dcc-<host>-<hash> --delete      # clear cached tokens and remove the profile
databricks auth logout dcc-mon-<host>-<hash> --delete  # same for the monitor profile
```

The `auth logout … --delete` form is documented in the current
[CLI `auth` command reference](https://docs.databricks.com/aws/en/dev-tools/cli/reference/auth-commands).
If your CLI doesn't have `auth logout`, update the CLI, or open `~/.databrickscfg` in a text editor
and delete the `[dcc-…]` sections. Editing the file alone may leave cached tokens in the CLI's
credential store: the OS keychain for CLI 1.x, or `~/.databricks/` when plaintext storage is
configured. Don't delete your other profiles.

Also delete any `costs.json` you created and the `dist/` folder if you built a package.

## Security model

- **Optional per-site access.** Site access is requested per workspace origin through
  `optional_host_permissions`, for `*.cloud.databricks.com`, `*.azuredatabricks.net`,
  `*.gcp.databricks.com` and the local fixture. Content scripts are registered only for origins you
  granted, and account-console hosts are excluded. Other permissions are `storage`, `activeTab`,
  `scripting`, `alarms` and the optional `notifications`. The extension requests no cookies,
  debugger, web-request or all-sites access, and loads no remote code.
- **Strict message validation.** Content-script messages must come from the extension's top-frame
  script on a supported origin, with a workspace ID that matches the page and the saved connection.
  Admin actions are accepted only from the options page. Pairing messages are accepted only from
  the helper's `/setup` page on `http://127.0.0.1:8766`.
- **Secrets.** PATs and the helper pairing live in `chrome.storage.session`, which is memory-only
  and hidden from content scripts. They are never returned to pages or written to logs. Diagnostics
  are redacted.
- **Helper.**
  - Binds to `127.0.0.1` only and validates the `Host` header.
  - Bridge calls must carry the random pairing key and come from this extension's origin. CORS
    preflights are answered only for that origin.
  - The launcher endpoint rejects browser requests and needs its own header.
  - The helper never runs caller-supplied SQL, only named query kinds.
  - Monitor calls use a fixed read-only `GET` allowlist.
  - CLI child processes get argument arrays, never tokens on the command line.
- **SQL.** Read-only, parameterized statements. Three-part names are validated and quoted. Only the
  two allowed price tables can be used.
- **Databricks APIs.** SQL statement execution and cancel, plus read-only `GET` calls for
  warehouses, job runs, pipelines and clusters. The Genie side panel adds a separate allowlist:
  listing agents, reading messages and results, and three `POST`s (start a conversation, send a
  follow-up, re-run an expired result). Nothing else is written to Databricks.

## Privacy

- No telemetry, analytics or remote logging. The extension talks only to your workspace and,
  optionally, to the helper on your computer.
- It never collects SQL statement text or query result rows. Query History estimates use only
  statement IDs, timestamps, durations, status, cache flags and compute metadata.
- It never infers identities from display names.
- All stored data stays in your browser profile. The CLI's own profile files and credential store
  are the only exception.

## Project layout

```
extension/            the unpacked extension (load this folder)
  manifest.json       MV3 manifest with a stable public key
  src/core/           validation, IDs, UTC periods, labels, allocation, demo and import data
  src/databricks/     pricing adapter, config, HTTP client, warehouses, monitor API, query kinds
  src/background/     service worker, router, sender checks, store, secrets, cache, helper client, monitor
  src/content/        banner, badges, Query History estimates, compute previews, colors
  src/explorer/       Cost Explorer model, data, charts, CSV export
  ui/                 popup, Connection preferences (options), monitor window
  docs/               calculation guide (offline HTML + CSS)
local/                local helper (server.mjs, oauth-bridge.mjs, setup page), fixture, tests
scripts/              icon generation, sanitized packaging
start-helper.command  macOS launcher (double-click)
start-helper.sh       macOS/Linux launcher
costs.example.json    synthetic import example
```

## License

No license has been chosen yet. `package.json` says `UNLICENSED`.
