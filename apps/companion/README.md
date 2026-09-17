# Token Forecaster companion

The local background service. It indexes your Codex and Claude Code history,
trains a forecasting profile from **your** calls, and serves an authenticated
loopback API. The menu-bar app in `apps/menubar` is a client of this; so is any
future extension integration.

Nothing is uploaded. Your history files are opened read-only and never modified.
No prompt or response text is stored anywhere — see
[ADR 0001](../../docs/adr/0001-macos-companion.md).

## Quick start

```bash
pnpm install
pnpm build

# One-shot: import everything, train, and print what happened.
node --no-warnings apps/companion/dist/cli.js index

# What the held-out evaluation concluded.
node --no-warnings apps/companion/dist/cli.js evaluate

# Run the background daemon (backfill, watch, serve the API).
node --no-warnings apps/companion/dist/cli.js start
```

`--no-warnings` only silences Node's experimental-SQLite notice.

Then build and launch the menu bar:

```bash
cd apps/menubar && make release
open .build/TokenForecaster.app
```

## Running on Windows

Everything above the menu bar runs on Windows: the daemon, the status line and
the draft-aware launchers, for both CLIs — the reserved row `tf-codex` paints
its bar on is virtual-terminal sequences a ConPTY console handles the same way
a pty does. The menu bar app itself is Swift and macOS-only, so
the dashboard at `http://127.0.0.1:<port>/dashboard?token=<token>` (port and
token are in `runtime.json`) is the UI, and the settings it exposes are set
through the API rather than a menu.

**Needs:** Node 22+, Python 3, and `pip install pywinpty` for the draft
forecast. Without pywinpty everything else still works; without Python the
launcher steps aside and the CLI runs unchanged.

```powershell
git clone https://github.com/Sumcap/token-forecaster.git
cd token-forecaster
pnpm install
pnpm build
pnpm --filter @token-forecaster/companion build   # the root build covers packages/ only

node --no-warnings apps\companion\dist\cli.js index         # import history, train, report
node --no-warnings apps\companion\dist\cli.js install-shell # wrap `claude` and `codex`, then: . $PROFILE
node --no-warnings apps\companion\dist\cli.js start         # the daemon
```

`install-shell` says so if it cannot find a Python to run the launcher with,
rather than leaving you to notice that the forecast never mentions a draft.

There is no service wrapper — `start` is a foreground process. To have it
running after a reboot, put a launcher in the Startup folder:

```powershell
$startup = [Environment]::GetFolderPath('Startup')
$repo    = (Get-Location).Path
@"
@echo off
start "" /min node --no-warnings "$repo\apps\companion\dist\cli.js" start
"@ | Set-Content -Encoding ASCII "$startup\token-forecaster.cmd"
```

Delete that file to stop it starting. Then add the status line to
`~/.claude/settings.json` as described below, with the backslashes doubled.
Codex needs no such setting: `tf-codex` paints its own row.

## Data location

Everything derived lives in one directory, named by the platform's own
convention:

| Platform | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/TokenForecaster/` |
| Windows | `%LOCALAPPDATA%\TokenForecaster\` |
| Linux, BSD | `$XDG_STATE_HOME/token-forecaster/`, or `~/.local/state/token-forecaster/` |

| File | What it is |
| --- | --- |
| `forecaster.db` | SQLite store: observations, file cursors, profiles, evaluations |
| `runtime.json` | `{ port, token, pid, startedAt }`, mode `0600` — how clients find the daemon |
| `drafts/<pid>.json` | Counts for the line being typed, one per live launcher |

`--data-dir <path>` overrides it, which is how you try this without touching
your real store. The status line is a separate process and takes no flags, so
it follows `TOKEN_FORECASTER_DATA_DIR` instead — set that and every part agrees
on where to look. Four programs compute this path (daemon, CLI, status line,
launcher) from two implementations, one of them Python;
`src/launcher.test.ts` runs both and fails if they ever disagree.

## Commands

| Command | What it does |
| --- | --- |
| `start` | Backfill, watch both history directories, serve the API. |
| `index` | Import new history once and retrain, then exit. |
| `evaluate` | Print the chronological holdout report. |
| `status` | Sources, profile and stored observation counts. |
| `forecast --provider <openai\|anthropic> --scale <call\|turn> [--model ...] [--reasoning ...]` | One forecast. |
| `reset` | Delete all derived data. Your history files are untouched. |

Add `--json` for machine-readable output on `index`, `evaluate`, `status` and
`forecast`. `--port <n>` pins the daemon's port; by default the OS assigns a
free one and publishes it in `runtime.json`.

## API

Loopback only (`127.0.0.1`). Every request needs
`Authorization: Bearer <token>` from `runtime.json`. There is no CORS header at
any origin, so a web page cannot read a response even if it guessed the port.

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/health` | Indexing state, sources, profile summary, held-out coverage, current session. |
| `GET` | `/profiles` | The trained profile and the latest evaluation report. |
| `GET` | `/stats` | Everything the statistics page renders, as JSON. |
| `POST` | `/forecast` | `{ provider, scale, model?, reasoning?, promptFeatures?, maxTokens? }` → `{ forecast }`. |
| `POST` | `/rebuild` | Kick off an index + retrain. |
| `POST` | `/pause` | `{ paused: boolean }`. |
| `GET`/`POST` | `/settings` | `{ codexDir, claudeDir, launchAtLogin }`. |
| `POST` | `/reset` | Delete all derived data. |
| `GET` | `/dashboard` | The statistics page (below). Accepts `?token=` so a menu item can open it. |

`/forecast` always reports where its numbers came from:

```
personal_group     a conditioned rung of your own profile
personal_overall   your unconditional distribution for that provider and scale
bundled_fallback   the shipped Claude Code profile — cold start, not your data
static_baseline    nothing usable; a fixed prior
```

Example:

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/Library/Application Support/TokenForecaster/runtime.json'))['token'])")
PORT=$(python3 -c "import json;print(json.load(open('$HOME/Library/Application Support/TokenForecaster/runtime.json'))['port'])")

curl -s -X POST "http://127.0.0.1:$PORT/forecast" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"provider":"openai","scale":"turn","model":"gpt-5.3-codex","reasoning":"xhigh"}'
```

## The status line

A live readout inside the CLI itself. While a turn runs it shows that turn's
output growing against **your** own history, so a turn heading for an expensive
tail is visible while it is still running:

```
◆ 15k tokens out  ·  ▓▓▓░░░░░░░ typical  ·  usual 22k tokens
◆ 34k tokens out  ·  ▓▓▓▓▓▓▓▓▓▓ very long  ·  usual 22k tokens
```

Between turns it reports the turn that just finished and what the next one is
expected to cost — the same number a caller such as the host app would set
aside as its output budget:

```
◆ last turn 18k tokens out  ·  ▓▓▓▓▓▓▓▓▓░ running long  ·  next turn est 2.9k tokens out  ·  ctx 13%  ·  $5.52
```

Started through a launcher it forecasts the prompt you are writing instead, and
the number moves as the draft grows:

```
◆ prompt 3 tokens in → est 2.7k tokens out  ·  worst case 29k tokens  ·  ctx 13%
◆ prompt 103 tokens in → est 4.6k tokens out  ·  worst case 27k tokens  ·  ctx 13%
```

That last line is the point of the app: this much in, about that much out.

### Claude Code renders it; Codex cannot

Claude Code runs a command for its status line and prints what it returns, so
there it is a setting (below) and `dist/statusline.js` is the command.

Codex has a status line too, but nothing outside Codex can write to it.
`tui.status_line` takes a list of Codex's **own built-in item names** — model,
reasoning, directory, branch, context left, token totals — configured through
`/statusline`; anything else is answered with `Ignored invalid status line
item`, and no hook, plugin or config key runs a command and shows its output.

So for Codex the bar is painted from outside, by `bin/tf-codex`. It gives Codex
a screen one row shorter than the terminal really is, clamps every scrolling
region Codex sets to that shorter screen, and keeps the last row for itself:

```
› write a haiku about scroll regions

  gpt-5.6-sol xhigh · ~/Projects/token-forecaster      ← Codex's own status line

◆ prompt 9 tokens in → est 2.7k tokens out  ·  worst case 29k tokens
```

Two details are the whole technique. The region is re-clamped on the way past
rather than set once, because Codex drives it itself for its inline viewport
and a bare `ESC[r` — reset to the full screen — would hand the row back and let
the next line of output scroll over it. And the *top* margin is never touched:
terminals only copy a scrolled-off line into the scrollback buffer when the
region starts at row one, so clamping the bottom keeps your history and moving
the top would silently throw the session away as it scrolled.

The line itself is not reimplemented. `tf-codex` runs `statusline.js --stream`
— one JSON payload per line in, one rendered bar per line out — so both CLIs
show a bar built by one piece of code from one forecast endpoint. What differs
is only where the turn is read from: Claude Code names its transcript in the
payload it pipes in, while Codex tells a process that wrapped it nothing at
all, so the launcher passes down where Codex keeps its sessions and the newest
rollout that appeared after the launcher started is this session's.

The bar is pinned to the bottom row rather than floating under the composer,
because nothing outside Codex knows where the composer ends. Once the session
fills the screen the two are adjacent; before that there is a gap.

Two things about the Codex bar differ from the Claude Code one, both because
Codex reports differently:

* **No price.** Codex reports a cost only on Enterprise workspaces. Rather than
  guess one from token counts and a price list that may not be yours, the bar
  says nothing about money there.
* **A row is only taken when there is something to put in it.** No Node, an
  unbuilt status line, or a terminal under five rows tall — each one prints a
  line saying so and starts Codex with the screen it would have had.

## Forecasting the prompt you are typing

Claude Code never puts the prompt being written on disk — not in the transcript,
not in `history.jsonl`, which records a prompt only once it is sent — and the
[status line payload](https://code.claude.com/docs/en/statusline) has no input
field; typing is not even an update trigger. So the draft can only come from
something sitting between the keyboard and Claude Code, and that is what
`bin/tf-claude` is. Codex is the same story with one more gap in it, so
`bin/tf-codex` is the same program:

```bash
apps/companion/bin/tf-claude          # instead of: claude
apps/companion/bin/tf-claude --resume # any claude arguments pass straight through
apps/companion/bin/tf-codex           # instead of: codex
```

Nobody types that every time, and an app whose main feature only works for
people who find a menu is an app whose main feature does not work. So the daemon
writes the block itself on first run, the app says so once (with an Undo button
on the notice), and **Settings › Wrap `claude` and `codex` in new terminals**
turns it off again. It is written exactly once: switch it off and no restart will put it
back. By hand:

```bash
node apps/companion/dist/cli.js install-shell     # then: source ~/.zshrc
node apps/companion/dist/cli.js uninstall-shell   # puts the file back
```

`install-shell` finds your startup file from `$SHELL` (zsh and bash; pass
`--rc <path>` for anything else) or, on Windows, your PowerShell profile — a
`--rc` ending in `.ps1` is written as PowerShell, anything else as shell, so
there is no second flag to remember. It copies it to `<rc>.token-forecaster-backup`
before its first edit, and writes one block, between two markers, holding a
wrapper for each CLI it has a launcher for. Running it twice updates the block
rather than stacking another.
`uninstall-shell` removes exactly that block, leaves every later edit of yours
in place, and drops the backup once the file matches it again — so uninstalling
returns the file byte for byte to what it was.

What it writes is a shell *function*, not a bare alias:

```sh
claude() {
  if [ -x "…/bin/tf-claude" ]; then command "…/bin/tf-claude" "$@"; else command claude "$@"; fi
}

codex() {
  if [ -x "…/bin/tf-codex" ]; then command "…/bin/tf-codex" "$@"; else command codex "$@"; fi
}
```

because an app can be dragged to the Trash without anyone running the uninstall
first. An alias to a deleted file would break `claude` outright; this falls back
to the real one, so the worst case of a missing app is a status line that stops
forecasting drafts. (`command` bypasses the function, so the fallback cannot
recurse.)

### On Windows

Same job, two differences. The block goes into a PowerShell profile rather than
an rc file, and it names `bin\tf-claude.cmd` and `bin\tf-codex.cmd` — Windows
does not read `#!` lines, so each `.cmd` finds a Python 3 (`py -3`, then
`python`, or `TOKEN_FORECASTER_PYTHON`) and hands it the launcher:

```powershell
function claude {
  $tf = 'C:\Users\you\token-forecaster\apps\companion\bin\tf-claude.cmd'
  if (Test-Path -LiteralPath $tf -PathType Leaf) { & $tf @args }
  else { … Get-Command claude -CommandType Application … }
}
```

`Get-Command -CommandType Application` cannot resolve to a function, so the
fallback reaches the real `claude` and not this block again — the same
no-recursion property `command` gives the POSIX version.

Which profile: `install-shell` writes to the PowerShell it is running under
(PowerShell 7 sets `POWERSHELL_DISTRIBUTION_CHANNEL`), else to whichever
profile already exists, else to PowerShell 7 if it is installed, else to
Windows PowerShell 5.1. It follows Documents into OneDrive when Known Folder
Move has redirected it, and creates the profile directory if PowerShell has
never made one. A profile written to the *other* PowerShell is not an error —
it is simply never loaded — which is why the choice is made this carefully.

The transport differs too: Windows has no pty, so the launcher opens a pseudo
console (ConPTY), which Python reaches through
[pywinpty](https://pypi.org/project/pywinpty/):

```powershell
pip install pywinpty
```

Without it the launcher prints one line and starts the CLI unchanged — the
session is exactly what it would have been, minus the draft forecast. That is
the only failure this program is allowed to have. The console is also read a
byte at a time rather than in 64KB chunks, so the keystroke parser holds a
partial escape sequence until the rest of it arrives; `src/draft.test.ts` feeds
the same streams both ways and fails if the two disagree.

### What it does with the keystrokes

It allocates a pty, runs the CLI inside it, forwards your keystrokes, and keeps
a model of the line you are editing — backspace, ctrl-u, ctrl-w, bracketed
paste, meta-enter for a newline, enter to clear. Every change is reduced to the
same aggregates the trainer derives from history and written to a private file
named in `TOKEN_FORECASTER_DRAFT`, which the CLI inherits and hands to the
status line. In Claude Code `refreshInterval` then picks it up — about once a
second, since typing itself cannot trigger a redraw; in Codex the launcher is
already the one drawing, and it asks for a fresh line on its own timer.

One keystroke model, one draft file, two front ends: `bin/tf_wrap.py` is the
launcher, and `bin/tf-claude` and `bin/tf-codex` are ten lines each on top of
it. `src/draft.test.ts` exercises the shared module, so neither CLI can drift
into a keystroke parser of its own.

**It never writes, logs or sends the text.** The buffer lives in memory, becomes
counts, and is dropped the moment you press enter. It sees only what you type
into that one session: it wraps a process, it is not a system-wide input tap, and
it needs no macOS permissions. `bin/tf_draft.py` is a port of
`extractPromptFeatures`, and `src/draft.test.ts` runs both over the same prompts
and fails if they ever disagree.

### The switch behind it

The forecast only reacts to a draft if the profile has prompt rungs, and the
adoption gate decides that from your held-out data. On this corpus it says no by
a hair: prompt rungs cut turn-scale pinball loss at P50 by 1.1% and at P90 by
1.4%, then give it back at P99, netting 0.5% worse on the mean — under the 2%
margin. **Settings › Forecast from your draft** decides it, and it is **on by default**:
the point of the app is the number moving with what you write, so the trade —
sharper P50 and P90, a slightly fatter tail — is taken deliberately rather than
left to a menu nobody opens. The reason recorded in the profile says out loud
that the gate was overridden, and switching it off restores the measured
default.

With it on, a turn on Opus 5 at high effort forecasts 6.3k under 80 characters,
11.7k from 80–300, and 29.2k past 1200 — your own rungs, so the steps land where
your history says they land, not per keystroke.

Once the turn starts it measures, and grades what it measures against a forecast
**conditioned on the prompt you actually sent**:

```
◆ 15k tokens out  ·  ▓▓▓░░░░░░░ typical  ·  usual 22k tokens  ·  ctx 41%  ·  $0.42
◆ 34k tokens out  ·  ▓▓▓▓▓▓▓▓▓▓ very long  ·  usual 22k tokens  ·  ctx 62%  ·  $1.90
```

The verdict is `typical` below your P50, `running long` between P50 and P90, and
`very long` past P90. A forecast that came from the bundled profile rather than
your own history says `usual 22k tokens (generic)`, or `(generic)` on the
prediction. The price is only shown once the session has been billed something,
and only in Claude Code, which is the one that reports it.

### The prompt in flight

While a turn is running the status line reads the human prompt that opened it
out of the transcript — Claude Code's, or Codex's rollout — reduces it to the
same aggregates the trainer derives
during training — length, code fences, paths, question or imperative, images —
and sends **those counts** with the forecast request. It uses
`extractPromptFeatures` from `@token-forecaster/core`, the very function the
importers use, so the live features cannot drift from the trained ones; the hash
is blanked, since it only exists to match repeated prompts during training.

No prompt text is sent, held or written down: it exists inside one function call
and is reduced to numbers there. Between turns nothing is conditioned on — the
prompt you are still typing is not in the transcript, and the previous turn's
prompt says nothing about the next one.

`Settings > Detailed terminal status line` in the menu bar switches to the
numbers behind that verdict:

```
◆ 15k tokens out  ·  ▓▓▓░░░░░░░  ·  P50 22k P90 49k 0.7× P50  ·  ctx 41%  ·  session 245k
```

Setting `TOKEN_FORECASTER_STATUS_STYLE=simple|detailed` in the status line
command overrides the app's setting, for a status line configured by hand.

Enable it by adding this to `~/.claude/settings.json` (or `./.claude/settings.json`
for one project):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node --no-warnings /ABSOLUTE/PATH/TO/token-forecaster/apps/companion/dist/statusline.js",
    "refreshInterval": 2,
    "padding": 0
  }
}
```

Installing from the `.app` rather than a checkout? The status line ships inside
the bundle, so point at that copy instead:

```text
node --no-warnings /Applications/TokenForecaster.app/Contents/Resources/companion/statusline.js
```

On Windows the same key takes a Windows path, and `settings.json` is JSON:
every backslash has to be doubled, or the setting silently does nothing.

```json
{
  "statusLine": {
    "type": "command",
    "command": "node --no-warnings C:\\Users\\you\\token-forecaster\\apps\\companion\\dist\\statusline.js",
    "refreshInterval": 2,
    "padding": 0
  }
}
```

Remove the `statusLine` key to turn it off.

### Where each number comes from

| Field | Source |
| --- | --- |
| Leading count and meter | Output tokens in the **current turn**, read from the tail of the transcript: `transcript_path` in Claude Code, this session's `~/.codex/sessions/…/rollout-*.jsonl` in Codex. This is the only genuinely live number — both CLIs append as the turn runs. |
| `P50` / `P90` | `POST /forecast` on the local daemon, for `scale: "turn"` conditioned on the session's model and reasoning effort. |
| `last` | Output tokens of the turn that just finished, from the same transcript scan. |
| `est` / `worst case` | `POST /forecast`: your P50 and P90 output tokens for the next turn on this model, for `provider: "anthropic"` or `"openai"` as the CLI decides. With a draft in the box the request carries its prompt features, and the daemon reads the length rungs as a curve rather than four steps — so the number moves as the prompt grows instead of jumping at bucket edges. |
| Prompt conditioning | Prompt aggregates: from the draft published by the launcher between turns, or from the turn-root message in the transcript while a turn runs. Sent as `promptFeatures` on the same request. |
| `prompt N tokens in` | Input tokens typed so far, estimated locally from the line the launcher is watching (the same four-characters-a-token heuristic `@token-forecaster/token-counter` uses). |
| `ctx` | `context_window.used_percentage` from the payload Claude Code pipes in; in Codex, the last call's `total_tokens` against `model_context_window` from its own `token_count` rows. |
| `session` (detailed only) | `context_window.total_output_tokens` from the same payload; in Codex, `total_token_usage.output_tokens`. |
| Price | `cost.total_cost_usd` from the same payload — what this session has been billed so far, not a forecast. Claude Code only: Codex reports a price on Enterprise workspaces alone. |
| Style | `statusStyle` on the same `POST /forecast` reply, so the style costs no extra round trip. |

The meter fills to half width at your P50 and full width at your P90, then
saturates; it turns yellow past P50 and red past P90. If the forecast came from
the bundled profile rather than your own history it says `(generic)`
(`(generic profile)` in the detailed style) — a generic number never passes as a
personal one.

### Constraints it respects

Claude Code blanks the status line on a non-zero exit or empty output, so this
never fails: a missing daemon prints `no forecast`, a malformed
transcript counts zero, and every path exits 0. It imports only Node builtins —
no SQLite, no trainer — and runs in about 40 ms warm, reading only the last
512 KB of the transcript rather than a file that can reach hundreds of megabytes.

**Refresh honesty:** the status line is event-driven (it fires when an assistant
message arrives) plus the optional `refreshInterval` timer. With
`refreshInterval: 2` the count does advance while a turn is running, but it is a
2-second poll, not a stream — treat it as a coarse live meter, not a token
counter.

## The statistics page

`Open dashboard` in the menu, or
`http://127.0.0.1:<port>/dashboard?token=<token>`. It answers four questions in
order, and it loads no remote resources and runs no scripts.

1. **What we read** — per source: files, bytes on disk, rows parsed, usable
   calls, sessions, last scan, and every skipped row broken down by reason with
   a plain-English gloss. Nothing is silently dropped.
2. **What the predictor is doing** — per provider and scale: whether that slice
   conditions on model and reasoning at all, how many rungs it has, and its
   P50/P90/P99.
3. **Is this enough data?** — a learning curve per slice. The deployed model is
   refitted on progressively more of your *recent* history and every fit is
   scored against the same strictly-later holdout. Two numbers matter: how many
   observations it took to beat the generic profile, and where the curve stops
   falling.
4. **Does personalization actually help?** — the chronological holdout table.

On the corpus this was built against, the answer to (3) turned out to be
"far less than you'd think":

| Slice | Beats the generic profile at | Stops improving at | Available |
| --- | --- | --- | --- |
| openai · turn | **36** observations | 144 | 825 |
| anthropic · turn | 336 | 673 | 1,923 |
| openai · call | 689 | 689 | 15,759 |
| anthropic · call | 1,221 | 1,221 | 27,923 |

Three of four slices are flagged **plateaued**: past a few hundred observations,
more history stops buying accuracy, and on three of them the most recent
quarter of the archive forecasts as well as all of it. That is reported as
"recency dominates" rather than hidden, because it means the useful lever is
better features, not a bigger archive.

## How the profile is decided

`rebuild` always evaluates before it trains. Each `(provider, scale)` slice is
split chronologically — earlier 70% to fit, strictly later 30% to score — and
four candidates compete on pinball loss: the cold start, your unconditional
distribution, model-and-reasoning conditioning, and conditioning plus prompt
features.

A candidate must cut pinball loss by at least 2% to be adopted, and the decision
is per slice. A slice where conditioning lost keeps only its unconditional rung.
Nothing is ever scored on data it was fitted on.

Run `evaluate` to see the table. If personalization is not helping on your
corpus, the report says so rather than the profile quietly pretending otherwise.
