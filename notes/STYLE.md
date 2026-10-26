# House style for every extension surface

Lakeline's visual language for the popup, options, side panel, monitor, in-page surfaces, store
images and video. The product name is "Lakeline for Databricks" ("Lakeline" where space is short).

## Look

- **Surfaces:** pure white (light) or pure black (dark). No grey page backgrounds.
- **Type:** Inter for text and IBM Plex Mono for labels, eyebrows, IDs, numbers in tables and
  technical details.
  - The fonts are bundled in `extension/fonts/` (woff2 + OFL licenses).
  - Extension pages load them with `@font-face`.
  - Shadow-DOM surfaces injected into Databricks pages can't load extension fonts without
    `web_accessible_resources`, so they use the stack `Inter, -apple-system, "Segoe UI", Roboto,
    Arial, sans-serif` and `"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace`. Do
    not add `web_accessible_resources` for fonts.
- **Accent:** a single blue for what matters (links, the selected period, highlights, focus
  rings, key numbers).
- **Second accent:** warm amber, used only for data or a second thing, such as prior-period
  overlays, warnings, "priced subtotal" and partial coverage.
- **Cards:** hairline cards (1px line, radius 12–14px, no heavy shadows). Cards inside cards use
  `surface2`.
- **Buttons:** primary buttons are solid pills (white pill on dark, black pill on light).
  Secondary buttons are hairline pills. Small labels are pill chips.
- **Eyebrows:** uppercase IBM Plex Mono, letter-spacing about 0.12em, 11–12px, accent color, and
  numbered for sections, e.g. `01 · Connection`.
- **Headings:** short statements that fit one line.
- **Navy panel** (`panel`), optionally with subtle blue wave lines as an inline SVG drawn with
  token colors: for one hero or summary area per page at most. Candidates are the monitor header
  and the docs page header.
- **Copy:** no em dashes anywhere in UI copy or docs. Use a colon, comma, period, middle dot
  (`·`) or parentheses instead. For a missing value in a table cell, write "n/a" or a
  state-specific word (Unavailable, No data), never a dash glyph and never 0. Plain, direct
  wording with contractions.
- **Accessibility:**
  - WCAG AA contrast.
  - Visible focus: a 2px accent outline with an offset.
  - Status is never shown by color alone.
  - Respect `prefers-reduced-motion`.
  - No animation is required.

## Minimal

The connection screens (popup, options) and the Genie side panel follow this stricter layer. It
wins over the "Look" rules above where they differ; the monitor and the guide may keep their
navy panel and numbered eyebrows.

- **Fewer things on screen.** One primary action per view. Secondary items sit behind a
  disclosure ("More", collapsed `<details>` rows, an Edit link on a completed step).
- **Hairlines and whitespace, not cards.** Separate sections with a 1px `line` rule. No shadows.
  Radius 10px (`--dcc-radius`) for buttons, inputs, segmented controls, alerts and selected rows.
  Spacing scale 4 / 8 / 12 / 16 / 24.
- **Type.** Inter 13–14px for body. IBM Plex Mono only for code, IDs, URLs or tokens to copy, and
  numbers. Section names, when needed, use `.dcc-section-title` (tiny uppercase Inter, `muted`),
  not numbered mono eyebrows.
- **Color.** Pure white or pure black page. The accent blue marks the primary action
  (`--dcc-primary`, white text, `.dcc-btn--primary`), selection (`--dcc-selected` fill,
  `--dcc-on-selected` text, a 1px accent edge on segmented controls) and links. Amber only for
  warnings. Status is a small dot (`.dcc-dot`, `--dcc-dot-*`) next to text that says the state.
- **Alerts are quiet.** `.dcc-alert`: a soft tint, no border, a dot before a title that names
  what happened. Never a colored side stripe.
- **Disclosure rows.** `.dcc-disclosure` on a `<details>`: full-width summary row, chevron on
  the right, an optional muted one-line hint.
- **Checked, not guessed.** Text meets WCAG AA in both schemes, measured from computed colors.
  Focus is a visible 2px accent ring.

## Tokens (exact values)

| token | light | dark |
|---|---|---|
| bg | #FFFFFF | #000000 |
| surface | #F6F6F7 | #0F0F10 |
| surface2 | #EFEFF1 | #141416 |
| line | #E4E4E7 | #232326 |
| line2 | #D4D4D8 | #2A2A2E |
| text | #0A0A0A | #F5F5F4 |
| body | #52525B | #A1A1AA |
| muted | #6B6B74 | #8A8A93 |
| faint | #A1A1AA | #52525B |
| accent | #2F5BEA | #5B8CFF |
| accentSoft | #EEF2FF | #0B1A3A |
| accentLine | #B9C8FA | #2E4A85 |
| accentFill | #DCE5FF | #132447 |
| accentText | #1E3A8A | #C7D5FF |
| warm | #B45309 | #F5B83D |
| warmSoft | #FFF7E8 | #1A1406 |
| warmLine | #F2CF8E | #5A4515 |
| pillBg | #0A0A0A | #F5F5F4 |
| pillText | #FFFFFF | #0A0A0A |
| panel | #0B1A3A | #0B1A3A |
| panelText | #F5F5F4 | #F5F5F4 |
| panelSub | #C7D5FF | #C7D5FF |
| panelEyebrow | #8FB0FF | #8FB0FF |
| danger (added for failures; not in the base set) | #B42318 | #F97066 |
| success (added for success states) | #067647 | #47CD89 |

## Theme selection

- **Extension pages** (popup, options, monitor, docs): follow `prefers-color-scheme`.
- **Monitor widget:** the same, and it looks best dark.
- **In-page surfaces** (banner, Explorer, badges): match the Databricks page. Pick dark tokens
  when the computed background of the main container or body has relative luminance below 0.2,
  otherwise light. Re-check on route change.
