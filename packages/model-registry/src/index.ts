import { z } from "zod";

/**
 * Versioned registry of Anthropic model metadata: context limits, output
 * limits, pricing, and provenance. Nothing else in the codebase hard-codes
 * these numbers.
 *
 * The registry is a local snapshot, not a live source of truth. Every entry
 * records where the value came from and when it was last verified. Runtime
 * verification against Anthropic's Models API (GET /v1/models/{id}, which
 * exposes max_input_tokens and max_tokens) belongs to the anthropic package.
 */

export const modelPricingSchema = z.object({
  /** USD per million uncached input tokens. */
  inputUsdPerMTok: z.number().nonnegative(),
  /** USD per million output tokens (thinking included). */
  outputUsdPerMTok: z.number().nonnegative(),
  /** USD per million tokens written to the prompt cache (5m TTL). */
  cacheWriteUsdPerMTok: z.number().nonnegative().optional(),
  /** USD per million tokens read from the prompt cache. */
  cacheReadUsdPerMTok: z.number().nonnegative().optional(),
  /** Where the price came from. */
  source: z.string(),
  /** ISO date the price took effect, when known. */
  effectiveDate: z.string().optional(),
  /** ISO date we last checked the price against the source. */
  lastVerified: z.string(),
  notes: z.string().optional(),
});
export type ModelPricing = z.infer<typeof modelPricingSchema>;

export const modelRegistryEntrySchema = z.object({
  /** API model identifier, e.g. "claude-sonnet-5". */
  id: z.string(),
  displayName: z.string(),
  /** Dated snapshot identifier where one exists; many current ids have none. */
  snapshot: z.string().optional(),
  /** Maximum input/context tokens. */
  contextWindow: z.number().int().positive(),
  /** Maximum output tokens per request. */
  maxOutputTokens: z.number().int().positive(),
  capabilities: z.object({
    vision: z.boolean(),
    thinking: z.boolean(),
    toolUse: z.boolean(),
    streaming: z.boolean(),
  }),
  pricing: modelPricingSchema,
  /** Where the limits came from. */
  metadataSource: z.string(),
  /** ISO date the limits were last verified against the source. */
  lastVerified: z.string(),
  deprecated: z.boolean().default(false),
});
export type ModelRegistryEntry = z.infer<typeof modelRegistryEntrySchema>;

const METADATA_SOURCE =
  "platform.claude.com/docs/en/about-claude/models/overview (via claude-api reference, cached 2026-06-24)";
const LAST_VERIFIED = "2026-08-01";
const LAST_VERIFIED_2026_08_03 = "2026-08-03";

/**
 * Cache prices are published as multipliers on the uncached input price rather
 * than as per-model figures: a 5-minute cache write costs 1.25x input and a
 * cache read costs 0.1x input. Entries whose cache prices were derived that way
 * rather than read off a per-model table say so in `pricing.notes`.
 */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;
const DERIVED_CACHE_PRICE_NOTE =
  "Cache prices derived from the documented multipliers (write 1.25x input, read 0.1x input), not from a per-model price table.";

/**
 * The registry data, ordered by capability tier then recency. When adding a
 * model, fill every field from an official source and set lastVerified.
 */
const ENTRIES: ModelRegistryEntry[] = [
  {
    id: "claude-fable-5",
    displayName: "Claude Fable 5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    // Thinking is always on and cannot be disabled: an explicit
    // {type: "disabled"} is rejected with a 400. Depth is controlled through
    // output_config.effort instead of a thinking budget.
    capabilities: { vision: true, thinking: true, toolUse: true, streaming: true },
    pricing: {
      inputUsdPerMTok: 10.0,
      outputUsdPerMTok: 50.0,
      cacheWriteUsdPerMTok: 10.0 * CACHE_WRITE_MULTIPLIER,
      cacheReadUsdPerMTok: 10.0 * CACHE_READ_MULTIPLIER,
      source: METADATA_SOURCE,
      lastVerified: LAST_VERIFIED_2026_08_03,
      notes: DERIVED_CACHE_PRICE_NOTE,
    },
    metadataSource: METADATA_SOURCE,
    lastVerified: LAST_VERIFIED_2026_08_03,
    deprecated: false,
  },
  {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: { vision: true, thinking: true, toolUse: true, streaming: true },
    pricing: {
      inputUsdPerMTok: 5.0,
      outputUsdPerMTok: 25.0,
      cacheWriteUsdPerMTok: 6.25,
      cacheReadUsdPerMTok: 0.5,
      source: METADATA_SOURCE,
      lastVerified: LAST_VERIFIED,
    },
    metadataSource: METADATA_SOURCE,
    lastVerified: LAST_VERIFIED,
    deprecated: false,
  },
  {
    id: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: { vision: true, thinking: true, toolUse: true, streaming: true },
    pricing: {
      inputUsdPerMTok: 5.0,
      outputUsdPerMTok: 25.0,
      cacheWriteUsdPerMTok: 5.0 * CACHE_WRITE_MULTIPLIER,
      cacheReadUsdPerMTok: 5.0 * CACHE_READ_MULTIPLIER,
      source: METADATA_SOURCE,
      lastVerified: LAST_VERIFIED_2026_08_03,
      notes: DERIVED_CACHE_PRICE_NOTE,
    },
    metadataSource: METADATA_SOURCE,
    lastVerified: LAST_VERIFIED_2026_08_03,
    deprecated: false,
  },
  {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: { vision: true, thinking: true, toolUse: true, streaming: true },
    pricing: {
      inputUsdPerMTok: 3.0,
      outputUsdPerMTok: 15.0,
      cacheWriteUsdPerMTok: 3.75,
      cacheReadUsdPerMTok: 0.3,
      source: METADATA_SOURCE,
      lastVerified: LAST_VERIFIED,
      notes:
        "Introductory pricing of $2/$10 per MTok applies through 2026-08-31; list price recorded here.",
    },
    metadataSource: METADATA_SOURCE,
    lastVerified: LAST_VERIFIED,
    deprecated: false,
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: { vision: true, thinking: true, toolUse: true, streaming: true },
    pricing: {
      inputUsdPerMTok: 3.0,
      outputUsdPerMTok: 15.0,
      cacheWriteUsdPerMTok: 3.75,
      cacheReadUsdPerMTok: 0.3,
      source: METADATA_SOURCE,
      lastVerified: LAST_VERIFIED,
    },
    metadataSource: METADATA_SOURCE,
    lastVerified: LAST_VERIFIED,
    deprecated: false,
  },
  {
    id: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    snapshot: "claude-haiku-4-5-20251001",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    capabilities: { vision: true, thinking: true, toolUse: true, streaming: true },
    pricing: {
      inputUsdPerMTok: 1.0,
      outputUsdPerMTok: 5.0,
      cacheWriteUsdPerMTok: 1.25,
      cacheReadUsdPerMTok: 0.1,
      source: METADATA_SOURCE,
      lastVerified: LAST_VERIFIED,
    },
    metadataSource: METADATA_SOURCE,
    lastVerified: LAST_VERIFIED,
    deprecated: false,
  },
];

/**
 * Lookup is keyed on both the canonical id and the dated snapshot id, because
 * callers legitimately hold either one: the API accepts both, and Claude Code
 * transcripts record whichever the client sent. Keying on `id` alone made
 * getModel("claude-haiku-4-5-20251001") return undefined for a model the
 * registry already described, which silently degraded every downstream
 * consumer (requireModel threw, cost projection was unavailable, and the
 * forecaster fell back to its blended `overall` group).
 */
const REGISTRY = new Map<string, ModelRegistryEntry>();
for (const entry of ENTRIES) {
  REGISTRY.set(entry.id, entry);
  if (entry.snapshot !== undefined) REGISTRY.set(entry.snapshot, entry);
}

/** The model the playground selects by default (primary benchmark model). */
export const DEFAULT_MODEL_ID = "claude-sonnet-5";

export function listModels(): ModelRegistryEntry[] {
  return [...ENTRIES];
}

/** Accepts a canonical id or a dated snapshot id. */
export function getModel(id: string): ModelRegistryEntry | undefined {
  return REGISTRY.get(id);
}

export interface ModelIdAlias {
  /** Canonical, undated identifier, e.g. "claude-haiku-4-5". */
  id: string;
  /** Dated snapshot identifier, e.g. "claude-haiku-4-5-20251001". */
  snapshot: string;
}

/**
 * Every (canonical id, dated snapshot) pair the registry knows about.
 *
 * Consumers that key data on a model string — the historical forecast profile
 * most of all — use this to accept whichever form the caller happens to hold,
 * instead of hand-maintaining their own alias table and drifting from the
 * registry.
 */
export function listModelIdAliases(): ModelIdAlias[] {
  return ENTRIES.flatMap((entry) =>
    entry.snapshot === undefined ? [] : [{ id: entry.id, snapshot: entry.snapshot }],
  );
}

export class UnknownModelError extends Error {
  constructor(public readonly modelId: string) {
    super(`Unknown model id: ${modelId}. Add it to @token-forecaster/model-registry.`);
    this.name = "UnknownModelError";
  }
}

export function requireModel(id: string): ModelRegistryEntry {
  const entry = REGISTRY.get(id);
  if (!entry) throw new UnknownModelError(id);
  return entry;
}

export interface CostRangeUsd {
  inputUsd: number;
  outputUsdAtP50: number;
  outputUsdAtP90: number;
  totalUsdAtP50: number;
  totalUsdAtP90: number;
}

/**
 * Projected cost range before generation. Clearly an estimate: output cost
 * uses forecast quantiles, not a promise about actual usage.
 */
export function projectCostUsd(
  modelId: string,
  inputTokens: number,
  outputP50: number,
  outputP90: number,
): CostRangeUsd {
  const { pricing } = requireModel(modelId);
  const inputUsd = (inputTokens / 1_000_000) * pricing.inputUsdPerMTok;
  const outputUsdAtP50 = (outputP50 / 1_000_000) * pricing.outputUsdPerMTok;
  const outputUsdAtP90 = (outputP90 / 1_000_000) * pricing.outputUsdPerMTok;
  return {
    inputUsd,
    outputUsdAtP50,
    outputUsdAtP90,
    totalUsdAtP50: inputUsd + outputUsdAtP50,
    totalUsdAtP90: inputUsd + outputUsdAtP90,
  };
}
