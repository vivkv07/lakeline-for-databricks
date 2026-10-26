# Lakeline for Databricks: launch video (storyboard and production contract)

Brief:
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
   - **Workspaces:** `northpeak-prod` and `northpeak-analytics`, plus lightweight `northpeak-dev` and `northpeak-stage` for the colors scene.
   - No real customer data, and no Databricks logos or brand marks.
   - Show the line "Independent project; not affiliated with Databricks, Inc." on the closing card.
4. **House style** (notes/STYLE.md):
   - Pure black or white, Inter + IBM Plex Mono, blue accent, amber for data.
   - Hairlines, the navy panel with blue wave lines, no em dashes in on-screen text.
5. **Original music.** Composed and synthesized for this video, with no samples or melodies from existing works, so there is no licensing risk.
6. **Output:**
   - `dist/video/lakeline-launch-4k.mp4`: 3840×2160, 30 fps, H.264 High, yuv420p, CRF ≤ 16, AAC 48 kHz 320 kb/s.
   - `dist/video/lakeline-launch-1080p.mp4`: for LinkedIn and YouTube.
   - Target length 1:56 (±5 s).

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
| 9 | 62.0–86.0 | Ask Genie: work while you wait | dark | Why a side panel matters: you keep working while Genie answers.<br>(a) 62–67: prod workspace, dark, with the side panel docked. Ask "Which jobs drove last week's compute increase?" and the panel shows Genie is working.<br>(b) 67–71: the user switches to a DIFFERENT tab, a neutral, synthetic video player page (a recorded tech talk; no YouTube or other brand UI or logos). The side panel stays open beside it, because Chrome keeps it across tabs. Caption: "Ask Genie, then watch a video or get other work done."<br>(c) 71–75: still on the video tab, the answer lands in the side panel (Markdown + bar chart) with a subtle attention cue. Caption: "Your answer is waiting in the side panel."<br>(d) 75–79: the user opens another tab with a doc they're writing (a neutral, synthetic doc editor, "Weekly cost review"; no Google Docs or other brand UI). In the side panel they use the real ⋯ menu, Copy answer then Copy table, and paste into the doc. The pasted content is exactly what the real copy actions produced. Caption: "Copy answers straight into your doc."<br>(e) 79–82: switch Genie Agent "Platform ops" → "Revenue analytics"; ask; KPI tiles or bars.<br>(f) 82–86: switch workspace prod → analytics. The agent list changes; ask; line chart. Caption: "Switch workspaces and Genie Agents without leaving your work." |
| 10 | 86.0–94.0 | Run monitor | dark | Floating monitor window: running and failed runs, warehouses, clusters. A failed `customer_360_refresh` run and its desktop notification (rendered by the composer in the house style from the real notification text). Caption: "A run fails, you know." |
| 11 | 94.0–104.0 | Workspace colors | light | The problem, then the fix.<br>(a) 94–97: three tabs (dev, stage, prod) with identical default top bars. Caption: "Dev, stage, prod. They all look the same."<br>(b) 97–100: Workspace colors in the popup: pick any color per workspace (e.g. dev green, stage amber, prod red) with the picker and presets.<br>(c) 100–104: switching between the three tabs, each top bar in its own color. Caption: "Pick any color. Know where you are at a glance." |
| 12 | 104.0–112.0 | Security and privacy | MG navy panel | "Nothing leaves your Databricks workspace and your browser." Points: read-only SQL on your own system tables; talks only to your workspace, with no Lakeline servers or analytics; sign-in stays in this browser and Genie chats clear when it closes; your full chat history stays in Genie in Databricks; access granted one workspace at a time. |
| 13 | 112.0–116.0 | CTA | MG | Icon, "Lakeline for Databricks", "Add to Chrome", small line "Independent project; not affiliated with Databricks, Inc." Music resolves; tail to about 118 s. |

## Framing rules (review feedback: the browser looked small and far away)

- The browser window fills the stage: at least 92% of the width (about 1770 of 1920 CSS px), with margins of 24 to 48 px. No large empty side areas in product scenes.
- Camera on every product shot:
  - Open on the full window for about 0.8 s.
  - Then an eased push-in (1.3× to 2.2×) to the scene's focus box from the manifest bounding boxes.
  - Pan between focus points within the scene.
  - Pull back before the transition.
  - The cursor, highlight rings and click ripples move with the camera.
- Captions sit in the lower third, as a compact pill with a subtle scrim. They never push the window smaller and never cover the current focus box (place them on the opposite side).
- UI text must stay legible at 1080p: at the full-window shot, body text renders at 15 CSS px or more on the 1920×1080 stage.

## Asset contract

- **Captures:** `dist/video/captures/<scene>/<theme>/<state>.png` (dist/ is git-ignored).
  - Device scale factor 2.
  - Page viewport 1600×900, 16:9 (3200×1800 px).
  - In side-panel scenes, page 1180×900 plus side panel 420×900 (together 1600×900, as in Chrome).
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

## Pacing v2 (review feedback: zoom moves felt off and the cut was too fast to follow)

This section supersedes the times in the timeline table above. Scene content is unchanged. Target length 2:34 (154 s plus a tail to about 156 s). All marks fall on 2 s bar lines at 120 BPM.

| # | Scene | Time (s) | Beats |
|---|---|---|---|
| 1 | Hook | 0–6 | |
| 2 | Reveal | 6–12 | Drop at 6 |
| 3 | One-click connect | 12–22 | |
| 4 | Cost banner | 22–34 | 7d / 30d / 90d, about 3.5 s each |
| 5 | Run costs | 34–48 | Runs list with spike 34–41; job total with pipelines 41–48 |
| 6 | Queries and sizing | 48–60 | Query estimate 48–54; size picker 54–60 |
| 7 | Cost Explorer | 60–74 | Products 60–65; Top drivers 65–69; Calendar spike 69–74 |
| 8 | Theme flip | 74–80 | |
| 9 | Ask Genie | 80–116 | Ask 80–86; video tab 86–92; answer waiting 92–99; paste into doc 99–106; switch agent 106–111; switch workspace 111–116 |
| 10 | Run monitor | 116–126 | |
| 11 | Workspace colors | 126–140 | Same-looking tabs 126–130; pick colors 130–135; switch tabs 135–140 |
| 12 | Security and privacy | 140–150 | |
| 13 | CTA | 150–154 | Tail to about 156, fading out |

Camera and comprehension rules:
- Open each product scene on the full window for at least 1.5 s.
- At most one camera move per beat. Each move takes 1.2–1.8 s, eased in and out (cubic), with no overshoot.
- Hold at least 2.5 s after every move before the next.
- Maximum zoom 1.8×.
- Never zoom out and back in within 3 s, and never pan and zoom at the same time to an unrelated area.
- Pull back over at least 1.2 s before a cut, or cut on the full window.
- No camera motion while a caption is entering.
- Captions stay on screen at least 3 s.
- Multi-step scenes (4, 5, 7, 9, 11) show a small step label in the caption pill, e.g. "1 Ask · 2 Keep working · 3 Answer ready · 4 Paste into doc", with the current step highlighted.
- The cursor moves over at least 0.6 s with deceleration. Each click shows its ripple, then a 0.5 s pause before the UI state changes.
- Crossfades between states of the same page take 0.4–0.6 s; tab switches take 0.3 s.
