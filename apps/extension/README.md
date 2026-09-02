# Token Forecaster for claude.ai/code

A Chrome extension that shows, while you type in the composer, how big the
message you are about to send is and how long the reply is likely to be.

```text
                              ┌────────────────────────────────┐
                              │ ● 6 in · ~348–1.4k out ▁▁▁ 6%  │
                              └────────────────────────────────┘
   ┌─────────────────────────────────────────────────────────┐
   │ hello does this work?                                   │
   │  + Chat  Cowork                    Opus 5  High   [ ↑ ] │
   └─────────────────────────────────────────────────────────┘
```

The bar on the right of the pill is the panel's context meter, shrunk: the
same fill, the same colour, the same `≥` when the figure is a lower bound. It
tracks the conversation live, whether the panel is open or shut.

Click the pill and the panel opens on the forecast itself:

```text
REPLY FORECAST                            ● 6 in · estimate
~348–1,420 tokens out · tuned to your draft
████████▒▒▒▒▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
        348          1.4k                        5.1k
If this becomes a tool or research loop: ~4.3k–30k total
──────────────────────────────────────────────────────
CONTEXT (VISIBLE ONLY)                       ≥ 12,528 / 1M
▓▓░···················································
lower bound: excludes the system prompt, attachments, tools, and memory
──────────────────────────────────────────────────────
API-equivalent cost        $0.0089–$0.036 · list API rates
Opus 5 (from the page) · thinking High (from the page) · confidence low
Fitted on one person's Claude Code agent traffic, which is the work this
page does. Read these as a prior for this kind of work, not a promise
about how you write.                                    Options
```

## While the reply is being written

Send the draft and the chip stops describing what you are about to send and
starts describing what is arriving. The forecast is **frozen at the moment you
send** and never revised: a prediction that drifts towards the outcome cannot
be checked against it. Only the marker moves.

```text
   ┌──────────────────────────────────────────────┐
   │ THIS TURN                    unusually long  │
   │ ≈41k written of about 4.3k expected          │
   │ ████████▒▒▒▒▒▒▒░░░░░░░░░│░░░░░░░░░░░░░░░░░░  │
   │        4.3k        30k                  90k  │
   │ 9 in 10 comparable turns finish under 30k    │
   └──────────────────────────────────────────────┘
                    ● ≈41k out · unusually long ▁▁█
```

The chip also **moves** for the duration. The composer is empty while a reply
writes, so pinning the one live number on the page beside it puts it next to
the one thing nobody is looking at. Instead the chip walks into the gutter
beside the reply, level with the last line on screen, and follows it down as it
grows. Two rules keep that safe: it never crosses the composer (the parked
position is the floor), and with no gutter wide enough to stand in it does not
move at all, because covering the reply it is describing would be worse than
sitting in the wrong corner. It walks back when the turn ends.

When the turn settles, its score stays pinned to the reply it scored:

```text
   ┌──────────────────────────────────────────────┐
   │ …the end of the reply.                       │
   └──────────────────────────────────────────────┘
                          ✓ 2.1k written · shorter than typical
```

and the panel grows a running total for the whole conversation:

```text
FORECAST SO FAR
55k written · 13k expected (429% of expected)
██████████████████████▒▒▒▒▒▒│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│▒▒▒▒▒
3 turns scored · 2/3 landed inside the usual range  ● ● ●
```

One turn landing high says nothing. Most of them landing high says the profile
does not match this work, and that is only visible in aggregate. The totals are
compared against the summed p50, so a healthy session hovers near 100% and over
100% is a session of longer-than-typical turns rather than a failing grade.

Three things this deliberately does **not** claim:

- The written figure is **estimated from the text on your screen** with the
  same character heuristic the draft uses. Nothing is sent anywhere to count
  it, so it lags the stream and, on `/code`, it includes whatever the reply
  renders (tool calls and their results). Every surface that shows the number
  says so.
- A turn is scored against the **whole-turn** quantiles on `/code`, where what
  appears after a send is an agent loop, and against the **single-call**
  quantiles in chat, where it is one reply. The scale follows the surface and
  never switches mid-turn.
- Only turns the extension actually forecast are scored. History that was on
  screen before it loaded gets no badge, because a verdict with no frozen
  prediction behind it would be invented.

Both halves can be turned off in options ("Follow the reply while it is
written" and "Leave the score on each reply"). They are on by default.

## Where it runs, and why

On `claude.ai/code` by default, and nowhere else. The shipped profile is fitted
on Claude Code agent traffic, so `/code` is the surface it actually describes.
The chat surface can be switched on in options; the panel then says it is out
of domain.

The confidence is capped at `low` on both surfaces. The predictor grants
`medium` once a conditioned rung holds 500 or more samples, but those samples
are one person's, so the level is not defensible for a stranger. The cap lifts
only if the leave-one-project-out probe in
[docs/MULTI-USER-PLAN.md](../../docs/MULTI-USER-PLAN.md) shows the fit
transfers.

## First run

A fresh install opens `welcome.html` once, from `chrome.runtime.onInstalled`.
An update never opens it: an extension that steals a tab whenever Chrome
auto-updates it is a nuisance, and the user asked for nothing at that moment.
The page explains the three numbers, states that no request leaves the browser
by default, offers the two display toggles a new user has an opinion about (the
chat surface and the transcript gauge), and names the profile the forecast came
from. It also offers separate, unchecked choices for reliability diagnostics
and derived forecast research. The settings page renders the same provenance
and consent state from the same modules.

`onboardingSeenVersion` in the settings object records what has been shown. It
is written only after the tab actually opens, so a browser that refuses the tab
leaves the next install able to try again. Raising `ONBOARDING_VERSION` in
`src/lib/onboarding.ts` is what shows the page again to somebody who already
has the extension; do that only when the page says something new.

## How the forecast is trained

Nothing is trained or automatically promoted in your browser. The extension
carries a frozen profile compiled into `content.js`. With both contribution
choices off—the default—nothing is uploaded.

That profile is produced once, offline, from **local Claude Code transcripts**:

1. `experiments/evaluation/lib/load-history.mjs` reads `~/.claude/projects/**/*.jsonl`
   on the machine running the pipeline.
2. It derives character counts and a fixed set of booleans and buckets from
   each human message, then discards the text in the same pass. No prompt or
   response text is kept.
3. `pnpm evaluate:claude-history` writes an aggregate profile: sample counts,
   quantiles per group, and the trained correction trees. It is compiled into
   `packages/predictor/src/bundled-profile.ts`.
4. A new profile only ships if it beats the current one on a chronological
   holdout.

So: **you do not need Claude Code installed to use the extension.** You need it
only if you want to regenerate the profile from your own history.

The profile is therefore a prior for this kind of work, not a calibration of
the person reading it: it was fitted on one corpus, and nothing adapts to the
installing user. The welcome page and the settings page both say so, and
`ProfileSummary.personal` is the single flag both read. Training a profile from
the installing user's own transcripts needs a local process outside the
browser, because an MV3 extension cannot read `~/.claude`. That is not built.

The optional research path records only locally derived numeric/categorical
draft features, the forecast frozen at send, and the visible reply's estimated
token count. It never sends prompt or reply text. Every such outcome is tagged
`outputTokenQuality: "dom_estimate"` and `forecastScale: "call" | "turn"`, so
it cannot silently enter an exact API-token fit. The collector issues random
per-install credentials, batches idempotently, rate-limits, and supports
user-triggered physical deletion. A collected row is evidence for an offline,
human-gated evaluation—not permission to ship a new profile automatically.

## What it measures, and what it cannot

- **The draft.** Counted locally with the character heuristic from
  `@token-forecaster/token-counter`, labelled `estimate`. With the optional API
  key it becomes an exact Anthropic count of the draft, labelled `counted`.
- **The reply.** Quantiles from the bundled profile, drawn as a band. The band
  has no needle, because the forecast has no point estimate; opacity fades
  outward because certainty does.
- **The conversation.** Only what the page renders. It is a lower bound, drawn
  with a fading right edge and prefixed `≥`, because the extension cannot see
  the system prompt, attachments, tool definitions, or memory. The same meter
  is drawn in miniature on the pill, so the collapsed and open views can never
  disagree; it reads `<1%` rather than `0%` while a real conversation is still
  a fraction of a 1M window.
- **The reply, once it is real.** The rendered text of every message that
  appeared after the send, estimated locally and scored against the frozen
  forecast. Not the API's count: the extension cannot see one.
- **Extended thinking.** Ships **on**, because that is how claude.ai ships and
  because the thinking group forecasts the longer reply of the two. Switch the
  setting to `auto` and it is deduced in three rungs instead: the effort control
  next to the model picker, then a thinking block in the newest reply on the
  page, then the same default. The panel always names the rung that answered
  ("your setting", "from the page", "from the last reply", "assumed"), and the
  on/off control on the panel always shows which way it is set.

## Privacy

By default the extension makes no network requests at all. It stores settings
and an empty telemetry queue state in `chrome.storage.local`.

If you turn on verified counting in options, and only then, the draft text and
the model id go to `api.anthropic.com/v1/messages/count_tokens` with your own
API key. The conversation is never sent. The key is stored unencrypted, as all
extension storage is. The extension never touches your claude.ai session,
cookies, or internal endpoints.

Reliability diagnostics and forecast research are independent, unchecked
choices on the welcome and settings pages. Enabling one asks Chrome for access
only to the build-configured collector origin. The durable queue accepts only
the enumerated schema; it has no arbitrary properties field in which page text,
URLs, or stack traces could hide. Turning a choice off drops unsent events of
that kind. **Delete contributed data** revokes the anonymous installation,
physically removes its collector rows, clears the local queue, and removes the
collector host permission. `privacy.html` is the packaged notice; publish a
completed operator-specific copy and enter its URL in the Chrome Web Store
dashboard before public distribution.

## Build and load

```bash
pnpm install
pnpm build:extension     # builds the workspace packages, then apps/extension/dist
```

That default build is offline-only. A collector build is explicit and must use
HTTPS outside local development:

```bash
TF_TELEMETRY_ORIGIN=https://telemetry.example.com pnpm build:extension
```

The build adds only that origin to `optional_host_permissions`; Chrome asks for
it from the user's consent click, not at install.

Then in Chrome: `chrome://extensions` → **Developer mode** → **Load unpacked** →
pick `apps/extension/dist`. Open <https://claude.ai/code> and click in the
composer.

While iterating:

```bash
pnpm --filter @token-forecaster/extension dev    # esbuild watch
```

Press the reload arrow on the extension card, then reload the tab.

The clean-profile browser test uses a temporary Chrome profile and local
collector, with no live Claude traffic:

```bash
pnpm test:extension:e2e
```

Once a consented study has data, report readiness and visible-surface accuracy
without printing installation hashes:

```bash
pnpm telemetry:report:extension /absolute/path/to/extension-events.jsonl
```

## Looking at the design without Chrome

```bash
node scripts/render-static-preview.mjs           # dist/preview-static.html
```

That renders the real chip against real engine output, light and dark, for
eight states (a reply being written on track, one running past the predicted
range, a scored conversation between turns, short draft, long draft with a
measured conversation, verified count, context nearly full, chat surface). `dist/preview.html` is the live version of
the same thing.

## Manual test script

1. `pnpm build:extension`, load `apps/extension/dist` unpacked, open
   <https://claude.ai/code>. The pill sits above the composer, dimmed.
2. Type `hi`. The pill shows an input count and a reply range.
3. Paste a longer prompt that names a file, for example
   `rewrite packages/predictor/src/historical.ts and add a table`. The count
   grows and the band moves.
4. Click the pill. The panel opens above it, never over the greeting, and never
   runs off the top of the window. The bar on the pill matches the panel's
   context meter, and keeps filling as the session grows after you close it.
5. Check the meta line: it reads `thinking on (your setting, the page shows
   High)`, and the on/off control below it shows **on** pressed.
6. Set **Extended thinking** to `Auto` in options. The segment now reads the
   effort control on the page; change that control and the numbers move. Hide
   the control (a layout with no effort picker) and the segment falls back to
   `thinking on (from the last reply)`, or to `thinking on (assumed)` on an
   empty session.
7. Open a different session from the sidebar. The chip re-anchors within about
   a second. Reload the page: it comes back.
8. Navigate to a normal chat. The chip disappears. Turn on **Also show on the
   chat surface** in options: it returns, with the out-of-domain caveat and
   `confidence low`.
9. Press Escape with the panel open: it closes. Click elsewhere on the page: it
   closes. Click the pill while typing: the caret stays in the composer.
10. Open DevTools → Network, filter on `anthropic`. Type. There must be zero
    requests.
11. In options, turn on verified counting, paste an Anthropic API key, accept
    the permission prompt, press **Test the key**. Back in the tab, type and
    pause: the header flips to `counted` and the dot turns green.
12. Remove the extension and load it again. A tab opens on the welcome page.
    Press the reload arrow on the extension card instead: no tab opens.
13. On the welcome page, tick **Also show on the chat surface**, then open the
    settings page. The same box is ticked, and both pages print the same
    profile id.
14. Zoom to 150% and resize the window. The pill stays pinned to the composer's
    top-right corner and the panel shrinks instead of escaping the viewport.
15. Send a prompt. The pill switches to `≈… out` with a verdict word, the dot
    pulses, and the chip walks out of the composer's corner to the gutter
    beside the reply, following the last line down as it writes. It never
    crosses the composer. Narrow the window until there is no gutter: the chip
    stays parked instead of covering the reply.
16. Let the reply finish. Within a couple of seconds the chip walks back, a
    badge appears under the reply reading `✓ … written · shorter than typical`
    (or `!` and a longer wording), and the panel gains **FORECAST SO FAR**.
    Hover the badge: the tooltip names the p50 and p90 it was judged against.
17. Scroll the badge off screen and back: it follows its reply and never lands
    on the composer. Click it: the panel opens.
18. Press stop mid-reply. The turn still settles and is still scored, on what
    was written. Send an empty turn that errors before any text: it is recorded
    as `Turn ended with nothing written. Not scored.` and is left out of the
    totals.
19. Open a different session from the sidebar. The score line and the badges
    disappear with the conversation they belonged to.
20. Turn both live toggles off in options. The pill goes back to the draft
    range for the whole turn and no badges appear.
21. Look at the mascot beside the composer. The pill stops short of it with a
    gap, at every zoom level and window width, and never covers it.
22. With both contribution boxes unchecked, filter Network on the configured
    collector and complete a turn. There must be zero collector requests.
23. Enable diagnostics only. Accept the narrowly scoped collector permission;
    settings must report an anonymous registration and an empty delivered
    queue. No research observation is sent.
24. Enable forecast research and complete one turn. Inspect the collector row:
    it contains derived prompt features and `dom_estimate`, never the prompt or
    reply string.
25. Choose **Delete contributed data**. The local queue clears, both choices
    become denied, the host permission is removed, the credential is revoked,
    and that installation's rows disappear from the collector file.

## Layout

| Path | What it is |
| --- | --- |
| `src/manifest.json` | MV3 manifest: local storage/alarms, plus optional hosts for Anthropic and a configured collector |
| `src/lib/engine.ts` | The whole pipeline: counts, forecast, band geometry, meter, cost, strings |
| `src/lib/format.ts` | Number formatting and every user-facing string |
| `src/lib/model-map.ts` | Picker label to registry model id, derived from `listModels()` |
| `src/lib/thinking.ts` | Control, last reply, or default, to the boolean the forecaster uses |
| `src/lib/surface.ts` | `/code` versus chat |
| `src/lib/theme.ts` | Reads the page's own light or dark background |
| `src/lib/settings.ts` | The single `chrome.storage.local` object |
| `src/content/anchor.ts` | Finds the composer and survives re-mounts and SPA navigation |
| `src/content/extract.ts` | Every read of the page's DOM, each a ladder of selectors |
| `src/content/chip.ts` | The Shadow DOM overlay: pill, band, meter, panel, and the measurement that keeps it off the page's own decorations |
| `src/content/index.ts` | Wiring: input events, debounces, reconciler, render |
| `src/sw/index.ts` | Privileged boundary for the optional Anthropic count and consented telemetry queue |
| `src/sw/telemetry.ts` | Durable batching, anonymous registration, retry, consent enforcement, and deletion |
| `src/lib/telemetry-events.ts` | Text-free diagnostic and research event construction |
| `src/lib/onboarding.ts` | Whether a fresh install sees the welcome page. No profile import, so the worker stays small |
| `src/lib/profile-info.ts` | The user-facing description of the profile the forecast came from |
| `src/options/` | The settings page |
| `src/welcome/` | The page a fresh install opens once |
| `src/privacy/` | Packaged privacy notice linked from both consent surfaces |
| `src/preview/` | The design preview, live and static |
| `e2e/fresh-install.mjs` | Clean-profile Chrome install, first-value, consent, restart, ingest, and deletion test |
| `scripts/make-icons.mjs` | Regenerates the icons in `src/icons` |

## Design notes

- **The band is on a square-root scale.** Linear buries p50 (348 of 4,200 is 8%
  of the track); log needs a lower bound the data does not supply. Square root
  is zero-anchored and parameter-free, and every boundary is labelled with its
  real value so the reader compares numbers, not lengths.
- **The track ends at p99**, or at the model's output cap once p99 comes within
  half of it, or at p90 when the profile carries no p99. The aria label says
  which.
- **Opacity encodes probability mass**, so the fade is the statement "we know
  less out here".
- **One data hue**, deliberately outside the status range, so a forecast band
  can never be misread as a status. Status colors always ship with a word.

## When the page changes its DOM

The composer lookup ends in a structural heuristic (the largest editable box on
the page), so a renamed class usually changes nothing. If it does break, the
chip hides itself; it never breaks the page. The model name, the effort level,
and the transcript gauge degrade one field at a time. Fix the ladders in
`src/content/extract.ts`; `test/extract.test.ts` and `test/thinking.test.ts`
hold the fixtures.
