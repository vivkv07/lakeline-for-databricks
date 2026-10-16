# Launch-video captures (real UI, synthetic data)

Everything here produces the product footage for the Lakeline launch video
(`notes/VIDEO.md`). Every product pixel is the real extension, running in Chromium against
a synthetic backend. Every caption number is read from the DOM at capture time and saved in
the manifests.

```sh
node local/video/capture.mjs                 # all scenes, about 6 minutes
node local/video/capture.mjs --only 09,10    # some scenes (merges into the existing index.json)
node local/video/video-server.mjs            # the server alone, to look around
```

Suggested script for `package.json`, which the integrator adds:

```json
"video:capture": "node local/video/capture.mjs"
```

Requirements:
- Playwright's cached Chrome for Testing (`channel: 'chromium'`, headless with extensions). The
  scripts never download a browser.
- The `openssl` CLI.
- No network access.

## Output

Captures are written to `dist/video/captures/` (git-ignored):

| Path | Contents |
|---|---|
| `<scene>/<theme>/<state>.png` | Device scale factor 2. Page states are 16:9, 1600×900 CSS px (3200×1800). In the side-panel scene, `*-docked` page states are 1180×900 and the side panel is 420×900, so together they are 1600×900, as Chrome lays them out; the full-width page states there are extras. Popup 360 wide at its natural height. Monitor 380×600, plus one full-height monitor state. |
| `<scene>/<theme>/manifest.json` | Per state: `file`, `viewport`, `dpr`, `kind`, `description`, plus `focus`, the primary focus box for the composer's push-in, and `focusPath`, the ordered boxes to pan between. `boxes` holds key elements in CSS px relative to the viewport. `texts` holds the exact visible text read from the DOM (innerText, so CSS uppercase is applied; `*Source` fields hold textContent). `extra` holds scene data such as panel/page pairing, clipboard texts, notification text and side-panel verification. |
| `index.json` | Scenes and states, story numbers, environment, and automated checks (all must be `ok`). |

Scenes:

| Scene | Contents |
|---|---|
| `03-connect` | Real one-click connect in the popup. |
| `04-banner` | 7, 30 and 90 days. |
| `05-run-costs` | Run badges and the backfill spike; `customer_360_refresh` total including its pipeline. |
| `06-queries-sizing` | Query History estimates with the note and the tooltip; the warehouse size picker. |
| `07-explorer` | Products, Top drivers and Calendar, with hovers, in light and dark. |
| `08-theme-flip` | The same Explorer views in both themes. |
| `09-genie` | The real side panel, the video tab, the doc tab, the agent and workspace switches, dark. |
| `10-monitor` | The monitor and the real failure notification. |
| `11-colors` | dev, stage and prod before colors; the popup's Workspace colors panel; after colors. |

## What is real, what is synthetic

### Real

**The extension.** It is a test copy of the Chrome Web Store build: `scripts/package.mjs`
`storeEntries()` with no manifest key and the store flags. It is loaded unpacked into a
disposable profile, and `extension/` is never modified. The copy has three capture-only
additions, all documented in `browser.mjs`:
1. `manifest.host_permissions` for the four Northpeak hosts, because the optional
   host-permission prompt can't be clicked headless. The e2e suites do the same.
2. `manifest.permissions += "notifications"`, an optional permission granted at install for the
   same reason.
3. `ui/capture-shim.js`, loaded first by `ui/popup.html` and `ui/sidepanel.html`. When the page
   URL has `?captureTab=<workspace origin>`, `chrome.tabs.query({active: true, ...})` returns
   that real open workspace tab. The popup is opened as a normal tab for screenshots, so without
   the shim it would see itself as the active tab. The real side panel is opened without the
   parameter, so the shim does nothing there.

**The UI code.** No UI code is changed.

**Interactions.** Settings, PAT and connection go through the real router messages. The popup
connect, period buttons, Explorer tabs and Load, and the Workspace colors panel all use real
clicks. The Genie side panel is the browser's real side panel: the popup's real "Ask Genie" click
calls `chrome.sidePanel.open`. It is driven over CDP with trusted mouse and keyboard input and
captured with an emulated 420×900 viewport at DPR 2. The doc paste is a real Cmd/Ctrl+V of what
the panel's real Copy answer and Copy table wrote. Headless Chromium's clipboard is isolated from
the OS clipboard (checked).

**The failure notification.** It is created by the extension's monitor through
`chrome.notifications.create`. The capture wraps that function with a pass-through wrapper only
to record the title and message; Chrome still creates the notification.

### Synthetic

**`story-data.mjs`.** This is "Northpeak Retail", with the workspaces `northpeak-prod`,
`northpeak-analytics`, `northpeak-dev` and `northpeak-stage` (AWS, list prices), covering 185
days. That is enough for the 90-day banner to have a full prior period. The beats are true in
the data:
- 30-day spend is about +12 % on the prior 30 days.
- `nightly_sales_etl` has one manually launched backfill on a weekday 4–8 days ago. It is
  flagged as a spike in the calendar.
- `customer_360_refresh` triggers `cust360_dlt` (JOB_TASK linkage).
- BI Serverless runs a heavy 12m 48s dashboard query alone in its billing hour.
- There is a GENIE billing line.

Genie answers are computed by running the SQL shown under "Show SQL" on the same DuckDB
engine. That engine has the system tables plus a synthetic `northpeak.sales` and
`northpeak.marketing` catalog. Monitor data is relative to now. Mid-scene, the capture turns
today's `customer_360_refresh` run into a failure (`server.live.prod.c360FailedAt`), so the
monitor's next poll notifies.

**`video-server.mjs`.** It serves HTTPS on 127.0.0.1 with one port for all hosts, dispatched by
the Host header. Each workspace is one `createFixtureApp` from `local/fixture-server.mjs`, with
the same mock REST, DuckDB SQL (a SIMULATION), Genie and monitor as the e2e fixture, plus that
workspace's dataset and fake token (`dapi-video-…-not-a-real-token`).
- `/oidc/v1/authorize` and `/oidc/v1/token` form a mock OIDC provider that checks PKCE and
  redirects straight back. This lets the popup's real one-click "Sign in with Databricks" run
  (scene 03). The OAuth client ID is a one-time account setup, done first on `northpeak-dev`.
  After scene 03, `northpeak-prod` is switched to its fake PAT, so Genie and the monitor need no
  second consent.
- `videos.example` and `docs.example` serve `pages/video.html` and `pages/doc.html`: neutral
  "other work" pages with no brand UI. The extension doesn't run there.
- TLS uses a throwaway self-signed certificate for exactly these hosts. It is made with
  `openssl` in a fresh temp dir and deleted on close; no key is ever written to the repository.

**The capture browser.** It runs with
`--host-resolver-rules="MAP <host> 127.0.0.1:<port>, …"`, `--ignore-certificate-errors` and a
disposable profile. The capture checks that both page loads and service-worker fetches reach the
local server.

**The workspace pages.** `shell.html`, `fragments/` and `static/` are a neutral imitation of a
data-platform workspace, with no vendor logos or assets. They are routed by `local/workspace.js`.
Dark mode is a page preference (`localStorage["np-video-theme"]`, or `?np_theme=dark` once). The
in-page extension surfaces pick dark tokens from the measured background, as they do on a real
dark workspace.

## Files

| File | Purpose |
|---|---|
| `story-data.mjs` | Dataset, template values, monitor snapshot, Genie agents and computed answers. |
| `video-server.mjs` | The HTTPS multi-host server and the mock OIDC provider. |
| `browser.mjs` | Test-copy build, capture shim, browser launch and small helpers. |
| `capture.mjs` | Scenes, states, manifests, index and checks. |
| `shell.html`, `static/`, `fragments/{prod,small,common}/` | Synthetic workspace pages. |
| `pages/video.html`, `pages/doc.html` | Synthetic "other work" pages. |

Changes outside `local/video/` are small and backward compatible:
- `local/fixture-server.mjs` exposes `createFixtureApp` (the app without the listener). The
  defaults behave as before.
- `local/workspace.js` reads an optional `<meta name="fixture-workspace-id">`.
