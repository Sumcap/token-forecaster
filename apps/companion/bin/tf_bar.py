"""
The rendered status line, for a CLI that will not render one for us.

Claude Code runs `statusline.js` itself, once per assistant message and once a
second, and prints what it returns. Codex has no such hook, so the launcher has
to ask for the same line and paint it -- but the line itself is not reimplemented
here. `statusline.js --stream` is the very renderer Claude Code runs, reading a
payload per line and answering with a bar per line, so both CLIs show a bar
built by one piece of code from one forecast endpoint.

It runs on its own thread. The pty pump must never wait on a forecast: a
terminal that stutters while you type is worse than a terminal with no bar.
"""

import json
import os
import shutil
import subprocess
import sys
import threading
import time

BIN_DIR = os.path.dirname(os.path.abspath(__file__))


def find_node():
    """The Node to run the renderer with, or None."""
    override = os.environ.get("TOKEN_FORECASTER_NODE")
    if override:
        return override if os.path.isfile(override) else shutil.which(override)
    return shutil.which("node")


def find_statusline():
    """
    The status line the daemon ships, or None.

    Two layouts, because the launcher runs from a checkout and from inside the
    `.app`, where the bundler puts `statusline.js` in a sibling directory of
    `bin/` rather than in `dist/`.
    """
    override = os.environ.get("TOKEN_FORECASTER_STATUSLINE")
    if override:
        return override if os.path.isfile(override) else None
    for relative in (
        os.path.join("..", "dist", "statusline.js"),
        os.path.join("..", "companion", "statusline.js"),
    ):
        candidate = os.path.normpath(os.path.join(BIN_DIR, relative))
        if os.path.isfile(candidate):
            return candidate
    return None


class Bar:
    """
    A line of text, kept up to date in the background.

    `text` is whatever the renderer said last, or "" before it has said
    anything. It is read by the pty pump on every chunk of output, so it is
    only ever a plain attribute read -- no lock, no call, no waiting.
    """

    #: How often to ask for a fresh line. Claude Code's own status line is
    #: configured at two seconds; a draft that only moves every two seconds
    #: does not feel like it is following the typing, and the renderer is a
    #: loopback request to a daemon that is already running.
    INTERVAL = 0.7

    #: Consecutive renderer deaths before giving up for the session. A renderer
    #: that cannot start is a missing Node or a broken build, and respawning it
    #: every second for an afternoon helps nobody.
    MAX_RESTARTS = 3

    def __init__(self, payload: dict):
        self.payload = dict(payload)
        self.text = ""
        self.node = find_node()
        self.script = find_statusline()
        self._process = None
        self._stop = threading.Event()
        self._thread = None
        self._restarts = 0

    @property
    def available(self) -> bool:
        """
        Whether a bar can be drawn at all.

        Asked before a row is reserved: taking a row away and then leaving it
        empty is worse than not taking it.
        """
        return self.node is not None and self.script is not None

    def why_unavailable(self) -> str:
        if self.node is None:
            return "no Node 22+ on PATH"
        if self.script is None:
            return "the status line is not built (pnpm --filter @token-forecaster/companion build)"
        return ""

    # -- lifecycle -------------------------------------------------------
    def start(self) -> None:
        if not self.available or self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._kill()

    def update(self, **fields) -> None:
        """Change part of the payload -- the terminal width, as it happens."""
        self.payload.update(fields)

    # -- the renderer ----------------------------------------------------
    def _spawn(self) -> bool:
        try:
            self._process = subprocess.Popen(
                [self.node, "--no-warnings", self.script, "--stream"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf8",
                errors="replace",
                bufsize=1,
            )
            return True
        except OSError:
            self._process = None
            return False

    def _kill(self) -> None:
        process, self._process = self._process, None
        if process is None:
            return
        try:
            process.stdin.close()
        except Exception:
            pass
        try:
            process.wait(timeout=1)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass

    def _loop(self) -> None:
        while not self._stop.is_set():
            if self._process is None or self._process.poll() is not None:
                self._kill()
                if self._restarts >= self.MAX_RESTARTS or not self._spawn():
                    return
                self._restarts += 1
            line = self._exchange()
            if line is None:
                # The renderer died mid-answer. Keep the last good line on the
                # bar rather than blanking it, and try again on the next tick.
                self._kill()
            elif line:
                self.text = line
            self._stop.wait(self.INTERVAL)

    def _exchange(self):
        """One payload out, one line back. None when the renderer is gone."""
        process = self._process
        if process is None or process.stdin is None or process.stdout is None:
            return None
        try:
            process.stdin.write(json.dumps(self.payload) + "\n")
            process.stdin.flush()
        except (OSError, ValueError):
            return None
        try:
            line = process.stdout.readline()
        except (OSError, ValueError):
            return None
        if line == "":
            return None  # stdout closed: the renderer exited
        return line.rstrip("\r\n")


def codex_home() -> str:
    """
    Where Codex keeps its sessions.

    `CODEX_HOME` is the variable Codex itself reads, so a machine that has
    moved it is followed rather than guessed at.
    """
    override = os.environ.get("CODEX_HOME")
    if override and override.strip():
        return os.path.expanduser(override.strip())
    return os.path.join(os.path.expanduser("~"), ".codex")


def note(program: str, message: str) -> None:
    """One line on stderr, before the child takes the terminal over."""
    sys.stderr.write(f"{program}: {message}\n")
    sys.stderr.flush()
    # Given a moment to be read: the TUI is about to redraw over it.
    time.sleep(0.4)
