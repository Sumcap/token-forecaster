# Semantic turn-total probes (local only)

These read the human prompt TEXT of each turn root and ask whether words and
structure forecast the turn's output-token total better than the shipped
portable feature vector. They exist to answer STATE-OF-PLAY §6.30 and
`docs/SEMANTIC-PLAN.md`.

The text never enters the repository:

```sh
# 1. export turns + cleaned prompt text to the session scratchpad (refuses in-repo paths)
node experiments/evaluation/export-turn-text.mjs --out "$SCRATCH/turns.jsonl"
# 2. run any probe against it (needs python3 with scikit-learn and sentence-transformers)
python3 experiments/evaluation/semantic/probe_folds_pooled.py "$SCRATCH/turns.jsonl" total
python3 experiments/evaluation/semantic/probe_folds_pooled.py "$SCRATCH/turns.jsonl" openerTokens
python3 experiments/evaluation/semantic/probe_folds_structural.py "$SCRATCH/turns.jsonl"
python3 experiments/evaluation/semantic/probe_shrinkage.py "$SCRATCH/turns.jsonl"
python3 experiments/evaluation/semantic/inspect_terms.py "$SCRATCH/turns.jsonl"
```

Population is identical to `probe-turn-total-boost.mjs` (exact turns only,
session-chronological splits). Learners: sklearn `HistGradientBoostingRegressor`
with quantile loss at p50/p90/p99 on `log1p(total)`, min leaf 40, depth 3,
150 iterations, lr 0.05; TF-IDF word 1-2 grams reduced to 48 SVD components;
MiniLM-L6-v2 embeddings reduced to 32 PCA components; kNN-40 empirical
quantiles in embedding space. Differences are graded with the same
session-block bootstrap as every JS probe.

`inspect_terms.py` prints ridge weights for ordinary-word terms only (no paths
or identifiers), so its output can be pasted into a doc.

## Public corpora (`docs/SEMANTIC-PLAN.md` Step A)

The local corpus is one person. To test the semantic claim at ten times the
turns, the same probes run against public turn corpora written in the same
schema, under `experiments/datasets/public/<name>/turns.jsonl` (gitignored;
only `MANIFEST.md` is committed).

```sh
# 1. harvest agent chat histories people committed to public GitHub repos
python3 experiments/evaluation/semantic/harvest_github_chats.py
# 2. add the shipped 38-float feature vector, in place (generic: any harvester)
node experiments/evaluation/semantic/featurize.mjs \
  experiments/datasets/public/github-agent-chats/turns.jsonl
# 3. schema check + shape report (never prints prompt text)
python3 experiments/evaluation/semantic/validate.py \
  experiments/datasets/public/github-agent-chats/turns.jsonl
# 4. any probe, unchanged
python3 experiments/evaluation/semantic/probe_folds_pooled.py \
  experiments/datasets/public/github-agent-chats/turns.jsonl total
```

`harvest_github_chats.py` caches raw blobs under the dataset's `raw/`
directory, so a rerun refetches nothing. `featurize.mjs` calls the real
`derivePromptFeatures` / `portableBoostFeatures` code path, so the metadata
control on a public corpus is the same 38 numbers as locally. Public prompt
text is research input only: it is never committed, printed, or redistributed,
and each source repository's license is recorded per row.

## The shipped base text head (`docs/SEMANTIC-PLAN.md` Stage 1)

`text_hash.py` is the single definition of the hashed feature form — FNV-1a
over UTF-16 code units, `u:<w>` / `b:<w1> <w2>` terms, `2^bits` signed buckets,
`sign(c)·log1p(|c|)`, 2,000-code-unit truncation. `packages/predictor/src/base-text-head.ts`
mirrors it in TypeScript, and `base-text-head.test.ts` holds the two together
against a fixture of synthetic prompts. Change one and you must change both.

```sh
P=experiments/datasets/public/github-agent-chats/turns.jsonl
# 1. Step 0: how small can (hash bits, SVD dims) get before the transfer moves?
python3 experiments/evaluation/semantic/probe_semantic_scale.py sweep \
  --public "$P" --local "$SCRATCH/turns.jsonl" --seeds 2 --label github-agent-chats
# 2. train the head at the chosen size; writes the JSON asset AND the .ts module
python3 experiments/evaluation/semantic/train_base_head.py \
  --public "$P" --bits 13 --dims 48 \
  --out packages/predictor/src/text-head/base-text-head.json
# 3. regenerate the parity fixture from the new asset
python3 experiments/evaluation/semantic/make_parity_fixture.py
# 4. prove the TypeScript evaluator agrees
pnpm --filter @token-forecaster/predictor test
```

`base_head_eval.py` is the Python reference evaluator: it reads the same
quantised asset the TypeScript reads and walks it in the same bucket order, so
the two agree bit for bit rather than merely to a tolerance.
`make_parity_fixture.py` assembles its 200 prompts from a fixed word list,
Portuguese words, paths and code fences under a fixed seed — no corpus text,
public or local, reaches the fixture.
