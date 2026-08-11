import { z } from "zod";

/**
 * How a token count was produced. The UI must always show this so the user
 * knows whether a number is a local estimate or a provider-counted estimate.
 */
export const countQualitySchema = z.enum([
  "anthropic_verified",
  "local_exact",
  "local_estimate",
  "character_heuristic",
]);
export type CountQuality = z.infer<typeof countQualitySchema>;

/** Result of Anthropic's POST /v1/messages/count_tokens. */
export const inputTokenCountSchema = z.object({
  tokens: z.number().int().nonnegative(),
  quality: z.literal("anthropic_verified"),
  countedAt: z.string().datetime(),
});
export type InputTokenCount = z.infer<typeof inputTokenCountSchema>;

/** A local (pre-verification) count. Fast, labelled, never authoritative. */
export const localTokenCountSchema = z.object({
  tokens: z.number().int().nonnegative(),
  quality: countQualitySchema.exclude(["anthropic_verified"]),
  countedAt: z.string().datetime(),
});
export type LocalTokenCount = z.infer<typeof localTokenCountSchema>;

export const forecastConfidenceSchema = z.enum(["low", "medium", "high"]);
export type ForecastConfidence = z.infer<typeof forecastConfidenceSchema>;

export const forecastSourceSchema = z.enum([
  "default",
  "rules",
  "historical",
  "trained",
]);
export type ForecastSource = z.infer<typeof forecastSourceSchema>;

/**
 * Pre-generation output forecast. Always a distribution, never a point claim.
 * Quantiles are in output tokens.
 */
export const outputForecastSchema = z
  .object({
    p50: z.number().int().nonnegative(),
    p90: z.number().int().nonnegative(),
    p99: z.number().int().nonnegative().optional(),
    probabilityOfOutputCap: z.number().min(0).max(1).optional(),
    probabilityOfContextOverflow: z.number().min(0).max(1).optional(),
    confidence: forecastConfidenceSchema,
    source: forecastSourceSchema,
    predictorVersion: z.string(),
  })
  .refine((f) => f.p90 >= f.p50, {
    message: "p90 must be >= p50",
  })
  .refine((f) => f.p99 === undefined || f.p99 >= f.p90, {
    message: "p99 must be >= p90",
  });
export type OutputForecast = z.infer<typeof outputForecastSchema>;

/** Thinking-token usage as reported by Anthropic. Provider values preserved. */
export const thinkingUsageSchema = z.object({
  reportedThinkingTokens: z.number().int().nonnegative().optional(),
  totalOutputTokens: z.number().int().nonnegative(),
  visibleOutputTokens: z.number().int().nonnegative().optional(),
});
export type ThinkingUsage = z.infer<typeof thinkingUsageSchema>;

export const promptStorageModeSchema = z.enum([
  "none",
  "hash_only",
  "redacted",
  "full_opt_in",
]);
export type PromptStorageMode = z.infer<typeof promptStorageModeSchema>;

/** Default privacy mode: derived features and hashes only, never raw prompts. */
export const DEFAULT_PROMPT_STORAGE_MODE: PromptStorageMode = "hash_only";

export const expectedOutputKindSchema = z.enum([
  "message",
  "artifact",
  "tool_call",
  "mixed",
  "unknown",
]);
export type ExpectedOutputKind = z.infer<typeof expectedOutputKindSchema>;

export const expectedOutputKindSourceSchema = z.enum([
  "human_declared",
  "orchestrator_declared",
  "prompt_heuristic",
  "resolved_context_heuristic",
  "unknown",
]);
export type ExpectedOutputKindSource = z.infer<
  typeof expectedOutputKindSourceSchema
>;

/** Pre-call file context only. Omit the object when it was not observed. */
export const resolvedFileContextSchema = z.object({
  knownPathCount: z.number().int().nonnegative(),
  immediateResultPathCount: z.number().int().nonnegative(),
  readPathCount: z.number().int().nonnegative(),
  searchedPathCount: z.number().int().nonnegative(),
  mutationPathCount: z.number().int().nonnegative(),
  vaguePromptResolvedFile: z.boolean(),
});
export type ResolvedFileContextObservation = z.infer<
  typeof resolvedFileContextSchema
>;

export const promptForecastFeaturesSchema = z.object({
  characterCount: z.number().int().nonnegative(),
  requirements: z.number().int().nonnegative(),
  hasLimit: z.boolean(),
  hasExpansive: z.boolean(),
  artifactIntent: z.boolean(),
  requestedFormat: z.enum([
    "json",
    "table",
    "list",
    "code",
    "document",
    "mixed",
    "unspecified",
  ]),
  deliverableType: z.enum([
    "artifact",
    "structured",
    "document",
    "code",
    "analysis",
    "operation",
    "other",
  ]),
  // Optional on purpose: telemetry rows written before feature schema v3 carry
  // no such field, and absent must stay valid rather than become `false`.
  followupCompression: z.boolean().optional(),
});
export type PromptForecastFeatureObservation = z.infer<
  typeof promptForecastFeaturesSchema
>;

export const agentLoopForecastContextSchema = z
  .object({
    sessionPosition: z.number().int().nonnegative(),
    loopDepth: z.number().int().nonnegative(),
    priorCallCount: z.number().int().nonnegative(),
    priorMaxOutputTokens: z.number().int().nonnegative().optional(),
    priorArtifactCount: z.number().int().nonnegative().optional(),
    priorWriteObserved: z.boolean().optional(),
    priorArtifactObserved: z.boolean().optional(),
  })
  .superRefine((context, issue) => {
    if (context.priorCallCount === 0) return;
    for (const field of [
      "priorMaxOutputTokens",
      "priorArtifactCount",
      "priorWriteObserved",
      "priorArtifactObserved",
    ] as const) {
      if (context[field] === undefined) {
        issue.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is required when priorCallCount > 0`,
        });
      }
    }
  });
export type AgentLoopForecastContextObservation = z.infer<
  typeof agentLoopForecastContextSchema
>;

/**
 * One normalized telemetry event: what we predicted and what actually
 * happened. This is the training-data unit for later predictor baselines.
 */
export const forecastObservationSchema = z.object({
  id: z.string(),
  timestamp: z.string().datetime(),

  provider: z.literal("anthropic"),
  model: z.string(),
  modelSnapshot: z.string().optional(),

  request: z.object({
    inputTokensVerified: z.number().int().nonnegative().optional(),
    inputTokensLocal: z.number().int().nonnegative().optional(),

    systemPromptTokens: z.number().int().nonnegative().optional(),
    conversationTokens: z.number().int().nonnegative().optional(),
    currentUserTokens: z.number().int().nonnegative().optional(),
    toolTokens: z.number().int().nonnegative().optional(),

    messageCount: z.number().int().nonnegative(),
    toolCount: z.number().int().nonnegative(),

    temperature: z.number().optional(),
    topP: z.number().optional(),
    maxTokens: z.number().int().positive(),
    thinkingConfiguration: z.unknown().optional(),
    outputEffort: z
      .enum(["low", "medium", "high", "xhigh", "max"])
      .optional(),
    responseFormat: z.unknown().optional(),
    toolChoice: z.unknown().optional(),
    stopSequenceCount: z.number().int().nonnegative().optional(),

    taskType: z.string().optional(),
    language: z.string().optional(),
    /**
     * Whether the human turn-root prompt names a source file or repository
     * path. Derived before storage so raw prompt text is not required.
     */
    promptMentionsPath: z.boolean().optional(),
    /**
     * Whether the human turn-root message carries an image attachment.
     * Omitted means the turn root was unavailable, not "no image".
     */
    promptHasImage: z.boolean().optional(),
    promptForecastFeatures: promptForecastFeaturesSchema.optional(),
    agentLoopForecastContext: agentLoopForecastContextSchema.optional(),
    /**
     * Caller-declared intent before generation. This is the smallest telemetry
     * addition capable of targeting the unresolved long-artifact regime.
     * Omitted/unknown is never treated as `message`.
     */
    expectedOutputKind: expectedOutputKindSchema.optional(),
    /** How the pre-call declaration was obtained; never infer this post-call. */
    expectedOutputKindSource: expectedOutputKindSourceSchema.optional(),
    /** Optional probability/confidence stated before generation. */
    expectedOutputKindConfidence: z.number().min(0).max(1).optional(),
    resolvedFileContext: resolvedFileContextSchema.optional(),
    extractedConstraints: z.record(z.unknown()).optional(),

    /**
     * Output tokens produced by the call immediately preceding this one in the
     * same agent loop, when there was one.
     *
     * Legal pre-call: the previous call has finished by the time this forecast
     * is due. Omitted means "no preceding call / not tracked", which is NOT the
     * same as a short previous call — see previousOutputBucket() in
     * @token-forecaster/predictor.
     */
    previousOutputTokens: z.number().int().nonnegative().optional(),
  }),

  forecast: z.object({
    outputP50: z.number().int().nonnegative(),
    outputP90: z.number().int().nonnegative(),
    outputP99: z.number().int().nonnegative().optional(),

    probabilityOfCap: z.number().min(0).max(1).optional(),
    probabilityOfContextOverflow: z.number().min(0).max(1).optional(),

    predictorVersion: z.string(),
    forecastSource: forecastSourceSchema,
    confidence: forecastConfidenceSchema,
  }),

  actual: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),

      cacheCreationInputTokens: z.number().int().nonnegative().optional(),
      cacheReadInputTokens: z.number().int().nonnegative().optional(),
      thinkingTokens: z.number().int().nonnegative().optional(),
      visibleOutputTokens: z.number().int().nonnegative().optional(),

      finishReason: z.string().optional(),
      /**
       * True when the response stopped at max_tokens. A censored observation:
       * natural output length >= observed length. Excluded from ordinary
       * median regression; kept for cap-risk classification and survival
       * analysis.
       */
      isCensored: z.boolean(),

      timeToFirstTokenMs: z.number().nonnegative().optional(),
      totalLatencyMs: z.number().nonnegative().optional(),
      estimatedCostUsd: z.number().nonnegative().optional(),
      /** Post-call label for training the pre-call expected-output detector. */
      observedOutputKind: expectedOutputKindSchema.optional(),
      firstAction: z.string().optional(),
    })
    .optional(),

  metadata: z
    .object({
      sessionId: z.string().optional(),
      workflowId: z.string().optional(),
      agentId: z.string().optional(),
      experimentId: z.string().optional(),
      /** Stable salted hashes; raw user/workload identifiers are not required. */
      userIdHash: z.string().optional(),
      workloadIdHash: z.string().optional(),
    })
    .optional(),
});
export type ForecastObservation = z.infer<typeof forecastObservationSchema>;
