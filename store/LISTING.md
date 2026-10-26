# Chrome Web Store listing: Lakeline for Databricks

Copy each block into the matching field of the Chrome Web Store developer dashboard. The files to
upload are gathered in `dist/store-upload/` (the ZIP, the store icon, screenshots 1 to 5 in upload
order, and both promo tiles).

Build the upload ZIP with `node scripts/package.mjs --store`. It writes
`dist/lakeline-for-databricks-store-<version>.zip`, with `manifest.json` at the root, no
development `key`, no developer-only links and no local test-workspace permission.

---

## Store listing tab

**Name** (from the manifest)
Lakeline for Databricks

**Summary** (manifest description, 123 of 132 characters)
Databricks cost estimates, run monitoring and a Genie side panel. Independent project; not affiliated with Databricks, Inc.

**Category:** Developer Tools
**Language:** English

**Description**

Lakeline puts Databricks cost context, run status and Genie answers right where you work.

Cost estimates inside your workspace
- A slim banner shows estimated spend for the last 7, 30 or 90 complete UTC days, the change from the previous period, and how fresh the billing data is.
- Badges next to jobs, pipelines, SQL warehouses, notebooks and apps. Each job run and pipeline update shows the cost of that single execution.
- Job totals include the pipeline updates the job triggered, with no record counted twice.
- Query History shows a per-query estimate, with the assumptions explained.
- SQL warehouse and cluster size pickers show the hourly DBU cost before you choose.
- A Cost Explorer with product, top driver, run, calendar, SKU and daily views, plus CSV export.

Run monitor
- A compact window (it can float on top) with running and failed job runs, pipelines, SQL warehouses and clusters.
- Optional desktop notifications when a run fails.

Ask Genie from the side panel
- Pick a Genie Agent, ask a question and keep working. The answer, the result table, a chart and the generated SQL appear when Genie is done.

How the numbers are calculated
- Read-only SQL against your own Databricks system tables, priced with system.billing.list_prices (or system.billing.account_prices if you choose it).
- Every amount is labeled as an estimate. Billing can be delayed, and final invoices may differ. Cloud provider charges are not included.
- A built-in guide explains every formula and limitation.

Privacy
- No analytics, no tracking, no developer servers. The extension talks only to the Databricks workspaces you connect.
- Sign-in tokens and Genie conversations stay in your browser.

Sign in
- Sign in with Databricks in one click. No admin setup: it uses Databricks' built-in sign-in app, the one the Databricks CLI uses.
- Or paste a personal access token, or use your organization's own app connection.

Lakeline is an independent project and is not affiliated with, endorsed by or sponsored by Databricks, Inc. Databricks and Genie are trademarks of Databricks, Inc.

**Graphic assets** (all in `store/assets/`, 24-bit PNG without alpha, as the store requires)

The store takes up to five screenshots. Upload these five, in this order:
1. `screenshot-light-1.png`: Cost banner, "Your Databricks spend, right where you work."
2. `screenshot-dark-1.png`: Ask Genie in the side panel, with an answer and a bar chart.
3. `screenshot-light-2.png`: Every job run priced; the Oct 9 backfill spike stands out.
4. `screenshot-dark-4.png`: Run monitor floating over the workspace, with a failed run.
5. `screenshot-light-5.png`: Workspace colors for dev, stage and prod.

Alternates, if you would rather show these features:
- `screenshot-light-3.png`: Warehouse size picker.
- `screenshot-light-4.png`: Cost Explorer, top drivers.
- `screenshot-dark-2.png`: Copy a Genie answer into a doc.
- `screenshot-dark-3.png`: Calendar spike.
- `screenshot-dark-5.png`: Security and privacy.

Other assets:
- **Small promo tile:** `promo-small-440x280.png`.
- **Marquee promo tile** (optional, used if the store features the extension): `promo-marquee-1400x560.png`.
- **Icon:** `extension/icons/icon-128.png`.
- **Promo video** (optional): upload `dist/video/lakeline-launch-1080p.mp4` to YouTube and paste its URL.

Every screenshot is a real capture of the extension, driven against the synthetic "Northpeak Retail" fixture workspace, so no real customer data appears. To rebuild the images, run `npm run store:assets` (it reads the captures from `npm run video:capture`).

**Official URL / Homepage:** https://vivkv07.github.io/lakeline-for-databricks/
**Support URL:** https://github.com/vivkv07/lakeline-for-databricks/issues

---

## Privacy practices tab

**Single purpose**
Show estimated Databricks costs, job run status and Genie answers for the user's own Databricks workspaces, inside and beside the Databricks web app.

**Permission justifications**

| Permission | Justification |
|---|---|
| storage | Saves settings, the connection for each workspace (warehouse, price table) and workspace colors in local storage. Sign-in tokens and Genie conversations are kept in session storage, which is cleared when the browser closes. |
| activeTab | When the user clicks the toolbar icon, reads the current tab's URL to offer "Connect this workspace" if it is a Databricks workspace. |
| scripting | Registers the in-page cost banner and badges only for Databricks workspaces the user has granted access to, and loads them into tabs that were already open when access was granted. |
| alarms | Refreshes the opt-in run monitor on a schedule (60 to 300 seconds) and resumes Genie questions that were in flight when the background worker restarted. |
| identity | "Sign in with Databricks" through an organization's own app connection: OAuth authorization code with PKCE through chrome.identity.launchWebAuthFlow against the user's own workspace. |
| Host permission (optional): http://localhost:8020/* | Requested only when the user clicks "Sign in with Databricks" without an app connection. Databricks' built-in public sign-in client (databricks-cli) only redirects to http://localhost:8020. The extension opens the workspace's own sign-in page in a tab, reads the one-time code from that tab's address when it reaches localhost:8020, and closes the tab. Nothing is served from or sent to localhost, and no content script runs there. |
| sidePanel | The "Ask Genie" side panel, where the user picks a Genie Agent in their own workspace, asks a question and reads the answer while they keep working in other tabs. |
| notifications (optional) | Requested only when the user turns on notifications for failed job runs or for Genie answers that are ready. Notifications never contain query data. |
| Host permissions (optional): https://*.cloud.databricks.com/*, https://*.azuredatabricks.net/*, https://*.gcp.databricks.com/* | Requested at runtime for the one workspace the user chooses to connect, never for all sites. Used to show costs inside that workspace and to call that workspace's Databricks APIs (SQL Statement Execution, SQL warehouses, Jobs, Pipelines, Clusters and Genie). Account console hosts are excluded. |
| externally_connectable: http://127.0.0.1:8766/* | Lets the optional local helper program, running on the user's own computer, pair with the extension from its setup page. Nothing on the internet can use this. |

**Remote code:** No. All JavaScript is included in the package. No eval, and no code loaded from the network.

**Data usage** (answer the checkboxes conservatively and add this note)
- *Authentication information:* yes, handled. Databricks OAuth tokens or a personal access token are used only to call the user's own Databricks workspace. They are kept in session storage. A token is kept on disk only if the user ticks "Remember on this computer", and then only in the extension's own IndexedDB, which content scripts and websites cannot open. They are never sent to the developer or any third party.
- *Website content:* yes, handled. The extension reads Databricks page URLs and page structure to place cost badges, and it shows Databricks query results and Genie answers. This data stays in the browser and goes only to the user's own workspace.
- Everything else: no. That covers personally identifiable information, health, financial and payment, personal communications, location, web history and user activity.
- Certify all three: data is not sold to third parties; it is not used or transferred for purposes unrelated to the single purpose; it is not used to determine creditworthiness or for lending.

**Privacy policy URL:** https://vivkv07.github.io/lakeline-for-databricks/privacy.html (the source is `docs/privacy.html`)

---

## Notes for reviewers (Test instructions tab)

The dashboard's "Additional instructions" box takes at most 500 characters. This is the text that was submitted:

> No test account needed. Click the toolbar icon and set Data source to Demo: synthetic data, no network requests. Click Ask Genie for the side panel; demo Genie Agents return synthetic answers. For the in-page banner, open a Databricks workspace with system.billing access, click the icon, then Connect this workspace: a tab opens on that workspace's sign-in page and closes itself (redirect read on localhost:8020). Or paste a personal access token under Other ways to sign in. Read-only calls only.

The longer version, for a support reply or the README:

Lakeline needs a Databricks workspace for its in-page features. The fastest way to review it:
1. Install it, click the toolbar icon, and choose **Demo** as the data source. Demo mode uses synthetic data and makes no network requests.
2. Click **Ask Genie** to open the side panel. Demo Genie Agents return synthetic answers with tables and charts.
3. For the in-page banner and badges, use any Databricks workspace (a free trial works), with access to the system.billing tables. Open it, click the toolbar icon, choose **Connect this workspace** and allow access for that one site. Then either click Sign in with Databricks (a tab opens on the workspace's own sign-in page and closes itself), or open Other ways to sign in and paste a personal access token (Settings, Developer, Access tokens).

The extension runs only read-only SQL and read-only API calls. Asking Genie a question starts a Genie conversation in the user's own workspace, and only because the user explicitly asked it to.

---

## Submission record

- Item ID: `gcadffgngihfjameoafjagofiompdngo`. Publisher: Vivek Kovvuru (non-trader). Visibility: Unlisted.
- 0.1.0 was submitted on 16 October 2026, then withdrawn the same day. 0.1.1 (sign-in with no setup, token box in the popup) was submitted in its place, with "publish automatically after review" ticked.
- Done after the first upload:
  1. The item's public key is in `extension/manifest.json` as `"key"`, so unpacked builds share the store ID. The store ZIP still strips it.
  2. `extension/EXTENSION_ID` and the constant in `local/setup.js` hold the store ID.
- Still to do after approval: install from the Unlisted link, test with a few people, then switch Visibility to **Public**.
- Only organizations that use their own app connection need to add `https://gcadffgngihfjameoafjagofiompdngo.chromiumapp.org/` as its redirect URL. The default sign-in needs no setup.
