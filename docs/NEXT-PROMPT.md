# Follow-up prompt — the sheep-manager port

> **Paste this into a fresh session.** Written 11 August 2026 (early), after
> the session-totals session. The previous version is archived at
> `docs/archive/NEXT-PROMPT-2026-08-10-night.md`; its task is resolved into
> STATE-OF-PLAY §6.26.

---

You are picking up the output-token forecaster in this repo. The corpus work
is DONE for now — §6.26 closed the last open modeling question at this
corpus size. The next move is the port into the sheep-manager repo, plus the
standing gate watches. Read before inventing work.

## Read first, in this order

1. `docs/STATE-OF-PLAY.md` — the 10 Aug (night) header block, §6.26
   (session totals: unconditional shipped, kill condition fired, remaining
   is memoryless — do not subtract spent), §8 house rules. **Do not
   re-propose anything in §6 without qualitatively new evidence.**
2. Memory: `sheep-manager-port-telemetry.md` and `cold-start-first-design.md`
   — the port wires live telemetry (incl. `expectedOutputKind`) only at the
   sheep-manager import; cold-start tiers are first-class, telemetry never
   load-bearing.
3. `docs/TELEMETRY.md` — the `expectedOutputKind` contract the port enables.

## Where the model stands (10 Aug night regeneration, corpus ~16,010 calls)

- Per call: static 885 → base ladder 513 → **boosted 489.3** (−23.8
  [−34.0, −15.9]). Boost = `portable-precall-v2`, depth 3 / 48 iters /
  lr 0.08.
- Per turn: `historicalTurnTotalForecast()` — `overall` + `thinking=yes|no`
  (P50 4,878 / P90 31,132 / P99 101,983).
- Per session: `historicalSessionTotalForecast()` — `overall` only
  (P50 21,075 / P90 117,016 / P99 223,033, n=311). Unconditional on
  purpose; consumers must re-read, never subtract spent (§6.26).
- Ceiling: ~405/call with a perfect tool oracle. Below that requires
  caller-declared `expectedOutputKind` (TELEMETRY.md), which the port is
  the first chance to collect.

## The task: port to sheep-manager

Follow `sheep-manager-port-telemetry.md`. The deliverable is the predictor
package consumed from the sheep-manager repo with live telemetry wired at
the import boundary. Cold-start behavior is the acceptance bar: the
predictor must produce sane forecasts with zero context before any
telemetry lands.

## Standing gate watches (no action unless they fire)

- **`promptImage`** — self-adopting, last read −3.95 [−10.57, +0.75]. If a
  regeneration prints ADOPTED, update §6.23 and the README contract.
- **`promptPath` / `prevOutput`** — same machinery, same rule. Never
  hand-restore.

## Guardrails

- House rules §8 all apply. Corpus work is closed until the session count
  (~300) roughly doubles — §6.26, house rule 14.
- The corpus is live; absolute numbers drift between regenerations. Paired
  comparisons are the only stable statements.
- Aggregates only in committed artifacts (house rule 9).

## Commands

```sh
pnpm build && pnpm evaluate:claude-history   # regenerate everything shipped
node experiments/evaluation/probe-session-totals.mjs [--as-of <instant>]
node experiments/evaluation/probe-turn-totals.mjs [--as-of <instant>]
pnpm -r test
```
