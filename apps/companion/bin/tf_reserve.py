"""
Keep the bottom row of the terminal for the forecaster while a TUI runs above.

Claude Code asks for a status line and renders whatever a command prints.
Codex does not: `tui.status_line` is a list of *built-in* item names picked
through `/statusline`, anything else is answered with "Ignored invalid status
line item", and no hook, plugin or config key paints a line of our own. So for
Codex the only place the bar can come from is the thing already sitting between
the keyboard and the CLI -- the launcher -- and it has to reserve the row itself.

The technique is the one a status bar has always used. The child is told the
terminal is one row shorter than it is, every scrolling region it sets is
clamped to that shorter screen, and the row underneath is painted by us. The
child never addresses the bottom row and nothing it prints can scroll it away.

Two details are the whole trick:

* **The region is rewritten, not just set once.** Codex drives DECSTBM itself
  for its inline viewport, and a bare `ESC[r` -- reset to the full screen --
  would hand our row back and let the next line of output scroll over it. Every
  region the child sets passes through {@link ReservedRow.filter} on the way out.
* **The top margin is left alone.** Terminals only copy a scrolled-off line
  into the scrollback buffer when the region starts at row one, so clamping the
  bottom keeps history working; moving the top would silently throw away the
  session as it scrolled.

Nothing here knows what the bar says. It takes a rendered string and puts it on
a row, which is what makes it testable without a daemon, a forecast or a pty.
"""

import re

#: Save and restore the cursor (DECSC/DECRC). Painting has to be invisible to
#: the child: it is drawing in the same terminal and was not consulted.
SAVE = "\x1b7"
RESTORE = "\x1b8"

#: DECSTBM, with both parameters optional -- `ESC[r`, `ESC[5r`, `ESC[5;40r`.
#: Private sequences (`ESC[?...r`, XTRESTORE) do not match and are left alone.
SCROLL_REGION = re.compile(rb"\x1b\[([0-9]*)(?:;([0-9]*))?r")

#: A trailing fragment that could still turn into a DECSTBM once the rest of it
#: arrives. Held back rather than forwarded, because half a sequence forwarded
#: is a region that escapes the clamp.
PARTIAL = re.compile(rb"\x1b(?:\[[0-9;]*)?$")

#: Longest fragment worth waiting on. Nothing real is close; a stream that is
#: not escape sequences at all must not be able to stall output for ever.
MAX_PARTIAL = 32

#: Below this there is no room to give a row away, and a one-line-shorter
#: session is worse than no forecast.
MIN_ROWS = 5


def visible_width(text: str) -> int:
    """Characters `text` occupies on screen, ignoring escape sequences."""
    return len(re.sub(r"\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])", "", text))


def fit(text: str, columns: int) -> str:
    """
    `text` cut to `columns` visible characters, escape sequences intact.

    A bar wider than the terminal is not a cosmetic problem: it wraps onto a
    row the child believes it owns, and the two draw over each other for the
    rest of the session. Colour is kept while cutting -- dropping a `[0m`
    would leak the bar's styling into whatever is drawn next.
    """
    if columns <= 0:
        return ""
    out: list[str] = []
    shown = 0
    i = 0
    while i < len(text):
        if text[i] == "\x1b":
            match = re.match(r"\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])", text[i:])
            if match:
                out.append(match.group(0))
                i += len(match.group(0))
                continue
        if shown >= columns:
            # Past the edge: keep scanning for escapes so the styling still
            # closes, but stop adding characters.
            i += 1
            continue
        out.append(text[i])
        shown += 1
        i += 1
    return "".join(out)


class ReservedRow:
    """
    The bottom row of the terminal, held for the bar.

    Every method returns bytes for the terminal and writes nothing itself, so
    the caller keeps one output path and the tests need no terminal at all.
    """

    def __init__(self, rows: int, columns: int):
        self.rows = rows
        self.columns = columns
        self.text = ""
        self._pending = b""
        #: Child output may have erased the row even when its text has not
        #: changed. The next quiet repaint has to restore it rather than
        #: mistaking equal strings for proof that it is still on screen.
        self._dirty = False
        #: Whether a region was ever set. A terminal that never gave a row up
        #: must not have its last line cleared on the way out.
        self.entered = False

    # -- geometry --------------------------------------------------------
    @property
    def usable(self) -> bool:
        """Whether this terminal is big enough to give a row away."""
        return self.rows >= MIN_ROWS and self.columns >= 20

    @property
    def child_rows(self) -> int:
        """The height the child is told about: everything except our row."""
        return self.rows - 1

    def child_size(self) -> tuple[int, int]:
        """`(rows, columns)` for the pty the child runs in."""
        return (self.child_rows, self.columns)

    # -- lifecycle -------------------------------------------------------
    def enter(self) -> bytes:
        """
        Claim the row.

        The cursor is saved around the region change because DECSTBM homes it,
        and homing the cursor before the child has drawn anything would start
        the session on top of whatever was already on the screen.
        """
        self.entered = True
        return f"{SAVE}\x1b[1;{self.child_rows}r{RESTORE}".encode() + self.repaint()

    def resize(self, rows: int, columns: int) -> bytes:
        """Take the new size, re-clamp the region, and redraw the bar."""
        self.rows = rows
        self.columns = columns
        if not self.usable:
            # Shrunk below the point where a row can be spared. Give the region
            # back before the child is told it has the whole screen again, or
            # it would draw inside a region nothing is maintaining any more.
            return self.leave()
        return self.enter()

    def leave(self) -> bytes:
        """
        Give the row back.

        The region goes to the full screen first, since DECSTBM homes the
        cursor and the clear has to happen after that, not before it. A row
        that was never claimed is left exactly as it was found: clearing the
        bottom line of a terminal this never drew on would delete somebody
        else's output.
        """
        if not self.entered:
            return b""
        self.entered = False
        return f"\x1b[r\x1b[{self.rows};1H\x1b[2K".encode()

    # -- painting --------------------------------------------------------
    def paint(self, text: str) -> bytes:
        """The bar, if it changed since the last call. Empty bytes if not."""
        if text == self.text and not self._dirty:
            return b""
        self.text = text
        return self.repaint()

    def repaint(self) -> bytes:
        """The bar, whether or not it changed -- after a resize or a redraw."""
        if not self.usable:
            return b""
        self._dirty = False
        body = fit(self.text, self.columns)
        return f"{SAVE}\x1b[{self.rows};1H\x1b[2K{body}{RESTORE}".encode()

    # -- the child's output ----------------------------------------------
    def filter(self, chunk: bytes) -> bytes:
        """
        `chunk` with every scrolling region clamped to the child's screen.

        A DECSTBM split across two reads is held until the rest of it arrives:
        forwarded in halves it would miss the clamp, and the half that got
        through would set a region over our row.
        """
        if not self.usable:
            return chunk
        data = self._pending + chunk
        self._pending = b""
        held = PARTIAL.search(data)
        if held and len(data) - held.start() <= MAX_PARTIAL:
            self._pending = data[held.start() :]
            data = data[: held.start()]
        filtered = SCROLL_REGION.sub(self._clamp, data)
        if filtered:
            # Anything the child puts on the terminal could include a clear or
            # a cursor-addressed write over our row. Most chunks are followed
            # by an immediate repaint, but the repaint throttle deliberately
            # skips some. Remember those so the next quiet tick restores the
            # bar even if the rendered text itself has not changed.
            self._dirty = True
        return filtered

    def flush(self) -> bytes:
        """Anything held back waiting for the rest of a sequence."""
        pending, self._pending = self._pending, b""
        return pending

    def _clamp(self, match: "re.Match[bytes]") -> bytes:
        top = int(match.group(1)) if match.group(1) else 1
        # An omitted bottom means "the last row" -- of the screen the child was
        # told it has, which is the one row short of the real one.
        bottom = int(match.group(2)) if match.group(2) else self.child_rows
        bottom = min(bottom, self.child_rows)
        if top >= bottom:
            top = 1
        return f"\x1b[{top};{bottom}r".encode()
