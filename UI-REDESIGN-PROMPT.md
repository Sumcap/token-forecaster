# Dashboard UI redesign — handoff prompt

Paste everything below the line into a fresh session after `/clear`.

Two notes before you do:

- The current colors come from a **validated accessibility palette**. Whoever picks new ones has
  to re-run the validator, not just choose nicer hues. The prompt says so — push back if the next
  session skips it.
- Item 4 ("how the pages are separated") is the one complaint I could not turn into a specific
  instruction, so the prompt asks for a decision with a stated tradeoff instead of guessing. **If
  you already know you want one long scrolling page, say so directly and delete that ambiguity.**

---

Redesign the Token Forecaster dashboard UI. Repo: `/Users/polpedu/Projects/token-forecaster`
(branch `followup-compression`). This is a visual/UX task — the data layer is done and correct,
do not change it.

## Where the UI lives (only these files should change)

| File | Contains |
| --- | --- |
| `apps/companion/src/ui/shell.ts` | CSS design tokens, app bar, tab nav, `PAGES` list, page frame |
| `apps/companion/src/ui/charts.ts` | Server-rendered SVG primitives: `statTile`, `barChart`, `stackedBar`, `quantileStrip`, `calibrationPlot`, `learningCurve`, `timeSeries`, `table`, `pill`, `details` |
| `apps/companion/src/ui/pages.ts` | The five page renderers + all user-facing copy |
| `apps/companion/src/dashboard.ts` | Slug routing (`isPageSlug` / `dashboardHtml`) |

Do **not** touch `packages/*`, `apps/companion/src/service.ts`, `store.ts`, `statusline.ts`, or
any forecasting logic.

## What the user dislikes — act on all of it

1. **Colors.** "hate the UI design aspect... improve the colors and stuff". The current
   blue/orange/aqua on near-black/near-white reads generic and flat. Re-theme it. It must still
   look like a real macOS-native-adjacent app, not a Bootstrap page.
2. **Header too big.** The app bar is currently two stacked rows (52px brand row + tab row).
   Collapse it into one compact row.
3. **Kill the stat-tile squares, keep the numbers.** "i dont like the squares on top of the page
   but the numbers are important and should show". Remove the boxed 4-card grid. Every number
   must survive — present it inline/typographically (a compact metric strip, inline with the
   heading, or folded into the charts) instead of four bordered cards.
4. **Page separation feels wrong.** "i dont like how the pages are separated". The 5-tab split
   is not working. Reconsider the information architecture. Strong candidate: **one scrolling
   page with a slim sticky section nav**, or 2–3 pages instead of 5. Pick one, explain the
   tradeoff in a single sentence, and build it.
5. **"Enough?" is a bad name and its layout is broken.** Rename the page (e.g. "Data needed",
   "Coverage", "Maturity"). Fix its spacing: the small-multiple facet grid is uneven and the
   4th facet orphans onto its own row.

## Hard constraints — do not break these

- The page is served by a local Node daemon under CSP
  `default-src 'none'; style-src 'unsafe-inline'`. **No JavaScript, no remote fonts, no remote
  images, no CDN.** All charts are server-rendered inline SVG. Keep it that way.
- Theme-aware: light tokens on bare `:root`; dark redefined under **both**
  `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` **and**
  `:root[data-theme="dark"]`.
- No prompt or response text may ever appear in the UI. Only counts, token numbers, and hashes.
- Every chart needs a non-hover path to its values (direct labels or a `<details>` table).
  Tooltips must never be the only way to read a number.

## Color work — measure, don't eyeball

Load the **`dataviz` skill first** and follow it. Before shipping any palette, run its validator:

```bash
cd <dataviz skill dir>
node scripts/validate_palette.js "#hex,#hex,#hex" --mode light --pairs all
node scripts/validate_palette.js "#hex,#hex,#hex" --mode dark  --pairs all
```

All checks must **PASS**. The current palette passes (CVD ΔE 9.2 light / 9.4 dark). If you change
hues you must re-validate, not assume. A contrast `WARN` obligates visible labels or a table view.

Rules that must survive a re-theme:

- Ordered quantiles use **one hue, light→dark** — never three categorical colors.
- Status green/amber/red is **reserved for status only**, and always ships with an icon + label.
- Maximum three categorical slots.

## Build, run, and actually see it

```bash
pnpm --filter @token-forecaster/companion build
pkill -f "companion/dist/cli.js start"
node --no-warnings apps/companion/dist/cli.js start --port 8801 &

# print the authenticated URL (port + token live in runtime.json):
python3 -c "import json,os;i=json.load(open(os.path.expanduser('~/Library/Application Support/TokenForecaster/runtime.json')));print(f\"http://127.0.0.1:{i['port']}/dashboard?token={i['token']}\")"
```

**You must look at the rendered result, not just the markup.** The last three real bugs — clipped
bar labels, meaningless y-axis numbers, a colliding axis label — were only visible in a
screenshot.

Open the URL, then capture **only the browser content region**:

```bash
screencapture -x -R<x>,<y>,<w>,<h> out.png
```

Do **not** capture the full screen: the user has browser extension popups (including a crypto
wallet) that must not end up in a screenshot.

## Verify before reporting

```bash
pnpm --filter @token-forecaster/companion build
cd apps/companion && npx vitest run    # 18 tests
cd - && pnpm typecheck && pnpm test    # 383 tests must stay green
```

`server.test.ts` asserts that every page returns 200, carries a chart *or* an explicit empty
state, keeps `?token=` in its nav links, and contains no `<script>`. If you change the page slugs,
update `PAGES` in `shell.ts`, `isPageSlug`, and `server.test.ts` **together**.

## Report back with

- Before/after screenshots of at least two pages, cropped to the browser content area.
- The validator output for both modes, verbatim.
- The IA decision you made for item 4, and why.
- Anything you chose **not** to change, and why.
