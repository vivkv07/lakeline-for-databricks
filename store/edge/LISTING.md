# Microsoft Edge Add-ons listing: Lakeline for Databricks

Partner Center (Microsoft Edge program) fields, in the order the submission pages ask for them.
Edge uses the same package as the Chrome Web Store: `dist/lakeline-for-databricks-store-<version>.zip`
from `node scripts/package.mjs --store`, with no `key`, no development flags and no local test host.
Everything to upload is gathered in `dist/edge-upload/`.

---

## 1. Create the developer account (free, one time)

1. Open https://partner.microsoft.com/dashboard/microsoftedge/public/login?ref=dd and sign in with
   a Microsoft account. A personal Outlook or Hotmail account works, or sign up for a new one with
   your existing Gmail address.
2. Choose **Account type: Individual**. A Company account needs business verification, which takes
   longer.
3. Fill in the publisher details.
   - **Publisher display name:** Vivek Kovvuru. This shows under the extension's name.
   - Your name, contact email and address.
4. Accept the Microsoft Edge program agreement, then select **Finish**.
5. Verify the contact email from the message Microsoft sends.

There is no registration fee. Partner Center then opens on **Microsoft Edge, Extensions**.

---

## 2. Packages

**Create new extension**, then drag in `dist/edge-upload/lakeline-for-databricks-0.1.1.zip` (a copy of the store ZIP). Partner Center
reads the name, version, summary and permissions from `manifest.json`.

## 3. Availability

- **Visibility:** Hidden for the first release. Only people with the link can find and install it.
  Switch to **Public** after a few people have tried it.
- **Markets:** all markets.

## 4. Properties

- **Category:** Developer tools.
- **Does your extension access, collect, or transmit personal information?** Yes. It handles sign-in
  tokens and Databricks page content for the user's own workspace, so a privacy policy is required.
- **Privacy policy URL:** https://vivkv07.github.io/lakeline-for-databricks/privacy.html
- **Website URL:** https://vivkv07.github.io/lakeline-for-databricks/
- **Support contact details:** https://github.com/vivkv07/lakeline-for-databricks/issues
- **Mature content:** No.

## 5. Store listings (English)

**Description** (Partner Center requires at least 250 characters; this text is the same as the
Chrome Web Store description in `store/LISTING.md`):

Copy the block under **Description** in `store/LISTING.md`.

**Short description** (if asked):
Databricks cost estimates, run monitoring and a Genie side panel. Independent project; not affiliated with Databricks, Inc.

**Search terms** (at most 7 terms, 30 characters each, 21 words in total):
1. Databricks
2. Databricks costs
3. FinOps
4. Genie
5. SQL warehouse
6. Cloud cost
7. Data engineering

**Images** (all in `dist/edge-upload/`; Edge accepts up to 10 screenshots at 1280×800):

| Field | File |
|---|---|
| Extension Store logo (300×300, required) | `store-logo-300.png` |
| Small promotional tile (440×280) | `promo-small-440x280.png` |
| Large promotional tile (1400×560) | `promo-marquee-1400x560.png` |
| Screenshot 1 | `screenshot-01.png`: Cost banner (light) |
| Screenshot 2 | `screenshot-02.png`: Ask Genie in the side panel (dark) |
| Screenshot 3 | `screenshot-03.png`: Every job run priced (light) |
| Screenshot 4 | `screenshot-04.png`: Run monitor (dark) |
| Screenshot 5 | `screenshot-05.png`: Workspace colors (light) |
| Screenshot 6 | `screenshot-06.png`: Cost Explorer, top drivers (light) |
| Screenshot 7 | `screenshot-07.png`: Copy a Genie answer into a doc (dark) |
| Screenshot 8 | `screenshot-08.png`: Warehouse size picker (light) |
| Screenshot 9 | `screenshot-09.png`: Calendar spike (dark) |
| Screenshot 10 | `screenshot-10.png`: Security and privacy (dark) |

**YouTube video URL** (optional): the launch video, if you upload `dist/video/lakeline-launch-1080p.mp4`.

The screenshots show a neutral browser frame, not Chrome's, so they suit Edge as they are.

## 6. Submission options

**Notes for certification:**

No test account is needed. Click the toolbar icon and set Data source to Demo: it uses synthetic
data and makes no network requests. Click Ask Genie to open the side panel; demo Genie Agents return
synthetic answers with tables and charts.

For the in-page banner and badges, open any Databricks workspace (a free trial works) with access
to the system.billing tables, click the toolbar icon, then Connect this workspace. A tab opens on
that workspace's own sign-in page and closes itself once you are signed in. Databricks' built-in
sign-in client (databricks-cli) only redirects to http://localhost:8020, so the extension asks for
that origin and reads the one-time code from its own sign-in tab; nothing runs on that port. Or open
Other ways to sign in and paste a personal access token (Settings, Developer, Access tokens).

The extension runs only read-only SQL and read-only API calls. Asking Genie a question starts a
Genie conversation in the user's own workspace, and only because the user asked it to.

Then select **Publish**. Microsoft reviews within about 7 business days and emails the result.

---

## After the first submission

- Partner Center shows the Edge **extension ID** (Extensions overview, the item, Extension
  identity). It differs from the Chrome Web Store ID. Two features care about it:
  - **The optional local helper** trusts exactly one extension ID today (`extension/EXTENSION_ID`,
    read by `local/server.mjs`, and the constant in `local/setup.js`). Edge Add-ons installs need
    a small change so the helper accepts both IDs. Until then, Edge users connect with Sign in
    with Databricks or a token, which is what the store build offers anyway.
  - **An organization's own app connection** needs `https://<edge-id>.chromiumapp.org/` added as a
    second redirect URL.
- The default sign-in (built-in client) and personal access tokens need nothing for Edge.
- Updates: upload a new ZIP on the **Packages** page, then **Publish** again.
