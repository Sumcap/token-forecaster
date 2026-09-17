#!/usr/bin/env python3
"""
Steps 0-2 of docs/CONTEXT-SIGNALS-PLAN.md: do PRE-CALL context signals -- what
the session has already touched (S) and what the repository looks like (R) --
beat the shipped 38-column metadata model on turn totals, and what is the
post-hoc oracle ceiling above them?

Everything here is aggregates. No prompt text, no path, no branch name and no
repository name exists in the input file, let alone in the output.

    python3 probe_context.py <context-turns.jsonl> [--seeds 3] [--folds 5]

The learner, the pinball loss, the five chronological session folds and the
session-block bootstrap are imported from probe_semantic_scale.py so the numbers
are directly comparable with the 2-3 September semantic tables.

Results are merged into experiments/artifacts/context-signals.json under the
`context` key, with the same O_EXCL-locked read-modify-write that
probe_semantic_scale.save uses (copied rather than imported, because that helper
is bound to its own artifact path).
"""

import argparse
import json
import os
import sys
import time
import warnings
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

warnings.filterwarnings("ignore")

from sklearn.ensemble import HistGradientBoostingRegressor  # noqa: E402

from probe_semantic_scale import (  # noqa: E402
    K_FOLDS,
    Q,
    block_boot,
    folds_of,
    gbm,
    log,
    loss_rows,
    print_table,
    summarise,
)

META_COLS = 38
HERE = os.path.dirname(os.path.abspath(__file__))
ARTIFACT = os.path.normpath(
    os.path.join(HERE, "..", "..", "artifacts", "context-signals.json")
)
SECTION = "context"
LOPO_MIN_ROWS = 50


# --------------------------------------------------------------------------- io


def save(key, payload):
    """Merge one entry into the artifact under `context`, lock-guarded."""
    os.makedirs(os.path.dirname(ARTIFACT), exist_ok=True)
    lock = ARTIFACT + ".lock"
    for _ in range(600):
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            break
        except FileExistsError:
            time.sleep(0.5)
    try:
        data = {}
        if os.path.exists(ARTIFACT):
            try:
                data = json.load(open(ARTIFACT))
            except Exception:
                data = {}
        data.setdefault("generatedAt", [])
        data["generatedAt"] = [
            t for t in data["generatedAt"] if not t.startswith(f"{SECTION}:{key} ")
        ]
        data["generatedAt"].append(
            f"{SECTION}:{key} {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}"
        )
        data.setdefault(SECTION, {})[key] = payload
        json.dump(data, open(ARTIFACT, "w"), indent=1, sort_keys=True)
        log(f"wrote {SECTION}.{key} -> {ARTIFACT}")
    finally:
        try:
            os.unlink(lock)
        except OSError:
            pass


def load_context(path, columns_path=None):
    rows = [json.loads(l) for l in open(path) if l.strip()]
    assert rows, f"{path}: no rows"
    y = np.array([r["total"] for r in rows], float)
    X = np.array([r["features"] for r in rows], float)
    assert X.shape[1] == META_COLS, f"expected {META_COLS} control columns, got {X.shape[1]}"
    S = np.array([r["s"] for r in rows], float)
    R = np.array([r["r"] for r in rows], float)
    O = np.array([r["o"] for r in rows], float)
    sess = np.array([r["sessionId"] or f"u:{r['turnRootId']}" for r in rows])
    work = np.array([r.get("workloadId") or "?" for r in rows])
    first = {}
    for i, r in enumerate(rows):
        first.setdefault(sess[i], r["firstMs"])
    order = sorted(first, key=first.get)
    names = {"s": None, "r": None, "o": None}
    if columns_path and os.path.exists(columns_path):
        meta = json.load(open(columns_path))
        names = {k: meta.get(k) for k in ("s", "r", "o")}
    for key, block in (("s", S), ("r", R), ("o", O)):
        if names[key] is None:
            names[key] = [f"{key}_{i}" for i in range(block.shape[1])]
        assert len(names[key]) == block.shape[1], f"{key}: name/column mismatch"
    return dict(
        y=y, X=X, S=S, R=R, O=O, sess=sess, work=work, order=order,
        n=len(rows), names=names,
    )


# ------------------------------------------------------------------------ arms


def arms_of(D):
    """name -> the column block appended to the 38 control columns."""
    return {
        "control": None,
        "oracle": ("O",),
        "S": ("S",),
        "R": ("R",),
        "S+R": ("S", "R"),
        "S+R+oracle": ("S", "R", "O"),
    }


def design(D, arm, mask):
    parts = [D["X"][mask]]
    for block in arms_of(D)[arm] or ():
        parts.append(D[block][mask])
    return np.hstack(parts)


def gates_of(res, ref_name):
    out = {}
    for name, r in res.items():
        if name == ref_name:
            continue
        ci_below = r["ci"][1] < 0
        worst = max(r["per_fold_pct"])
        out[name] = dict(
            ci_below_zero=bool(ci_below),
            worst_fold_pct=float(worst),
            no_fold_worse_than_5pct=bool(worst <= 5.0),
            pass_=bool(ci_below and worst <= 5.0),
        )
    return out


# -------------------------------------------------------------------- main run


def run_folds(D, seeds, k_folds):
    blocks = folds_of(D["order"], k_folds)
    y, sess = D["y"], D["sess"]
    arms = list(arms_of(D))

    acc = defaultdict(list)
    per_fold = defaultdict(list)
    grp = []
    fold_sizes = []
    # pooled per-row losses, kept for the permutation-importance pass

    for k in range(k_folds):
        t0 = time.time()
        ho = set(blocks[k])
        te = np.array([s in ho for s in sess])
        tr = ~te
        assert te.sum() > 0, f"fold {k} is empty"
        assert tr.sum() > 0, f"fold {k} leaves no training rows"
        fold_sizes.append(dict(train=int(tr.sum()), test=int(te.sum()), sessions=len(ho)))
        log(f"  fold {k}: train {tr.sum()} test {te.sum()} rows, {len(ho)} sessions")
        fl = defaultdict(list)
        for seed in range(seeds):
            for arm in arms:
                p = gbm(design(D, arm, tr), y[tr], design(D, arm, te), seed)
                L = loss_rows(y[te], np.maximum(p, 0.0))
                acc[arm].append(L)
                fl[arm].append(L.mean())
            grp.append(sess[te])
        for arm in arms:
            per_fold[arm].append(float(np.mean(fl[arm])))
        log(f"  fold {k} done in {time.time() - t0:.0f}s")

    groups = np.concatenate(grp)
    res = summarise(acc, groups, "control", per_fold)
    return res, groups, fold_sizes, blocks


def permutation_importance(D, arm, seeds, k_folds, blocks, rng_seed=0):
    """
    Permutation drop on the POOLED HOLDOUT: refit the arm per fold/seed, then
    shuffle one added column at a time inside the held-out block and re-score.
    Positive = the arm gets worse without the column, i.e. the column helped.
    """
    added = []
    for block in arms_of(D)[arm] or ():
        added += [(block, i, name) for i, name in enumerate(D["names"][block.lower()])]
    if not added:
        return {}
    y, sess = D["y"], D["sess"]
    drops = defaultdict(list)
    base_losses = []
    rng = np.random.default_rng(rng_seed)
    for k in range(k_folds):
        ho = set(blocks[k])
        te = np.array([s in ho for s in sess])
        tr = ~te
        Xtr = design(D, arm, tr)
        Xte = design(D, arm, te)
        for seed in range(seeds):
            models = []
            for p in Q:
                models.append(
                    HistGradientBoostingRegressor(
                        loss="quantile",
                        quantile=p,
                        max_iter=150,
                        learning_rate=0.05,
                        max_depth=3,
                        min_samples_leaf=40,
                        l2_regularization=1.0,
                        random_state=seed,
                    ).fit(Xtr, np.log1p(y[tr]))
                )

            def score(M):
                preds = np.column_stack([np.expm1(m.predict(M)) for m in models])
                return loss_rows(y[te], np.maximum(preds, 0.0)).mean()

            base = score(Xte)
            base_losses.append(base)
            for j, (_, _, name) in enumerate(added):
                col = META_COLS + j
                for rep in range(3):
                    P = Xte.copy()
                    P[:, col] = P[rng.permutation(P.shape[0]), col]
                    drops[name].append(score(P) - base)
    base_mean = float(np.mean(base_losses))
    out = {
        name: dict(
            drop=float(np.mean(v)),
            pct=100 * float(np.mean(v)) / base_mean,
            sd=float(np.std(v)),
        )
        for name, v in drops.items()
    }
    return dict(arm=arm, base_loss=base_mean, columns=out)


def run_lopo(D, seeds):
    """Leave-one-project-out over workloadId: control vs the R arm. Informs only."""
    work = D["work"]
    y, sess = D["y"], D["sess"]
    out = {}
    for w in sorted(set(work)):
        te = work == w
        if te.sum() < LOPO_MIN_ROWS:
            continue
        tr = ~te
        if tr.sum() < 200:
            continue
        ctrl, rarm = [], []
        for seed in range(seeds):
            pc = gbm(design(D, "control", tr), y[tr], design(D, "control", te), seed)
            pr = gbm(design(D, "R", tr), y[tr], design(D, "R", te), seed)
            ctrl.append(loss_rows(y[te], np.maximum(pc, 0.0)))
            rarm.append(loss_rows(y[te], np.maximum(pr, 0.0)))
        c = np.concatenate(ctrl)
        r = np.concatenate(rarm)
        g = np.concatenate([sess[te]] * seeds)
        d, lo, hi = block_boot(r - c, g)
        base = float(c.mean())
        out[w] = dict(
            rows=int(te.sum()),
            sessions=int(len(set(sess[te]))),
            control_loss=base,
            r_loss=float(r.mean()),
            delta=d,
            ci=[lo, hi],
            pct=100 * d / base,
            pct_ci=[100 * lo / base, 100 * hi / base],
        )
        print(
            f"  {w[:8]}… n={te.sum():5d} sess={len(set(sess[te])):4d} "
            f"control={base:9.0f} R={r.mean():9.0f} {d:+9.0f} "
            f"[{lo:+9.0f},{hi:+9.0f}] ({100 * d / base:+.1f}%)"
        )
    return out


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("path")
    ap.add_argument("--columns", default=None, help="context-columns.json from the exporter")
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--folds", type=int, default=K_FOLDS)
    ap.add_argument("--label", default="local")
    a = ap.parse_args()

    t_start = time.time()
    D = load_context(a.path, a.columns)
    projects = len(set(D["work"]))
    log(
        f"{a.label}: {D['n']} turns, {len(D['order'])} sessions, {projects} projects, "
        f"{a.folds} folds x {a.seeds} seeds"
    )
    log(
        f"columns: control {META_COLS}, S {D['S'].shape[1]}, R {D['R'].shape[1]}, "
        f"oracle {D['O'].shape[1]}"
    )

    res, groups, fold_sizes, blocks = run_folds(D, a.seeds, a.folds)
    print(f"\n=== {a.label}: pooled holdout rows {len(groups)}, "
          f"{a.folds} folds x {a.seeds} seeds ===")
    print_table(res, "control")
    gates = gates_of(res, "control")
    print("\ngates (whole 95% CI below zero AND no fold worse than +5%):")
    for name, g in gates.items():
        print(f"  {name:12s} ci_below_zero={g['ci_below_zero']!s:5s} "
              f"worst_fold={g['worst_fold_pct']:+.1f}%  -> {'PASS' if g['pass_'] else 'FAIL'}")

    ceiling = -res["oracle"]["pct"]
    print(f"\nStep 0 oracle ceiling: {ceiling:.2f}% improvement "
          f"({'stop rule NOT fired' if ceiling >= 5 else 'STOP RULE FIRED (<5%)'})")

    print("\nleave-one-project-out (workloadId), control vs R -- informs, does not gate:")
    lopo = run_lopo(D, a.seeds)

    best = min(
        (n for n in res if n not in ("control", "oracle", "S+R+oracle")),
        key=lambda n: res[n]["loss"],
    )
    print(f"\npermutation importance, arm '{best}' (pooled holdout, 3 shuffles per column):")
    imp = permutation_importance(D, best, a.seeds, a.folds, blocks)
    for name, v in sorted(imp["columns"].items(), key=lambda kv: -kv[1]["drop"]):
        print(f"  {name:24s} {v['drop']:+9.1f}  ({v['pct']:+.2f}%)")

    print("\npermutation importance, arm 'oracle' (for the ceiling's own story):")
    imp_o = permutation_importance(D, "oracle", a.seeds, a.folds, blocks)
    for name, v in sorted(imp_o["columns"].items(), key=lambda kv: -kv[1]["drop"]):
        print(f"  {name:24s} {v['drop']:+9.1f}  ({v['pct']:+.2f}%)")

    payload = dict(
        label=a.label,
        rows=D["n"],
        sessions=len(D["order"]),
        projects=projects,
        pooled_holdout_rows=int(len(groups)),
        folds=a.folds,
        seeds=a.seeds,
        fold_sizes=fold_sizes,
        columns=D["names"],
        control_loss_per_turn=float(res["control"]["loss"]),
        oracle_ceiling_pct=float(ceiling),
        step0_stop_rule_fired=bool(ceiling < 5.0),
        models=res,
        gates=gates,
        leave_one_project_out_R=lopo,
        permutation_importance=imp,
        permutation_importance_oracle=imp_o,
        wall_clock_seconds=float(time.time() - t_start),
        note=(
            "population is EVERY exact turn (no prompt-text filter); control is the "
            "38-column v3 metadata GBM on the same rows, same learner, same seeds"
        ),
    )
    save(f"step2:{a.label}", payload)


if __name__ == "__main__":
    main()
