import json, sys, numpy as np, warnings, os
os.environ["TRANSFORMERS_VERBOSITY"]="error"; os.environ["HF_HUB_DISABLE_PROGRESS_BARS"]="1"
from collections import defaultdict
warnings.filterwarnings("ignore")
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.decomposition import TruncatedSVD
from sklearn.linear_model import Ridge
rng = np.random.default_rng(0)
Q = [0.5, 0.9, 0.99]
rows = [json.loads(l) for l in open(sys.argv[1])]
target = sys.argv[2]
y = np.array([r[target] for r in rows], float); X = np.array([r["features"] for r in rows], float)
sess = np.array([r["sessionId"] or f"u:{r['turnRootId']}" for r in rows]); text = [r["text"] or "" for r in rows]
has_text = np.array([bool(r["text"]) for r in rows]); thinking = np.array([r["thinking"] for r in rows])
first = {}
for i, r in enumerate(rows): first.setdefault(sess[i], r["firstMs"])
order = sorted(first, key=first.get)
def pinball(y, q, p): d = y - q; return np.maximum(p * d, (p - 1) * d)
def loss_rows(y, preds): return sum(pinball(y, preds[:, i], p) for i, p in enumerate(Q))
def block_boot(diff, groups, n=2000):
    g = defaultdict(list)
    for d, k in zip(diff, groups): g[k].append(d)
    blocks = [np.array(v) for v in g.values()]; means = []
    for _ in range(n):
        idx = rng.integers(0, len(blocks), len(blocks)); means.append(np.concatenate([blocks[i] for i in idx]).mean())
    return diff.mean(), np.percentile(means, 2.5), np.percentile(means, 97.5)
def ladder(ktr, ytr, kte, mn=60):
    fits = {k: np.quantile(ytr[ktr == k], Q) for k in set(ktr) if (ktr == k).sum() >= mn}; o = np.quantile(ytr, Q)
    return np.array([fits.get(k, o) for k in kte])
def gbm(Xtr, ytr, Xte, seed):
    return np.column_stack([np.expm1(HistGradientBoostingRegressor(loss="quantile", quantile=p, max_iter=150, learning_rate=0.05,
        max_depth=3, min_samples_leaf=40, l2_regularization=1.0, random_state=seed).fit(Xtr, np.log1p(ytr)).predict(Xte)) for p in Q])

# 5 chronological session folds: fold k holds out sessions block k (rolling-origin style: train on everything else)
K = 5; blocks = np.array_split(np.array(order), K)
acc = defaultdict(list)   # name -> list of per-row loss arrays (holdout, text rows only)
grp = []; base_meta = []; base_lad = []
for k in range(K):
    ho = set(blocks[k]); te = np.array([s in ho for s in sess]); tr = ~te
    trt, tet = tr & has_text, te & has_text
    tf = TfidfVectorizer(ngram_range=(1, 2), min_df=3, sublinear_tf=True, max_features=20000)
    T_tr = tf.fit_transform([text[i] for i in np.where(trt)[0]]); T_te = tf.transform([text[i] for i in np.where(tet)[0]])
    svd = TruncatedSVD(48, random_state=0).fit(T_tr); S_tr, S_te = svd.transform(T_tr), svd.transform(T_te)
    lad = ladder(thinking[tr], y[tr], thinking[tet])
    for seed in range(3):
        meta = gbm(X[trt], y[trt], X[tet], seed)
        acc["B meta GBM"].append(loss_rows(y[tet], meta))
        acc["C tfidf GBM"].append(loss_rows(y[tet], gbm(S_tr, y[trt], S_te, seed)))
        acc["F meta+tfidf GBM"].append(loss_rows(y[tet], gbm(np.hstack([X[trt], S_tr]), y[trt], np.hstack([X[tet], S_te]), seed)))
        acc["A thinking ladder"].append(loss_rows(y[tet], lad))
        grp.append(sess[tet])
    print(f"fold {k}: holdout text turns {tet.sum()} sessions {len(ho)}", file=sys.stderr)
groups = np.concatenate(grp)
print(f"target={target}: 5 chronological session folds x 3 seeds, holdout text turns pooled n={len(groups)}")
ref = np.concatenate(acc["B meta GBM"])
for name, lst in acc.items():
    l = np.concatenate(lst); m, lo, hi = block_boot(l - ref, groups)
    print(f"{name:22s} loss={l.mean():7.0f}  vs meta {m:+6.0f} [{lo:+6.0f},{hi:+6.0f}]  ({100*m/ref.mean():+.1f}%)")
