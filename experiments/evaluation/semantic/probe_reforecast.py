#!/usr/bin/env python3
"""
docs/REFORECAST-PLAN.md: does re-forecasting the turn TOTAL once k calls have
completed beat the frozen pre-call number by enough to earn a trainer task?

Grades five arms per k in {1, 2, 3, 5}: precall (the shipped 38-column
control, unchanged), clamp (precall floored at outputSoFar -- the control the
gate is against), reforecast (38+K -> log1p(total)), remaining (38+K ->
log1p(total - outputSoFar), added back -- the named candidate) and oracle
(38+K+O, never shippable). Same learner, same five chronological session
folds and the same session-block bootstrap as every other probe here,
imported from probe_semantic_scale.py so the numbers are comparable.

Everything here is aggregates. No prompt text and no path exists in the input
file, let alone the output.

    python3 probe_reforecast.py <reforecast-turns.jsonl> [--columns FILE] [--seeds 3]

Results are merged into experiments/artifacts/reforecast.json under the
`reforecast` key, with the same O_EXCL-locked read-modify-write
probe_context.py uses (copied rather than imported, because that helper is
bound to its own artifact path).
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
    log,
    loss_rows,
    print_table,
    summarise,
)

META_COLS = 38
K_COLS = 7
O_COLS = 2
K_STEPS = [1, 2, 3, 5]
HERE = os.path.dirname(os.path.abspath(__file__))
ARTIFACT = os.path.normpath(os.path.join(HERE, "..", "..", "artifacts", "reforecast.json"))
SECTION = "reforecast"

# k=1 needs -10%, k>=3 needs -15% (docs/REFORECAST-PLAN.md, "Gates").
POINT_THRESHOLD_PCT = {1: -10.0, 2: -10.0, 3: -15.0, 5: -15.0}


# --------------------------------------------------------------------------- io


def save(key, payload):
    """Merge one entry into the artifact under `reforecast`, lock-guarded."""
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


def load_reforecast(path, columns_path=None):
    rows = [json.loads(l) for l in open(path) if l.strip()]
    assert rows, f"{path}: no rows"
    turn = np.array([r["turnRootId"] for r in rows])
    sess = np.array([r["sessionId"] or f"u:{r['turnRootId']}" for r in rows])
    work = np.array([r.get("workloadId") or "?" for r in rows])
    first_ms = np.array([r["firstMs"] for r in rows], float)
    k = np.array([r["k"] for r in rows], int)
    y = np.array([r["total"] for r in rows], float)
    calls = np.array([r["calls"] for r in rows], int)
    X = np.array([r["features"] for r in rows], float)
    assert X.shape[1] == META_COLS, f"expected {META_COLS} control columns, got {X.shape[1]}"
    K = np.array([r["K"] for r in rows], float)
    assert K.shape[1] == K_COLS, f"expected {K_COLS} K columns, got {K.shape[1]}"
    O = np.array([r["O"] for r in rows], float)
    assert O.shape[1] == O_COLS, f"expected {O_COLS} O columns, got {O.shape[1]}"
    osf = np.array([r["outputSoFar"] for r in rows], float)

    first = {}
    for i in range(len(rows)):
        first.setdefault(sess[i], first_ms[i])
    order = sorted(first, key=first.get)

    names = {"k": None, "o": None}
    if columns_path and os.path.exists(columns_path):
        meta = json.load(open(columns_path))
        names = {"k": meta.get("k"), "o": meta.get("o")}
    if names["k"] is None:
        names["k"] = [f"k_{i}" for i in range(K_COLS)]
    if names["o"] is None:
        names["o"] = [f"o_{i}" for i in range(O_COLS)]

    return dict(
        turn=turn, sess=sess, work=work, k=k, y=y, calls=calls,
        X=X, K=K, O=O, osf=osf, order=order, n=len(rows), names=names,
    )


# ------------------------------------------------------------------ quantile GBM
#
# `gbm()` in probe_semantic_scale.py fits and predicts in one call, discarding
# the models -- fine for an arm that is scored once. The precall control here
# is fit ONCE per (fold, seed) and then has to score several different row
# sets (k=0's own holdout for the reach table, and every k in {1,2,3,5}'s
# holdout for the arm tables), so its models must be kept around. This is the
# same per-quantile construction `gbm()` and probe_context.py's
# `permutation_importance` both use, just returning the fitted models instead
# of only their predictions.


def fit_quantile_models(Xtr, ytr, seed):
    return [
        HistGradientBoostingRegressor(
            loss="quantile",
            quantile=p,
            max_iter=150,
            learning_rate=0.05,
            max_depth=3,
            min_samples_leaf=40,
            l2_regularization=1.0,
            random_state=seed,
        ).fit(Xtr, np.log1p(ytr))
        for p in Q
    ]


def predict_quantile_models(models, X):
    return np.column_stack([np.maximum(np.expm1(m.predict(X)), 0.0) for m in models])


# ------------------------------------------------------------------------- main


def run(D, seeds, k_folds):
    blocks = folds_of(D["order"], k_folds)
    sess_to_fold = {}
    for fi, block in enumerate(blocks):
        for s in block:
            sess_to_fold[s] = fi

    y, sess, k_col, osf = D["y"], D["sess"], D["k"], D["osf"]

    # k=0 pooled holdout: the reach table's denominator and the "does k=0 here
    # reproduce probe_context.py's control" acceptance check.
    acc0 = []
    per_fold0 = []
    groups0 = []
    precall_loss_by_turn = defaultdict(list)  # turnRootId -> [loss per seed]
    precall_pred_by_turn = defaultdict(list)  # turnRootId -> [[p50,p90,p99], ...]

    # Per-k accumulators, arm -> list of per-row loss arrays (pooled over
    # fold x seed, exactly probe_context.py's shape).
    acc = {k: defaultdict(list) for k in K_STEPS}
    per_fold = {k: defaultdict(list) for k in K_STEPS}
    groups = {k: [] for k in K_STEPS}
    n_rows_k = {k: int((k_col == k).sum()) for k in K_STEPS}

    remaining_pred_by_turn = {k: defaultdict(list) for k in K_STEPS}
    clamp_pred_by_turn = {k: defaultdict(list) for k in K_STEPS}

    fold_sizes = []
    is_k0 = k_col == 0

    for fold_idx in range(k_folds):
        t0 = time.time()
        ho = set(blocks[fold_idx])
        te_all = np.array([s in ho for s in sess])
        tr_all = ~te_all
        tr0 = tr_all & is_k0
        te0 = te_all & is_k0
        assert te0.sum() > 0, f"fold {fold_idx} has no k=0 holdout rows"
        assert tr0.sum() > 0, f"fold {fold_idx} leaves no k=0 training rows"
        fold_sizes.append(dict(fold=fold_idx, k0_train=int(tr0.sum()), k0_test=int(te0.sum())))
        log(f"  fold {fold_idx}: k=0 train {tr0.sum()} test {te0.sum()}, {len(ho)} sessions")

        fold_loss0 = []
        fold_fl = {k: defaultdict(list) for k in K_STEPS}

        for seed in range(seeds):
            precall_models = fit_quantile_models(D["X"][tr0], y[tr0], seed)
            pred0 = predict_quantile_models(precall_models, D["X"][te0])
            L0 = loss_rows(y[te0], pred0)
            acc0.append(L0)
            groups0.append(sess[te0])
            fold_loss0.append(L0.mean())
            for tid, loss_v, pred_v in zip(D["turn"][te0], L0, pred0):
                precall_loss_by_turn[tid].append(float(loss_v))
                precall_pred_by_turn[tid].append(pred_v)

            for k in K_STEPS:
                is_k = k_col == k
                tr_k = tr_all & is_k
                te_k = te_all & is_k
                if te_k.sum() == 0:
                    continue
                Xk_tr = np.hstack([D["X"][tr_k], D["K"][tr_k]])
                Xk_te = np.hstack([D["X"][te_k], D["K"][te_k]])
                Xo_tr = np.hstack([Xk_tr, D["O"][tr_k]])
                Xo_te = np.hstack([Xk_te, D["O"][te_k]])
                osf_te = osf[te_k]
                y_te = y[te_k]

                pred_precall = predict_quantile_models(precall_models, D["X"][te_k])
                pred_clamp = np.maximum(pred_precall, osf_te[:, None])

                rf_models = fit_quantile_models(Xk_tr, y[tr_k], seed)
                pred_rf = predict_quantile_models(rf_models, Xk_te)

                rem_target_tr = np.maximum(y[tr_k] - osf[tr_k], 0.0)
                rem_models = fit_quantile_models(Xk_tr, rem_target_tr, seed)
                pred_rem_raw = predict_quantile_models(rem_models, Xk_te)
                pred_rem = osf_te[:, None] + pred_rem_raw
                pred_rem = np.maximum(pred_rem, osf_te[:, None])

                or_models = fit_quantile_models(Xo_tr, y[tr_k], seed)
                pred_or = predict_quantile_models(or_models, Xo_te)

                for name, pred in (
                    ("precall", pred_precall),
                    ("clamp", pred_clamp),
                    ("reforecast", pred_rf),
                    ("remaining", pred_rem),
                    ("oracle", pred_or),
                ):
                    L = loss_rows(y_te, np.maximum(pred, 0.0))
                    acc[k][name].append(L)
                    fold_fl[k][name].append(L.mean())
                groups[k].append(sess[te_k])

                for tid, pred_v in zip(D["turn"][te_k], pred_rem):
                    remaining_pred_by_turn[k][tid].append(pred_v)
                for tid, pred_v in zip(D["turn"][te_k], pred_clamp):
                    clamp_pred_by_turn[k][tid].append(pred_v)

        per_fold0.append(float(np.mean(fold_loss0)))
        for k in K_STEPS:
            for name in ("precall", "clamp", "reforecast", "remaining", "oracle"):
                if fold_fl[k][name]:
                    per_fold[k][name].append(float(np.mean(fold_fl[k][name])))
        log(f"  fold {fold_idx} done in {time.time() - t0:.0f}s")

    groups0 = np.concatenate(groups0)

    # -- turn-level averages across seeds, for the dip/ratchet tables --
    precall_avg = {tid: np.mean(v, axis=0) for tid, v in precall_pred_by_turn.items()}
    remaining_avg = {
        k: {tid: np.mean(v, axis=0) for tid, v in remaining_pred_by_turn[k].items()}
        for k in K_STEPS
    }
    clamp_avg = {
        k: {tid: np.mean(v, axis=0) for tid, v in clamp_pred_by_turn[k].items()}
        for k in K_STEPS
    }
    turn_precall_loss = {tid: float(np.mean(v)) for tid, v in precall_loss_by_turn.items()}

    return dict(
        blocks=blocks,
        sess_to_fold=sess_to_fold,
        acc0=acc0,
        groups0=groups0,
        per_fold0=per_fold0,
        acc=acc,
        groups={k: np.concatenate(v) for k, v in groups.items()},
        per_fold=per_fold,
        fold_sizes=fold_sizes,
        n_rows_k=n_rows_k,
        precall_avg=precall_avg,
        remaining_avg=remaining_avg,
        clamp_avg=clamp_avg,
        turn_precall_loss=turn_precall_loss,
    )


# ---------------------------------------------------------------------- reach


def reach_table(D, R):
    calls_by_turn = {}
    for tid, c in zip(D["turn"][D["k"] == 0], D["calls"][D["k"] == 0]):
        calls_by_turn[tid] = int(c)
    n_turns = len(calls_by_turn)
    total_precall_loss = sum(R["turn_precall_loss"].values())
    out = {}
    for k in K_STEPS:
        turns_running = [tid for tid, c in calls_by_turn.items() if c > k]
        share_turns = len(turns_running) / n_turns
        loss_running = sum(R["turn_precall_loss"].get(tid, 0.0) for tid in turns_running)
        share_loss = loss_running / total_precall_loss if total_precall_loss > 0 else 0.0
        out[k] = dict(
            n_rows=R["n_rows_k"][k],
            n_turns_running=len(turns_running),
            share_of_turns_pct=100 * share_turns,
            share_of_precall_loss_pct=100 * share_loss,
        )
    return out, n_turns


# ----------------------------------------------------------------------- gates


def gates_of_k(res_vs_clamp, k):
    out = {}
    threshold = POINT_THRESHOLD_PCT[k]
    for name, r in res_vs_clamp.items():
        if name == "clamp":
            continue
        ci_below = r["ci"][1] < 0
        worst = max(r["per_fold_pct"]) if r["per_fold_pct"] else float("nan")
        no_fold_worse = bool(worst <= 5.0)
        point_ok = bool(r["pct"] <= threshold)
        entry = dict(
            ci_below_zero=bool(ci_below),
            worst_fold_pct=float(worst),
            no_fold_worse_than_5pct=no_fold_worse,
            point_estimate_pct=float(r["pct"]),
            point_threshold_pct=threshold,
            point_threshold_met=point_ok,
        )
        if name == "remaining":
            entry["pass_"] = bool(ci_below and no_fold_worse and point_ok)
        else:
            entry["pass_"] = bool(ci_below and no_fold_worse)
        out[name] = entry
    return out


# ------------------------------------------------------------------------- dip


def dip_and_ratchet(D, R, k_folds):
    calls_by_turn = {}
    for tid, c in zip(D["turn"][D["k"] == 0], D["calls"][D["k"] == 0]):
        calls_by_turn[tid] = int(c)

    steps = [(0, 1), (1, 2), (2, 3), (3, 5)]

    def shown_at(tid, kk):
        if kk == 0:
            return R["precall_avg"].get(tid)
        return R["remaining_avg"][kk].get(tid)

    def clamp_shown_at(tid, kk):
        # clamp = max(precall, outputSoFar); outputSoFar is 0 at k=0, so clamp
        # and precall coincide there.
        if kk == 0:
            return R["precall_avg"].get(tid)
        return R["clamp_avg"][kk].get(tid)

    # Acceptance check: clamp has zero dips by construction (each quantile is
    # max(precall, outputSoFar), and outputSoFar is non-decreasing in k), so
    # assert it rather than only reason about it informally.
    clamp_dip_count = 0
    clamp_steps_checked = 0
    for kprev, knext in steps:
        for tid, calls in calls_by_turn.items():
            if calls <= knext:
                continue
            c_prev = clamp_shown_at(tid, kprev)
            c_next = clamp_shown_at(tid, knext)
            if c_prev is None or c_next is None:
                continue
            clamp_steps_checked += 1
            if np.any(c_next < c_prev - 1e-6):
                clamp_dip_count += 1
    assert clamp_dip_count == 0, (
        f"clamp arm dipped on {clamp_dip_count}/{clamp_steps_checked} steps; "
        "it is supposed to be non-decreasing by construction"
    )
    log(f"clamp zero-dip check: 0/{clamp_steps_checked} steps dipped (assertion held)")

    dip_report = {}
    for kprev, knext in steps:
        p50_dips, p50_depths = [], []
        p90_dips, p90_depths = [], []
        n_steps = 0
        for tid, calls in calls_by_turn.items():
            if calls <= knext:
                continue  # row at knext does not exist
            s_prev = shown_at(tid, kprev)
            s_next = shown_at(tid, knext)
            if s_prev is None or s_next is None:
                continue
            n_steps += 1
            for depths, dips, idx in ((p50_depths, p50_dips, 0), (p90_depths, p90_dips, 1)):
                dipped = s_next[idx] < s_prev[idx]
                dips.append(dipped)
                if dipped and s_prev[idx] > 0:
                    depths.append((s_prev[idx] - s_next[idx]) / s_prev[idx])
        dip_report[f"{kprev}->{knext}"] = dict(
            n_steps=n_steps,
            p50_dip_rate_pct=100 * float(np.mean(p50_dips)) if p50_dips else 0.0,
            p50_dip_depth_median_pct=100 * float(np.median(p50_depths)) if p50_depths else 0.0,
            p50_dip_depth_p90_pct=100 * float(np.percentile(p50_depths, 90)) if p50_depths else 0.0,
            p90_dip_rate_pct=100 * float(np.mean(p90_dips)) if p90_dips else 0.0,
            p90_dip_depth_median_pct=100 * float(np.median(p90_depths)) if p90_depths else 0.0,
            p90_dip_depth_p90_pct=100 * float(np.percentile(p90_depths, 90)) if p90_depths else 0.0,
        )

    # ratchet: sequential per-quantile max, graded against clamp per k.
    ratchet_shown = {0: dict(R["precall_avg"])}
    for kprev, knext in steps:
        ratchet_shown[knext] = {}
        for tid, calls in calls_by_turn.items():
            if calls <= knext:
                continue
            raw = R["remaining_avg"][knext].get(tid)
            prev = ratchet_shown[kprev].get(tid)
            if raw is None or prev is None:
                continue
            ratchet_shown[knext][tid] = np.maximum(raw, prev)

    def pinball_vec(y_val, pred_vec):
        return sum(
            max(p * (y_val - pred_vec[i]), (p - 1) * (y_val - pred_vec[i]))
            for i, p in enumerate(Q)
        )

    y_by_turn = {}
    for tid, tot in zip(D["turn"][D["k"] == 0], D["y"][D["k"] == 0]):
        y_by_turn[tid] = float(tot)

    ratchet_report = {}
    for k in K_STEPS:
        tids = sorted(ratchet_shown[k].keys())
        if not tids:
            continue
        clamp_pred = R["clamp_avg"][k]
        remaining_pred = R["remaining_avg"][k]
        tids_both = [t for t in tids if t in clamp_pred and t in remaining_pred]
        ratchet_loss = np.array([pinball_vec(y_by_turn[t], ratchet_shown[k][t]) for t in tids_both])
        clamp_loss = np.array([pinball_vec(y_by_turn[t], clamp_pred[t]) for t in tids_both])
        # Unratcheted remaining vs clamp, on the SAME turn-averaged basis as the
        # ratchet number above (average predictions across seeds, one row per
        # turn), so "gives up X points" subtracts like from like rather than
        # mixing this turn-averaged figure with the arm table's pooled
        # per-(fold,seed)-row figure.
        raw_remaining_loss = np.array([pinball_vec(y_by_turn[t], remaining_pred[t]) for t in tids_both])
        sess_by_turn = {tid: s for tid, s in zip(D["turn"], D["sess"])}
        groups_t = np.array([sess_by_turn[t] for t in tids_both])
        diff = ratchet_loss - clamp_loss
        d, lo, hi = block_boot(diff, groups_t)
        base = float(clamp_loss.mean())
        raw_pct_turn_avg = 100 * (raw_remaining_loss.mean() - base) / base if base else 0.0
        ratchet_report[k] = dict(
            n_turns=len(tids_both),
            ratchet_loss=float(ratchet_loss.mean()),
            clamp_loss=base,
            raw_remaining_loss_turn_avg=float(raw_remaining_loss.mean()),
            raw_remaining_pct_turn_avg=raw_pct_turn_avg,
            delta=d,
            ci=[lo, hi],
            pct=100 * d / base if base else 0.0,
            pct_ci=[100 * lo / base, 100 * hi / base] if base else [0.0, 0.0],
            gives_up_vs_raw_pct=raw_pct_turn_avg - (100 * d / base if base else 0.0),
        )
    return dip_report, ratchet_report


# ------------------------------------------------------------- permutation imp


def permutation_importance_remaining(D, k, R, seeds, k_folds, rng_seed=0):
    names = D["names"]["k"]
    y, sess, k_col, osf = D["y"], D["sess"], D["k"], D["osf"]
    rng = np.random.default_rng(rng_seed)
    is_k = k_col == k
    drops = defaultdict(list)
    base_losses = []
    for fold_idx in range(k_folds):
        ho = set(R["blocks"][fold_idx])
        te_all = np.array([s in ho for s in sess])
        tr_all = ~te_all
        tr_k = tr_all & is_k
        te_k = te_all & is_k
        if te_k.sum() == 0:
            continue
        Xk_tr = np.hstack([D["X"][tr_k], D["K"][tr_k]])
        Xk_te = np.hstack([D["X"][te_k], D["K"][te_k]])
        osf_tr, osf_te = osf[tr_k], osf[te_k]
        y_tr, y_te = y[tr_k], y[te_k]
        for seed in range(seeds):
            rem_target_tr = np.maximum(y_tr - osf_tr, 0.0)
            models = fit_quantile_models(Xk_tr, rem_target_tr, seed)

            def score(M, osf_vec):
                raw = predict_quantile_models(models, M)
                pred = np.maximum(osf_vec[:, None] + raw, osf_vec[:, None])
                return loss_rows(y_te, np.maximum(pred, 0.0)).mean()

            base = score(Xk_te, osf_te)
            base_losses.append(base)
            for j, name in enumerate(names):
                col = META_COLS + j
                for rep in range(3):
                    P = Xk_te.copy()
                    P[:, col] = P[rng.permutation(P.shape[0]), col]
                    drops[name].append(score(P, osf_te) - base)
    base_mean = float(np.mean(base_losses)) if base_losses else 0.0
    return dict(
        k=k,
        base_loss=base_mean,
        columns={
            name: dict(
                drop=float(np.mean(v)),
                pct=100 * float(np.mean(v)) / base_mean if base_mean else 0.0,
                sd=float(np.std(v)),
            )
            for name, v in drops.items()
        },
    )


# --------------------------------------------------------------------- report


def print_arm_table(k, res_vs_clamp, res_vs_precall, gates):
    print(f"\n--- k={k} ---")
    w = max(len(n) for n in res_vs_clamp)
    for name in ("precall", "clamp", "reforecast", "remaining", "oracle"):
        if name not in res_vs_clamp:
            continue
        rc = res_vs_clamp[name]
        rp = res_vs_precall[name]
        pf_c = " ".join(f"{v:+.1f}%" for v in rc["per_fold_pct"])
        gate = gates.get(name)
        gate_s = f"PASS" if gate and gate["pass_"] else ("FAIL" if gate else "-")
        print(
            f"{name:{w}s} loss={rc['loss']:9.0f}  vs_clamp {rc['delta']:+9.0f} "
            f"[{rc['ci'][0]:+9.0f},{rc['ci'][1]:+9.0f}] ({rc['pct']:+.1f}%)  "
            f"vs_precall ({rp['pct']:+.1f}%)  per-fold(clamp) {pf_c}  gate={gate_s}"
        )


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("path")
    ap.add_argument("--columns", default=None, help="reforecast-columns.json from the exporter")
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--folds", type=int, default=K_FOLDS)
    ap.add_argument("--label", default="local")
    a = ap.parse_args()

    t_start = time.time()
    D = load_reforecast(a.path, a.columns)
    projects = len(set(D["work"]))
    n_turns = len(set(D["turn"][D["k"] == 0]))
    log(
        f"{a.label}: {D['n']} rows, {n_turns} turns, {len(D['order'])} sessions, "
        f"{projects} projects, {a.folds} folds x {a.seeds} seeds"
    )

    R = run(D, a.seeds, a.folds)

    control_loss_per_turn = float(np.concatenate(R["acc0"]).mean())
    print(f"\n=== k=0 (precall control), pooled holdout rows {len(R['groups0'])} ===")
    print(f"precall loss/turn (k=0): {control_loss_per_turn:.0f}")
    print(
        "reference: probe_context.py's control was 10,090/turn on 2,225 turns "
        f"(this corpus: {n_turns} turns)"
    )

    reach, n_turns_check = reach_table(D, R)
    print("\n=== reach table ===")
    print(f"{'k':>3s} {'n_rows':>7s} {'turns_running':>13s} {'share_turns%':>13s} {'share_loss%':>12s}")
    for k in K_STEPS:
        r = reach[k]
        print(
            f"{k:3d} {r['n_rows']:7d} {r['n_turns_running']:13d} "
            f"{r['share_of_turns_pct']:13.1f} {r['share_of_precall_loss_pct']:12.1f}"
        )

    per_k_results = {}
    per_k_gates = {}
    oracle_gap = {}
    for k in K_STEPS:
        res_vs_clamp = summarise(R["acc"][k], R["groups"][k], "clamp", R["per_fold"][k])
        res_vs_precall = summarise(R["acc"][k], R["groups"][k], "precall", R["per_fold"][k])
        gates = gates_of_k(res_vs_clamp, k)
        print_arm_table(k, res_vs_clamp, res_vs_precall, gates)
        per_k_results[k] = dict(vs_clamp=res_vs_clamp, vs_precall=res_vs_precall)
        per_k_gates[k] = gates
        oracle_gap[k] = res_vs_clamp["oracle"]["pct"]

    print("\n=== oracle gap (oracle - clamp), pct ===")
    for k in K_STEPS:
        flag = "ceiling reading fires (<= -30% needed)" if oracle_gap[k] > -30 else "clears -30%"
        print(f"  k={k}: {oracle_gap[k]:+.1f}%  ({flag})" if k == 1 else f"  k={k}: {oracle_gap[k]:+.1f}%")

    print("\n=== dip table (raw remaining arm, p50 path s_0=precall, s_k=remaining) ===")
    dip_report, ratchet_report = dip_and_ratchet(D, R, a.folds)
    for step, d in dip_report.items():
        print(
            f"  step {step:6s} n={d['n_steps']:5d}  "
            f"p50 dip_rate={d['p50_dip_rate_pct']:5.1f}%  depth(median/p90)="
            f"{d['p50_dip_depth_median_pct']:5.1f}%/{d['p50_dip_depth_p90_pct']:5.1f}%   "
            f"p90 dip_rate={d['p90_dip_rate_pct']:5.1f}%  depth(median/p90)="
            f"{d['p90_dip_depth_median_pct']:5.1f}%/{d['p90_dip_depth_p90_pct']:5.1f}%"
        )

    print("\n=== ratchet variant vs clamp ===")
    for k in K_STEPS:
        if k not in ratchet_report:
            continue
        r = ratchet_report[k]
        # raw_remaining_pct_turn_avg and gives_up_vs_raw_pct are computed on the
        # SAME turn-averaged (seed-averaged-prediction) basis as the ratchet
        # figure itself -- NOT the arm table's pooled per-(fold,seed)-row pct,
        # which averages losses rather than predictions and is not directly
        # comparable to this number (see docs/REFORECAST-PLAN.md Results notes).
        print(
            f"  k={k}: n_turns={r['n_turns']:5d}  ratchet={r['ratchet_loss']:9.0f}  "
            f"clamp={r['clamp_loss']:9.0f}  {r['delta']:+9.0f} [{r['ci'][0]:+9.0f},{r['ci'][1]:+9.0f}] "
            f"({r['pct']:+.1f}%)  raw remaining (turn-avg) was ({r['raw_remaining_pct_turn_avg']:+.1f}%)  "
            f"gives_up={r['gives_up_vs_raw_pct']:+.1f}pt"
        )

    print("\n=== permutation importance, remaining arm ===")
    perm = {}
    for k in (1, 3):
        imp = permutation_importance_remaining(D, k, R, a.seeds, a.folds)
        perm[k] = imp
        print(f"  k={k} (base loss {imp['base_loss']:.0f}):")
        for name, v in sorted(imp["columns"].items(), key=lambda kv: -kv[1]["drop"]):
            print(f"    {name:20s} {v['drop']:+9.1f}  ({v['pct']:+.2f}%)")

    payload = dict(
        label=a.label,
        rows=D["n"],
        turns=n_turns,
        sessions=len(D["order"]),
        projects=projects,
        folds=a.folds,
        seeds=a.seeds,
        fold_sizes=R["fold_sizes"],
        columns=D["names"],
        control_loss_per_turn_k0=control_loss_per_turn,
        reach=reach,
        per_k=per_k_results,
        gates=per_k_gates,
        oracle_gap_pct=oracle_gap,
        dip=dip_report,
        ratchet=ratchet_report,
        permutation_importance_remaining=perm,
        wall_clock_seconds=float(time.time() - t_start),
        note=(
            "population is every exact turn with calls > k; precall control is "
            "fit once per fold/seed on k=0 rows and reused at every k for that "
            "fold's holdout turns, same learner/gates/bootstrap as probe_context.py"
        ),
    )
    save(f"run:{a.label}", payload)


if __name__ == "__main__":
    main()
