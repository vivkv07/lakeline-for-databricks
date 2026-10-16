# Databricks Cost Companion — product spec (as provided by the user, 2026-10-15)

Additions decided with the user are in PLAN.md ("Decisions"): floating monitor widget, run/compute
monitoring with opt-in notifications, separate all-apis sign-in for the monitor, all three clouds.

## 1. Product goal and presentation

Show useful cost context inside the user's existing Databricks workspace: a workspace banner, resource and job badges, run and pipeline-update rows, SQL Query History, and compute-size controls. Users shouldn't need a separate dashboard for basic cost questions. Offer an expandable Explorer for deeper analysis.

Take interaction inspiration from common FinOps dashboards, but write an independent implementation. Don't copy any vendor's source, assets, or branding, and don't imply affiliation.

Extension UI uses a neutral, accessible style: one accent color, dark text on light surfaces, restrained borders, visible focus states. Preserve native Databricks controls and navigation. The only intentional exception is workspace top-bar coloring (section 12).

All amounts are labeled as estimates. Keep this visible notice: **"Estimated costs. Billing can be delayed; final invoices may differ."** Distinguish: recorded attributed costs, allocated query estimates, prospective hourly rates, priced subtotals, imported data, and synthetic demo figures. Missing data is never displayed as zero.

## 2. Runtime, clouds, and architecture

- Edge and Chrome, Manifest V3, service worker, content scripts, options page, toolbar popup.
- Supported workspace hosts (HTTPS): `*.cloud.databricks.com`, `*.azuredatabricks.net`, `*.gcp.databricks.com`. Exclude account-console hosts and unrelated sites.
- Allow a separate local fixture at `http://127.0.0.1:8765`.

Modules: core, background, databricks, row-refs, row-data, workspace-data, workspace-ui, inline, warehouse-ui, native-adapter, native-cost-data, native-estimates-ui, explore-model, explore-data, explorer, workspace-color, workspace-theme, workspace-appearance, errors, setup-handoff, popup, options, brand, docs/calculation-guide.html + .css, local/server.mjs, local/oauth-bridge.mjs, local/workspace.html, local/workspace.js, costs.example.json, start script, README.md, CHANGELOG.md, local/test-*.mjs.

Don't mount both a legacy floating widget and the native banner.

## 3. Data modes and connection

**Three modes:**
- **A. Demo.** Synthetic data, labeled DEMO. No Databricks connection, no Databricks network requests.
- **B. Local import.** Optional `costs.json` with validated per-workspace, per-resource, per-period summaries. Fields: workspace, type, id, periodDays, currency, total, previous, basis, owner, allocation, updatedAt, coverageEnd, daily[{date, cost}]. Don't imply imported summaries contain query history or run detail that wasn't imported.
- **C. Connected Databricks.** Read-only SQL against the user's configured warehouse and billing sources.

**Popup controls:** mode, Connect Databricks, workspace colors, show costs inside Databricks, period (7/30/90 days), diagnostics, local fixture link, calculation guide.

**Connection flow:**
- Discover supported Databricks tabs in the browser profile. Resolve workspace IDs from `o=`, `w=`, `workspace_id=`, supported hash URLs, previously observed tab metadata, or the saved connection.
- If several workspaces are open, let the user choose. Never switch identity or workspace silently.
- One cost connection per workspace origin. Validate the numeric workspace ID on every content-script request; reject mismatches.
- Browser sign-in via the local helper, plus a PAT option. Manual URL/ID, auth, warehouse, and billing settings live under "Connection preferences."
- List real warehouses (name, ID, state, size) before requiring a save. Offer **Automatic** or an explicit warehouse per workspace.
- Automatic: prefer a usable RUNNING warehouse, then the smaller supported size, deterministic ordering. Resolve at save/reconnect. Never switch warehouses silently per query.
- Preserve saved Automatic/manual choices when editing. Show unavailable saved warehouses explicitly. Ignore late responses from a previously selected workspace.
- Listing a warehouse does not prove CAN USE or billing-table access. The first SQL execution may reveal access failures.

**Local helper:**
- Start script launches the Node helper with `--open`, opening setup in Edge if available, else the default browser.
- Normal flow: start helper → click Connect workspace. First-time extension loading, runtime installation, native permissions, and SSO consent are explicit user steps.
- Pair with a random 24-hex-character key in a URL fragment. Remove the fragment immediately. Verify pairing before opening options. Never put the key in query strings, response HTML, logs, or the options URL.
- Manual key entry is a fallback only. Reopening setup reuses a same-version helper. An older helper needs a clear restart handoff.
- Use a dedicated Databricks CLI OAuth profile derived from the explicitly selected origin, never an arbitrary default profile. Reuse a valid session; otherwise run interactive OAuth with the SQL scope. Enforce a minimum CLI version (v1.12).
- Helper pairing/bridge credentials live in extension session storage. Clear stale bridge sessions on key rotation.
- The CLI keeps its own OAuth credentials. Never package that directory.
- PAT mode works without the helper.

## 4. Pricing adapter: exactly two allowed tables

Dropdown with only: `system.billing.list_prices` → `p.pricing.effective_list.default`; `system.billing.account_prices` → `p.pricing.default`. Derive the field from the selected table. Reject any other pricing table or view. No free-text price-table field, no schema override.

Never write `COALESCE(p.pricing.effective_list.default, p.pricing.default)`. Choose the field before generating SQL. Use one shared adapter for every cost query (extension/src/databricks/pricing.js).

- Recorded cost = `SUM(signed usage_quantity × matching unit price)`. Read `system.billing.usage` or an approved configured usage view.
- Match price on account_id, sku_name, cloud, usage_unit, currency_code and validity: `usage_end_time >= price_start_time AND usage_end_time < price_end_time`, NULL end = open-ended.
- Native usage units; no silent currency conversion. Keep ORIGINAL, RETRACTION, RESTATEMENT in the signed sum.
- `GENIE_FREE_USAGE` is zero; free DBUs shown separately. Never zero any other missing price.
- Carry `pricingBasis` and `priceTable` through parsers, caches, responses, labels, tooltips, CSV.
- List-price labels disclose private discounts excluded. Account-price labels disclose invoice adjustments not modeled. Cloud-provider charges excluded and labeled. No silent fallback between account and list prices; no mixed-source totals.
- If some records are unpriced, show **"Priced subtotal"**, not a full total, with missing record count, affected SKUs, first/last affected usage dates. If nothing is priced, show no subtotal. A signed subtotal is not necessarily a lower bound.

## 5. Persistent workspace banner

- Compact sticky banner in a visible native header or main container. Survives SPA navigation and container replacement. No duplication, no offscreen drift, no blocked controls, no MutationObserver loop. Don't reinsert a hidden host that's already first in the correct container.
- Shows: estimated total or labeled priced subtotal; selected complete UTC period; latest-usage age; basis (list/account/import/demo); 7/30/90 controls; Refresh; Settings; How costs work; the estimates disclaimer.
- Periods use complete UTC dates and exclude today. Compare with the immediately preceding equal-length period. Latest-usage age is a freshness signal, not proof every SKU is complete.
- Expands into the Explorer (section 10). States: loading, available, no data, partially unpriced, paused, error. Technical details section shows SQL error code and statement ID, nothing secret.
- Manual Refresh updates the summary. Row and query caches keep their own lifecycles.

## 6. Native resource, title, run, and update costs

- Badges next to supported native names: jobs, pipelines, SQL warehouses, notebooks, Databricks Apps.
- Job and pipeline detail pages: total beside the title, labeled with the period, e.g. "Job total: $12.34 · 90d est." This is a period total, not lifetime spend.
- Each run/update row shows **that execution's** recorded cost, not the resource's period total. Search billing across up to 365 UTC dates (including today). Disclose that bounded history and delayed billing can make results incomplete. Show up to six decimal places for small amounts. Use "approx." or "est." labels.
- Parse real native links/IDs: job/run routes, pipeline/update routes, legacy routes, supported notebook and app routes. Validate origin and workspace ID. Reject external, edit, create, and navigation-only links.
- Don't read application-private React state. Don't infer identities from names.
- On job run tables, a row can contain the current job's run link **and** a different workflow in its Launched column. Prefer the exact current job/run identity. Don't suppress the badge because of multiple run IDs. Don't substitute the launching workflow's whole cost.
- Leave dense duration timeline bars native. Don't badge each status dot.
- Use visible row/cell geometry and semantic table/grid roles. Handle virtualized and recycled rows, inserted rows, scrolling, period changes, route changes, pause/resume. Remove stale badges. Bounded throttling so continuous DOM updates can't postpone scanning forever. Deduplicate references and in-flight requests; batch at most 40 resources.

## 7. Job costs that include triggered pipelines

Direct `job_id`/`job_run_id` billing is not enough for jobs that trigger pipelines. Add on top of direct attribution:
- `system.lakeflow.pipeline_update_timeline` gives pipeline_id, update_id, `trigger_details.job_task.job_id`, `trigger_details.job_task.job_task_run_id`.
- Join triggering task-run IDs to `system.lakeflow.job_task_run_timeline.run_id`, constrained by workspace and job, to get each requested run's parent `job_run_id`.
- Job-period cost includes updates triggered by that job. Per-run cost includes only updates mapped to that exact parent run.
- Add matched pipeline/update billing to direct job billing without counting any usage record twice for the same target.

Deduplicate hourly timeline slices and repeated task rows into unique pipeline/update membership per target (collect_set of keys per target + array_contains in the billing join). Don't use a correlated EXISTS in an ON clause referencing both inputs. Don't use a raw timeline-to-billing join (multiplies charges).

If timeline access or schema is unavailable, keep direct costs, label them **"Direct job cost,"** and show a pipeline-attribution warning. Don't call them a complete job total. Don't invent shared all-purpose allocation when billing has no relevant job/run identity.

Attach attribution status and warnings to each cached item, not just a top-level batch envelope.

## 8. Query History per-execution estimates

- On native SQL Query History rows, show an individual estimate. Suppress generic warehouse-total badges on this page.
- **Identity:** prefer statement ID from native attributes or execution-detail links. Otherwise accept only a **unique** metadata match on warehouse ID, start time at displayed-second precision, and total duration within the display's rounding tolerance. **Never match on SQL text.** Read only statement IDs, timestamps, durations, status, cache flags, and compute metadata. Never read the SQL text or result rows of estimated queries.
- Source: `system.query.history` or a configured approved three-part view. Look back 90 UTC dates, independent of the banner period. Only supported SQL warehouse executions with usable completed execution time get numeric allocations.

**Allocation method:**
1. `active_start = MAX(query_start, query_end − execution_duration_ms)`, `active_end = query_end`.
2. Price recorded warehouse usage intervals overlapping target execution windows.
3. Include **all** relevant executions visible to the identity overlapping those intervals, not only rows on screen.
4. Split billing intervals at execution-window boundaries. For each segment with active executions, allocate `interval_cost × segment_duration / interval_duration / active_execution_count` equally.
5. Sum per query. Fully idle segments stay unallocated.

Explain assumptions: uniform cost within an interval, equal sharing among concurrent queries, approximate active timing, hidden executions, delayed/partial billing, unused capacity. Not measured CPU/memory or an invoice line. Allocations need not sum to the warehouse's full bill.

Withhold rather than guess for: ambiguous IDs, no match, cached results without measurable execution time, running executions, unsupported compute, missing billing, missing prices. Labels: **Waiting for history, Waiting for billing, Cached · unallocated, Execution pending, Match ambiguous, Row unavailable, Compute unsupported, Price unavailable, Estimate unavailable.** Hover/focus shows the reason. A missing match may also mean old or out-of-window metadata. Show a visible explanatory note near the native Query History heading.

## 9. SQL warehouse and interactive compute previews

Show prospective hourly DBU cost beside supported native size options.
- **SQL warehouses:** current DBU rate for the latest billed warehouse SKU in the selected price source × an explicit DBU/hour value from the native UI. Where the UI omits it, the Azure serverless mapping is 2X-Small=4, X-Small=6, Small=12, Medium=24, Large=40, X-Large=80, 2X-Large=144, 3X-Large=272, 4X-Large=528 DBU/hr (verified against Azure docs 2026-10-15; 5X-Large has no published rate). Don't apply it to unsupported clouds, types, or real-time warehouses. Rate is per cluster; autoscaling multiplies it.
- **Interactive compute:** current all-purpose DBU prices for SKUs observed in the workspace or existing cluster in the last 90 UTC dates. Filter by Photon when detectable. Require one unambiguous numeric rate. Multiply the native DBU/hr value or range (include driver only where the native estimate does). Update on node-size, worker-range, input, and DOM changes. Price an option only if it exposes DBU info. Don't guess DBU-per-core mappings. Don't use SQL warehouse rates for interactive compute.
- Label previews **"DBU only"**. Exclude VM, disk, network, other infrastructure. "Rate unavailable" is a valid state. Never save or resize native compute while a preview shows.

## 10. Cost Explorer and visualizations

Six views inside the expandable banner: **Products** (stacked daily product bars, total trend, aligned prior-period overlay); **Top drivers** (ranked horizontal bars, sortable resource table); **Runs** (duration-vs-cost scatter, native execution links, accessible overlap selection); **Calendar** (Monday-first UTC heatmap; missing dates unavailable, not zero); **SKUs** (current vs prior, daily drilldown); **Daily detail** (sortable day-level table and comparisons).

Support: exact values on hover, tap, and focus; keyboard operation; drilldowns (product, resource, run, SKU, day); breadcrumbs and filter chips; search; sort by cost/change/name asc/desc; share of total where valid; reset to workspace; expanded and compact layouts. Selecting a day keeps its aligned prior-period comparison.

- On-demand resource/run detail: explicit load actions, 5-minute cache, request dedupe. Limit to 200 ranked entities; disclose the full candidate count and when results are limited. Reject silently truncated, multi-chunk, or oversized SQL results. Summary query ≤ 20,000 rows.
- **Ownership** is exclusive per billing record, priority: job, pipeline, warehouse, notebook, app, cluster, unattributed. Native badges may show broader related-workload attribution; document that these differ. Never add related badges into a workspace total.
- Run durations optional: if duration access fails, keep costs, warn, omit unusable scatter points. Never replace missing duration with zero. A selected-period run cost is not lifetime run cost.
- **CSV export** of the filtered table, with source, pricing basis/table, currency, UTC bounds, freshness, scope/limit metadata. Escape quotes, newlines, and formula prefixes (`=`, `+`, `-`, `@`) safely. Preserve legitimate negative costs. Validate native links and app names; don't guess routes from IDs.

## 11. Heuristic flags (not an anomaly engine)

- **Daily positive spike:** needs ≥14 priced previous-period days and recent observed billing. Use same-weekday samples if ≥3, else all previous samples. Flag if a positive daily cost exceeds `MAX(median × 1.5, median + 3 × MAD)`. Suppress when freshness or history is insufficient.
- **High-cost runs:** compare ≥8 priced, completed runs with positive observed duration in the same resource cohort. Flag cost above Q3 + 1.5 × IQR.
- Explanatory heuristics, not confirmed anomalies or causal analysis.

## 12. Workspace top-bar colors

- Popup → **Workspace colors** panel, independent of billing. Saved-workspace selection, URL input, native color picker, six-digit hex input, presets, readable preview, explicit Save, Reset.
- `chrome.storage.local`, separate from billing connections and cost visibility, keyed by `origin|workspaceId`. Host defaults apply when the saved URL has no workspace ID. ID-specific overrides win. If a page URL omits an ID, use the saved connection ID when present. Changing or disconnecting billing never overwrites appearance prefs.
- On Save, request already-declared site access for that workspace only if needed. No sign-in, helper, SQL, or new broad permission is needed for colors.
- Target `nav[aria-label="Top Navigation"]` or a visible supported topbar test ID. Don't tint every header or the extension's own banner. Scoped, removable CSS. Strict `#RRGGBB` validation. Choose black or white text by relative luminance; keep search and action controls readable. Preserve brand graphics; don't globally replace SVG fills.
- Handle SPA changes, nav replacement, refresh, browser restart without observer loops or duplicate styles. Colors stay active when cost display is paused. Reset removes the override; if a host default remains, say so. Invalid color/CSS input never reaches injected styles.

## 13. Errors, security, operational safety

Plain-language errors with next steps (extension/src/errors.js). Redact secrets. Helper capability checks: `accountPrices=true`, `priceAdapterVersion>=2`, `jobPipelineAttribution=true` before matching requests; block against an old helper with restart steps; don't force restarts just because versions differ.

Security: optional site permissions and activeTab only; no debugger, cookie/session scraping, remote code, broad permissions. Strict sender validation; options-only admin messages. PAT and bridge secrets in session storage. Helper bound to 127.0.0.1, validates Host header, authenticates bridge requests with the random key and allowed extension origins; never on the LAN. Loopback launcher endpoint rejects webpage origins and preflights, requires its dedicated launcher header, never returns credentials. Parameterize values; validate/quote three-part identifiers. Read-only SQL and inventory APIs only. No telemetry. Don't collect query text or result rows. Dedupe in-flight work; cache ~5 min isolated by origin/settings revision/period/resource/view/source. Pausing stops new UI-driven billing requests; colors stay active.

## 14. User documentation

Offline, responsive, accessible "How costs are calculated" guide linked from banner, popup, connection settings. Cover: period scopes; UTC periods; price fields and validity; signed corrections; free SKU; partial totals; job/pipeline attribution; worked concurrent-query allocation example; compute previews; freshness; cache; missing-state labels; Explorer differences/limits/flags; permissions; helper troubleshooting; workspace colors; monitor widget. Link official Databricks reference pages (verify each). Support Find and print. No credentials or real data. README: install, helper prerequisites, PAT alternative, pairing, workspace/warehouse selection, price table choice, update/reload, limitations, safe removal/reset; which updates need helper restart vs extension reload.

## 15. Verification and deliverables

Focused deterministic tests (see each stage). Sentinel values in SQL-text fixture cells so any accidental read fails. Browser testing in disposable profiles only. Live SQL only with explicit authorization. Sanitized ZIP from an explicit allowlist; exclude auth dirs, CLI config, real cost files, tokens, profiles, diagnostics, real screenshots.

## 17. Future ideas (NOT baseline)

Full anomaly analysis; automatic feature detection; alerts/emails/scheduled monitors/external notifications (EXCEPT the user-approved opt-in desktop notifications for failed runs in the monitor widget); helper-free OAuth PKCE; full VM pricing; shared all-purpose allocation; automatic optimization.
