# Databricks Cost Companion: build plan

Baseline (2026-10-15): empty directory, not a git repo. Node 22.16, git 2.50 and Google Chrome are
installed. Edge and the Databricks CLI are not. Playwright's cached Chromium is available for
disposable-profile browser tests. Building from scratch against the spec. "Spec §N" means the
numbered section of the pasted spec.

## Ground rules

- Plain JavaScript, HTML and CSS with no bundler. Shared modules are classic scripts that attach to
  `globalThis.DCC` and also `module.exports`, so the same file runs in the service worker
  (`importScripts`), content scripts, extension pages and `node --test`.
- Dev-only dependencies: `jsdom` for DOM unit tests and `playwright` for disposable-profile browser
  tests. Neither is shipped.
- Permissions: `storage`, `activeTab`, `scripting`, `alarms`. Workspace hosts are
  `optional_host_permissions`. Content scripts are registered per granted origin with
  `chrome.scripting.registerContentScripts`, so nothing runs before the user grants a workspace.
- The helper executes SQL itself, so CLI OAuth tokens never enter the extension. PAT mode executes
  from the service worker. Both paths use the same SQL builders, and the helper loads them from
  `extension/src/databricks/`.
- Every stage ends with `npm test` green and a git commit.

## Layout

```
extension/
  manifest.json
  src/core/         ns, ids (workspace/resource parsing), validate, periods (UTC), money, labels, demo-data
  src/databricks/   config, pricing (2-table adapter), sql-client, warehouses, rest-client,
                    queries/{summary,row-data,job-attribution,query-history,compute-rates,explore}
  src/background/   service-worker, router, sender, connections, secrets, cache, helper-client, monitor-poller
  src/content/      row-refs, row-data, workspace-data, workspace-ui, inline, warehouse-ui,
                    native-adapter, native-cost-data, native-estimates-ui, workspace-color,
                    workspace-theme, content-main, setup-handoff
  src/explorer/     explore-model, explore-data, explorer, charts, csv
  src/errors.js
  ui/               popup, options, monitor (widget), workspace-appearance, brand.css
  docs/             calculation-guide.html, calculation-guide.css
local/              server.mjs (helper + fixture), oauth-bridge.mjs, workspace.html, workspace.js, test-*.mjs
scripts/            package.mjs (allowlist ZIP + inspection)
start-helper.command, costs.example.json, README.md, CHANGELOG.md
```

## Stages (spec §16, plus the monitor widget)

| # | Stage | Main files | Tests |
|---|-------|-----------|-------|
| 1 | Baseline, PLAN.md, git init, package.json, manifest skeleton | PLAN.md, package.json, manifest.json | manifest lint |
| 2 | Data, identity and security contracts | core/ids, core/validate, core/periods, background/sender, background/secrets, errors.js | host/ID parsing, account-console rejection, sender rejection, redaction |
| 3 | Pricing adapter | databricks/pricing, databricks/config, queries/summary | both schemas on every SQL path, table allowlist, no COALESCE across structs, validity window, signed corrections, GENIE_FREE_USAGE, priced subtotal |
| 4 | Summary and native placement | sql-client, warehouses, connections, cache, workspace-data, workspace-ui, popup, options, demo-data | banner states, SPA replacement, mutation storms, no duplicate hosts, warehouse auto-selection, stale responses |
| 5 | Job, pipeline and run attribution | row-refs, row-data, inline, queries/row-data, queries/job-attribution | role-grid rows with a Launched link, collect_set dedupe, single counting, direct-only fallback |
| 6 | Query and compute estimates | native-adapter, native-cost-data, native-estimates-ui, warehouse-ui, queries/query-history, queries/compute-rates | unique vs ambiguous matching, allocation conservation, SQL-text sentinels, rate previews |
| 7 | Explorer | explore-model, explore-data, explorer, charts, csv | hover/focus, filters, prior-period alignment, limits, CSV escaping |
| 8 | Workspace colors | workspace-color, workspace-theme, ui/workspace-appearance | `#RRGGBB` validation, contrast, origin\|ID isolation, nav replacement, reset |
| 9 | **Monitor widget** (from your request; not in the spec) | ui/monitor, background/monitor-poller, databricks/rest-client | read-only REST allowlist, polling backoff, never wakes a stopped warehouse |
| 10 | Setup, errors, docs | local/server.mjs, local/oauth-bridge.mjs, setup-handoff, start-helper.command, docs/*, README, CHANGELOG | fragment pairing, Host header, launcher origin rules, capability gating, guide anchors |
| 11 | Browser and authorized SQL validation | local/workspace.html, local/test-browser-*.mjs | Playwright with a disposable profile against the fixture; live SQL only with your authorization |
| 12 | Sanitized package | scripts/package.mjs | allowlist ZIP, inspected for secrets |

## Monitor widget (proposed, pending your answer)

A Chrome extension cannot draw on the desktop by itself. The closest supported options:

1. **Monitor window.** A compact `monitor.html` opened with `chrome.windows.create({type:"popup"})`.
   It can open automatically when Chrome starts (`runtime.onStartup`, opt-in).
2. **Always on top.** A "Float" button moves the widget into a Document Picture-in-Picture window,
   which stays above other apps while Chrome runs. It needs a click each time.
3. **Toolbar badge.** The icon shows a count of running and failed runs.
4. **Optional desktop notifications** for failed runs. The spec lists notifications as future
   work (§17), so this is off unless you approve it.

Data: active and recent job runs, pipeline updates, SQL warehouse states and cluster states come
from read-only REST GETs, which use no warehouse time. The cost summary refreshes from cache or on
demand. Background polling never sends SQL to a stopped warehouse, because that would start it and
bill you.

## Verified facts (2026-10-15, official docs and CLI source)

- **CLI.** 1.x line, latest v1.21.0. Keep the v1.12 minimum. `auth login --scopes` exists (v0.287+),
  and `auth token --profile X` prints JSON that includes `refresh_token`. That output never leaves
  the helper. Tokens live in the OS keychain from v1.0.
- **`list_prices`.** Confirmed `pricing.effective_list.default`. `usage` has no currency column, so
  currency comes from the price row. `GENIE_FREE_USAGE` is documented (from 2026-07-20).
- **`account_prices`.** Not in the official docs. Third-party sources say Private Preview, AWS/GCP
  only, schema unverified. It stays in the allowlist, as the spec requires. A missing table or field
  produces a specific error, never a fallback to list prices.
- **Lakeflow tables.** `pipeline_update_timeline.trigger_details.job_task.{job_id, job_task_run_id}`
  is confirmed. It is set only when `trigger_type = JOB_TASK`.
- **`query.history`.** `compute.cluster_id` is never populated, so cluster matching uses
  `compute.type` and `warehouse_id` only. We never select `statement_text`.
- **Azure serverless DBU/hr table.** Matches the spec exactly. Classic and Pro have the same DBU
  counts. 5X-Large has no published rate, so it shows "Rate unavailable".
- **REST.** Warehouses have no SERVERLESS type, so use `enable_serverless_compute`. Use Jobs API 2.2
  `runs/list` (limit ≤ 25) and read `status`, because `state` is deprecated. INLINE results cap at
  25 MiB, and we reject `truncated` or multi-chunk results.
- **Chrome.** Document Picture-in-Picture (Chrome 116+) needs a gesture and a top-level page. It is
  unverified from `chrome-extension://` pages, so stage 9 tests it, with the plain monitor window as
  the fallback. The side panel is Chrome 114+.

## Interaction reference: finopsway.com/features (ideas only; no code, assets or branding)

- **Borrowed:**
  - A cost banner on every page that expands into period controls, a chart and a per-SKU list.
  - A visible "latest reported" freshness line.
  - Badges beside each run's start time.
  - Dollar estimates in the warehouse size picker.
  - Like-for-like period comparisons.
- **Differs on purpose:**
  - No VM or infrastructure estimates: excluded by spec §4 and §17.
  - Periods are 7, 30 and 90 days, per spec §3.
  - Shared-cluster costs are not split, per spec §7.
  - Serving endpoints, Genie and Lakebase show up through `billing_origin_product` in the
    banner and Explorer. Resource badges for them are a later add-on.

## Visual style (owner request, 2026-10-15)

All extension surfaces use the owner's house style from `notes/STYLE.md`: pure black or white
surfaces, Inter and IBM Plex Mono, one blue accent plus warm amber for data, hairline cards, pill
buttons, numbered mono eyebrows and no em dashes. This supersedes the spec §1 "neutral" palette.
Accessibility rules still apply. The style is used without any brand names or marks. The work is
published as the owner's own.

Open question for publishing: the Chrome Web Store and Databricks trademark rules discourage a
third-party mark at the start of a product name. "Cost Companion for Databricks" is safer than
"Databricks Cost Companion". This needs the owner's decision before any public listing.

## Decisions (answered 2026-10-15)

- **Widget.** A floating monitor window, opt-in auto-open on Chrome start, a "Float" button for an
  always-on-top PiP window, and a toolbar badge.
- **Monitor scope.** Job runs, pipeline updates, SQL warehouses and clusters, polled every 60 s
  with read-only REST GETs. Desktop notifications for failed runs are opt-in, with `notifications`
  as an optional permission. This intentionally adds one item from spec §17 to v1.
- **Monitor auth.** The cost profile keeps `--scopes sql`. Enabling the monitor triggers a separate
  one-time sign-in with `all-apis` on a dedicated `dcc-mon-*` profile. The helper forwards only an
  allowlist of read-only GET paths. PAT mode works for both.
- **Clouds.** AWS, Azure and GCP are all in scope. The Azure serverless DBU table applies only to
  Azure serverless warehouses. `account_prices` can fail on Azure, and that failure gets a specific
  error.
- **Pairing.** The manifest carries a public `key`, so the extension ID is stable. The helper setup
  page hands the fragment key to the extension through `externally_connectable` (exact
  `127.0.0.1:<helper port>` origin only). The helper answers CORS preflights only for that
  extension origin. Ports: helper on 8766, fixture on 8765.
