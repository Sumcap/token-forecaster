import { useMemo, useState } from "react";
import {
  assessActualOutput,
  medianPinballToMeanAbsoluteError,
  oneInFromCoverage,
  type ForecastQuantiles,
} from "./accuracy.js";

/**
 * Privacy-safe aggregates from experiments/artifacts/claude-code-history-eval.json
 * and loss-decomposition-probe.json, generated together on 4 August 2026.
 * Keeping this compact avoids shipping the multi-thousand-line research artifact
 * to the browser. No prompt or response content is included.
 */
const EVALUATION = {
  generatedAt: "2026-08-05T11:15:14.063Z",
  calls: 15_095,
  holdoutCalls: 3_019,
  staticLoss: 919.59,
  learnedLoss: 623.7,
  foldLow: 465.23,
  foldHigh: 765.98,
  coverage: {
    p50: { target: 0.5, actual: 0.4879, loss: 278.89 },
    p90: { target: 0.9, actual: 0.892, loss: 265.87 },
    p99: { target: 0.99, actual: 0.9887, loss: 78.94 },
  },
  topOnePercentLossShare: 0.228,
  writeTrafficShare: 0.0311,
  writeWorstShare: 0.3046,
  writeLift: 9.78,
  promptDifference: -10.89,
  promptCi: [-21.9, -0.41] as const,
} as const;

interface AccuracyDashboardProps {
  forecast: ForecastQuantiles;
  modelName: string;
  thinkingLabel: string;
  profileScope: string;
  sampleSize: number;
  usedFallback: boolean;
  groupKey: string | null;
}

const percent = (value: number, digits = 1) =>
  `${(value * 100).toFixed(digits)}%`;

function CoverageCard({
  label,
  target,
  actual,
}: {
  label: string;
  target: number;
  actual: number;
}) {
  const difference = actual - target;
  return (
    <article className="coverage-card">
      <div className="coverage-heading">
        <span>{label}</span>
        <strong>{percent(actual)}</strong>
      </div>
      <div
        className="coverage-track"
        aria-label={`${label} actual coverage ${percent(actual)}, target ${percent(target, 0)}`}
      >
        <span
          className="coverage-fill"
          style={{ width: `${actual * 100}%` }}
        />
        <span
          className="coverage-target"
          style={{ left: `${target * 100}%` }}
          title={`Target ${percent(target, 0)}`}
        />
      </div>
      <p>
        Target {percent(target, 0)} · {difference < 0 ? "under" : "over"} by{" "}
        {Math.abs(difference * 100).toFixed(1)} points
      </p>
    </article>
  );
}

function ScoreRow({
  label,
  value,
  max,
  emphasis = false,
}: {
  label: string;
  value: number;
  max: number;
  emphasis?: boolean;
}) {
  return (
    <div className={`score-row${emphasis ? " score-row-emphasis" : ""}`}>
      <span>{label}</span>
      <div className="score-track">
        <span style={{ width: `${(value / max) * 100}%` }} />
      </div>
      <strong>{Math.round(value)}</strong>
    </div>
  );
}

function ActualResultChart({
  actual,
  forecast,
}: {
  actual: number;
  forecast: ForecastQuantiles;
}) {
  const scaleMax = Math.max(actual * 1.08, forecast.p99 * 1.12, 1);
  const position = (value: number) => Math.min(100, (value / scaleMax) * 100);
  const markers = [
    { label: "P50", value: forecast.p50 },
    { label: "P90", value: forecast.p90 },
    { label: "P99", value: forecast.p99 },
  ];

  return (
    <figure
      className="actual-chart"
      aria-label={`Actual output ${actual} tokens; p50 ${forecast.p50}, p90 ${forecast.p90}, p99 ${forecast.p99}`}
    >
      <div className="actual-track">
        <span
          className="actual-zone actual-zone-p50"
          style={{ width: `${position(forecast.p50)}%` }}
        />
        <span
          className="actual-zone actual-zone-p90"
          style={{
            left: `${position(forecast.p50)}%`,
            width: `${position(forecast.p90) - position(forecast.p50)}%`,
          }}
        />
        <span
          className="actual-zone actual-zone-p99"
          style={{
            left: `${position(forecast.p90)}%`,
            width: `${position(forecast.p99) - position(forecast.p90)}%`,
          }}
        />
        {markers.map((marker) => (
          <span
            key={marker.label}
            className="actual-quantile-marker"
            style={{ left: `${position(marker.value)}%` }}
          />
        ))}
        <span
          className="actual-value-marker"
          style={{ left: `${position(actual)}%` }}
        >
          <span>Actual</span>
        </span>
      </div>
      <figcaption>
        {markers.map((marker) => (
          <span
            key={marker.label}
            style={{ left: `${position(marker.value)}%` }}
          >
            {marker.label} {marker.value.toLocaleString()}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

export function AccuracyDashboard({
  forecast,
  modelName,
  thinkingLabel,
  profileScope,
  sampleSize,
  usedFallback,
  groupKey,
}: AccuracyDashboardProps) {
  const [actualTokens, setActualTokens] = useState(1_800);
  const assessment = useMemo(
    () => assessActualOutput(actualTokens, forecast),
    [actualTokens, forecast],
  );
  const improvement = 1 - EVALUATION.learnedLoss / EVALUATION.staticLoss;
  const meanAbsoluteP50Error = medianPinballToMeanAbsoluteError(
    EVALUATION.coverage.p50.loss,
  );
  const p90OneIn = oneInFromCoverage(EVALUATION.coverage.p90.actual);
  const p99OneIn = oneInFromCoverage(EVALUATION.coverage.p99.actual);

  const presets = [
    { label: "Typical", value: forecast.p50 },
    { label: "P90 edge", value: forecast.p90 },
    { label: "P99 edge", value: forecast.p99 },
    { label: "Worst miss", value: 22_551 },
  ];

  return (
    <div className="dashboard-stack">
      <section className="dashboard-hero panel">
        <div>
          <p className="eyebrow">Decision</p>
          <h2>Useful for reservation. Weak at exact length.</h2>
          <p>
            Tested on {EVALUATION.holdoutCalls.toLocaleString()} later calls the
            profile had not seen. The result generalizes to this workload—not to
            every user or every model.
          </p>
        </div>
        <span className="research-status">Profile updated</span>
      </section>

      <section className="metric-grid" aria-label="Accuracy summary">
        <article className="metric-card metric-card-positive">
          <span className="metric-label">Less error than static</span>
          <strong>{percent(improvement, 1)}</strong>
          <small>held-out rolling evaluation</small>
        </article>
        <article className="metric-card">
          <span className="metric-label">Average P50 miss</span>
          <strong>{Math.round(meanAbsoluteP50Error).toLocaleString()}</strong>
          <small>tokens per call, absolute</small>
        </article>
        <article className="metric-card metric-card-watch">
          <span className="metric-label">P90 is exceeded</span>
          <strong>1 in {Math.round(p90OneIn)}</strong>
          <small>wanted 1 in 10</small>
        </article>
        <article className="metric-card">
          <span className="metric-label">P99 is exceeded</span>
          <strong>1 in {Math.round(p99OneIn)}</strong>
          <small>wanted 1 in 100</small>
        </article>
      </section>

      <section className="dashboard-grid">
        <article className="panel score-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Held-out score</p>
              <h2>Error compared with static</h2>
            </div>
            <span className="lower-better">Lower is better</span>
          </div>
          <div className="score-chart">
            <ScoreRow
              label="Static guess"
              value={EVALUATION.staticLoss}
              max={EVALUATION.staticLoss}
            />
            <ScoreRow
              label="User-data profile"
              value={EVALUATION.learnedLoss}
              max={EVALUATION.staticLoss}
              emphasis
            />
          </div>
          <p className="panel-note">
            The learned score ranged from {Math.round(EVALUATION.foldLow)} to{" "}
            {Math.round(EVALUATION.foldHigh)} across time periods. Workload drift
            is still large.
          </p>
        </article>

        <article className="panel coverage-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Promise check</p>
              <h2>Coverage</h2>
            </div>
          </div>
          <div className="coverage-list">
            <CoverageCard label="P50" {...EVALUATION.coverage.p50} />
            <CoverageCard label="P90" {...EVALUATION.coverage.p90} />
            <CoverageCard label="P99" {...EVALUATION.coverage.p99} />
          </div>
        </article>
      </section>

      <section className="panel reality-panel">
        <div className="panel-heading reality-heading">
          <div>
            <p className="eyebrow">Interactive test</p>
            <h2>Compare one actual response</h2>
            <p>
              {modelName} · thinking {thinkingLabel} · {sampleSize.toLocaleString()} samples
            </p>
          </div>
          <span className={`assessment assessment-${assessment.tone}`}>
            {assessment.label}
          </span>
        </div>

        {usedFallback && (
          <div className="fallback-notice" role="status">
            This model has no fitted group. The test is using the broader
            <strong> overall profile</strong>. Choose Opus 5 or Fable 5 to test a
            model-specific forecast.
          </div>
        )}

        <div className="actual-input-row">
          <label>
            Actual output tokens
            <input
              type="number"
              min={0}
              step={1}
              value={actualTokens}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isInteger(value) && value >= 0) setActualTokens(value);
              }}
            />
          </label>
          <div className="preset-buttons" aria-label="Actual output presets">
            {presets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => setActualTokens(preset.value)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <ActualResultChart actual={actualTokens} forecast={forecast} />
        <div className={`assessment-copy assessment-copy-${assessment.tone}`}>
          <strong>{assessment.label}</strong>
          <span>{assessment.detail}</span>
        </div>
        <dl className="actual-deltas">
          <div>
            <dt>Actual</dt>
            <dd>{actualTokens.toLocaleString()}</dd>
          </div>
          <div>
            <dt>vs P50</dt>
            <dd>{(actualTokens - forecast.p50).toLocaleString()} tokens</dd>
          </div>
          <div>
            <dt>vs P90</dt>
            <dd>{(actualTokens - forecast.p90).toLocaleString()} tokens</dd>
          </div>
          <div>
            <dt>vs P99</dt>
            <dd>{(actualTokens - forecast.p99).toLocaleString()} tokens</dd>
          </div>
        </dl>
        <p className="profile-caption">
          Source: {profileScope} · group {groupKey ?? "static fallback"}
        </p>
      </section>

      <section className="dashboard-grid evidence-grid">
        <article className="panel evidence-panel">
          <p className="eyebrow">Where it breaks</p>
          <h2>The loss is concentrated</h2>
          <div className="evidence-number">
            <strong>1%</strong>
            <span>of calls create {percent(EVALUATION.topOnePercentLossShare, 0)} of error</span>
          </div>
          <div className="evidence-number">
            <strong>Write</strong>
            <span>
              {percent(EVALUATION.writeTrafficShare, 1)} of traffic, but{" "}
              {percent(EVALUATION.writeWorstShare, 1)} of the worst misses
            </span>
          </div>
        </article>

        <article className="panel evidence-panel">
          <p className="eyebrow">What improved</p>
          <h2>One prompt signal cleared the gate</h2>
          <div className="evidence-number">
            <strong>Path named</strong>
            <span>selects a path-aware tail learned from this workload</span>
          </div>
          <div className="evidence-number">
            <strong>{EVALUATION.promptDifference.toFixed(1)}</strong>
            <span>
              score change; 95% CI [{EVALUATION.promptCi[0].toFixed(1)}, {EVALUATION.promptCi[1].toFixed(1)}] stays below zero
            </span>
          </div>
        </article>
      </section>

      <p className="dashboard-footnote">
        Evaluation snapshot {new Date(EVALUATION.generatedAt).toLocaleDateString()} ·{" "}
        {EVALUATION.calls.toLocaleString()} uncensored calls · aggregate data only
      </p>
    </div>
  );
}
