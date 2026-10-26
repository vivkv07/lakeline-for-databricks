# Changelog

All notable changes to Lakeline for Databricks are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Open source under the Apache License 2.0, with a NOTICE file, a trademark policy for the Lakeline
  name and icon, a contributing guide with DCO sign-off, a security policy with private reporting,
  code owners, issue and pull request templates, CI (tests and the packaging secret scan) and a DCO
  check. Store packages now include LICENSE and NOTICE.
- README prerequisites (system tables, grants and a SQL warehouse that can read them), screenshots,
  and RELEASING.md describing how a merged contribution reaches the stores.

### Removed

- The experimental "Use my Databricks login" sign-in. Databricks' public API rejects browser
  sessions, the store build already hid it, and its bridge script no longer loads into workspace
  tabs. Connections saved with it by development builds are dropped; connect again with Sign in
  with Databricks or a token.
- Unused code: chart color constants, exported lists and debug hooks nothing read, and two message
  handlers nothing sent.

### Security

- The extension CSP now allows connections only to Databricks workspace hosts and the local helper
  (`connect-src`). The store build also drops the local test workspace from it.
- The message router fails closed. A handler with an unknown trust class, or an add-on that
  registers a message type twice, stops the router at startup instead of running unchecked.
- Error redaction now runs before the 2000-character cut, so no token prefix survives, and it catches
  tokens glued to other text.
- Tokens saved with "Remember on this computer" now live in the extension's own IndexedDB, which
  content scripts can't open, instead of `chrome.storage.local`. Tokens remembered by 0.1.1 move
  over automatically on first start, and the old key is deleted.
- Disconnecting a workspace now also signs it out, instead of keeping its sign-in tokens until the
  browser closes.

### Fixed

- Store ZIPs had an invalid central directory: entries were compressed but labeled as stored, so
  strict ZIP readers rejected them. A test now checks every entry inflates to its CRC.
- The calculation guide and README described an admin-only sign-in, a SQL-only scope and
  session-only tokens; they now match 0.1.1.
- The browser test for the run monitor no longer depends on the time of day. The fixture adds a
  failed manual re-run three hours before now, which is always inside the monitor's 24-hour window.

## [0.1.1] (2026-10-16)

### Changed

- **Sign in with Databricks needs no setup.** Without an app connection, Lakeline signs in through
  Databricks' built-in public client (`databricks-cli`, the one the CLI and SDKs use). The
  workspace's sign-in page opens in a tab; Lakeline reads the code when the tab reaches
  `http://localhost:8020` (new optional host permission), closes the tab and uses one all-apis
  token for costs, Genie and the run monitor. It never opens a tab without a click.
- **Personal access token in the popup.** Other ways to sign in now starts with a token box, a link
  to the workspace's Access tokens page and "Remember on this computer". The token is checked with
  Databricks before it is saved; a refused token is not kept.
- An organization's app connection (client ID) still works and moved under Other ways to sign in.
- New messages: quick sign-in blocked by an admin, token refused, token format.

## [0.1.0] (2026-10-15)

First development version. Independent project, not affiliated with Databricks,
Inc. All amounts are estimates: "Estimated costs. Billing can be delayed; final invoices may differ."

### Added

**Genie side panel**
- Ask a Genie Agent from a Chrome side panel ("Ask Genie" in the popup) and keep working: the
  service worker sends the question, polls with backoff under a 10-minute limit, fetches the
  result table and resumes in-flight questions after a restart.
- Per-message status (Sending, Genie is working, Running query, Answer ready, Failed with a plain
  reason), answer text, a capped result table with "showing N of M", Show SQL, Copy answer,
  suggested follow-ups, New conversation, keyboard sending (Enter, Shift+Enter for a newline).
- One shared `all-apis` consent for the run monitor and Genie (OAuth purpose `apis`, with
  `monitor` and `genie` as aliases); PAT mode works too. Helper mode is explained, not supported.
- Conversations kept only in session storage with size caps; never in local storage, diagnostics,
  logs or notifications. Opt-in "Notify me when Genie answers" (data-free notification) and a
  badge count while the panel is closed.
- Genie paths are a separate HTTP allowlist, used only by the Genie client. New `GENIE_*` error
  codes with next steps. Demo mode has synthetic DEMO agents; the fixture server mocks the API.

**Extension and data modes**
- Manifest V3 extension for Chrome and Edge (116+), with a stable extension ID from a public
  manifest key.
- Three data modes. Demo shows synthetic, labeled data and makes no Databricks requests. Local
  import reads a validated `costs.json` file (see `costs.example.json`). Connected runs read-only SQL
  on a SQL warehouse you choose.
- Workspace identity from URL parameters, documented host names, observed tabs or the saved
  connection. Conflicting IDs are refused rather than guessed. Requests are checked against the
  saved workspace ID.
- One cost connection per workspace origin, with Automatic or explicit SQL warehouse selection.
  Automatic is resolved at save time and never per query.

**Pricing**
- A single shared pricing adapter for every cost query. Exactly two price tables are allowed:
  `system.billing.list_prices` (`pricing.effective_list.default`) and
  `system.billing.account_prices` (`pricing.default`). The field is chosen before SQL is built, and
  there is no fallback or mixing between the two.
- Price matching on account, SKU, cloud, usage unit and currency, with half-open validity
  (a `NULL` end is open-ended). A record is priced only when exactly one price row matches.
- Signed corrections (ORIGINAL, RETRACTION and RESTATEMENT) are kept, and currency is never
  converted.
- `GENIE_FREE_USAGE` is treated as free and its quantity is reported separately. No other missing
  price is treated as zero.
- A "Priced subtotal" with the unpriced record count, affected SKUs and first and last affected
  dates when coverage is partial. No subtotal is shown when nothing is priced.

**Workspace banner**
- A sticky banner with the estimated total or priced subtotal for 7, 30 or 90 complete UTC days,
  the change against the previous equal period, the latest-usage age, the pricing basis, Refresh,
  Settings and **How costs work**.
- States for loading, available, no data, partially unpriced, no priced usage, paused, not
  connected, unidentified workspace and error. Technical details show the SQL error code and
  statement ID, never secrets.

**Native costs**
- Period badges for jobs, pipelines, SQL warehouses, notebooks and Databricks Apps, and period
  totals beside job and pipeline titles.
- Per-execution costs on job run and pipeline update rows, searched across 365 UTC dates including
  today. Small amounts show up to six decimal places.
- Job costs include pipeline updates triggered by the job, through
  `system.lakeflow.pipeline_update_timeline` and `job_task_run_timeline`. Memberships are
  deduplicated and each billing record is counted once. If the timelines are unavailable, jobs fall
  back to "Direct job cost" with a warning on each affected item.

**SQL Query History estimates**
- Per-execution estimates allocated by time overlap with warehouse billing intervals. Concurrent
  queries share equally, and idle time stays unallocated.
- Matching uses the statement ID, or else a unique match on warehouse, start second and duration.
  The extension never reads SQL text or result rows.
- Explicit labels when no estimate is given: Waiting for history, Waiting for billing,
  Cached · unallocated, Execution pending, Match ambiguous, Row unavailable, Compute unsupported,
  Price unavailable and Estimate unavailable.

**Compute previews**
- "DBU only" hourly previews beside SQL warehouse sizes, using the latest billed SKU's current price
  multiplied by DBU/hour. The published Azure serverless DBU table is used only where it applies.
  5X-Large shows "Rate unavailable".
- Interactive compute previews from an unambiguous all-purpose DBU rate, multiplied by the native
  DBU/hour value or range.

**Cost Explorer**
- Products, Top drivers, Runs, Calendar, SKUs and Daily detail views. Values are available on hover,
  tap and focus, with keyboard operation, drilldowns, breadcrumbs, filter chips, search and sorting.
- Exclusive ownership per billing record: job, pipeline, warehouse, notebook, app, cluster, then
  unattributed.
- On-demand detail loads with limits: 200 entities with the full candidate count, and a 20,000-row
  summary. Oversized or truncated results are rejected.
- CSV export with provenance metadata and formula-injection protection.
- Heuristic flags for daily positive spikes and high-cost runs. These are explanatory, not anomaly
  detection.

**Workspace colors**
- Per-workspace top-bar colors from the popup: strict `#RRGGBB` values, presets, a preview, Save
  and Reset. Stored separately from cost connections, keyed by `origin|workspaceId`, with host
  defaults. Text contrast is chosen automatically.
- Optional sidebar coloring ("Also color the sidebar", saved per workspace): the side navigation
  and the shell around the page card take the same color, so bar and sidebar read as one frame.
- Native controls blend with the color instead of keeping their own backgrounds: the search box,
  pills, the New button and the selected sidebar item use a lighter or darker shade of the same
  color, with readable secondary text; account initials keep their own circle. Search fields are
  no longer forced white.

**Monitor widget**
- A compact monitor window for job runs, pipeline updates, SQL warehouses and clusters. It polls
  read-only REST `GET` endpoints every 60, 120 or 300 seconds with backoff, and never sends SQL in
  the background.
- A toolbar badge with the active run count and a failure marker.
- Opt-in desktop notifications for failed runs, using the optional `notifications` permission.
- Opt-in opening when the browser starts.
- A **Float on top** button that uses Document Picture-in-Picture, which isn't yet verified on
  extension pages.
- A separate monitor sign-in (`all-apis`, `dcc-mon-*` profile) when you use the helper.

**Local helper and setup**
- A Node 20+ helper on `127.0.0.1:8766` that runs the Databricks CLI (v1.12+) browser sign-in on
  dedicated `dcc-*` profiles with the `sql` scope, and runs the same named query kinds as the
  extension.
- `start-helper.command` and `start-helper.sh` start the helper, reuse a running helper of the same
  version, and explain how to stop an older one.
- Pairing uses a random key passed in a URL fragment and verified before it is saved. Manual key
  entry is a fallback.
- Capability checks (account prices, price adapter version 2, job–pipeline attribution, monitor)
  block requests against an outdated helper with restart steps.
- Personal access token mode, with no helper.

**Errors and diagnostics**
- Plain-language errors with next steps for permissions, missing tables, price-field mismatch,
  schema mismatch, expired sign-in, timeouts, unavailable warehouses, oversized results and helper
  problems.
- The last 20 diagnostics are stored locally, with secrets redacted.

**Documentation**
- An offline, accessible "How costs are calculated" guide (`extension/docs/calculation-guide.html`).
  It includes a worked query-allocation example and links to official references checked on
  2026-10-15.
- A README covering install, modes, connection, updates, limitations, safe removal, security and
  privacy.

**Development**
- Synthetic fixture workspace on `127.0.0.1:8765` (`node local/server.mjs --fixture`).
- Simulated tests (`npm test`): DuckDB with system-table-shaped tables for SQL, and jsdom for
  content scripts. Query-history fixtures use SQL-text sentinels.
- Sanitized, allowlist-based packaging (`npm run package`) with secret and real-host scanning.

### Security

- Optional, per-workspace site access. Other permissions are `storage`, `activeTab`, `scripting`,
  `alarms` and the optional `notifications`. No cookies, debugger, web-request or broad host
  permissions, and no remote code.
- Strict sender validation for content scripts, extension pages, options-only admin actions and the
  helper setup page.
- PATs and the helper pairing are kept only in memory-only session storage.
- The helper binds to loopback only and validates the `Host` header. It authenticates bridge calls
  with the pairing key and the extension origin, and never runs caller-supplied SQL.
- Read-only, parameterized SQL. No telemetry. No query text or result rows are collected.
