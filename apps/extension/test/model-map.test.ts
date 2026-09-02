import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID, listModels } from "@token-forecaster/model-registry";
import { matchModelLabel, parseModelName, resolveModel } from "../src/lib/model-map.js";

describe("parseModelName", () => {
  it("reads a picker label", () => {
    expect(parseModelName("Claude Sonnet 4.6")).toEqual({ family: "sonnet", version: 4.6 });
    expect(parseModelName("Opus 5")).toEqual({ family: "opus", version: 5 });
  });

  it("reads a canonical id", () => {
    expect(parseModelName("claude-sonnet-4-6")).toEqual({ family: "sonnet", version: 4.6 });
  });

  it("returns null for a label with no family", () => {
    expect(parseModelName("New chat")).toBeNull();
  });
});

describe("matchModelLabel", () => {
  it("matches every display name the registry ships", () => {
    for (const entry of listModels()) {
      const match = matchModelLabel(entry.displayName);
      expect(match.id).toBe(entry.id);
      expect(match.kind === "exact" || match.kind === "id").toBe(true);
    }
  });

  it("accepts a registry id directly", () => {
    expect(matchModelLabel("claude-sonnet-5")).toEqual({ id: "claude-sonnet-5", kind: "id" });
  });

  it("falls back inside the family for an unknown version", () => {
    const match = matchModelLabel("Claude Sonnet 9.9");
    expect(match.kind).toBe("family");
    expect(match.id.startsWith("claude-sonnet")).toBe(true);
  });

  it("falls back to the default model for an unrecognizable label", () => {
    expect(matchModelLabel("Nimbus 2")).toEqual({ id: DEFAULT_MODEL_ID, kind: "none" });
  });
});

describe("resolveModel", () => {
  it("prefers an explicit override", () => {
    const resolved = resolveModel("claude-opus-5", "Claude Sonnet 5");
    expect(resolved).toEqual({
      id: "claude-opus-5",
      resolution: "override",
      pageLabel: "Claude Sonnet 5",
    });
  });

  it("ignores an override the registry does not know", () => {
    expect(resolveModel("claude-nimbus-2", "Claude Opus 5").resolution).toBe("page");
  });

  it("uses the page next, then the default", () => {
    expect(resolveModel("auto", "Opus 5")).toEqual({
      id: "claude-opus-5",
      resolution: "page",
      pageLabel: "Opus 5",
    });
    expect(resolveModel("auto", null)).toEqual({
      id: DEFAULT_MODEL_ID,
      resolution: "assumed",
      pageLabel: null,
    });
  });

  it("marks an unreadable page label as assumed rather than throwing", () => {
    const resolved = resolveModel("auto", "Nimbus 2");
    expect(resolved.resolution).toBe("assumed");
    expect(resolved.id).toBe(DEFAULT_MODEL_ID);
  });
});
