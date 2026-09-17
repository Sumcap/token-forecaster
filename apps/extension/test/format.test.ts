import { describe, expect, it } from "vitest";
import { formatCompact, formatExact, formatUsd, STRINGS } from "../src/lib/format.js";

describe("formatCompact", () => {
  it("keeps small counts exact and abbreviates larger ones", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(391)).toBe("391");
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(1_000)).toBe("1k");
    expect(formatCompact(1_700)).toBe("1.7k");
    expect(formatCompact(9_949)).toBe("9.9k");
    expect(formatCompact(30_222)).toBe("30k");
    expect(formatCompact(200_000)).toBe("200k");
    expect(formatCompact(1_000_000)).toBe("1M");
  });

  it("never renders a negative count", () => {
    expect(formatCompact(-5)).toBe("0");
  });
});

describe("formatExact", () => {
  it("groups thousands", () => {
    expect(formatExact(30_222)).toBe("30,222");
    expect(formatExact(9)).toBe("9");
  });
});

describe("formatUsd", () => {
  it("keeps chat-scale amounts non-zero", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.000_6)).toBe("$0.0006");
    expect(formatUsd(0.042)).toBe("$0.042");
    expect(formatUsd(1.5)).toBe("$1.50");
  });
});

describe("STRINGS", () => {
  it("states the out-of-domain caveat for chat", () => {
    expect(STRINGS.caveatChat).toContain("Claude Code");
    expect(STRINGS.caveatChat).toContain("out of domain");
  });

  it("still refuses to promise on the surface it was fitted for", () => {
    expect(STRINGS.caveatCode).toContain("Claude Code");
    expect(STRINGS.caveatCode).toContain("not a promise");
  });

  it("names the workload and the single user it was fitted on", () => {
    expect(STRINGS.caveatCode).toContain("one person's");
    expect(STRINGS.caveatCode).toContain("prior for this kind of work");
  });

  it("says a context figure is a lower bound", () => {
    expect(STRINGS.contextLowerBound).toContain("lower bound");
    expect(STRINGS.contextLowerBound).toContain("system prompt");
  });

  it("never turns an unmeasured conversation into a zero", () => {
    expect(STRINGS.contextDraftOnly).toContain("not measured");
  });

  it("labels an assumed thinking state as an assumption", () => {
    expect(STRINGS.thinkingAssumed("on")).toContain("assumed");
    expect(STRINGS.thinkingAssumedNote).toContain("Nothing on the page says");
    expect(STRINGS.thinkingFromTranscript("off")).toContain("last reply");
  });
});
