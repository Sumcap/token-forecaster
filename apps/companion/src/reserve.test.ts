import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { findPython } from "./python.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
const [PYTHON, ...PYTHON_ARGS] = (findPython() ?? ["python3"]) as [string, ...string[]];

/**
 * The reserved row is the whole of the Codex integration.
 *
 * Codex has no status-line hook — `tui.status_line` takes only Codex's own
 * built-in items — so `bin/tf-codex` gives Codex a screen one row shorter than
 * the terminal and paints the last row itself. Two things make that safe, and
 * both are silent when they break: every scrolling region Codex sets has to be
 * clamped to the shorter screen, or the next line of output scrolls the bar
 * away, and the bar has to be cut to the terminal's width, or it wraps onto a
 * row Codex believes it owns and the two draw over each other for the rest of
 * the session.
 */
function run(body: string[]): unknown {
  const out = execFileSync(
    PYTHON,
    [
      ...PYTHON_ARGS,
      "-c",
      ["import json, sys", `sys.path.insert(0, ${JSON.stringify(BIN)})`, "import tf_reserve", ...body].join(
        "\n",
      ),
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(out) as unknown;
}

/** Run the child's bytes through the filter and get back what the terminal sees. */
function filtered(rows: number, chunks: string[]): string[] {
  return run([
    `row = tf_reserve.ReservedRow(${rows}, 120)`,
    `chunks = json.loads(${JSON.stringify(JSON.stringify(chunks))})`,
    "out = [row.filter(c.encode()).decode('utf8', 'replace') for c in chunks]",
    "out.append(row.flush().decode('utf8', 'replace'))",
    "print(json.dumps(out))",
  ]) as string[];
}

describe("clamping the child's scrolling region", () => {
  it("takes the bottom row away from every region the child sets", () => {
    // `ESC[r` is the one that matters: it means "the whole screen", and the
    // child's whole screen is one row shorter than the real one. Left alone it
    // hands the bar's row back and the next scroll writes over it.
    expect(filtered(45, ["[r", "[1;45r", "[8;45r", "[1;20r"])).toEqual([
      "[1;44r",
      "[1;44r",
      "[8;44r",
      "[1;20r",
      "",
    ]);
  });

  it("leaves the top margin alone, because that is what keeps the scrollback", () => {
    // A terminal only copies a scrolled-off line into its history when the
    // region starts at row one. Clamping the bottom keeps that; moving the top
    // would throw the session away as it scrolled, with nothing to show for it.
    const [out] = filtered(45, ["[8;45r"]);
    expect(out).toBe("[8;44r");
  });

  it("holds a region split across two reads until the rest of it arrives", () => {
    // Forwarded in halves it would miss the clamp entirely, and the half that
    // got through would set a region over the bar's row.
    expect(filtered(45, ["text[1;", "45r more"])).toEqual(["text", "[1;44r more", ""]);
    expect(filtered(45, ["", "[r"])).toEqual(["", "[1;44r", ""]);
  });

  it("never holds a fragment for ever", () => {
    // A stream that is not escape sequences at all must not be able to stall
    // output; anything past the longest real sequence goes straight through.
    const long = `[${"1;".repeat(40)}`;
    const [out] = filtered(45, [long]);
    expect(out).toBe(long);
  });

  it("leaves private sequences alone", () => {
    // `ESC[?...r` is XTRESTORE, not a scrolling region, and rewriting it would
    // change what the child asked the terminal to put back.
    expect(filtered(45, ["[?1049r[?25h"])).toEqual(["[?1049r[?25h", ""]);
  });

  it("passes everything through untouched on a terminal too small to share", () => {
    // Four rows minus one for a bar is not a session anybody wants. A bar is
    // worth having; a row is worth more.
    expect(filtered(4, ["[r"])).toEqual(["[r", ""]);
  });
});

describe("the row itself", () => {
  it("tells the child about a screen one row shorter than the terminal", () => {
    expect(run(["print(json.dumps(tf_reserve.ReservedRow(45, 120).child_size()))"])).toEqual([
      44, 120,
    ]);
  });

  it("saves and restores the cursor around every write", () => {
    // The child is drawing in the same terminal and was not consulted: a bar
    // that moved the cursor would corrupt whatever it was in the middle of.
    const painted = run([
      "row = tf_reserve.ReservedRow(45, 120)",
      "print(json.dumps(row.paint('bar').decode()))",
    ]) as string;
    expect(painted.startsWith("7")).toBe(true);
    expect(painted.endsWith("8")).toBe(true);
    expect(painted).toContain("[45;1H");
  });

  it("draws nothing twice, so an unchanged bar costs no bytes", () => {
    expect(
      run([
        "row = tf_reserve.ReservedRow(45, 120)",
        "first = row.paint('bar')",
        "print(json.dumps([len(first) > 0, len(row.paint('bar')) == 0, len(row.paint('other')) > 0]))",
      ]),
    ).toEqual([true, true, true]);
  });

  it("restores an unchanged bar after child output may have erased it", () => {
    expect(
      run([
        "row = tf_reserve.ReservedRow(45, 120)",
        "row.paint('bar')",
        "row.filter(b'child redraw')",
        "restored = row.paint('bar')",
        "print(json.dumps([len(restored) > 0, len(row.paint('bar')) == 0]))",
      ]),
    ).toEqual([true, true]);
  });

  it("gives the row back when the session ends", () => {
    const left = run([
      "row = tf_reserve.ReservedRow(45, 120)",
      "row.enter()",
      "print(json.dumps(row.leave().decode()))",
    ]) as string;
    // The full screen first: DECSTBM homes the cursor, so the clear has to
    // come after it, not before.
    expect(left).toBe("[r[45;1H[2K");
  });

  it("refuses a terminal with no room to spare", () => {
    expect(
      run([
        "print(json.dumps([tf_reserve.ReservedRow(r, 120).usable for r in (3, 4, 5, 45)]))",
      ]),
    ).toEqual([false, false, true, true]);
  });
});

describe("cutting the bar to the terminal", () => {
  it("counts what is on screen, not what is in the string", () => {
    expect(
      run([
        "print(json.dumps(tf_reserve.visible_width('\\x1b[36m\\u25c6\\x1b[0m prompt 9')))",
      ]),
    ).toBe(10);
  });

  it("cuts to the width and still closes the colour", () => {
    // A bar wider than the terminal wraps onto the row the child owns. Dropping
    // the reset while cutting would leak this bar's styling into whatever the
    // child draws next.
    const cut = run([
      "print(json.dumps(tf_reserve.fit('\\x1b[36mabcdefghij\\x1b[0m', 4)))",
    ]) as string;
    expect(cut).toBe("[36mabcd[0m");
  });

  it("leaves a bar that already fits exactly as it was", () => {
    expect(run(["print(json.dumps(tf_reserve.fit('\\x1b[2mshort\\x1b[0m', 40)))"])).toBe(
      "[2mshort[0m",
    );
  });
});

describe("giving the terminal back", () => {
  it("clears nothing on a terminal it never drew on", () => {
    // The bottom line of a terminal this never claimed belongs to whatever
    // printed it, and clearing it on the way out would delete that.
    expect(
      run([
        "row = tf_reserve.ReservedRow(3, 120)",
        "print(json.dumps(row.leave().decode()))",
      ]),
    ).toBe("");
  });

  it("hands the region back when the window shrinks too far to share", () => {
    // Below five rows the child is given the whole screen again, so the region
    // it was drawing inside has to go with it.
    expect(
      run([
        "row = tf_reserve.ReservedRow(45, 120)",
        "row.enter()",
        "print(json.dumps([row.resize(4, 120).decode(), row.usable]))",
      ]),
    ).toEqual(["\u001b[r\u001b[4;1H\u001b[2K", false]);
  });

  it("re-claims the row at the new size when the window grows", () => {
    const out = run([
      "row = tf_reserve.ReservedRow(45, 120)",
      "row.enter()",
      "print(json.dumps(row.resize(60, 100).decode()))",
    ]) as string;
    expect(out).toContain("\u001b[1;59r");
    expect(out).toContain("\u001b[60;1H");
  });
});
