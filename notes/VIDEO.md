# Lakeline for Databricks: launch video (storyboard and production contract)

Owner's brief:
- A 4K marketing video with motion graphics and good background music.
- It shows every feature, ease of access, and why it matters.
- It matches the exact UI and design, with no deviation.
- It tells one good use case with real-looking numbers.
- It covers dark and light mode.
- It shows switching between workspaces and between Genie Agents, and the visualizations.
- It explains security and privacy: nothing leaves the user's Databricks and browser, and access is session-controlled.
- It says that full Genie chat history lives in Genie in Databricks itself.

## Hard rules

1. **Real UI only.** Every product shot is a capture of the real extension, loaded in Chromium and driven against the synthetic fixture backend. No redrawn, mocked or edited UI. Motion graphics around the captures are fine:
   - frames, zooms, pans and crossfades;
   - highlight rings, captions and a cursor;
   - a minimal browser frame.

   Never paint over UI text or numbers.
2. **Numbers come from the captures.** Every number in a caption must be read from the captured UI state (`manifest.json`), never typed by hand.
3. **Synthetic data only.**
   - **Company:** "Northpeak Retail".
   - **Workspaces:** `northpeak-prod` and `northpeak-analytics`.
   - No real customer data, and no Databricks logos or brand marks.
   - Show the line "Independent project; not affiliated with Databricks, Inc." on the closing card.
4. **House style** (notes/STYLE.md):
   - Pure black or white, Inter + IBM Plex Mono, blue accent, amber for data.
   - Hairlines, the navy panel with blue wave lines, no em dashes in on-screen text.
   - No brand labels from the style's origin.
5. **Original music.** Composed and synthesized for this video, with no samples or melodies from existing works, so there is no licensing risk.
6. **Output:**
   - `dist/video/lakeline-launch-4k.mp4`: 3840×2160, 30 fps, H.264 High, yuv420p, CRF ≤ 16, AAC 48 kHz 320 kb/s.
   - `dist/video/lakeline-launch-1080p.mp4`: for LinkedIn and YouTube.
   - Target length 1:40 (±5 s).

## Story: "Where did last month's Databricks spend go?"

The platform team at Northpeak Retail sees spend climbing. Without leaving Databricks, Lakeline shows:
- the total and the trend;
- which job and which single run spiked (a backfill);
- that a job's real cost includes the pipelines it triggers;
- what a heavy BI query cost;
- what a warehouse size change would cost per hour.

Then they ask Genie, switching workspaces and agents. The run monitor catches a failure. Workspace colors keep prod and analytics apart. Everything stays inside their Databricks and their browser.

## Timeline (seconds; 30 fps; music sections must land on these marks)

| # | Time | Scene | Theme | Content (real captures unless marked MG = motion graphics only) |
|---|---|---|---|---|
| 1 | 0.0–6.0 | Hook | MG on black | Kinetic type: "Your Databricks bill shouldn't be a mystery." Then "Spend hides across jobs, warehouses, queries and Genie." Navy wave lines rise. |
| 2 | 6.0–12.0 | Reveal | MG | Icon mark builds (three bars, the tallest blue). "Lakeline for Databricks". Tagline: "Costs, runs and Genie answers, right where you work." Music drop lands at 6.0. |
| 3 | 12.0–20.0 | One-click connect | light | Popup on a prod workspace tab: "Connect this workspace", cursor click, then the Connected state ("Connected · workspace … · warehouse"). Caption: "Connect in one click. Read-only." |
| 4 | 20.0–30.0 | Cost banner | light | Prod workspace (red top bar) with the banner at 30 days: amount, change vs prior, freshness, basis. The period switches 7 → 30 → 90 (three captured states). Caption with the real amount and change. |
| 5 | 30.0–40.0 | Run costs | light | Job runs list for `nightly_sales_etl`: a badge on every run; zoom on the spike run (the backfill day). Then the detail page of `customer_360_refresh`, with a title total that includes the pipeline it triggers. Captions: "Every run, priced." "Job totals include the pipelines they trigger." |
| 6 | 40.0–48.0 | Queries and sizing | light | Query History rows with per-query estimates plus the explanatory note; the warehouse size picker with "≈ $X/h per cluster · DBU only". Caption: "Know the cost before you scale." |
| 7 | 48.0–58.0 | Cost Explorer | light | Explorer expanded: Products stacked bars → Top drivers → Calendar heatmap with the spike flag. Caption: "Explore what drives spend." |
| 8 | 58.0–62.0 | Theme flip | light→dark | The same Explorer view crossfades from light to dark (Databricks dark mode). Caption: "Light or dark, it fits in." Music breakdown. |
| 9 | 62.0–78.0 | Ask Genie | dark | Side panel docked next to the dark prod workspace. Switch the workspace selector prod → analytics, and the Genie Agent "Platform ops" ↔ "Revenue analytics". Ask "Which jobs drove last week's compute increase?" and show "Genie is working" → answer with Markdown and a bar chart. Switch to Table. Show SQL. Then a second agent answer with a line chart and KPI tiles. Caption: "Ask Genie, keep working." |
| 10 | 78.0–86.0 | Run monitor | dark | Floating monitor window: running and failed runs, warehouses, clusters. A failed `customer_360_refresh` run and its desktop notification (rendered by the composer in the house style from the real notification text). Caption: "A run fails, you know." |
| 11 | 86.0–90.0 | Workspace colors | light + dark | Prod (red top bar) and analytics (blue top bar), side by side or as a quick switch. Caption: "Never mix up prod and dev." |
| 12 | 90.0–97.0 | Security and privacy | MG navy panel | "Nothing leaves your Databricks and your browser." Points: read-only SQL on your own system tables; talks only to your workspace, with no Lakeline servers or analytics; sign-in and Genie chats live in your browser session and clear when it closes; your full chat history stays in Genie in Databricks; access granted one workspace at a time. |
| 13 | 97.0–100.0 | CTA | MG | Icon, "Lakeline for Databricks", "Add to Chrome", small line "Independent project; not affiliated with Databricks, Inc." Music resolves. |

## Asset contract

- **Captures:** `dist/video/captures/<scene>/<theme>/<state>.png` (dist/ is git-ignored).
  - Device scale factor 2.
  - Page viewport 1600×1000 (3200×2000 px).
  - Side panel 420×1000.
  - Popup 360 wide at natural height.
  - Monitor 380×600.
- **Manifests:** each scene folder has a `manifest.json` listing:
  - its states (file, theme, viewport, description);
  - bounding boxes of key elements in CSS px, for highlights and zooms;
  - the exact text of every number and label used in captions.
- **Music:** `dist/video/music/lakeline-theme.wav` (48 kHz stereo, 24-bit) and `dist/video/music/markers.json` (section start times; they match the timeline above).
- **Composer:**
  - The source is `video/composer/` (index.html + scenes + render.mjs), committed.
  - It renders on a virtual clock (performance.now and requestAnimationFrame replaced; every frame exact) at 1920×1080 CSS with deviceScaleFactor 2 → 3840×2160.
  - Frames are piped as high-quality JPEG to ffmpeg; no PNGs on disk.
