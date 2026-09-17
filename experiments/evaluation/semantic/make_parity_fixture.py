#!/usr/bin/env python3
"""
Generate the committed parity fixture for the TypeScript base text head.

    python3 experiments/evaluation/semantic/make_parity_fixture.py \\
        --asset packages/predictor/src/text-head/base-text-head.json \\
        --out packages/predictor/src/__fixtures__/base-text-head-parity.json

Every prompt in the fixture is SYNTHETIC: assembled by the seeded routine below
out of a fixed English word list, a handful of Portuguese words, punctuation,
repository-shaped paths and code fences.  No corpus text -- public or local --
is read, so nothing a person wrote is committed.

The fixture carries three things:

  prompts  200 synthetic prompts with the Python evaluator's three outputs, on
           the log1p scale, after the monotone clamp;
  hasher   20 strings with every term's (bucket, sign) in emission order, so a
           TypeScript failure can be localised to the hasher rather than the
           trees;
  meta     the asset version, the hash configuration and the longest prompt
           length, which is what the privacy check greps against.
"""

import argparse
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import base_head_eval as ev  # noqa: E402
import text_hash  # noqa: E402

SEED = 20260902

WORDS = """
add also always analyse and answer any api app apply are argument array ask
assert assume async await because before behaviour below branch break bug build
but cache call can case change check class clean cli client close code command
commit compare compile component config connect const context copy correct
count create data database debug default delete dependency deploy describe
design detail did diff directory disable docs document does done down draft
each edit else empty enable endpoint ensure enum error event every example
exact exit expect explain export fail feature fetch field file filter finally
find first fix flag folder for from function generate get git give handle has
header help here hook how idea if implement import improve include index infer
input inside install instead interface into issue json just keep key label
large last later layer let library like limit line link list load local log
long look loop main make many map match maybe measure merge message method
migrate minor missing mock model module more move name need never new next
node not note now null number object of ok on once only open option order
other output over package page parameter parse patch path pattern per plan
please pointer port possible prefer print probably problem process produce
project prompt proper pull push put query queue quick read reason rebase
refactor reference regression remove rename render repeat replace report
request require reset resolve response result return review revert right route
run same scale schema score script search see server service session set setup
should show simple since size skip small solve some sort source split stack
start state static status step still stop store string struct style suite
support sure switch sync table take task team test text than that the then
there these thing think this those thread through time to token tool trace
track train type under undo unit update usage use user value variable verify
version view wait want warn watch way when where which while why will with
without work would write yes yet
""".split()

PORTUGUESE = [
    "agora",
    "arquivo",
    "ação",
    "código",
    "então",
    "faça",
    "não",
    "pacote",
    "por favor",
    "próximo",
    "revisão",
    "só",
    "também",
    "versão",
]

PATHS = [
    "src/index.ts",
    "packages/predictor/src/boosted.ts",
    "docs/SEMANTIC-PLAN.md",
    "apps/extension/build.mjs",
    "experiments/evaluation/semantic/text_hash.py",
    "README.md",
    "package.json",
    ".github/workflows/ci.yml",
    "tests/unit/parser_test.py",
    "lib/http-client/retry.rs",
]

FENCE_LANGS = ["ts", "python", "sh", "json", "rust", ""]

PUNCT = [".", ",", "!", "?", ":", ";", " --", " ...", ")", "'"]


def sentence(rng, length):
    parts = []
    for _ in range(length):
        roll = rng.random()
        if roll < 0.06:
            parts.append(rng.choice(PATHS))
        elif roll < 0.10:
            parts.append(rng.choice(PORTUGUESE))
        elif roll < 0.13:
            parts.append(str(rng.randint(0, 4096)))
        elif roll < 0.15:
            parts.append(rng.choice(WORDS).upper())
        else:
            parts.append(rng.choice(WORDS))
    text = " ".join(parts)
    if rng.random() < 0.35:
        text = text.replace(" ", "_", 1)
    return text + rng.choice(PUNCT)


def code_fence(rng):
    lang = rng.choice(FENCE_LANGS)
    lines = [
        f"  {rng.choice(WORDS)}({rng.choice(WORDS)}, {rng.randint(0, 99)});"
        for _ in range(rng.randint(1, 5))
    ]
    return "```" + lang + "\n" + "\n".join(lines) + "\n```"


def bullet_list(rng):
    return "\n".join(
        f"- {sentence(rng, rng.randint(3, 12))}" for _ in range(rng.randint(2, 6))
    )


def synthetic_prompt(rng, index):
    """Deliberately spans the shapes the hasher has to survive."""
    kind = index % 10
    if kind == 0:  # very short
        return sentence(rng, rng.randint(1, 3))
    if kind == 1:  # one long line, no structure
        return sentence(rng, rng.randint(40, 90))
    if kind == 2:  # bullets
        return sentence(rng, rng.randint(4, 10)) + "\n" + bullet_list(rng)
    if kind == 3:  # code fence
        return sentence(rng, rng.randint(3, 10)) + "\n" + code_fence(rng)
    if kind == 4:  # repetition, so bucket counts exceed one
        word = rng.choice(WORDS)
        return " ".join([word] * rng.randint(3, 20)) + " " + sentence(rng, 6)
    if kind == 5:  # paths only
        return " ".join(rng.choice(PATHS) for _ in range(rng.randint(2, 8)))
    if kind == 6:  # Portuguese-leaning
        return " ".join(rng.choice(PORTUGUESE) for _ in range(rng.randint(4, 14)))
    if kind == 7:  # past the truncation boundary
        return "\n\n".join(sentence(rng, rng.randint(30, 60)) for _ in range(rng.randint(8, 14)))
    if kind == 8:  # punctuation-heavy / mixed case
        return " ".join(
            rng.choice(WORDS).title() + rng.choice(PUNCT) for _ in range(rng.randint(5, 20))
        )
    paragraphs = [sentence(rng, rng.randint(6, 20)) for _ in range(rng.randint(1, 4))]
    if rng.random() < 0.5:
        paragraphs.insert(rng.randint(0, len(paragraphs)), code_fence(rng))
    return "\n\n".join(paragraphs)


HASHER_EDGE_CASES = [
    "",
    "   ",
    "!!! ??? ...",
    "ok",
    "ok ok ok",
    "OK Ok oK",
    "src/index.ts",
    "_private-name.v2",
    "não faça isso",
    "café com açúcar",
    "fix these: docs/SEMANTIC-PLAN.md and packages/predictor/src/boosted.ts",
    "a b a b a b",
    "42 0 007",
    "```ts\nconst x = 1;\n```",
    "let's do it -- afterwards, reply with the diff",
    "TOKEN_FORECASTER_HOME=/tmp/tf",
    "one\ntwo\nthree",
    "hyphen-word slash/word dot.word under_word",
]


def hasher_case(text, bits, truncate):
    hashes = text_hash.document_hashes(text, truncate)
    words = text_hash.tokenize(text, truncate)
    # Emission order in TypeScript is interleaved: u(i), then b(i-1, i).
    terms = []
    for i in range(len(words)):
        terms.append(int(hashes[i]))
        if i > 0:
            terms.append(int(hashes[len(words) + i - 1]))
    mask = (1 << bits) - 1
    return [
        {"bucket": h & mask, "sign": -1 if h & 0x80000000 else 1} for h in terms
    ]


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--asset", default="packages/predictor/src/text-head/base-text-head.json"
    )
    ap.add_argument(
        "--out", default="packages/predictor/src/__fixtures__/base-text-head-parity.json"
    )
    ap.add_argument("--count", type=int, default=200)
    a = ap.parse_args()

    asset = ev.load_asset(a.asset)
    deq = ev.dequantise(asset)
    truncate = asset["truncateChars"]
    bits = asset["bits"]

    rng = random.Random(SEED)
    prompts = []
    clamped = 0
    for index in range(a.count):
        text = synthetic_prompt(rng, index)
        x = ev.project(asset, text, deq)
        raw = [
            head["baseline"] + sum(ev.walk(t, x) for t in head["trees"])
            for head in asset["heads"]
        ]
        if raw[1] < raw[0] or raw[2] < max(raw[0], raw[1]):
            clamped += 1
        prompts.append({"text": text, "head": ev.evaluate(asset, text, _dequantised=deq)})

    cases = HASHER_EDGE_CASES + [prompts[i]["text"] for i in (1, 4)]
    assert len(cases) == 20, f"expected 20 hasher cases, got {len(cases)}"

    fixture = {
        "generator": f"experiments/evaluation/semantic/make_parity_fixture.py seed={SEED}",
        "note": "Every prompt here is synthetic. No corpus text, public or local.",
        "assetVersion": asset["version"],
        "bits": bits,
        "dims": asset["dims"],
        "truncateChars": truncate,
        "longestPromptChars": max(len(p["text"]) for p in prompts),
        "clampedPrompts": clamped,
        "prompts": prompts,
        "hasher": [
            {"text": text, "bits": bits, "terms": hasher_case(text, bits, truncate)}
            for text in cases
        ],
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(fixture, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print(
        f"wrote {a.out}: {len(prompts)} prompts "
        f"(longest {fixture['longestPromptChars']} chars, {clamped} needed the clamp), "
        f"{len(fixture['hasher'])} hasher cases"
    )


if __name__ == "__main__":
    main()
