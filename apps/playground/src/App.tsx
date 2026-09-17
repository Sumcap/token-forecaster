import { useEffect, useMemo, useRef, useState } from "react";
import {
  calculateContextBudget,
  type ContextBudgetResult,
} from "@token-forecaster/core";
import {
  DEFAULT_MODEL_ID,
  listModels,
  projectCostUsd,
  requireModel,
} from "@token-forecaster/model-registry";
import {
  BUNDLED_CLAUDE_CODE_PROFILE,
  historicalBaselineForecast,
  promptMentionsPath,
} from "@token-forecaster/predictor";
import {
  CountReconciler,
  debounced,
  type DisplayedCount,
  type EstimatableRequest,
} from "@token-forecaster/token-counter";
import type {
  CountWorkerRequest,
  CountWorkerResponse,
} from "./count-worker.js";
import { AccuracyDashboard } from "./AccuracyDashboard.js";
import { requestVerifiedInputTokens } from "./verification.js";

const VERIFY_DEBOUNCE_MS = 750;
const SAFETY_MARGIN_TOKENS = 2_000;
type VerificationStatus = "idle" | "waiting" | "verifying";

const QUALITY_LABELS: Record<DisplayedCount["quality"], string> = {
  anthropic_verified: "Anthropic counted",
  local_exact: "Local exact",
  local_estimate: "Local estimate",
  character_heuristic: "Local estimate (character heuristic)",
};

interface ForecastBandChartProps {
  p50: number;
  p90: number;
  p99: number;
  maxTokens: number;
}

/**
 * Horizontal band of the forecast output-token quantiles on a 0..max_tokens
 * scale: solid to p50, lighter to p90, lightest to p99, empty track to the cap.
 */
function ForecastBandChart({ p50, p90, p99, maxTokens }: ForecastBandChartProps) {
  const pct = (v: number) => Math.min(100, (v / maxTokens) * 100);
  const segments = [
    { from: 0, to: p50, className: "band-seg-p50" },
    { from: p50, to: p90, className: "band-seg-p90" },
    { from: p90, to: p99, className: "band-seg-p99" },
  ];
  // Collapse markers that clamp to the same position (small max_tokens).
  const markers = [
    { name: "p50", value: p50 },
    { name: "p90", value: p90 },
    { name: "p99", value: p99 },
  ].filter((m, i, arr) => {
    const prev = arr[i - 1];
    return prev === undefined || pct(m.value) - pct(prev.value) > 6;
  });
  return (
    <figure
      className="band-chart"
      aria-label={`Forecast output tokens: p50 ${p50}, p90 ${p90}, p99 ${p99}, of ${maxTokens} reserved`}
    >
      <div className="band-track">
        {segments.map((s) =>
          s.to > s.from ? (
            <div
              key={s.className}
              className={`band-seg ${s.className}`}
              style={{
                left: `${pct(s.from)}%`,
                width: `${pct(s.to) - pct(s.from)}%`,
              }}
            />
          ) : null,
        )}
      </div>
      <div className="band-labels">
        {markers.map((m) => (
          <span
            key={m.name}
            className="band-label"
            style={{ left: `${pct(m.value)}%` }}
          >
            {m.name} {m.value.toLocaleString()}
          </span>
        ))}
        <span className="band-label band-label-cap">
          cap {maxTokens.toLocaleString()}
        </span>
      </div>
    </figure>
  );
}

export function App() {
  const models = useMemo(() => listModels(), []);
  const [view, setView] = useState<"accuracy" | "forecast">("accuracy");
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [maxTokens, setMaxTokens] = useState(16_000);
  // Tri-state on purpose: "unspecified" is not the same as "disabled". The
  // forecaster falls back to a broader group when it does not know, rather than
  // assuming the cheaper no-thinking distribution.
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean | undefined>(
    undefined,
  );
  const [displayed, setDisplayed] = useState<DisplayedCount>({
    tokens: 0,
    quality: "character_heuristic",
    pendingVerification: false,
  });
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verificationStatus, setVerificationStatus] =
    useState<VerificationStatus>("idle");

  const model = requireModel(modelId);
  const reconciler = useRef(new CountReconciler());
  const workerSeq = useRef(0);
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef<EstimatableRequest>({ messages: [] });

  const composedRequest = useMemo<EstimatableRequest>(
    () => ({
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: userPrompt ? [{ role: "user", content: userPrompt }] : [],
    }),
    [systemPrompt, userPrompt],
  );
  requestRef.current = composedRequest;

  const modelIdRef = useRef(modelId);
  modelIdRef.current = modelId;

  const verify = useMemo(
    () =>
      debounced(() => {
        const request = requestRef.current;
        if (request.messages.length === 0) {
          setVerificationStatus("idle");
          return;
        }
        const ticket = reconciler.current.startVerification();
        setVerificationStatus("verifying");
        requestVerifiedInputTokens({ model: modelIdRef.current, ...request })
          .then((tokens) => {
            const next = reconciler.current.resolveVerification(
              ticket,
              tokens,
            );
            if (next) {
              setDisplayed({ ...next });
              setVerifyError(null);
              setVerificationStatus("idle");
            }
          })
          .catch((error: unknown) => {
            if (reconciler.current.failVerification(ticket)) {
              setVerifyError(
                error instanceof Error ? error.message : String(error),
              );
              setVerificationStatus("idle");
            }
          });
      }, VERIFY_DEBOUNCE_MS),
    [],
  );

  useEffect(() => {
    const worker = new Worker(new URL("./count-worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<CountWorkerResponse>) => {
      // Discard responses that are not for the latest input.
      if (event.data.id !== workerSeq.current) return;
      setDisplayed({ ...reconciler.current.noteInputChanged(event.data.tokens) });
    };
    return () => {
      worker.terminate();
      verify.cancel();
    };
  }, [verify]);

  useEffect(() => {
    const message: CountWorkerRequest = {
      id: ++workerSeq.current,
      request: composedRequest,
    };
    workerRef.current?.postMessage(message);
    if (composedRequest.messages.length === 0) {
      verify.cancel();
      setVerifyError(null);
      setVerificationStatus("idle");
    } else {
      setVerifyError(null);
      setVerificationStatus("waiting");
      verify.call();
    }
  }, [composedRequest, modelId, verify]);

  const forecastResult = useMemo(
    () =>
      historicalBaselineForecast(
        {
          // The full forecast contract: model id, maxTokens, thinkingEnabled.
          // Input size and tool count are deliberately not passed — neither is
          // a dimension of the profile any more (see historical.ts).
          model: modelId,
          maxTokens,
          ...(thinkingEnabled === undefined ? {} : { thinkingEnabled }),
          ...(userPrompt
            ? { promptMentionsPath: promptMentionsPath(userPrompt) }
            : {}),
        },
        BUNDLED_CLAUDE_CODE_PROFILE,
      ),
    [maxTokens, modelId, thinkingEnabled, userPrompt],
  );
  const { forecast, calibration } = forecastResult;

  let budget: ContextBudgetResult | null = null;
  let budgetError: string | null = null;
  try {
    budget = calculateContextBudget({
      contextWindow: model.contextWindow,
      inputTokens: displayed.tokens,
      reservedOutputTokens: maxTokens,
      outputP50: forecast.p50,
      outputP90: forecast.p90,
      safetyMarginTokens: SAFETY_MARGIN_TOKENS,
    });
  } catch (error) {
    budgetError = error instanceof Error ? error.message : String(error);
  }

  const cost = projectCostUsd(modelId, displayed.tokens, forecast.p50, forecast.p90);

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <p className="eyebrow">Claude output intelligence</p>
          <h1>Token Forecaster</h1>
          <p className="tagline">
            Know what the forecast can promise—and where it breaks.
          </p>
        </div>
        <span className="profile-badge">
          <span /> {BUNDLED_CLAUDE_CODE_PROFILE.eligibleObservations.toLocaleString()} calls fitted
        </span>
      </header>

      <nav className="view-tabs" aria-label="Playground views">
        <button
          type="button"
          className={view === "accuracy" ? "active" : ""}
          aria-pressed={view === "accuracy"}
          onClick={() => setView("accuracy")}
        >
          Accuracy dashboard
        </button>
        <button
          type="button"
          className={view === "forecast" ? "active" : ""}
          aria-pressed={view === "forecast"}
          onClick={() => setView("forecast")}
        >
          Live forecast
        </button>
      </nav>

      <section className="controls panel configuration-panel">
        <label>
          Model
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName} ({m.contextWindow.toLocaleString()} ctx)
              </option>
            ))}
          </select>
        </label>

        <label>
          Reserved output (max_tokens)
          <input
            type="number"
            min={1}
            max={model.maxOutputTokens}
            value={maxTokens}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v > 0) {
                setMaxTokens(Math.min(v, model.maxOutputTokens));
              }
            }}
          />
        </label>

        <label>
          Extended thinking
          <select
            value={
              thinkingEnabled === undefined
                ? "unspecified"
                : thinkingEnabled
                  ? "enabled"
                  : "disabled"
            }
            onChange={(e) =>
              setThinkingEnabled(
                e.target.value === "unspecified"
                  ? undefined
                  : e.target.value === "enabled",
              )
            }
          >
            <option value="unspecified">Not specified</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
      </section>

      {view === "forecast" ? (
        <>
      <section className="prompt-panel panel">
        <label>
          System prompt
          <textarea
            rows={3}
            value={systemPrompt}
            placeholder="Optional system prompt"
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        </label>
        <label>
          User prompt
          <textarea
            rows={8}
            value={userPrompt}
            placeholder="Type here; the input count updates while you type"
            onChange={(e) => setUserPrompt(e.target.value)}
          />
        </label>
      </section>

      <section className="meter">
        <div className="count-row">
          <span className="count">
            {displayed.tokens.toLocaleString()} input tokens
          </span>
          <span
            className={`quality quality-${displayed.quality}`}
            title="How this count was produced"
          >
            {QUALITY_LABELS[displayed.quality]}
            {verificationStatus === "waiting"
              ? " (waiting for pause...)"
              : verificationStatus === "verifying"
                ? " (verifying...)"
                : ""}
          </span>
        </div>
        {verifyError && (
          <p className="verify-error">
            Provider verification unavailable: {verifyError}. Showing the local
            estimate.
          </p>
        )}

        {budget && (
          <>
            <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, budget.inputUsagePercent)}>
              <div
                className={`bar-fill level-${budget.warningLevel}`}
                style={{ width: `${Math.min(100, budget.inputUsagePercent)}%` }}
              />
            </div>
            <div className="bar-caption">
              {displayed.tokens.toLocaleString()} / {model.contextWindow.toLocaleString()} ({budget.inputUsagePercent.toFixed(2)}%)
              {" · "}remaining after input: {budget.remainingAfterInput.toLocaleString()}
              {" · "}after reservation: {budget.remainingAfterReservation.toLocaleString()}
            </div>
          </>
        )}
        {budgetError && <p className="verify-error">{budgetError}</p>}
      </section>

      <section className="forecast">
        <h2>Output forecast</h2>
        <p className="forecast-source">
          Predicted <strong>output tokens</strong> the model will generate (the
          input count above is measured, not forecast) · source:{" "}
          {forecast.source} · confidence: {forecast.confidence} ·{" "}
          {forecast.predictorVersion}
        </p>
        <p className="forecast-source">
          Profile: {calibration.profileScope} ·{" "}
          {calibration.sampleSize.toLocaleString()} eligible calls
          {calibration.groupKey === null
            ? " · static cold-start fallback"
            : calibration.usedFallback
              ? " · overall fallback (insufficient model-specific history)"
              : " · model-specific history"}
        </p>
        <ForecastBandChart
          p50={forecast.p50}
          p90={forecast.p90}
          p99={forecast.p99 ?? forecast.p90}
          maxTokens={maxTokens}
        />
        <dl>
          <div>
            <dt>p50</dt>
            <dd>{forecast.p50.toLocaleString()} output tokens</dd>
          </div>
          <div>
            <dt>p90</dt>
            <dd>{forecast.p90.toLocaleString()} output tokens</dd>
          </div>
          <div>
            <dt>p99</dt>
            <dd>{(forecast.p99 ?? 0).toLocaleString()} output tokens</dd>
          </div>
          <div>
            <dt>Cap risk</dt>
            <dd>
              {forecast.probabilityOfOutputCap === undefined
                ? "Unavailable — needs cap-aware calibration"
                : `${(forecast.probabilityOfOutputCap * 100).toFixed(
                    1,
                  )}% at ${maxTokens.toLocaleString()} max_tokens`}
            </dd>
          </div>
          {budget?.remainingAfterProjectedP90 !== undefined && (
            <div>
              <dt>Context after p90</dt>
              <dd>{budget.remainingAfterProjectedP90.toLocaleString()} tokens</dd>
            </div>
          )}
          <div>
            <dt>Projected cost</dt>
            <dd>
              ${cost.totalUsdAtP50.toFixed(4)} to ${cost.totalUsdAtP90.toFixed(4)}{" "}
              (estimate)
            </dd>
          </div>
        </dl>
      </section>

      {budget && budget.warningReasons.length > 0 && (
        <section className={`warnings level-${budget.warningLevel}`}>
          <h2>Warnings ({budget.warningLevel})</h2>
          <ul>
            {budget.warningReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </section>
      )}
        </>
      ) : (
        <AccuracyDashboard
          forecast={{
            p50: forecast.p50,
            p90: forecast.p90,
            p99: forecast.p99 ?? forecast.p90,
          }}
          modelName={model.displayName}
          thinkingLabel={
            thinkingEnabled === undefined
              ? "unspecified"
              : thinkingEnabled
                ? "enabled"
                : "disabled"
          }
          profileScope={calibration.profileScope}
          sampleSize={calibration.sampleSize}
          usedFallback={calibration.usedFallback}
          groupKey={calibration.groupKey}
        />
      )}
    </main>
  );
}
