import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ID,
  getModel,
  listModelIdAliases,
  listModels,
  modelRegistryEntrySchema,
  projectCostUsd,
  requireModel,
  UnknownModelError,
} from "./index.js";

describe("model registry", () => {
  it("every entry passes its own schema", () => {
    for (const entry of listModels()) {
      expect(() => modelRegistryEntrySchema.parse(entry)).not.toThrow();
    }
  });

  it("contains the default model", () => {
    expect(getModel(DEFAULT_MODEL_ID)).toBeDefined();
  });

  it("records provenance on every entry and price", () => {
    for (const entry of listModels()) {
      expect(entry.metadataSource.length).toBeGreaterThan(0);
      expect(entry.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.pricing.source.length).toBeGreaterThan(0);
      expect(entry.pricing.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("throws a typed error for unknown models", () => {
    expect(() => requireModel("claude-nonexistent-9")).toThrow(UnknownModelError);
  });

  // The three models the shipped forecast profile is fitted on. Without these
  // the main app cannot price a request, size a context budget, or list the
  // model it is actually going to call.
  it.each(["claude-fable-5", "claude-opus-4-8", "claude-opus-5"])(
    "describes the forecast-profile model %s",
    (id) => {
      const entry = requireModel(id);
      expect(entry.contextWindow).toBeGreaterThan(0);
      expect(entry.maxOutputTokens).toBeGreaterThan(0);
      expect(entry.pricing.outputUsdPerMTok).toBeGreaterThan(0);
      expect(listModels().map((m) => m.id)).toContain(id);
    },
  );

  it("resolves a dated snapshot id onto its canonical entry", () => {
    const aliases = listModelIdAliases();
    expect(aliases.length).toBeGreaterThan(0);

    for (const { id, snapshot } of aliases) {
      // Both forms must resolve, and to the very same entry: a caller holding
      // a dated id would otherwise get undefined for a model we describe.
      expect(getModel(snapshot), `snapshot ${snapshot}`).toBe(getModel(id));
      expect(requireModel(snapshot).id).toBe(id);
      expect(projectCostUsd(snapshot, 1_000_000, 0, 0).inputUsd).toBe(
        projectCostUsd(id, 1_000_000, 0, 0).inputUsd,
      );
    }
  });

  it("only reports aliases for entries that declare a snapshot", () => {
    const declared = listModels().filter((m) => m.snapshot !== undefined);
    expect(listModelIdAliases()).toHaveLength(declared.length);
  });

  it("projects a cost range from forecast quantiles", () => {
    const cost = projectCostUsd(DEFAULT_MODEL_ID, 1_000_000, 100_000, 500_000);
    expect(cost.inputUsd).toBeCloseTo(3.0);
    expect(cost.outputUsdAtP50).toBeCloseTo(1.5);
    expect(cost.outputUsdAtP90).toBeCloseTo(7.5);
    expect(cost.totalUsdAtP90).toBeGreaterThan(cost.totalUsdAtP50);
  });
});
