# Token Forecaster — menu bar app

A macOS status-bar (menu bar) client for the Token Forecaster companion daemon.

The app is a **thin client** — it contains no forecasting logic — but it is
**self-sufficient**: on launch it looks for a running companion daemon and, if
there isn't one, starts and supervises its own. You never have to keep a
terminal open.

---

## 1. Run it (from this repo)

```bash
# once, from the repo root
pnpm install
pnpm -w build
pnpm --filter @token-forecaster/companion build

# build and launch the app
cd apps/menubar
make release
open .build/TokenForecaster.app
```

That is the whole thing. The app appears in the menu bar as `◆ 4.3k` (glyph plus
the personal P50 for the current default group), or `◆ —` when that value is not
known yet. There is no Dock icon and no window.

The app starts the daemon itself: it runs
`node --no-warnings apps/companion/dist/cli.js start` as a child process and
kills it again when you quit (⌘Q). If a daemon is **already** running — because
you started one in a terminal — the app adopts it and leaves it alone, including
on quit.

To stop everything from the shell:

```bash
pkill -f TokenForecaster.app/Contents/MacOS/TokenForecaster
```

### Pointing the app at a different companion build

The app looks for the daemon entry point in this order and uses the first that
exists:

1. `TokenForecaster.app/Contents/Resources/companion/cli.js` — the bundled copy
   produced by `make dist`;
2. the path in `UserDefaults` key `companionCliPath`;
3. `<repo>/apps/companion/dist/cli.js`, inferred by walking up from the running
   executable (this is what a `make release` build uses).

```bash
defaults write com.tokenforecaster.menubar companionCliPath \
  /path/to/token-forecaster/apps/companion/dist/cli.js
```

Node is found by probing `/opt/homebrew/bin/node`, then `/usr/local/bin/node`,
then whatever `/bin/zsh -lc "command -v node"` resolves (this is how nvm
installs are found), then the `UserDefaults` key `nodePath`. A GUI app does not
inherit your shell `PATH`, which is why the probing exists.

---

## 2. Share it with a colleague

```bash
cd apps/menubar
make dist
```

This builds the workspace, builds the app, bundles the daemon into the `.app`
with esbuild (one self-contained `cli.js`, no `node_modules`, no pnpm
symlinks), verifies that bundle actually runs from outside the repo, ad-hoc
signs the app and zips it. It prints the result:

```
==> done
    /…/apps/menubar/.build/TokenForecaster.zip
    208K
```

Send them `TokenForecaster.zip`. What they do:

```bash
unzip TokenForecaster.zip
mv TokenForecaster.app /Applications/

# Required once: this build is not notarized (see below).
xattr -dr com.apple.quarantine /Applications/TokenForecaster.app

open /Applications/TokenForecaster.app
```

### Gatekeeper — read this, it will not "just work"

The app is **ad-hoc signed and NOT notarized**. On a machine that did not build
it, macOS will refuse to open it on first launch: double-clicking gives
*"TokenForecaster" cannot be opened because Apple cannot check it for malicious
software* (or, on macOS 15+, it is blocked outright and you are sent to System
Settings). This is expected, not a broken build.

Two ways past it, both legitimate:

- **Terminal (most reliable):**
  `xattr -dr com.apple.quarantine /Applications/TokenForecaster.app`, then open
  it normally.
- **Finder:** right-click (or Control-click) the app → **Open** → **Open** in
  the dialog. On macOS 15 you may instead have to open it once, get rejected,
  then go to **System Settings › Privacy & Security** and click **Open Anyway**.

Doing this properly — so the app opens on a double-click with no warning at all
— requires an **Apple Developer ID certificate ($99/year) plus notarization**
through Apple's service. **This build has neither.** Only hand the zip to people
who trust you enough to bypass Gatekeeper deliberately.

---

## 3. What your colleague needs

- **macOS 14 (Sonoma) or later**, Apple silicon or Intel matching the machine
  the zip was built on (the Swift binary is not a universal build).
- **Node.js 22 or later, already installed.** The daemon is a Node program; the
  `.app` bundles the daemon's *code* but not a Node runtime. Homebrew
  (`brew install node`) puts it at `/opt/homebrew/bin/node`, which the app finds
  automatically; an nvm install is found through a login shell. If it cannot
  find Node at all, the menu says **"Node.js not found — click to choose…"** and
  clicking opens a file picker for the `node` binary; the choice is remembered.
- **`python3`.** The `claude` launcher that drives the live draft forecast is a
  Python script. macOS ships `python3` as a stub that installs Xcode Command
  Line Tools on first use, so if the launcher prompts, run
  `xcode-select --install` once.
- Nothing else. No pnpm, no repo checkout, no Xcode project.

The zip contains everything else it needs: the daemon, the `tf-claude` launcher
at `Contents/Resources/bin/tf-claude`, and the terminal status line at
`Contents/Resources/companion/statusline.js`. `build-dist.sh` fails the build if
any of the three is missing, because a bundle without the launcher writes a
`claude()` block into the recipient's shell that silently points at nothing.

Note that **Launch at Login may not register on an ad-hoc-signed build** —
`SMAppService` wants a stable code identity. Starting the app by hand works
regardless; a Developer ID signature fixes the toggle.

On first launch the daemon **backfills their own history** from
`~/.codex/sessions` and `~/.claude/projects`, then trains a personal profile
from their calls. That takes a minute or two the first time and the menu shows
`Indexing… 120/294 files` while it happens. Those files are opened read-only and
never modified.

**Nothing is uploaded.** Everything stays on their machine. No prompt or
response text is stored, displayed or logged anywhere — only counts,
timestamps and percentiles.

---

## 4. Where the data lives, and removing it

| Path | What it is |
| --- | --- |
| `~/Library/Application Support/TokenForecaster/forecaster.db` | SQLite store: observations, file cursors, profiles, evaluations |
| `~/Library/Application Support/TokenForecaster/runtime.json` | `{ port, token, pid, startedAt }`, mode `0600` — how the app finds the daemon |
| `~/Library/Logs/TokenForecaster/companion.log` | daemon stdout/stderr, appended; truncated when it passes ~5 MB |

To remove everything:

- **Delete all derived data…** in the menu (asks for confirmation), or
- quit the app and `rm -rf ~/Library/Application\ Support/TokenForecaster ~/Library/Logs/TokenForecaster`,
  then drag `TokenForecaster.app` to the Trash.

Your Codex and Claude Code history is never touched by either.

---

## 5. Troubleshooting

**I can't see the menu bar icon.**
The app is running fine — the menu bar has no room for it. macOS gives each
status item the leftmost free slot and simply hides any item that would land
under the notch, instead of moving it. What helps:

* hold ⌘ and drag menu bar icons to rearrange them;
* quit a menu bar app you don't need, to free a slot;
* use a menu bar manager such as Ice, Bartender or Hidden Bar;
* connect an external display, which has no notch.

The dashboard stays reachable either way. About two seconds after launch the app
writes its own placement to `~/Library/Logs/TokenForecaster/companion.log`:

```
menubar: status item frame=764,945,31x37 visible=true notchSafeLeft=663 notchSafeRight=848
```

An `x` between `notchSafeLeft` and `notchSafeRight` means the slot macOS handed
us is under the notch. The item is icon-only (~24pt) by default to make that as
unlikely as possible; **Show number in menu bar** adds the compact P50 back at
the cost of extra width.

**The menu says "Daemon failed to start — see log".**
Click **Open log** in the menu (or open
`~/Library/Logs/TokenForecaster/companion.log`). The first line of every start
attempt records the exact `node … cli.js start` command that was run, so you can
paste it into a terminal and see the failure directly. **Restart daemon** in the
menu retries.

**"Node.js not found".**
Install Node 22+ (`brew install node`) and pick **Restart daemon**, or click the
**Node.js not found — click to choose…** row and select your `node` binary.
`which node` in a terminal tells you where it is. The path is stored in
`UserDefaults` key `nodePath`:

```bash
defaults write com.tokenforecaster.menubar nodePath /opt/homebrew/bin/node
```

**"Starting daemon…" never becomes "Connected".**
Give it ~25 s on a first run with a large history; the app gives up after that
and switches to the failure state. Check the log. A common cause is a half-built
workspace when running from the repo — re-run `pnpm -w build` and
`pnpm --filter @token-forecaster/companion build`.

**Port in use.**
The daemon asks the OS for a free port and publishes it in `runtime.json`, so
collisions are rare. If a stale `runtime.json` points at a port something else
now owns, quit the app, delete that file, and relaunch. To pin a port, run the
daemon yourself with `--port <n>` — the app will adopt it rather than starting
a second one.

**Two daemons.**
Cannot happen through the app: before spawning, it checks `/health` and adopts
whatever answers. If you started one in a terminal, the app will neither
duplicate nor kill it.

**Launch at login does nothing.**
`SMAppService` only works from inside the `.app` bundle, and macOS may require
approval in **System Settings › General › Login Items**.

---

## How it finds the daemon

On every poll the app reads:

```
~/Library/Application Support/TokenForecaster/runtime.json
```

```json
{ "port": 8787, "token": "<hex>", "pid": 1234, "startedAt": "<iso8601>" }
```

It then calls `http://127.0.0.1:<port>` with `Authorization: Bearer <token>`.
A connection error triggers the supervisor, which throttles itself to one spawn
attempt every 8 s.

Polling interval: **5 s** while the menu is closed, **2 s** while it is open.
Polls never overlap — an in-flight request suppresses the next tick.

### Endpoints used

| Method | Path        | Used for                                    |
| ------ | ----------- | ------------------------------------------- |
| GET    | `/health`   | everything rendered in the menu             |
| POST   | `/rebuild`  | "Rebuild profile" (⌘R)                      |
| POST   | `/pause`    | "Pause watching" / "Resume watching"        |
| GET    | `/settings` | (available in the client; not read by menu) |
| POST   | `/settings` | "Choose history directories…"               |
| POST   | `/reset`    | "Delete all derived data…" (after confirm)  |
| GET    | `/dashboard`| opened in the browser with `?token=`        |

`GET /profiles` is a dashboard-only endpoint and is intentionally not called.

## Menu contents

The menu is a glance, not a report: numbers to read belong in the dashboard,
which has room to lay them out.

1. Header — `Token Forecaster` and the state in words: `This turn 3.2k tokens ·
   running warm — past P50, under P90` / `Connected — no turn in flight` /
   `Paused` / `Indexing… 120/294 files` / `Training… rebuilding your profile` /
   `Starting daemon…` / `Daemon failed to start — see log` /
   `Node.js not found` / `Daemon not running`.
2. The numbers behind that line, while it is about a turn — `P50 2.1k · P90 8.4k
   · 12 calls`, then which chat it is: `in token-forecaster · 1 of 3 active
   chats`, and `Generic profile — not yet your own numbers` when it applies.
3. **Accuracy** — the word, and then a bar per recent finished turn, plotted
   against the forecast it was actually given. How many turns there are and how
   they landed is what the bars say, so the heading does not repeat it. The
   solid line is P50 and the dotted line is P90; bars grow up when the turn ran
   longer than forecast and down when it ran shorter, so a well-calibrated
   forecaster looks like noise around the line rather than a trend. Washed-out
   bars were forecast from the bundled generic profile. Under it, the rates and
   what they should be: `52% under P50 · 88% under P90 — calibrated is 50% and
   90%`.
4. Actions — Open dashboard (⌘D), Rebuild profile (⌘R).
5. **Settings** submenu — Show number in menu bar, Detailed terminal status
   line (adds P50/P90 and the session total to the bar in the terminal),
   Forecast from your draft (conditions the forecast on the prompt being typed
   when Claude Code was launched with `tf-claude`; rebuilds the profile),
   Wrap `claude` in new terminals (on from the first run; switching it off is
   remembered), Launch at login,
   Pause/Resume watching, Choose history directories…, Restart daemon,
   Open log, Delete all derived data…,
   Uninstall Token Forecaster…
6. Quit (⌘Q).

### Uninstalling

**Settings › Uninstall Token Forecaster…** does the whole thing: it restores your
shell startup file from the copy taken before the first edit, deletes the
profile, the index and every setting, then moves the app to the Trash (moves, not
deletes, so a mis-click is recoverable) and quits. Your Claude Code and Codex
history files are never touched — the app only ever reads them.

By hand, or after the app is already gone:

```bash
node apps/companion/dist/cli.js uninstall-shell   # restores ~/.zshrc from its backup
rm -rf ~/Library/Application\ Support/TokenForecaster   # profile, index, settings, drafts
rm -rf ~/Library/Logs/TokenForecaster
```

Deleting the app without uninstalling is safe too: the shell block it writes is a
function that falls back to the real `claude` when the launcher is missing, so
nothing breaks — you are just left with a stale block that `uninstall-shell`
removes whenever you get to it. `Settings › Delete all derived data…` does the
middle step alone.

### Several chats at once

Every Claude Code session with the status line installed reports its own live
turn, so the daemon holds one slot per session rather than one in total. The bar
features one of them and keeps featuring it until its turn finishes, then moves
to whichever turn is live and grew most recently. Alternating between sessions
several times a second — which is what a single shared slot did — says nothing
and reads as a glitch. The menu names the session on screen and counts the rest.

## Build targets

```bash
cd apps/menubar
swift build -c release   # binary only, at .build/release/TokenForecasterMenuBar
make release             # binary + .app bundle (ad-hoc signed)
make dist                # release + bundled daemon + verified + zipped
make run                 # release, then open the app
make clean               # remove .build
```

Requires only the Swift 6.1 toolchain from **Command Line Tools** — no Xcode,
never `xcodebuild`.

## Layout

```
apps/menubar/
├── Package.swift                 SwiftPM manifest (macOS 14, no dependencies)
├── Makefile                      release / dist / run / clean
├── build-app.sh                  bundle assembly + Info.plist + plutil -lint
├── build-dist.sh                 workspace build + esbuild daemon + sign + zip
├── package.json                  keeps `pnpm -r` happy inside the workspace
├── README.md
└── Sources/TokenForecasterMenuBar/
    ├── main.swift                 NSApplication entry point, .accessory policy
    ├── StatusItemController.swift NSStatusItem + NSMenu, polling, actions
    ├── DaemonSupervisor.swift     starts/owns the companion child process
    ├── DaemonClient.swift         runtime.json discovery + async HTTP calls
    ├── Models.swift               Codable API types (all fields optional)
    ├── Formatting.swift           counts, compact tokens, percents, "4m ago"
    └── LaunchAtLogin.swift        SMAppService wrapper
```

## Privacy

The app never displays, logs, or stores prompt or response text. The daemon API
returns none, and no field that could carry it is decoded. The companion log
contains only the daemon's own status lines. Only counts, timestamps,
percentiles, and directory paths chosen by the user are shown.
