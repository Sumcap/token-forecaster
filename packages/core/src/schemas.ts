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

/**
 * The longest prompt this contract will carry.
 *
 * Turn-root prompts on the local corpus are shorter than this at the 99.9th
 * percentile; beyond it a "prompt" is a pasted file, which is exactly the
 * content nobody consented to upload. Longer text is rejected rather than
 * truncated, so a client cannot quietly ship half of one.
 */
export const MAX_PROMPT_TEXT_CHARS = 8_000;

/**
 * Why the model stopped, as the harness reported it.
 *
 * `other` is for a provider value this enum has not seen; it is not a default,
 * and a client that does not know must omit the field instead.
 */
export const stopReasonSchema = z.enum([
  "end_turn",
  "tool_use",
  "max_tokens",
  "stop_sequence",
  "other",
]);
export type StopReasonObservation = z.infer<typeof stopReasonSchema>;

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

/**
 * The public base text head's three `log1p(tokens)` quantiles for the turn
 * root, in `[p50, p90, p99]` order. Three numbers, never text: the head is a
 * pure function of the prompt whose output cannot be inverted back into it,
 * which is what lets the server measure the head without ever seeing a draft.
 * Optional -- rows written before Stage 1 carry no such field, and a caller
 * that holds only prompt FEATURES cannot compute it.
 */
export const textHeadQuantilesSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
export type TextHeadQuantilesObservation = z.infer<typeof textHeadQuantilesSchema>;

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
const forecastObservationObjectSchema = z.object({
  id: z.string(),
  timestamp: z.string().datetime(),

  /**
   * Widened from `"anthropic"` when the companion daemon began uploading Codex
   * rows, which carry the same usage contract from a different vendor. Every
   * row written before that parses unchanged; nothing may pool the two when
   * fitting quantiles.
   */
  provider: z.enum(["anthropic", "openai"]),
  model: z.string(),
  modelSnapshot: z.string().optional(),

  request: z.object({
    inputTokensVerified: z.number().int().nonnegative().optional(),
    inputTokensLocal: z.number().int().nonnegative().optional(),

    systemPromptTokens: z.number().int().nonnegative().optional(),
    conversationTokens: z.number().int().nonnegative().optional(),
    currentUserTokens: z.number().int().nonnegative().optional(),
    toolTokens: z.number().int().nonnegative().optional(),

    /**
     * Optional because browser surfaces cannot see the provider's complete
     * request. Exact API callers should continue to provide both fields;
     * visible-page observers must omit rather than invent zeroes.
     */
    messageCount: z.number().int().nonnegative().optional(),
    toolCount: z.number().int().nonnegative().optional(),

    temperature: z.number().optional(),
    topP: z.number().optional(),
    /** Omit when the surface does not expose the request's max_tokens value. */
    maxTokens: z.number().int().positive().optional(),
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
    /** `baseTextHead(prompt)` -- three numbers, sibling of the features above. */
    textHeadQuantiles: textHeadQuantilesSchema.optional(),
    agentLoopForecastContext: agentLoopForecastContextSchema.optional(),

    /**
     * The cleaned turn-root prompt, harness wrappers removed.
     *
     * Present ONLY under `promptStorageMode` `redacted` or `full_opt_in`; the
     * observation-level check below rejects a row that carries text under any
     * other mode, or with no mode at all. This is the enforcement the storage
     * enum has been missing since it was written. See ADR 0002.
     */
    promptText: z.string().max(MAX_PROMPT_TEXT_CHARS).optional(),
    /**
     * Which tier of prompt storage the row was collected under. Required
     * whenever `promptText` is present; meaningful without it, because a
     * feature-only row that says `hash_only` is a positive statement that the
     * client held text and did not send it.
     */
    promptStorageMode: promptStorageModeSchema.optional(),

    // --- loop structure -----------------------------------------------------
    // Where this call sits in its agent loop. Numbers and short enum strings
    // only, so they ship under every storage mode including `none`. Two of
    // them (`toolNames`, `stopReason`) describe the response rather than the
    // request; they live here because the loop position of the NEXT call is
    // what they are collected for, and separating them from `turnRootId` and
    // `callIndex` would split one table across two objects.

    /**
     * Opaque identifier of the human turn that opened this call's agent loop.
     * Every call of one turn shares it; it is a transcript uuid, never derived
     * from prompt content. Turn-scale rows carry their own root id.
     */
    turnRootId: z.string().max(128).optional(),
    /**
     * Zero-based index of this call inside its turn.
     *
     * The same quantity as `agentLoopForecastContext.priorCallCount` -- the
     * number of calls this loop already made -- exposed on its own because a
     * caller that knows only the loop position cannot fill that object's
     * required siblings (`priorMaxOutputTokens` and friends). When both are
     * present they must agree, which the check below enforces.
     */
    callIndex: z.number().int().nonnegative().optional(),
    /**
     * Zero-based index of this call's TURN inside its session.
     *
     * Distinct from `agentLoopForecastContext.sessionPosition`, which counts
     * CALLS in the session: a session of three turns whose loops ran ten calls
     * each ends at `turnIndexInSession` 2 and `sessionPosition` 29.
     */
    turnIndexInSession: z.number().int().nonnegative().optional(),
    /**
     * Names of the `tool_use` blocks in this call's response, in the order the
     * response emitted them. Tool NAMES only -- never inputs, never results.
     * An empty array means "the call made no tool call", which is information;
     * omitting the field means the surface could not see the blocks.
     */
    toolNames: z.array(z.string().min(1).max(64)).max(32).optional(),
    /** Size of the largest tool input this call emitted, in characters. */
    largestToolInputChars: z.number().int().nonnegative().optional(),
    /** Why the call stopped. Post-call at call scale, pre-call for the next. */
    stopReason: stopReasonSchema.optional(),
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
      /**
       * Optional since the companion began uploading transcript rows: Claude
       * Code records the billed OUTPUT of every call and no per-call input
       * count, and writing a zero there would be inventing a measurement.
       * Missing is not zero. Rows written before this was relaxed all carry it.
       */
      inputTokens: z.number().int().nonnegative().optional(),
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
      /**
       * Omitted means the observing surface cannot distinguish a natural stop
       * from a provider cap. Browser-derived rows deliberately leave it out.
       */
      isCensored: z.boolean().optional(),
      /**
       * Whether outputTokens came from provider usage or an estimate of the
       * rendered text. Training code must never mix these without an explicit
       * measurement-error decision.
       *
       * This IS the exact/estimated tag for a row: the Chrome extension's
       * DOM-counted rows say `dom_estimate` and everything read from a
       * transcript's usage block says `provider_exact`. A second field naming
       * the same distinction was considered and refused -- two tags that can
       * disagree are worse than one.
       */
      outputTokenQuality: z
        .enum(["provider_exact", "dom_estimate"])
        .optional(),
      inputTokenQuality: countQualitySchema.optional(),

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
      /**
       * Stable salted hashes; raw user/workload identifiers are not required.
       *
       * `userIdHash` is also how a direct-API row says which INSTALLATION sent
       * it: the companion generates a random opaque id once, keeps it locally,
       * and puts it here. That is the key `DELETE /v1/installations/:id` and
       * the purge script match on, so somebody can have their rows deleted
       * without an account having to exist anywhere.
       */
      userIdHash: z.string().optional(),
      workloadIdHash: z.string().optional(),
      /** Browser-only provenance. Omitted on direct API observations. */
      surface: z.enum(["claude_code", "claude_chat"]).optional(),
      extensionVersion: z.string().optional(),
      consentVersion: z.number().int().positive().optional(),
      forecastScale: z.enum(["call", "turn"]).optional(),
    })
    .optional(),
});

/**
 * One normalized telemetry event, with the prompt-storage contract enforced.
 *
 * The enum on its own never stopped anybody: a client could set `hash_only`
 * and attach a prompt, and the row parsed. Text and mode are now checked
 * together, at the observation level, so the check runs everywhere the schema
 * does -- writer, ingest, and any reader replaying a file.
 */
export const forecastObservationSchema = forecastObservationObjectSchema.superRefine(
  (observation, issue) => {
    const { promptText, promptStorageMode, callIndex, agentLoopForecastContext } =
      observation.request;

    if (promptText !== undefined) {
      if (promptStorageMode === undefined) {
        issue.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["request", "promptStorageMode"],
          message:
            "promptStorageMode is required whenever request.promptText is present",
        });
      } else if (promptStorageMode === "none" || promptStorageMode === "hash_only") {
        issue.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["request", "promptText"],
          message: `request.promptText is not allowed under promptStorageMode "${promptStorageMode}"; send redacted or full_opt_in text, or no text at all`,
        });
      }
    }

    // Two names for one number may not disagree; see `request.callIndex`.
    if (
      callIndex !== undefined &&
      agentLoopForecastContext !== undefined &&
      agentLoopForecastContext.priorCallCount !== callIndex
    ) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["request", "callIndex"],
        message:
          "request.callIndex and request.agentLoopForecastContext.priorCallCount count the same calls and must agree",
      });
    }
  },
);
export type ForecastObservation = z.infer<typeof forecastObservationSchema>;

export const EXTENSION_TELEMETRY_SCHEMA_VERSION = 1 as const;

const extensionTelemetryBaseSchema = z.object({
  schemaVersion: z.literal(EXTENSION_TELEMETRY_SCHEMA_VERSION),
  id: z.string().min(16).max(128),
  timestamp: z.string().datetime(),
  extensionVersion: z.string().min(1).max(64),
  consentVersion: z.number().int().positive(),
});

/**
 * Small, enumerated operational events. There is deliberately no arbitrary
 * properties bag: page text, URLs, stack traces, and selector contents have
 * nowhere to enter the contract.
 */
export const extensionDiagnosticEventSchema = extensionTelemetryBaseSchema.extend({
  kind: z.literal("diagnostic"),
  name: z.enum([
    "extension_ready",
    "forecast_rendered",
    "turn_scored",
    "collector_unavailable",
  ]),
  surface: z.enum(["claude_code", "claude_chat"]).optional(),
  outcome: z.enum(["success", "degraded", "failure"]),
  code: z
    .enum([
      "ok",
      "model_assumed",
      "thinking_assumed",
      "pooled_forecast",
      "abandoned",
      "network_error",
      "permission_missing",
      "collector_not_configured",
    ])
    .optional(),
  /** Coarse timing only; never an exact interaction trace. */
  durationBucketMs: z.enum(["lt_250", "250_999", "1s_4s", "5s_plus"]).optional(),
});
export type ExtensionDiagnosticEvent = z.infer<typeof extensionDiagnosticEventSchema>;

export const extensionResearchEventSchema = extensionTelemetryBaseSchema.extend({
  kind: z.literal("research"),
  observation: forecastObservationSchema,
});
export type ExtensionResearchEvent = z.infer<typeof extensionResearchEventSchema>;

export const extensionTelemetryClientEventSchema = z.discriminatedUnion("kind", [
  extensionDiagnosticEventSchema,
  extensionResearchEventSchema,
]);
export type ExtensionTelemetryClientEvent = z.infer<
  typeof extensionTelemetryClientEventSchema
>;
