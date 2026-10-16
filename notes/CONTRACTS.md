# Shared contracts for parallel work

Read `notes/SPEC.md` (product spec) and `PLAN.md` (stages and decisions) first. Then read the
existing modules you build on. Match the surrounding code style and comment density.

## Ground rules

- **Edit only the files you own** (see the brief that assigned your work). If you need a change in a
  file you don't own, describe the change in your final report (file, exact snippet, reason). The
  integrator applies it.
- **Do not run `git commit`** or any git command that writes. The integrator commits.
- **Run only your own tests**, for example `node --test local/test-row-*.mjs`. Other agents are editing
  in parallel, so the full suite may be red for reasons that aren't yours. Before you finish, also run
  `node --test local/test-identity.mjs local/test-contracts.mjs local/test-pricing.mjs local/test-banner-smoke.mjs`.
  These are the baseline suites and must stay green.
- No new runtime dependencies. Dev-only test dependencies already installed: `jsdom` and
  `@duckdb/node-api`. Don't install anything else without saying so in your report.
- Never read SQL statement text or result rows of user queries. Never infer identity from names.
  Never use `innerHTML` with page data or any variable data (static extension-authored SVG constants
  are OK). Never log secrets.
- Report honestly. Say which tests you ran and their exact pass/fail counts. Label simulated tests
  (DuckDB, jsdom) as simulated.

## Module pattern (every shared file)

```js
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const V = dep('validate', '../core/validate.js');
  // ...
  const api = Object.freeze({ ... });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).<namespace> = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

These run as classic scripts:

- in the service worker, through `importScripts` in `src/background/service-worker.js`;
- in content scripts, through the `CONTENT_JS` list in `src/background/registration.js`;
- in extension pages, through `<script src>`;
- as CommonJS under `node --test`.

Query modules register under `DCC.queries.<kind>`. The only exception is `explore.js`, which
registers `DCC.queries.explore` and exposes `{ kinds: { exploreSummary, exploreEntities, exploreRuns } }`.

Existing namespaces:

- **core:** `DCC.validate`, `ids`, `periods`, `labels`, `demo`, `importData`, `errors`.
- **databricks:** `pricing`, `config`, `result`, `http`, `warehouses`, `queries.summary`, `queries.registry`.
- **background:** `sender`, `secrets`, `store`, `cache`, `helperClient`, `registration`, `dataService`, `router`.
- **content:** `dom`, `native`, `workspaceData`, `workspaceUi`.

## Query kinds (`src/databricks/queries/*.js`)

Each kind exposes **either**:

- `build(conn, args, nowMs)` → `{ statement, parameters, rowLimit, maxRows, ...meta }` together with
  `parse(rows, query)`, **or**
- `run({ conn, args, nowMs, exec })`, for kinds with more than one statement or a fallback. Here
  `exec(query)` executes one statement and resolves to parsed row objects. It throws a `DccError`
  whose `.dcc.code` is a classification from `errors.js`.

Rules:

- `conn` has `{ origin, workspaceId, priceTable, usageSource, historySource, currency, cloud }` and
  the warehouse is already chosen. All cost SQL **must** use `pricing.pricedUsageCte()` (the shared
  adapter), with `extraWhere` for internal predicates over alias `u`. Parameters go through
  `pricing.param(name, value, type)` with types STRING | DATE | TIMESTAMP | BIGINT. Never interpolate
  values. Re-validate every arg inside build/run (`ids.sanitizeRef`, `V.is*`).
- Results must carry `pricingBasis`, `priceTable`, `currency` (use `pricing.provenance`). Missing is
  `null`, never 0. Attach status and warnings **per item**.
- **Registry kinds:** `summary`, `rows`, `queryEstimates`, `computeRates`, `exploreSummary`,
  `exploreEntities`, `exploreRuns`. The local helper runs the same `registry.run(kind, ctx)` in Node
  with its own `exec`.
- **SQL portability, required by the simulated DuckDB test engine (`local/support/sqlengine.mjs`):**
  - Use standard SQL plus only these Databricks functions: `collect_set`, `array_contains`,
    `unix_millis`, `TRY_CAST`, `concat_ws`, `GREATEST`, `LEAST`, `COALESCE`.
  - Pass lists of IDs as individual params combined with `UNION ALL`, or as `IN (:p0, :p1, ...)`.
    Don't use `from_json`, `explode`, `named_struct`, `timestampadd` or `date_add`.
  - For composite membership keys, use `concat_ws('|', a, b)` strings.
  - Do timestamp arithmetic in JS: select `unix_millis(ts)` as epoch ms.
  - If you need a function the shim lacks, add a macro in **your own test file** through
    `engine.exec('CREATE MACRO ...')`, and mention it in your report.

## Messages (content → service worker)

All messages carry `{ origin, workspaceId }`, and the router validates them against the sender.

| type | args | response `data` |
|---|---|---|
| `dcc:hello` | `{origin, href}` | `{workspaceId, idSource, idConflict, settings:{mode, periodDays, showCosts, revision}, connection, connectionMismatch}` |
| `dcc:summary` | `{periodDays, force}` | summary (see `queries/summary.js` `parse`) or `{paused:true}` |
| `dcc:rows` | `{periodDays, refs:[ref]}` with refs ≤ 40, sanitized again by the router (adds `key = ids.refKey(ref)`) | `{pricingBasis, priceTable, currency, items:{[key]: Item}}` or `{paused:true}` |
| `dcc:query` | `{kind, args, scope}` with kind ∈ queryEstimates, computeRates, explore* | kind result, or `{unavailableInMode: mode}`, or `{paused:true}` |
| `dcc:setPeriod` `dcc:resume` `dcc:open {page:'options'\|'guide'\|'monitor', anchor}` | | |

`Item` = `{ key, status: 'ok' | 'unavailable' | 'pending' | ..., amount: number | null, scope: 'period' | 'execution', attribution: 'direct' | 'direct+pipelines' | 'direct-only' | 'demo' | 'import', label?, reason?, warnings: [{code, text}] }`.

The response envelope is `{ok:true, data}` or `{ok:false, error:{code, title, steps, details}}`.
`workspace-data.js` returns `{stale:true}` for superseded responses. Ignore those.

Background add-ons register handlers without editing `router.js`:
`(DCC.handlerFactories || (DCC.handlerFactories = [])).push((deps) => ({ 'monitor:open': { trust: 'page', handle: async (msg, sender) => ... } }))`.

- Trust classes are `content`, `page` (popup/options/monitor), `admin` (options only) and `external`.
- `deps` = `{ store, secrets, data, helper, openPage, chromeApi }`.
- One-time setup uses `(DCC.backgroundInits || (DCC.backgroundInits = [])).push((deps) => {...})`.
- The page-sender allowlist is in `sender.js` `PAGE_PATHS`: `/ui/popup.html`, `/ui/options.html`, `/ui/monitor.html`.

## Content feature modules

Register in `DCC.features` (an array) **before** `content-main.js` loads, via
`(root.DCC.features || (root.DCC.features = [])).push({ name, onStart(ctx), onTick(ctx), onRoute(ctx), onPeriod(ctx), onSummary(ctx), onSettings(ctx), onAppearance(ctx) })`.

`ctx` = `{ doc, origin, workspaceId, settings:{mode, periodDays, showCosts}, connection, summary, data, sendMessage, requestTick }`.

- `data` is the `workspace-data` client: `data.rows(channel, periodDays, refs)`,
  `data.query(channel, kind, args, scope)`, `data.invalidate(channel)`.
- `onTick` runs on a bounded scheduler (≤ 1.2 s even under continuous mutation). It must be
  idempotent and cheap, and must make no DOM writes when nothing changed.
- When `settings.showCosts === false`, remove cost badges. Colors stay.
- Mark every element you insert with a `data-dcc="<feature>"` attribute so mutation filtering and
  cleanup work.
- The Explorer mounts through `DCC.explorer.mount(panelEl, ctx, bannerState)`.

## Test harnesses (`local/support/`)

- **`load.mjs`:** `load('core/ids.js')` requires an extension module. `fakeArea()` gives an
  in-memory storage area.
- **`sqlengine.mjs`:** `createEngine()` returns a DuckDB engine with system-table-shaped tables:
  `billing.usage`, `billing.list_prices`, `billing.account_prices`,
  `lakeflow.pipeline_update_timeline`, `lakeflow.job_task_run_timeline`,
  `lakeflow.job_run_timeline`, `query.history`. It also gives `engine.execute({statement,
  parameters, row_limit})` → a Statement API response, plus the fixture builders `usageRow`,
  `listPrice`, `accountPrice` and the constant `SENTINEL_SQL_TEXT`. Add columns by running `ALTER
  TABLE` in your test if needed.
- **`content-harness.mjs`:** `createContentEnv({url, html, files, onMessage, storage})` returns a
  jsdom window with a fake `chrome`. `BASE_CONTENT_FILES` lists the base files. `settle(ms)` waits.

## Fixture pages

Every feature agent writes static HTML fragments that imitate the native DOM its selectors expect:
`local/fixture/<name>.html`, body fragments only, synthetic data only. The content-core agent
assembles them into the routed fixture SPA `local/workspace.html` + `local/workspace.js`, served at
`http://127.0.0.1:8765`.
