# Literature review

Research notes for Token Forecaster. The goal is to ground the output-length
forecasting design in the relevant statistics and in the recent LLM
length-prediction literature, and to be explicit about which techniques survive
contact with a black-box API model.

All four papers named in the project brief were located and verified on arXiv
in August 2026; identifiers are given inline. Classic statistics references are
cited from standard literature.

## 1. Prompt-conditioned output-length distributions are heavy-tailed

The foundational observation: a prompt does not determine an output length. At
nonzero temperature (and even at temperature 0 across model versions), the same
prompt induces a distribution over output lengths, and empirically that
distribution is heavy-tailed.

Robust Length Prediction: A Perspective from Heavy-Tailed Prompt-Conditioned
Distributions (arXiv:2604.07931, April 2026) makes this precise. The authors
sample many independent generations per prompt and show the per-prompt length
distribution is consistent with heavy-tailed behavior, meaning a single-sample
"actual length" is a noisy, outlier-prone draw, not ground truth. Their fix is
to construct training targets from multiple generations per prompt: ProD-M
trains on the per-prompt median (robust point prediction) and ProD-D projects
sampled lengths onto a binned histogram used as a soft target (distributional
prediction).

Scheduling LLM Inference with Uncertainty-Aware Output Length Predictions
(arXiv:2604.00499, April 2026) reaches the same conclusion from the serving
side: point estimates do not match the stochastic decoding process, so each
request's length should be fitted with a distribution. They model lengths with
a log-t distribution (heavy-tailed on the log scale) and schedule using CVaR,
i.e. they act on tail risk, not the mean.

Consequences for Token Forecaster:

- Predict quantiles or a distribution, never a single expected length. A mean
  is close to meaningless under heavy tails; p50, p90, and p99 are the honest
  outputs.
- Model in log space (log tokens). Both papers effectively do; heavy tails on
  the raw scale become tractable on the log scale, and it guarantees positive
  predictions.
- When we later collect multiple samples per prompt for calibration data,
  per-prompt medians and histograms (the ProD construction) are better targets
  than single draws.
- Downstream features like budget enforcement should key off tail quantiles
  (a CVaR-flavored decision rule), mirroring 2604.00499.

Earlier serving work is consistent: S3 (Jin et al., 2023, arXiv:2306.06000)
predicts output length buckets to pack batches, and Response Length Perception
and Sequence Scheduling (Zheng et al., 2023, arXiv:2305.13144) has the model
itself estimate response length. Both found even coarse length prediction
valuable, and both predate the distributional framing above.

## 2. Quantile regression

Koenker and Bassett (1978, Econometrica) introduced quantile regression: to
estimate the conditional tau-quantile, minimize the pinball (tilted absolute)
loss, rho_tau(u) = u * (tau - 1{u < 0}). The pinball loss is the key primitive:
it is a proper scoring rule for quantiles, so a model trained with it at
tau = 0.9 learns the conditional p90 directly, with no distributional
assumption.

Practical form for us: gradient boosted trees with pinball loss (quantile
objective in LightGBM/XGBoost, or GradientBoostingRegressor with
loss="quantile"). Train one model per target quantile (0.5, 0.9, 0.99) over
prompt features. Known issues to engineer around:

- Quantile crossing: independently trained quantile models can produce
  p90 < p50 on some inputs. Standard fix is post-hoc sorting (rearrangement,
  Chernozhukov et al. 2010) of the predicted quantiles per input.
- Extreme quantiles (p99) are data-hungry; with small calibration sets, a
  parametric tail (e.g. fit a log-t or lognormal tail above p90) can be more
  stable than a directly regressed p99.

Quantile regression gives sharp, input-conditional intervals but no coverage
guarantee on finite samples. That is what conformal prediction adds.

## 3. Conformal prediction

Split conformal prediction (Vovk, Gammerman, Shafer, Algorithmic Learning in a
Random World, 2005; accessible treatment in Angelopoulos and Bates, A Gentle
Introduction to Conformal Prediction and Distribution-Free Uncertainty
Quantification, arXiv:2107.07511) is the calibration layer:

- Hold out a calibration set of n exchangeable (prompt, actual length) pairs.
- Compute a nonconformity score per pair (for quantile models, the CQR score
  of Romano, Patras, Candes 2019, arXiv:1905.03222: how far the actual falls
  outside the predicted interval).
- Take the ceil((n+1)(1-alpha))/n empirical quantile of scores and pad the
  predicted interval by it.

The guarantee is finite-sample and distribution-free: marginal coverage of at
least 1 - alpha, for any underlying model, as long as calibration and test
points are exchangeable. Caveats that matter for us:

- The guarantee is marginal, not conditional: 90% coverage on average across
  prompts, not for every prompt type. Grouped or Mondrian conformal (calibrate
  per bucket, e.g. per model or per task type) recovers group-conditional
  coverage at the cost of needing samples per group.
- Exchangeability breaks under drift: a new model version, a changed system
  prompt, or a shifted workload invalidates the guarantee. Adaptive conformal
  inference (Gibbs and Candes, 2021, arXiv:2106.00170) handles this by
  adjusting the effective alpha online based on realized coverage errors, and
  is the right default for a tool whose data arrives as a stream. A simpler
  operational stance: use a sliding calibration window, and reset calibration
  on model-version change.
- Conformal needs uncensored actuals. A capped response yields no valid
  nonconformity score for the upper tail (see section 4); censored runs must
  be excluded from, or specially handled in, the calibration set.

Design conclusion: quantile gradient boosting supplies sharpness, conformalized
quantile regression (CQR) supplies validity, adaptive/windowed calibration
supplies drift tolerance. This is the same stack tarmac gestures at (split
conformal over ridge regression) but with quantile base learners and censoring
awareness.

## 4. Right-censored observations

When a response hits `max_tokens`, we observe only that the true length is at
least the cap: a right-censored observation, exactly as in survival analysis
where a patient leaves the study before the event. Treating capped lengths as
ordinary regression targets is wrong in a specific, damaging way: it replaces
large tail values with the cap, biasing every estimator downward precisely in
the upper tail, which is the part of the distribution p90/p99 forecasting
exists to get right. Worse, the bias is feedback-coupled: users set low caps on
prompts they expect to be long, so censoring is not random with respect to the
target.

Survival-analysis framing gives the standard tools:

- Kaplan-Meier (1958) estimates a distribution from censored data
  nonparametrically; the Tobit model (Tobin, 1958) is the classic parametric
  regression under censoring; Cox proportional hazards and modern
  gradient-boosted survival models (e.g. XGBoost AFT, Barnwal et al. 2020)
  give covariate-conditional versions.
- Censored quantile regression exists (Portnoy 2003; Powell 1986) and is the
  theoretically clean match for our quantile stack, though implementations are
  scarcer.
- Conformal prediction under censoring is an active area (e.g. conformalized
  survival analysis, Candes, Lei, Ren 2021, arXiv:2103.09763), useful as a
  reference if we want guarantees on censored calibration data rather than
  discarding it.

Pragmatic MVP plan consistent with this literature:

- Keep uncensored runs as the regression/calibration set.
- Model cap risk as a separate binary classification target: P(length >= cap
  | prompt, cap). A capped run is a positive label for this classifier, so
  censored data is used where it is informative instead of poisoning the
  regression. Context-overflow probability is the same construction against
  the context window minus exact input count.
- Optionally, use censored runs as lower-bound constraints (their length is
  known to exceed the cap) when fitting parametric tails.

## 5. Hidden-state length predictors (and their limits for us)

Two verified papers show that models internally "know" their remaining length:

- Predicting LLM Output Length via Entropy-Guided Representations
  (arXiv:2602.11812, ICLR 2026). Reuses the serving model's own hidden states:
  Entropy-Guided Token Pooling gives accurate static (pre-generation) length
  prediction at negligible cost, and Progressive Length Prediction re-estimates
  remaining length at each decoding step for stochastic one-to-many sampling.
  Also releases ForeLen, a length-prediction benchmark with long-sequence,
  chain-of-thought, and RL data.
- How Much is Left? LLMs Linearly Encode Their Remaining Output Length
  (arXiv:2607.05316, July 2026). Linear probes on frozen hidden states of
  7-8B open-weight models decode total response length from the prompt's last
  hidden state alone, before any token is emitted, and the probe directions
  transfer across datasets. Framed as evidence of a plan-like internal length
  representation.

These are scientifically encouraging: pre-generation length is genuinely
predictable, even linearly, from information available before decoding. But
both require access to hidden states.

## 6. What is and is not implementable for black-box Anthropic models

Not implementable in the MVP:

- Anything reading hidden states, activations, or per-token entropy of the
  target model (2602.11812, 2607.05316). The Anthropic API exposes none of
  this. These methods do not transfer to a black-box setting; they inform the
  statistical framing (length is decodable from prompt-side information, so
  prompt-feature regression is not hopeless) and become directly relevant only
  in a future open-weight backend.
- Per-step remaining-length re-estimation during decoding (PLP-style), except
  crudely via streamed token counts against the forecast.

Implementable, and therefore the MVP design:

- Provider-counted input estimates via `POST /v1/messages/count_tokens`; no
  third-party tokenizer approximation is needed, though final usage may differ
  slightly.
- Prompt-feature and metadata-feature extraction on our side of the API:
  message lengths, task-type signals, requested max_tokens, model id, system
  prompt characteristics, tool availability, stop sequences.
- Quantile gradient boosting on log length with pinball loss (section 2),
  trained on observed uncensored lengths.
- Conformalized quantile regression with a sliding/adaptive calibration
  window, reset on model-version changes (section 3).
- Separate cap-risk and overflow-risk classifiers that consume censored runs
  as labels (section 4).
- Multi-sample target construction (ProD-style medians/histograms) for
  offline calibration datasets where we control generation (section 1).

Verification status: arXiv:2604.07931, arXiv:2604.00499, arXiv:2602.11812, and
arXiv:2607.05316 were all independently located and verified. Koenker-Bassett,
Vovk et al., Romano et al. (CQR), Gibbs-Candes (ACI), Kaplan-Meier, Tobit,
Portnoy/Powell, Candes-Lei-Ren, S3, and Zheng et al. are standard published
works cited from the literature; identifiers given are believed correct but
page-level details were not re-fetched for this note.
