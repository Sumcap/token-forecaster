# Follow-up prompt

> **5 August correction — this supersedes the stopping conclusion below.**
> The prompt ancestry join treated injected `isMeta` skill rows as new human
> turns, which erased the real prompt on many of the exact long artifact calls
> we cared about. After making those rows transparent, prompt coverage rose
> **68.0% → 89.9%**. The `promptPath` ladder now beats model+thinking by
> **−10.9 pinball/call, 95% CI [−21.9, −0.4]** and is shipped. Single-split
> coverage is now P50 **48.8%**, P90 **89.2%**, P99 **98.9%**. The broader kill
> condition still fires because combined prompt R² is **0.244 < 0.25**, and the
> prompt still does not predict `Write` directly (best verb lift 1.19×).
>
> Code shipped with the correction: `isMeta` ancestry regression test; the
> privacy-safe `promptMentionsPath()` helper and request/schema field; a gated
> evaluator candidate with pooled sparse-cell backoff; 24-group generated
> profile; playground wiring and refreshed accuracy dashboard. The historical
> 4 August account below is retained to show how the wrong conclusion arose.

**Supersedes the 4 August (morning) version of this file, whose TASK 1–4 are all
now resolved.** Nothing from it needs re-reading; this file records what those
tasks returned and what — if anything — is left.

---

## What happened (4 August 2026, evening)

All four tasks ran. Two of them landed hard, in opposite directions, and
together they close the programme.

### TASK 1 — the oracle measurement was broken. Confirmed and fixed.

The published ceiling ("an oracle told the true tool is worth −49/call, ~8%")
**was a `MIN_GROUP = 100` artifact, exactly as the review claimed.** `Write` is
~3% of the corpus, so per fold exactly **one of six** (model, thinking) cells
clears the floor for it — `claude-fable-5|t=yes`, the model that has left recent
traffic. The oracle was falling straight back to the shipped predictor on
**68% of held-out `Write` calls**.

Reviewer's numbers, reproduced at the current endpoint:

| | reviewer | reproduced |
|---|---|---|
| 7-way tool, joint rung only | −47.1 ± 7.5 | **−46.3** [−61.7, −32.2] |
| 7-way tool, + pooled rung | −121.5 ± 33.4 | **−123.1** [−179.8, −73.8] |
| binary "is this a `Write`?" | −79.7 ± 27.8 | **−78.7** [−131.5, −33.9] |

**The falsification was run at 12 endpoints, not one, and it came back mixed —
read this part carefully:**

- **The mechanism replicates 12/12.** Joint-only is informed on 23–43% of
  held-out `Write` calls at every endpoint; pooled on 100% at every endpoint.
- **The direction replicates 10/12** (the two exceptions are ties within
  1.3/call).
- **The point estimate −121 does NOT replicate.** Pooled ranges −50.6 to −125.5,
  median **−89.8**.
- **But −49 is refuted by the same evidence**, so §7.2 was *not* reverted to it
  as the pre-commitment said. Joint-only slides **−108 → −44** as the corpus
  grows, because the one cell clearing the floor belongs to a departing model.
  −49 is the most recent and most suppressed reading of a sliding number.
- Independent corroboration: the mixture oracle against the *marginal* (§6.12)
  reads −112.6 and never had a joint rung to suppress.

**Ceiling now quoted as ~−90/call, ~17% of shipped loss, range −50 to −126.**
A binary `Write` detector is worth **71% of it** (median; 62–98%).

### TASK 2 — the actual hypothesis was tested. The kill condition fired.

Turn-root prompt features, joined onto **68.0%** of calls (not 8.8%) by
propagating each turn's human message onto all its descendants.

| | |
|---|---|
| best ladder vs shipped | **−6.2/call, 95% CI [−16.0, +4.4]** |
| R² on log Y with prompt features | **0.237** vs a pre-committed 0.25 |
| **kill condition** | 🔴 **FIRES** |

Most prompt ladders are *worse* than shipped. R² ladder: marginal 0.000 →
model+thinking 0.184 → +all metadata ever tried 0.227 → **+prompt 0.237** →
oracle 0.384. Prompt features alone: **0.011**.

**The one real finding, and it is worth keeping:** the null is not flat. Prompt
features alone explain R² **0.251 at depth 0** and **0.005 at depth 3+**. The
prompt predicts the turn's *first* reply and has decayed to nothing a few steps
into the loop. That gain survives the (day, model) gate that killed `effort`
(+0.070 → +0.057). It could not be demonstrated out-of-sample because only
**104 turn-openers** reach the holdout — a sample at which the *oracle* itself
cannot be demonstrated ([−146.6, +85.0]).

### TASK 3 — not built, because TASK 2 removed its input.

The prompt cannot see a `Write` coming. Against a 3.2% base rate, verb class
`write` gives **3.7% — a 1.17× lift** on a class that is 9.8× over-represented
among the worst misses. Every other candidate input was already ruled out.

### TASK 4 — salvage, and stop. Written up in STATE-OF-PLAY §7.6.

---

## What shipped in code

- **`lib/stats.mjs`** now owns `blockBootstrapDifference` / `bootstrapBlocks`
  (moved out of the eval, which imports them) plus `rSquaredOrthogonal`. The
  eval and every probe now grade with **one** statistic — a probe reporting a
  5-fold t while the eval reported a bootstrap CI is how the same effect got
  adopted and refused twenty minutes apart.
- **`probe-loop-depth.mjs`**: pooled oracle rung, binary-`Write` oracle,
  rung-firing diagnostics, `--min-group`, `--as-of`, minGroup sweep, and block
  bootstrap throughout (`legacyFold*` retained on every comparison).
- **`probe-oracle-endpoints.mjs`** *(new)*: replicates the ceiling across N
  corpus endpoints by shelling out to the probe rather than reimplementing it.
- **`probe-prompt-features.mjs`** *(new)*: the TASK 2 experiment.
- **`lib/load-history.mjs`**: `withPromptFeatures` derives prompt features and
  discards the text in the same pass the character counts are discarded in;
  `resolveLoopContext` propagates the turn-root prompt down the loop.
- **House rules 12–14** added, all three paid for by this session.

---

## Historical 4 August stopping advice (superseded)

> This section records the decision made with the broken 68.0%-coverage join.
> It is not the current recommendation; the 5 August correction at the top is.

**Do not start by adding features.** Every branch of §7 is closed and §7.6 says
why. Start by checking one number:

> **How many independent human TURNS does the corpus contain?**

That is the effective sample for the only live lead — the depth-0 prompt effect,
which is real and merely undemonstrable at n = 104 held-out turn-openers. The
corpus grows by thousands of *calls* a week and that buys nothing here. A few
thousand more *human messages* would settle it either way.

Everything else is genuinely finished:

- ❌ **Metadata is exhausted.** 16 ledger entries; two shipped.
- ❌ **The prompt is exhausted**, at least as bag-of-features. A semantic
  encoder is the only untried form, and it must clear the same bar: a 95% CI
  below zero on the block bootstrap, and R² past 0.25.
- ✅ **The ceiling is now known and correctly measured** — ~17% of shipped loss,
  71% of it reachable by a binary `Write` bit. If any future feature predicts
  `Write` with real lift, the prize is waiting and priced.
- ⚠️ **Still unchased, all pre-existing and none urgent:** `buildHistoricalProfile()`
  materialises `prevOutput` groups ungated (the gate lives only in the eval);
  the merged 3-bucket variant is not adoptable until `previousOutputBucket()`
  learns the merge; at that snapshot, **P90 coverage had drifted 90.2 → 88.6 →
  87.4% monotonically and nobody had chased it**; `probe-action-type.mjs` only writes
  JSON with `--json` and `probe-latent-structure.mjs` writes none.

---

## What would make this worth restarting

- **The corpus gains thousands of human turns** (not calls) — the depth-0 lead
  becomes testable.
- **A feature predicts `Write` with a lift above ~3×.** The prize is priced at
  ~17% of shipped loss and 71% of it is one bit.
- **Phase 3 telemetry lands with a deliberately low `max_tokens`**, making cap
  risk fittable for the first time — zero of 14,843 calls were censored in that
  4 August snapshot.
- **The workload changes shape.** Everything here is conditional on one user's
  agent traffic, ~293 sessions, 3 models, one of which has already left.
