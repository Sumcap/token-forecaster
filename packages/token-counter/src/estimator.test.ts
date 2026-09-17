import { describe, expect, it } from "vitest";
import { estimateRequestTokens, estimateTokensFromText } from "./estimator.js";

describe("estimateTokensFromText", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokensFromText("")).toBe(0);
  });

  it("estimates roughly a quarter of ASCII character count", () => {
    const text = "a".repeat(400);
    expect(estimateTokensFromText(text)).toBe(100);
  });

  it("weights non-ASCII text as denser", () => {
    const ascii = estimateTokensFromText("hello".repeat(20));
    const cjk = estimateTokensFromText("こんにちは".repeat(20));
    expect(cjk).toBeGreaterThan(ascii);
  });
});

describe("estimateRequestTokens", () => {
  it("counts system, messages, and tools together", () => {
    const bare = estimateRequestTokens({ messages: [] });
    const withParts = estimateRequestTokens({
      system: "You are helpful.",
      messages: [
        { role: "user", content: "Hello there" },
        { role: "assistant", content: "Hi!" },
      ],
      tools: [{ name: "get_weather", input_schema: { type: "object" } }],
    });
    expect(withParts).toBeGreaterThan(bare);
  });

  it("grows monotonically as the user types", () => {
    const at = (content: string) =>
      estimateRequestTokens({ messages: [{ role: "user", content }] });
    expect(at("hello world, this is a longer message")).toBeGreaterThan(at("hello"));
  });
});
