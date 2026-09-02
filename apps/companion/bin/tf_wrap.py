"""
The launcher both CLIs are started through.

Neither Claude Code nor Codex will tell anything outside itself what is in the
composer. Claude Code's status-line payload has no field for it and typing is
not an update trigger; Codex has no status-line hook at all. So the only place
a forecast for the prompt *being written* can come from is something sitting
between the keyboard and the CLI, and this is that something: it allocates a
pty, runs the CLI inside it, forwards the keystrokes, and keeps a model of the
line being edited. Every change is reduced to *counts* -- length, words, code
fences, urls, paths, question or imperative -- and published to a private file
the status line reads.

What it never does: write down, log, transmit or otherwise keep the text. The
buffer lives in memory, is reduced to numbers, and is dropped the moment enter
is pressed. It sees only what is typed into the one session it wraps -- it is a
wrapper around one process, not a system-wide input tap.

The two CLIs differ in one place. Claude Code renders the bar itself, so for
`tf-claude` this is a pipe and nothing more. Codex renders only its own
built-in items, so `tf-codex` also hands down a {@link tf_reserve.ReservedRow}:
the child is given a screen one row shorter than the real one and the launcher
paints the last row. Everything above that -- the buffer, the counts, the file,
the pty, the console -- is this file, once.

Windows has no pty to allocate, so there the same job is done through a pseudo
console (ConPTY), which Python reaches through `pywinpty`. Without it the
launcher steps aside and starts the CLI directly: the session is exactly as it
would have been, minus the draft forecast, which is the one failure this
program is allowed to have.
"""

import atexit
import json
import os
import shutil
import signal
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tf_draft import estimate_tokens, features  # noqa: E402
from tf_paths import ensure_draft_dir, process_alive  # noqa: E402

WINDOWS = os.name == "nt"

#: Bracketed paste, which the terminal wraps around anything not typed by hand.
PASTE_START = "\x1b[200~"
PASTE_END = "\x1b[201~"

#: Smallest gap between two repaints of the bar. The child redraws at animation
#: rate and every chunk it sends could have cleared the screen out from under
#: us, so the bar is rewritten after each one -- but not more often than an eye
#: can tell, because each repaint is bytes down the same pipe.
REPAINT_INTERVAL = 0.05


class Draft:
    """
    The line being edited, as a model good enough to count.

    It is not a reimplementation of either composer and does not need to be:
    the numbers it feeds are buckets (under 80 characters, under 300, a code
    fence present or not), so being a character or two off never changes the
    forecast, and enter resets everything anyway.
    """

    #: Longest partial escape sequence worth holding on to. Nothing real is
    #: anywhere near this; a stream that is not escape sequences at all must
    #: not be able to grow the buffer without bound.
    MAX_PENDING = 128

    def __init__(self, path: str):
        self.path = path
        self.buffer: list[str] = []
        self.pending = ""
        self.in_paste = False
        self.written = ""

    # -- the keystroke state machine ------------------------------------
    def feed(self, data) -> None:
        text = data if isinstance(data, str) else data.decode("utf8", "replace")
        # A read can end in the middle of an escape sequence — one byte at a
        # time is the normal case on Windows — and half a sequence parsed as
        # text would put an ANSI code into the count.
        text = self.pending + text
        self.pending = ""
        i = 0
        while i < len(text):
            ch = text[i]
            rest = text[i:]
            # Half a paste marker, waiting on the rest of itself. Inside a
            # paste the escape branch below is skipped, so without this the
            # tail of `\x1b[201~` would be counted as five typed characters.
            if ch == "\x1b" and len(rest) < 6 and (
                PASTE_START.startswith(rest) or PASTE_END.startswith(rest)
            ):
                self.pending = rest
                return
            # Bracketed paste: both CLIs turn large pastes into attachments,
            # but the characters are still part of the prompt's size.
            if rest.startswith(PASTE_START):
                self.in_paste = True
                i += 6
                continue
            if rest.startswith(PASTE_END):
                self.in_paste = False
                i += 6
                continue
            if ch == "\x1b" and not self.in_paste:
                # Escape sequence — arrow keys, meta-enter, mouse reports.
                # Meta-enter inserts a newline rather than submitting.
                if rest.startswith("\x1b\r") or rest.startswith("\x1b\n"):
                    self.buffer.append("\n")
                    i += 2
                    continue
                length = self._skip_escape(rest)
                if length is None:
                    # Not all here yet. Wait for the rest of it, unless waiting
                    # has stopped being plausible.
                    self.pending = rest if len(rest) <= self.MAX_PENDING else ""
                    return
                i += length
                continue
            if ch in ("\r", "\n") and not self.in_paste:
                # Submitted (or cancelled into nothing): the draft is over.
                self.buffer.clear()
                i += 1
                continue
            if ch in ("\x7f", "\x08"):
                if self.buffer:
                    self.buffer.pop()
                i += 1
                continue
            if ch == "\x03" or ch == "\x15":  # ctrl-c, ctrl-u
                self.buffer.clear()
                i += 1
                continue
            if ch == "\x17":  # ctrl-w
                while self.buffer and self.buffer[-1].isspace():
                    self.buffer.pop()
                while self.buffer and not self.buffer[-1].isspace():
                    self.buffer.pop()
                i += 1
                continue
            if ch == "\t" or ch >= " " or ch == "\n":
                self.buffer.append(ch)
            i += 1

    @staticmethod
    def _skip_escape(rest: str):
        """
        Length of the escape sequence at the head of `rest`.

        None when the sequence has not arrived in full, which is the caller's
        cue to hold what it has and wait for more.
        """
        if len(rest) < 2:
            return None
        if rest[1] == "[":
            j = 2
            while j < len(rest) and not ("@" <= rest[j] <= "~"):
                j += 1
            if j >= len(rest):
                return None
            return j + 1
        return 2

    # -- publishing ------------------------------------------------------
    def publish(self) -> None:
        """Write the counts, atomically, and only when they changed."""
        text = "".join(self.buffer)
        shape = features(text)
        tokens = estimate_tokens(text.strip())
        encoded = json.dumps([shape, tokens], sort_keys=True)
        if encoded == self.written:
            return
        self.written = encoded
        payload = json.dumps(
            {"updatedAt": int(time.time() * 1000), "features": shape, "tokens": tokens}
        )
        try:
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.path))
            with os.fdopen(fd, "w") as handle:
                handle.write(payload)
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except OSError:
            # A status line that cannot read a draft simply forecasts without
            # one. Never let bookkeeping take the session down.
            pass


def sweep_dead_drafts() -> None:
    """Drop drafts belonging to launchers that are no longer running."""
    directory = ensure_draft_dir()
    try:
        names = os.listdir(directory)
    except OSError:
        return
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            pid = int(name[: -len(".json")])
        except ValueError:
            continue
        if process_alive(pid):
            continue
        try:
            os.unlink(os.path.join(directory, name))
        except OSError:
            pass


def passthrough(argv) -> int:
    """
    Hand the session over unchanged.

    Used when there is nothing to watch (`claude -p …`, `codex exec …`, a
    heredoc, a pipeline) and when the pseudo console is unavailable. On POSIX
    this replaces the process, so the exit code and the signals are the CLI's
    own; Windows has no exec that a shell will wait for, so the child is run in
    the console it already has and its exit code is passed back up.
    """
    if WINDOWS:
        import subprocess

        return subprocess.run(argv).returncode
    os.execvp(argv[0], argv)
    return 127  # unreachable unless exec fails


def terminal_size():
    """
    The real terminal, as `(rows, columns)`.

    The terminal is asked before the environment: `COLUMNS` and `LINES` are
    exported by some shells and go stale the moment a window is resized, and
    `shutil.get_terminal_size` believes them first. A stale height here is not
    a cosmetic problem — it is the bar drawn on a row the child also thinks it
    owns.
    """
    for stream in (sys.__stdout__, sys.__stdin__):
        try:
            size = os.get_terminal_size(stream.fileno())
            if size.lines > 0 and size.columns > 0:
                return (size.lines, size.columns)
        except (OSError, ValueError, AttributeError):
            continue
    size = shutil.get_terminal_size((80, 24))
    return (size.lines, size.columns)


# ---------------------------------------------------------------- POSIX --
def run_posix(argv, draft: Draft, row=None, bar=None) -> int:
    import errno
    import fcntl
    import pty
    import select
    import struct
    import termios
    import tty

    def child_winsize():
        """The size to give the child: one row short when the bar has one."""
        if row is not None and row.usable:
            rows, columns = row.child_size()
            return struct.pack("HHHH", rows, columns, 0, 0)
        try:
            return fcntl.ioctl(sys.stdin.fileno(), termios.TIOCGWINSZ, b"\0" * 8)
        except OSError:
            return None

    def set_winsize(fd: int) -> None:
        size = child_winsize()
        if size is None:
            return
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, size)
        except OSError:
            pass

    pid, master = pty.fork()
    if pid == 0:
        os.execvp(argv[0], argv)
        os._exit(127)  # unreachable unless exec fails

    out = sys.stdout.fileno()

    def resized(*_):
        if row is None:
            set_winsize(master)
            return
        rows, columns = terminal_size()
        if bar is not None:
            bar.update(columns=columns)
        # The child's size first, then the region, so a redraw triggered by the
        # new size lands inside a region that already matches it.
        bytes_out = row.resize(rows, columns)
        set_winsize(master)
        try:
            os.write(out, bytes_out)
        except OSError:
            pass

    set_winsize(master)
    signal.signal(signal.SIGWINCH, resized)

    restore = None
    if sys.stdin.isatty():
        restore = termios.tcgetattr(sys.stdin.fileno())
        tty.setraw(sys.stdin.fileno())

    if row is not None and row.usable:
        os.write(out, row.enter())

    last_paint = 0.0
    stdin_open = True
    watched = [master, sys.stdin.fileno()]
    try:
        while True:
            try:
                readable, _, _ = select.select(watched, [], [], 0.2)
            except OSError as error:
                if error.errno == errno.EINTR:
                    continue  # a window resize interrupted the wait
                raise
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                if row is None:
                    os.write(out, data)
                else:
                    # Anything the child sends could have cleared the screen,
                    # so the bar is put back after it rather than left to
                    # notice it is gone.
                    os.write(out, row.filter(data))
                    now = time.monotonic()
                    if now - last_paint >= REPAINT_INTERVAL:
                        last_paint = now
                        if bar is not None:
                            row.text = bar.text
                        os.write(out, row.repaint())
            if stdin_open and sys.stdin.fileno() in readable:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    # Our input ended, but the child has not: stop watching and
                    # keep pumping its output until it is done.
                    stdin_open = False
                    watched = [master]
                    continue
                draft.feed(data)
                draft.publish()
                os.write(master, data)
            if row is not None and bar is not None and master not in readable:
                # Nothing arrived, so nothing was painted over: this is the
                # tick that lets the number move while the reader is typing
                # and the child has no reason to redraw.
                os.write(out, row.paint(bar.text))
    finally:
        if row is not None:
            try:
                # Whatever was held back waiting for the rest of a sequence is
                # the child's last word; it belongs on the screen either way.
                os.write(out, row.flush() + row.leave())
            except OSError:
                pass
        if restore is not None:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSAFLUSH, restore)

    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0


# -------------------------------------------------------------- Windows --
STD_INPUT_HANDLE = -10
STD_OUTPUT_HANDLE = -11
ENABLE_PROCESSED_INPUT = 0x0001
ENABLE_LINE_INPUT = 0x0002
ENABLE_ECHO_INPUT = 0x0004
ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200
ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004


class ConsoleRawMode:
    """
    The console in the state a full-screen program expects, and back again.

    Windows consoles arrive cooked: they echo, they buffer whole lines, and
    they turn ctrl-c into an event of their own. Virtual terminal input makes
    the arrow keys arrive as the same escape sequences every other platform
    sends, which is what both CLIs and the buffer above are written for.
    """

    def __init__(self):
        import ctypes
        from ctypes import wintypes

        self.ctypes = ctypes
        self.wintypes = wintypes
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # Every signature is declared: ctypes assumes a 32-bit return value,
        # and a console handle is 64 bits. Left to infer, GetStdHandle would
        # hand back a truncated handle that GetConsoleMode simply rejects, and
        # the console would stay in line mode with no error to explain it.
        self.kernel32.GetStdHandle.restype = wintypes.HANDLE
        self.kernel32.GetStdHandle.argtypes = (wintypes.DWORD,)
        self.kernel32.GetConsoleMode.restype = wintypes.BOOL
        self.kernel32.GetConsoleMode.argtypes = (wintypes.HANDLE, wintypes.LPDWORD)
        self.kernel32.SetConsoleMode.restype = wintypes.BOOL
        self.kernel32.SetConsoleMode.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        self.saved = {}

    def _handle(self, which):
        # GetStdHandle takes an unsigned DWORD; the constants are written the
        # way the SDK writes them, as small negative numbers.
        return self.kernel32.GetStdHandle(which & 0xFFFFFFFF)

    def _mode(self, handle):
        mode = self.wintypes.DWORD()
        if not self.kernel32.GetConsoleMode(handle, self.ctypes.byref(mode)):
            return None
        return mode.value

    def __enter__(self):
        for which, clear, add in (
            (
                STD_INPUT_HANDLE,
                ENABLE_ECHO_INPUT | ENABLE_LINE_INPUT | ENABLE_PROCESSED_INPUT,
                ENABLE_VIRTUAL_TERMINAL_INPUT,
            ),
            (STD_OUTPUT_HANDLE, 0, ENABLE_VIRTUAL_TERMINAL_PROCESSING),
        ):
            handle = self._handle(which)
            current = self._mode(handle)
            if current is None:
                continue  # redirected, not a console: nothing to put back
            self.saved[which] = (handle, current)
            self.kernel32.SetConsoleMode(handle, (current & ~clear) | add)
        return self

    def __exit__(self, *_):
        for handle, mode in self.saved.values():
            self.kernel32.SetConsoleMode(handle, mode)
        return False


def run_windows(argv, draft: Draft, program: str, row=None, bar=None) -> int:
    try:
        from winpty import PtyProcess  # type: ignore[import-not-found]
    except Exception:
        sys.stderr.write(
            f"{program}: pywinpty is not installed, so this session has no draft "
            f"forecast. Starting {argv[0]} unchanged.\n"
            "           Fix it with:  pip install pywinpty\n"
        )
        return passthrough(argv)

    rows, columns = terminal_size()
    if row is not None and row.usable:
        rows, columns = row.child_size()
    with ConsoleRawMode():
        try:
            process = PtyProcess.spawn(argv, dimensions=(rows, columns))
        except Exception as error:
            # Before anything has started is the one point where falling back
            # is still free. The console is restored on the way out of the
            # `with`, so the CLI gets it in the state it expects.
            spawn_error = error
            process = None
        if process is not None:
            return _pump_windows(process, draft, row, bar)

    sys.stderr.write(
        f"{program}: could not open a pseudo console ({spawn_error}), so this session "
        f"has no draft forecast. Starting {argv[0]} unchanged.\n"
    )
    return passthrough(argv)


def _pump_windows(process, draft: Draft, row=None, bar=None) -> int:
    """Keystrokes in, output out, until the child is done."""
    import threading

    def write_out(data) -> None:
        if not data:
            return
        sys.stdout.write(data if isinstance(data, str) else data.decode("utf8", "replace"))
        sys.stdout.flush()

    def pump_input():
        stream = sys.stdin.buffer
        while True:
            try:
                data = stream.read(1)
            except (OSError, ValueError):
                return
            if not data:
                return
            draft.feed(data)
            draft.publish()
            try:
                process.write(data.decode("utf8", "replace"))
            except Exception:
                return

    def pump_resize():
        last = terminal_size()
        while True:
            time.sleep(0.5)
            current = terminal_size()
            if current == last:
                continue
            last = current
            if row is not None:
                if bar is not None:
                    bar.update(columns=current[1])
                write_out(row.resize(current[0], current[1]))
                if row.usable:
                    current = row.child_size()
            try:
                process.setwinsize(current[0], current[1])
            except Exception:
                return

    def pump_bar():
        """The tick that moves the number while nothing is being drawn."""
        while True:
            time.sleep(0.2)
            try:
                write_out(row.paint(bar.text))
            except Exception:
                return

    pumps = [pump_input, pump_resize]
    if row is not None and bar is not None:
        pumps.append(pump_bar)
    # All daemons: the child's output is what decides when this program is
    # over, and a thread blocked on a keystroke must not hold that up.
    for pump in pumps:
        threading.Thread(target=pump, daemon=True).start()

    if row is not None and row.usable:
        write_out(row.enter())

    last_paint = 0.0
    try:
        while True:
            try:
                chunk = process.read(65536)
            except EOFError:
                break
            except Exception:
                break
            if chunk:
                if row is None:
                    write_out(chunk)
                else:
                    write_out(row.filter(chunk.encode("utf8", "replace")))
                    now = time.monotonic()
                    if now - last_paint >= REPAINT_INTERVAL:
                        last_paint = now
                        write_out(row.repaint())
                continue
            if not process.isalive():
                break
            # The read does not block, so without this the wait for the next
            # byte of output would be a spin at one whole core.
            time.sleep(0.005)
    finally:
        if row is not None:
            write_out(row.leave())

    try:
        process.wait()
    except Exception:
        pass
    return process.exitstatus or 0


def run(program: str, child_env: str, child_default: str, reserve_row: bool = False) -> int:
    """
    Start `child_default` with a draft forecast attached.

    `program` names this launcher in its own error messages, `child_env`
    overrides which binary is started, and `reserve_row` says whether the bar
    has to be painted here -- true for Codex, which renders only its own
    built-in status items, false for Claude Code, which renders ours.
    """
    child = os.environ.get(child_env) or child_default
    resolved = shutil.which(child)
    if resolved is None:
        print(f"{program}: cannot find '{child}' on PATH", file=sys.stderr)
        return 127
    # POSIX hands the name to execvp and lets it search; Windows has to be told
    # the file, since CreateProcess does no PATH lookup of its own.
    argv = [resolved if WINDOWS else child] + sys.argv[1:]

    sweep_dead_drafts()
    path = os.path.join(ensure_draft_dir(), f"{os.getpid()}.json")
    os.environ["TOKEN_FORECASTER_DRAFT"] = path
    draft = Draft(path)

    def cleanup() -> None:
        try:
            os.unlink(path)
        except OSError:
            pass

    atexit.register(cleanup)

    # A terminal closing sends SIGHUP, which would otherwise leave a draft file
    # behind. (The status line ignores stale ones anyway, but a file with your
    # last draft's dimensions has no business outliving the session.) Windows
    # has neither SIGHUP nor a handler that survives the console going away, so
    # there the sweep at the next start is what cleans up.
    def hang_up(signum, _frame):
        cleanup()
        signal.signal(signum, signal.SIG_DFL)
        os.kill(os.getpid(), signum)

    for name in ("SIGHUP", "SIGTERM"):
        sig = getattr(signal, name, None)
        if sig is not None and not WINDOWS:
            signal.signal(sig, hang_up)

    # Nothing to watch when the input is not a terminal: `claude -p …`,
    # `codex exec …`, a heredoc, a pipeline. Hand the process straight over
    # rather than putting a pty in the middle of someone's script, where it
    # would change how stdin ends and what the exit code means.
    if not sys.stdin.isatty():
        cleanup()
        return passthrough(argv)

    row = None
    bar = None
    if reserve_row:
        row, bar = _make_bar(program)

    if bar is not None:
        bar.start()
    try:
        if WINDOWS:
            return run_windows(argv, draft, program, row, bar)
        return run_posix(argv, draft, row, bar)
    finally:
        if bar is not None:
            bar.stop()
        cleanup()


def _make_bar(program: str):
    """
    The reserved row and the renderer that fills it, or `(None, None)`.

    A row is only taken when there is something to put in it. Losing the
    forecast is a bad afternoon; a session one row shorter with nothing to show
    for it is a worse one, so every reason not to draw is a reason not to
    reserve, and each of them says so once before the TUI takes the screen.
    """
    from tf_bar import Bar, codex_home, note
    from tf_reserve import ReservedRow

    rows, columns = terminal_size()
    row = ReservedRow(rows, columns)
    if not row.usable:
        note(program, f"terminal is only {rows} rows, so this session has no forecast bar")
        return (None, None)

    bar = Bar(
        {
            "provider": "openai",
            "codexHome": codex_home(),
            "since": int(time.time() * 1000),
            "columns": columns,
            # Named the way Claude Code names it, so one payload shape serves
            # both CLIs and the daemon labels a Codex session the same way.
            "cwd": os.getcwd(),
        }
    )
    if not bar.available:
        note(program, f"{bar.why_unavailable()}, so this session has no forecast bar")
        return (None, None)
    return (row, bar)
