#!/usr/bin/env python3
"""
Step B of docs/SEMANTIC-PLAN.md: does a HASHED text head beat the shipped
38-feature metadata model at scale, how many turns does it take, and does a
head trained on public data transfer to the local corpus?

Everything here is aggregates. No prompt text is printed or written.

    python3 probe_semantic_scale.py b1 <turns.jsonl> [--label NAME] [--seeds 3]
    python3 probe_semantic_scale.py b2 <turns.jsonl> [--label NAME] [--seeds 3]
    python3 probe_semantic_scale.py b3 --public <public.jsonl> --local <local.jsonl>

Results are merged into experiments/artifacts/semantic-scale.json.

Learner settings, pinball loss and the session-block bootstrap are copied from
probe_folds_pooled.py / probe_shrinkage.py so the numbers are comparable with
the 2 September tables in the plan.

Text feature form (SEMANTIC-PLAN, "The shape of the shipped model"): signed
hashed word unigrams+bigrams into 2**18 buckets with log1p counts, the same
shape as `semanticHashFeatures` in packages/ingest-claude/load-history.mjs, so
the head accepts words it never saw.  The token pattern matches the loader's
`[\\p{L}\\p{N}_][\\p{L}\\p{N}_./-]*` as closely as Python's `re` allows.
"""

import argparse
import json
import os
import sys
import time
import warnings
from collections import defaultdict

import numpy as np
from scipy import sparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import text_hash  # noqa: E402  (the shipped hasher, shared with the trainer)

warnings.filterwarnings("ignore")
from sklearn.decomposition import TruncatedSVD  # noqa: E402
from sklearn.ensemble import HistGradientBoostingRegressor  # noqa: E402
from sklearn.feature_extraction.text import (  # noqa: E402
    HashingVectorizer,
    TfidfVectorizer,
)
from sklearn.linear_model import Ridge  # noqa: E402

Q = [0.5, 0.9, 0.99]
SVD_DIM = 256
N_BOOT = 2000
K_FOLDS = 5
HASH_BITS = 18

HERE = os.path.dirname(os.path.abspath(__file__))
ARTIFACT = os.path.normpath(os.path.join(HERE, "..", "..", "artifacts", "semantic-scale.json"))

HV = HashingVectorizer(
    analyzer="word",
    lowercase=True,
    token_pattern=r"(?u)\w[\w./-]*",
    ngram_range=(1, 2),
    n_features=2**HASH_BITS,
    alternate_sign=True,
    norm=None,
)


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- data


def load(path):
    rows = [json.loads(l) for l in open(path)]
    rows = [r for r in rows if r.get("text")]
    y = np.array([r["total"] for r in rows], float)
    X = np.array([r["features"] for r in rows], float)
    sess = np.array([r["sessionId"] or f"u:{r['turnRootId']}" for r in rows])
    text = [r["text"] for r in rows]
    tool = np.array([r.get("tool") or r.get("dataset") or "?" for r in rows])
    first = {}
    for i, r in enumerate(rows):
        first.setdefault(sess[i], r["firstMs"])
    order = sorted(first, key=first.get)
    ord_ms = np.array([first[s] for s in sess], float)
    return dict(y=y, X=X, sess=sess, text=text, tool=tool, order=order, ord_ms=ord_ms, n=len(rows))


# ----------------------------------------------------------------------- learners


def hashed(texts):
    """Signed hashed 1-2 grams, log1p on the absolute count (loader shape)."""
    M = HV.transform(texts).tocsr()
    M.data = np.sign(M.data) * np.log1p(np.abs(M.data))
    M.eliminate_zeros()
    return M.astype(np.float32)


def pinball(y, q, p):
    d = y - q
    return np.maximum(p * d, (p - 1) * d)


def loss_rows(y, preds):
    return sum(pinball(y, preds[:, i], p) for i, p in enumerate(Q))


def block_boot(diff, groups, n=N_BOOT):
    rng = np.random.default_rng(0)
    g = defaultdict(list)
    for d, k in zip(diff, groups):
        g[k].append(d)
    blocks = [np.array(v) for v in g.values()]
    means = []
    for _ in range(n):
        idx = rng.integers(0, len(blocks), len(blocks))
        means.append(np.concatenate([blocks[i] for i in idx]).mean())
    return float(diff.mean()), float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))


def gbm(Xtr, ytr, Xte, seed):
    return np.column_stack(
        [
            np.expm1(
                HistGradientBoostingRegressor(
                    loss="quantile",
                    quantile=p,
                    max_iter=150,
                    learning_rate=0.05,
                    max_depth=3,
                    min_samples_leaf=40,
                    l2_regularization=1.0,
                    random_state=seed,
                )
                .fit(Xtr, np.log1p(ytr))
                .predict(Xte)
            )
            for p in Q
        ]
    )


def blend(meta, txt, lam):
    """Geometric shrink in log space, exactly probe_shrinkage.py's form."""
    return np.expm1((1 - lam) * np.log1p(meta) + lam * np.log1p(txt))


def _scaled_meta(Xtr, Xte):
    sd = Xtr.std(axis=0)
    sd[sd == 0] = 1.0
    return sparse.csr_matrix(Xtr / sd), sparse.csr_matrix(Xte / sd)


def linear_head(Htr, Xtr, ytr, Hte, Xte, ord_tr, alphas=(1.0, 10.0, 100.0), nbins=10):
    """
    Sparse Ridge on log1p(total) over [hashed + metadata]; quantiles from the
    empirical residual quantiles inside 10 bins of the training point
    prediction.  Alpha is picked on a chronological inner split of the train.
    """
    Mtr, Mte = _scaled_meta(Xtr, Xte)
    A_tr = sparse.hstack([Htr, Mtr]).tocsr()
    A_te = sparse.hstack([Hte, Mte]).tocsr()
    ltr = np.log1p(ytr)

    cut = np.quantile(ord_tr, 0.8)
    inner_tr = ord_tr <= cut
    inner_te = ~inner_tr
    best_alpha, best = alphas[0], np.inf
    if inner_te.sum() >= 50 and inner_tr.sum() >= 100:
        for a in alphas:
            r = Ridge(alpha=a, solver="lsqr").fit(A_tr[inner_tr], ltr[inner_tr])
            err = float(np.mean((r.predict(A_tr[inner_te]) - ltr[inner_te]) ** 2))
            if err < best:
                best, best_alpha = err, a

    model = Ridge(alpha=best_alpha, solver="lsqr").fit(A_tr, ltr)
    p_tr = model.predict(A_tr)
    p_te = model.predict(A_te)
    resid = ltr - p_tr

    edges = np.unique(np.quantile(p_tr, np.linspace(0, 1, nbins + 1)[1:-1]))
    b_tr = np.digitize(p_tr, edges)
    b_te = np.digitize(p_te, edges)
    glob = np.quantile(resid, Q)
    per_bin = {}
    for b in range(len(edges) + 1):
        m = b_tr == b
        per_bin[b] = np.quantile(resid[m], Q) if m.sum() >= 30 else glob
    off = np.array([per_bin.get(b, glob) for b in b_te])
    return np.expm1(p_te[:, None] + off), best_alpha


# -------------------------------------------------------------------- reporting


def summarise(acc, groups, ref_name, per_fold):
    ref = np.concatenate(acc[ref_name])
    out = {}
    for name, lst in acc.items():
        l = np.concatenate(lst)
        m, lo, hi = block_boot(l - ref, groups)
        pf = [
            100 * (per_fold[name][i] / per_fold[ref_name][i] - 1)
            for i in range(len(per_fold[ref_name]))
        ]
        out[name] = dict(
            loss=float(l.mean()),
            delta=m,
            ci=[lo, hi],
            pct=100 * m / ref.mean(),
            pct_ci=[100 * lo / ref.mean(), 100 * hi / ref.mean()],
            per_fold_pct=[float(v) for v in pf],
        )
    return out


def print_table(res, ref_name):
    w = max(len(k) for k in res)
    for name, r in res.items():
        pf = " ".join(f"{v:+.1f}%" for v in r["per_fold_pct"])
        tag = " (control)" if name == ref_name else ""
        print(
            f"{name:{w}s} loss={r['loss']:8.0f}  {r['delta']:+8.0f} "
            f"[{r['ci'][0]:+8.0f},{r['ci'][1]:+8.0f}]  ({r['pct']:+.1f}%)  per-fold {pf}{tag}"
        )


def save(section, key, payload):
    """Merge one section into the artifact.  Runs are often launched in
    parallel, so the read-modify-write is guarded by an O_EXCL lock file."""
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
        _save_locked(section, key, payload)
    finally:
        try:
            os.unlink(lock)
        except OSError:
            pass


def _save_locked(section, key, payload):
    data = {}
    if os.path.exists(ARTIFACT):
        try:
            data = json.load(open(ARTIFACT))
        except Exception:
            data = {}
    data.setdefault("generatedAt", [])
    data["generatedAt"] = [t for t in data["generatedAt"] if not t.startswith(f"{section}:{key} ")]
    data["generatedAt"].append(f"{section}:{key} {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    data.setdefault(section, {})[key] = payload
    os.makedirs(os.path.dirname(ARTIFACT), exist_ok=True)
    json.dump(data, open(ARTIFACT, "w"), indent=1, sort_keys=True)
    log(f"wrote {section}.{key} -> {ARTIFACT}")


def folds_of(order, k=K_FOLDS):
    return np.array_split(np.array(order), k)


# --------------------------------------------------------------------------- B.1


def run_b1(path, label, seeds, lams):
    D = load(path)
    y, X, sess, text, tool = D["y"], D["X"], D["sess"], D["text"], D["tool"]
    blocks = folds_of(D["order"])
    log(f"B.1 {label}: {D['n']} turns, {len(D['order'])} sessions, {K_FOLDS} folds x {seeds} seeds")

    acc = defaultdict(list)
    per_fold = defaultdict(list)
    grp, tools_pooled = [], []
    ridge_alphas = []
    # per-row pooled predictions of control / meta+svd, for the per-tool cut
    pool_ref, pool_ms, pool_y = [], [], []

    for k in range(K_FOLDS):
        t0 = time.time()
        ho = set(blocks[k])
        te = np.array([s in ho for s in sess])
        tr = ~te
        itr, ite = np.where(tr)[0], np.where(te)[0]
        Htr = hashed([text[i] for i in itr])
        Hte = hashed([text[i] for i in ite])
        svd = TruncatedSVD(SVD_DIM, random_state=0).fit(Htr)
        S_tr, S_te = svd.transform(Htr), svd.transform(Hte)
        log(
            f"  fold {k}: train {tr.sum()} test {te.sum()} sessions {len(ho)} "
            f"nnz/doc {Htr.nnz / max(1, tr.sum()):.0f} svd_evr {svd.explained_variance_ratio_.sum():.3f} "
            f"({time.time() - t0:.0f}s)"
        )
        lin, alpha = linear_head(Htr, X[tr], y[tr], Hte, X[te], D["ord_ms"][tr])
        ridge_alphas.append(alpha)
        fl = defaultdict(list)
        for seed in range(seeds):
            meta = gbm(X[tr], y[tr], X[te], seed)
            svdonly = gbm(S_tr, y[tr], S_te, seed)
            ms = gbm(np.hstack([X[tr], S_tr]), y[tr], np.hstack([X[te], S_te]), seed)
            preds = {
                "control meta GBM": meta,
                "SVD only": svdonly,
                "meta+SVD": ms,
                "linear ridge": lin,
            }
            for lam in lams:
                preds[f"blend lam={lam:.2f}"] = blend(meta, ms, lam)
            for name, p in preds.items():
                L = loss_rows(y[te], p)
                acc[name].append(L)
                fl[name].append(L.mean())
            grp.append(sess[te])
            tools_pooled.append(tool[te])
            pool_ref.append(loss_rows(y[te], meta))
            pool_ms.append(loss_rows(y[te], ms))
            pool_y.append(y[te])
        for name in fl:
            per_fold[name].append(float(np.mean(fl[name])))
        log(f"  fold {k} done in {time.time() - t0:.0f}s")

    groups = np.concatenate(grp)
    res = summarise(acc, groups, "control meta GBM", per_fold)
    print(f"\n=== B.1 {label}: n(pooled holdout rows) = {len(groups)} ===")
    print_table(res, "control meta GBM")

    # per-tool cut of meta+SVD vs control on the pooled holdout rows
    tt = np.concatenate(tools_pooled)
    rr, mm = np.concatenate(pool_ref), np.concatenate(pool_ms)
    by_tool = {}
    print("\nmeta+SVD vs control, per tool (pooled holdout rows):")
    for t in sorted(set(tt)):
        m = tt == t
        if m.sum() < 30:
            continue
        d, lo, hi = block_boot(mm[m] - rr[m], groups[m])
        base = rr[m].mean()
        by_tool[t] = dict(
            rows=int(m.sum()),
            control_loss=float(base),
            loss=float(mm[m].mean()),
            delta=d,
            ci=[lo, hi],
            pct=100 * d / base,
            pct_ci=[100 * lo / base, 100 * hi / base],
        )
        print(
            f"  {t:12s} n={m.sum():6d} control={base:8.0f} meta+SVD={mm[m].mean():8.0f} "
            f"{d:+8.0f} [{lo:+8.0f},{hi:+8.0f}] ({100 * d / base:+.1f}%)"
        )

    payload = dict(
        dataset=label,
        rows=D["n"],
        sessions=len(D["order"]),
        pooled_holdout_rows=int(len(groups)),
        folds=K_FOLDS,
        seeds=seeds,
        svd_dim=SVD_DIM,
        hash_bits=HASH_BITS,
        ridge_alpha_per_fold=[float(a) for a in ridge_alphas],
        models=res,
        per_tool_meta_svd=by_tool,
    )
    save("b1", label, payload)
    return payload


# --------------------------------------------------------------------------- B.2


def run_b2(path, label, seeds, sizes):
    D = load(path)
    y, X, sess, text = D["y"], D["X"], D["sess"], D["text"]
    blocks = folds_of(D["order"])
    ho = set(blocks[K_FOLDS - 1])  # fold 4 = latest 20% of sessions
    te = np.array([s in ho for s in sess])
    tr = ~te
    ite = np.where(te)[0]
    # chronological order of the training pool
    itr_all = np.where(tr)[0]
    itr_all = itr_all[np.lexsort((itr_all, D["ord_ms"][itr_all]))]
    log(f"B.2 {label}: train pool {len(itr_all)}, holdout {te.sum()} rows / {len(ho)} sessions")

    Hte = hashed([text[i] for i in ite])
    rows_out = []
    for n in sizes:
        n_eff = min(n, len(itr_all))
        idx = itr_all[:n_eff]
        t0 = time.time()
        Htr = hashed([text[i] for i in idx])
        dim = min(SVD_DIM, Htr.shape[0] - 1)
        svd = TruncatedSVD(dim, random_state=0).fit(Htr)
        S_tr, S_te = svd.transform(Htr), svd.transform(Hte)
        c_l, m_l = [], []
        for seed in range(seeds):
            meta = gbm(X[idx], y[idx], X[te], seed)
            ms = gbm(np.hstack([X[idx], S_tr]), y[idx], np.hstack([X[te], S_te]), seed)
            c_l.append(loss_rows(y[te], meta))
            m_l.append(loss_rows(y[te], ms))
        c, m = np.concatenate(c_l), np.concatenate(m_l)
        groups = np.tile(sess[te], seeds)
        d, lo, hi = block_boot(m - c, groups)
        rows_out.append(
            dict(
                train_turns=int(n_eff),
                svd_dim=int(dim),
                control_loss=float(c.mean()),
                meta_svd_loss=float(m.mean()),
                delta=d,
                ci=[lo, hi],
                pct=100 * d / c.mean(),
                pct_ci=[100 * lo / c.mean(), 100 * hi / c.mean()],
            )
        )
        log(
            f"  n={n_eff:6d} control={c.mean():8.0f} meta+SVD={m.mean():8.0f} "
            f"({100 * d / c.mean():+.1f}%) [{100 * lo / c.mean():+.1f}%,{100 * hi / c.mean():+.1f}%] "
            f"({time.time() - t0:.0f}s)"
        )
        if n_eff == len(itr_all):
            break

    print(f"\n=== B.2 {label}: learning curve on the fold-4 holdout ({te.sum()} rows) ===")
    for r in rows_out:
        print(
            f"  {r['train_turns']:6d}  control={r['control_loss']:8.0f}  "
            f"meta+SVD={r['meta_svd_loss']:8.0f}  {r['pct']:+.1f}% "
            f"[{r['pct_ci'][0]:+.1f}%,{r['pct_ci'][1]:+.1f}%]"
        )
    payload = dict(
        dataset=label,
        holdout_rows=int(te.sum()),
        holdout_sessions=len(ho),
        seeds=seeds,
        curve=rows_out,
    )
    save("b2", label, payload)
    return payload


# --------------------------------------------------------------------------- B.3


def run_b3(public_path, local_path, seeds, lam):
    P = load(public_path)
    L = load(local_path)
    log(f"B.3: public {P['n']} turns, local {L['n']} text turns / {len(L['order'])} sessions")

    # ---- base head: hashing + SVD + meta/SVD quantile GBM fitted on ALL public rows
    t0 = time.time()
    Hp = hashed(P["text"])
    svd = TruncatedSVD(SVD_DIM, random_state=0).fit(Hp)
    S_p = svd.transform(Hp)
    log(f"  base SVD on {P['n']} public rows, evr={svd.explained_variance_ratio_.sum():.3f} ({time.time() - t0:.0f}s)")
    Hl = hashed(L["text"])
    S_l = svd.transform(Hl)
    base_seeds = []
    for seed in range(seeds):
        base_seeds.append(
            gbm(np.hstack([P["X"], S_p]), P["y"], np.hstack([L["X"], S_l]), seed)
        )
        log(f"  base head seed {seed} fitted ({time.time() - t0:.0f}s)")

    y, X, sess, text = L["y"], L["X"], L["sess"], L["text"]
    blocks = folds_of(L["order"])

    acc = defaultdict(list)
    per_fold = defaultdict(list)
    grp = []
    ratios = []
    resid_alphas = []

    for k in range(K_FOLDS):
        t0 = time.time()
        ho = set(blocks[k])
        te = np.array([s in ho for s in sess])
        tr = ~te
        itr, ite = np.where(tr)[0], np.where(te)[0]

        # (c) the existing local TF-IDF shrinkage recipe, reproduced
        tf = TfidfVectorizer(ngram_range=(1, 2), min_df=3, sublinear_tf=True, max_features=20000)
        T_tr = tf.fit_transform([text[i] for i in itr])
        T_te = tf.transform([text[i] for i in ite])
        lsvd = TruncatedSVD(48, random_state=0).fit(T_tr)
        LS_tr, LS_te = lsvd.transform(T_tr), lsvd.transform(T_te)

        fl = defaultdict(list)
        for seed in range(seeds):
            base = base_seeds[seed]
            base_tr, base_te = base[tr], base[te]
            # calibration of the base head on the TRAIN folds
            ratios.append(float(np.median(y[tr] / np.maximum(base_tr[:, 0], 1.0))))

            meta = gbm(X[tr], y[tr], X[te], seed)
            local_txt = gbm(
                np.hstack([X[tr], LS_tr]), y[tr], np.hstack([X[te], LS_te]), seed
            )

            preds = {
                "a control local meta GBM": meta,
                "b base head raw": base_te,
                f"b base blend lam={lam:.2f}": blend(meta, base_te, lam),
                "c local tfidf blend lam=0.35": blend(meta, local_txt, 0.35),
            }
            # scale-corrected base head (extra row: the label scales differ)
            r = ratios[-1]
            preds["b base blend, scale-corrected"] = blend(meta, base_te * r, lam)

            # (d1) base head quantiles as 3 extra features into the local metadata GBM
            F_tr = np.hstack([X[tr], np.log1p(base_tr)])
            F_te = np.hstack([X[te], np.log1p(base_te)])
            preds["d1 meta + base quantile feats"] = gbm(F_tr, y[tr], F_te, seed)

            # (d2) local ridge residual on hashed n-grams over the base log-median
            off_tr = np.log1p(y[tr]) - np.log1p(base_tr[:, 0])
            Htr, Hte = Hl[tr], Hl[te]
            best_a, best_e = None, np.inf
            uniq = np.array(sorted(set(sess[tr])))
            rs = np.random.default_rng(seed)
            part = {s: int(i) for i, s in enumerate(rs.permutation(uniq))}
            pid = np.array([part[s] % 3 for s in sess[tr]])
            for a in (10.0, 100.0, 1000.0):
                errs = []
                for f in range(3):
                    m = pid != f
                    if m.sum() < 50 or (~m).sum() < 20:
                        continue
                    rg = Ridge(alpha=a, solver="lsqr").fit(Htr[m], off_tr[m])
                    errs.append(np.mean((rg.predict(Htr[~m]) - off_tr[~m]) ** 2))
                e = float(np.mean(errs)) if errs else np.inf
                if e < best_e:
                    best_e, best_a = e, a
            resid_alphas.append(best_a)
            rg = Ridge(alpha=best_a, solver="lsqr").fit(Htr, off_tr)
            shift = rg.predict(Hte)
            preds["d2 base + local ridge residual"] = np.expm1(
                np.log1p(base_te) + shift[:, None]
            )

            for name, p in preds.items():
                loss = loss_rows(y[te], np.maximum(p, 0.0))
                acc[name].append(loss)
                fl[name].append(loss.mean())
            grp.append(sess[te])
        for name in fl:
            per_fold[name].append(float(np.mean(fl[name])))
        log(f"  local fold {k}: train {tr.sum()} test {te.sum()} ({time.time() - t0:.0f}s)")

    groups = np.concatenate(grp)
    res = summarise(acc, groups, "a control local meta GBM", per_fold)
    print(f"\n=== B.3 transfer: n(pooled local holdout rows) = {len(groups)} ===")
    print_table(res, "a control local meta GBM")
    med_ratio = float(np.median(ratios))
    print(
        f"\nbase-head calibration on local TRAIN folds: median(local total / base p50) "
        f"= {med_ratio:.3f}  (range {min(ratios):.3f}..{max(ratios):.3f})"
    )
    payload = dict(
        public=os.path.basename(os.path.dirname(public_path)) or public_path,
        public_rows=P["n"],
        local_rows=L["n"],
        local_sessions=len(L["order"]),
        pooled_holdout_rows=int(len(groups)),
        seeds=seeds,
        lam=lam,
        base_calibration_median_ratio=med_ratio,
        base_calibration_range=[float(min(ratios)), float(max(ratios))],
        residual_alpha_choices=[float(a) for a in resid_alphas],
        models=res,
    )
    save("b3", "local-transfer", payload)
    return payload


# ------------------------------------------------------------------- Step 0 sweep


SWEEP_CONFIGS = [(18, 256), (14, 64), (13, 48), (12, 32)]


def _svd_of(H, dims, seed=0):
    return TruncatedSVD(dims, random_state=seed).fit(H)


def run_sweep(public_path, local_path, label, seeds, configs):
    """
    Step 0 of the Stage 1 plan: how small can (hash bits B, SVD dims K) get
    before the transfer result moves?

    Two differences from the B.1/B.3 tables above, both stated in the plan and
    both applied to EVERY row here so the comparison is internal:

      * the hasher is `text_hash.py` -- the shipped FNV-1a/UTF-16 form the
        TypeScript evaluator mirrors -- not sklearn's HashingVectorizer, and it
        truncates each document to the first 2,000 UTF-16 code units;
      * B.1 runs five folds x `--seeds` seeds (2 by default, not B.1's 3).

    Two base heads are graded for the B.3 d1 transfer:

      `d1 text-base`  the head that actually ships: `baseTextHead(text)` sees
                      SVD components only, because the TypeScript signature
                      takes a string and nothing else;
      `d1 meta-base`  the B.3 form for continuity with the 2 September table,
                      where the public head also saw the 38 metadata columns.

    The shipped form decides the gate; the other is reported beside it.
    """
    P = load(public_path)
    L = load(local_path)
    log(f"sweep: public {P['n']} turns / {len(P['order'])} sessions, "
        f"local {L['n']} text turns / {len(L['order'])} sessions")

    t0 = time.time()
    HP = text_hash.hash_documents(P["text"])
    HL = text_hash.hash_documents(L["text"])
    log(f"  tokenised+hashed once: {sum(h.size for h in HP) / max(1, P['n']):.0f} terms/doc "
        f"public, {sum(h.size for h in HL) / max(1, L['n']):.0f} local ({time.time() - t0:.0f}s)")

    pub_blocks = folds_of(P["order"])
    loc_blocks = folds_of(L["order"])
    pub_te = [np.array([s in set(b) for s in P["sess"]]) for b in pub_blocks]
    loc_te = [np.array([s in set(b) for s in L["sess"]]) for b in loc_blocks]

    # Controls do not depend on (B, K): fit them once and reuse for every config.
    pub_ctrl, loc_ctrl = [], []
    for k in range(K_FOLDS):
        te, tr = pub_te[k], ~pub_te[k]
        pub_ctrl.append([
            loss_rows(P["y"][te], gbm(P["X"][tr], P["y"][tr], P["X"][te], s))
            for s in range(seeds)
        ])
        log(f"  public control fold {k} ({time.time() - t0:.0f}s)")
    for k in range(K_FOLDS):
        te, tr = loc_te[k], ~loc_te[k]
        loc_ctrl.append([
            loss_rows(L["y"][te], gbm(L["X"][tr], L["y"][tr], L["X"][te], s))
            for s in range(seeds)
        ])
    pub_groups = np.concatenate([np.tile(P["sess"][pub_te[k]], seeds) for k in range(K_FOLDS)])
    loc_groups = np.concatenate([np.tile(L["sess"][loc_te[k]], seeds) for k in range(K_FOLDS)])
    pub_ref = np.concatenate([np.concatenate(v) for v in pub_ctrl])
    loc_ref = np.concatenate([np.concatenate(v) for v in loc_ctrl])

    def graded(losses, ref, groups):
        l = np.concatenate([np.concatenate(v) for v in losses])
        d, lo, hi = block_boot(l - ref, groups)
        base = ref.mean()
        return dict(
            loss=float(l.mean()),
            delta=d,
            ci=[lo, hi],
            pct=100 * d / base,
            pct_ci=[100 * lo / base, 100 * hi / base],
            per_fold_pct=[
                float(100 * (np.concatenate(losses[k]).mean() /
                             np.concatenate(ref_k).mean() - 1))
                for k, ref_k in enumerate(
                    pub_ctrl if ref is pub_ref else loc_ctrl)
            ],
        )

    out = {}
    for bits, dims in configs:
        cfg = f"B{bits}-K{dims}"
        t1 = time.time()

        # ---- B.1 on the public corpus
        b1_losses = []
        evr = []
        for k in range(K_FOLDS):
            te, tr = pub_te[k], ~pub_te[k]
            Htr = text_hash.hashed_matrix([HP[i] for i in np.where(tr)[0]], bits)
            Hte = text_hash.hashed_matrix([HP[i] for i in np.where(te)[0]], bits)
            svd = _svd_of(Htr, dims)
            evr.append(float(svd.explained_variance_ratio_.sum()))
            S_tr, S_te = svd.transform(Htr), svd.transform(Hte)
            b1_losses.append([
                loss_rows(
                    P["y"][te],
                    gbm(np.hstack([P["X"][tr], S_tr]), P["y"][tr],
                        np.hstack([P["X"][te], S_te]), s),
                )
                for s in range(seeds)
            ])
            log(f"  {cfg} B.1 fold {k} evr={evr[-1]:.3f} ({time.time() - t1:.0f}s)")
        b1 = graded(b1_losses, pub_ref, pub_groups)

        # ---- B.3 d1: base head fitted on ALL public rows, quantiles as features
        Hp = text_hash.hashed_matrix(HP, bits)
        Hl = text_hash.hashed_matrix(HL, bits)
        svd = _svd_of(Hp, dims)
        S_p, S_l = svd.transform(Hp), svd.transform(Hl)
        base_evr = float(svd.explained_variance_ratio_.sum())
        base_text = [gbm(S_p, P["y"], S_l, s) for s in range(seeds)]
        base_meta = [
            gbm(np.hstack([P["X"], S_p]), P["y"], np.hstack([L["X"], S_l]), s)
            for s in range(seeds)
        ]
        log(f"  {cfg} base heads fitted on {P['n']} public rows, evr={base_evr:.3f} "
            f"({time.time() - t1:.0f}s)")

        d1t, d1m, ratios = [], [], []
        for k in range(K_FOLDS):
            te, tr = loc_te[k], ~loc_te[k]
            fold_t, fold_m = [], []
            for s in range(seeds):
                for src_, sink in ((base_text[s], fold_t), (base_meta[s], fold_m)):
                    F_tr = np.hstack([L["X"][tr], np.log1p(src_[tr])])
                    F_te = np.hstack([L["X"][te], np.log1p(src_[te])])
                    sink.append(loss_rows(L["y"][te], gbm(F_tr, L["y"][tr], F_te, s)))
                ratios.append(
                    float(np.median(L["y"][tr] / np.maximum(base_text[s][tr][:, 0], 1.0)))
                )
            d1t.append(fold_t)
            d1m.append(fold_m)
        b3_text = graded(d1t, loc_ref, loc_groups)
        b3_meta = graded(d1m, loc_ref, loc_groups)

        payload = dict(
            bits=bits,
            dims=dims,
            projection_floats=dims * (1 << bits),
            svd_explained_variance_per_fold=evr,
            base_svd_explained_variance=base_evr,
            b1=b1,
            b3_d1_text_base=b3_text,
            b3_d1_meta_base=b3_meta,
            base_calibration_median_ratio=float(np.median(ratios)),
            seconds=float(time.time() - t1),
        )
        out[cfg] = payload
        log(
            f"  {cfg}: B.1 {b1['pct']:+.2f}% [{b1['pct_ci'][0]:+.2f},{b1['pct_ci'][1]:+.2f}]  "
            f"d1(text) {b3_text['pct']:+.2f}% [{b3_text['pct_ci'][0]:+.2f},{b3_text['pct_ci'][1]:+.2f}]  "
            f"d1(meta) {b3_meta['pct']:+.2f}% ({time.time() - t1:.0f}s)"
        )

    # ---- the gate: smallest config whose d1 interval overlaps the reference's
    ref_cfg = f"B{configs[0][0]}-K{configs[0][1]}"
    ref_ci = out[ref_cfg]["b3_d1_text_base"]["pct_ci"]
    order = sorted(out, key=lambda c: out[c]["projection_floats"])
    for cfg in order:
        ci = out[cfg]["b3_d1_text_base"]["pct_ci"]
        out[cfg]["overlaps_reference"] = bool(ci[0] <= ref_ci[1] and ref_ci[0] <= ci[1])

    print(f"\n=== Step 0 sweep: {label}, {K_FOLDS} folds x {seeds} seeds ===")
    print(f"{'config':10s} {'proj floats':>12s}  {'B.1 meta+SVD':>26s}  "
          f"{'B.3 d1 text-base':>26s}  {'B.3 d1 meta-base':>26s}  overlap")
    for cfg in [f"B{b}-K{k}" for b, k in configs]:
        r = out[cfg]
        def fmt(x):
            return f"{x['pct']:+6.2f}% [{x['pct_ci'][0]:+6.2f},{x['pct_ci'][1]:+6.2f}]"
        print(f"{cfg:10s} {r['projection_floats']:12d}  {fmt(r['b1']):>26s}  "
              f"{fmt(r['b3_d1_text_base']):>26s}  {fmt(r['b3_d1_meta_base']):>26s}  "
              f"{'yes' if r['overlaps_reference'] else 'NO'}")

    save(
        "sweep",
        label,
        dict(
            public=os.path.basename(os.path.dirname(os.path.abspath(public_path))),
            public_rows=P["n"],
            local_rows=L["n"],
            local_sessions=len(L["order"]),
            folds=K_FOLDS,
            seeds=seeds,
            hasher="text_hash.py (FNV-1a over UTF-16 code units, 2000-char truncation)",
            reference=ref_cfg,
            gate="smallest projection whose B.3 d1 text-base CI overlaps the reference CI",
            configs=out,
        ),
    )
    return out


# ------------------------------------------------------------------ svd noise


def run_svdnoise(path, label, fold, svd_seeds, gbm_seeds):
    """
    How much of the meta+SVD gap is the randomized SVD basis rather than the
    text?  Same fold, same rows, same GBM seeds, only `TruncatedSVD`'s
    random_state moves.  B.1 fits the SVD once per fold at random_state=0, so
    its session bootstrap does not carry this variance; this subcommand
    measures it so the interval can be read honestly.
    """
    D = load(path)
    y, X, sess, text = D["y"], D["X"], D["sess"], D["text"]
    blocks = folds_of(D["order"])
    ho = set(blocks[fold])
    te = np.array([s in ho for s in sess])
    tr = ~te
    itr, ite = np.where(tr)[0], np.where(te)[0]
    Htr, Hte = hashed([text[i] for i in itr]), hashed([text[i] for i in ite])
    ctrl = np.concatenate([loss_rows(y[te], gbm(X[tr], y[tr], X[te], s)) for s in range(gbm_seeds)])
    out = []
    for ss in range(svd_seeds):
        svd = TruncatedSVD(SVD_DIM, random_state=ss).fit(Htr)
        S_tr, S_te = svd.transform(Htr), svd.transform(Hte)
        l = np.concatenate(
            [
                loss_rows(y[te], gbm(np.hstack([X[tr], S_tr]), y[tr], np.hstack([X[te], S_te]), s))
                for s in range(gbm_seeds)
            ]
        )
        pct = 100 * (l.mean() / ctrl.mean() - 1)
        out.append(dict(svd_random_state=ss, loss=float(l.mean()), pct=float(pct)))
        log(f"  svd_random_state={ss}: meta+SVD {l.mean():.0f} vs control {ctrl.mean():.0f} ({pct:+.2f}%)")
    pcts = [o["pct"] for o in out]
    print(f"\n=== SVD-basis noise, {label} fold {fold}, {gbm_seeds} GBM seeds ===")
    print(f"control loss {ctrl.mean():.0f}; meta+SVD vs control across {svd_seeds} SVD seeds:")
    print("  " + "  ".join(f"{p:+.2f}%" for p in pcts))
    print(f"  spread {max(pcts) - min(pcts):.2f} pp, sd {np.std(pcts):.2f} pp")
    payload = dict(
        dataset=label,
        fold=fold,
        gbm_seeds=gbm_seeds,
        control_loss=float(ctrl.mean()),
        runs=out,
        spread_pp=float(max(pcts) - min(pcts)),
        sd_pp=float(np.std(pcts)),
    )
    save("svd_noise", f"{label}-fold{fold}", payload)
    return payload


# -------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("b1", help="scale test: 5 chronological session folds x seeds")
    p1.add_argument("turns")
    p1.add_argument("--label", default=None)
    p1.add_argument("--seeds", type=int, default=3)
    p1.add_argument("--lams", default="0.35,0.5,0.75,1.0")

    p2 = sub.add_parser("b2", help="learning curve on the fold-4 holdout")
    p2.add_argument("turns")
    p2.add_argument("--label", default=None)
    p2.add_argument("--seeds", type=int, default=3)
    p2.add_argument("--sizes", default="1000,2000,5000,10000,20000,1000000")

    p4 = sub.add_parser("svdnoise", help="how much of the gap is the randomized SVD basis")
    p4.add_argument("turns")
    p4.add_argument("--label", default=None)
    p4.add_argument("--fold", type=int, default=4)
    p4.add_argument("--svd-seeds", type=int, default=4)
    p4.add_argument("--gbm-seeds", type=int, default=3)

    p5 = sub.add_parser("sweep", help="Step 0: how small can (hash bits, SVD dims) get")
    p5.add_argument("--public", required=True)
    p5.add_argument("--local", required=True)
    p5.add_argument("--label", default="step0")
    p5.add_argument("--seeds", type=int, default=2)
    p5.add_argument(
        "--configs",
        default="18:256,14:64,13:48,12:32",
        help="comma-separated bits:dims; the FIRST is the reference",
    )

    p3 = sub.add_parser("b3", help="transfer a public base head to the local corpus")
    p3.add_argument("--public", required=True)
    p3.add_argument("--local", required=True)
    p3.add_argument("--seeds", type=int, default=3)
    p3.add_argument("--lam", type=float, required=True)

    a = ap.parse_args()
    if a.cmd == "b1":
        label = a.label or os.path.basename(os.path.dirname(os.path.abspath(a.turns)))
        run_b1(a.turns, label, a.seeds, [float(x) for x in a.lams.split(",")])
    elif a.cmd == "b2":
        label = a.label or os.path.basename(os.path.dirname(os.path.abspath(a.turns)))
        run_b2(a.turns, label, a.seeds, [int(x) for x in a.sizes.split(",")])
    elif a.cmd == "sweep":
        cfgs = [tuple(int(v) for v in c.split(":")) for c in a.configs.split(",")]
        run_sweep(a.public, a.local, a.label, a.seeds, cfgs)
    elif a.cmd == "svdnoise":
        label = a.label or os.path.basename(os.path.dirname(os.path.abspath(a.turns)))
        run_svdnoise(a.turns, label, a.fold, a.svd_seeds, a.gbm_seeds)
    else:
        run_b3(a.public, a.local, a.seeds, a.lam)


if __name__ == "__main__":
    main()
