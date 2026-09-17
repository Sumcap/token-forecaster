import json, sys, numpy as np, warnings, re
from collections import defaultdict
warnings.filterwarnings("ignore")
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.decomposition import TruncatedSVD
rng = np.random.default_rng(0); Q = [0.5, 0.9, 0.99]
rows = [json.loads(l) for l in open(sys.argv[1])]
y = np.array([r["total"] for r in rows], float); X = np.array([r["features"] for r in rows], float)
sess = np.array([r["sessionId"] or f"u:{r['turnRootId']}" for r in rows]); text = [r["text"] or "" for r in rows]
has_text = np.array([bool(r["text"]) for r in rows])
first = {}
for i, r in enumerate(rows): first.setdefault(sess[i], r["firstMs"])
order = sorted(first, key=first.get)
ACK = re.compile(r"^(ok|okay|yes|yeah|ya|sure|hi|hello|hey|go|do it|thanks|thx|no|nope|sim|nao|não|boa|ok then)\b", re.I)
PT = re.compile(r"\b(não|nao|para|com|isso|ele|ela|faz|fazer|vamos|está|estao|estão|mas|também|tambem|agora|depois|porque|isto)\b", re.I)
CONJ = re.compile(r"\b(and|also|then|afterwards|as well|plus|after that|e depois|também|tambem)\b", re.I)
CODEBLOCK = re.compile(r"```")
def struct(t):
    L = len(t); lines = t.count("\n")
    return [np.log1p(lines)/4, 1.0 if t.rstrip().endswith("?") else 0.0, 1.0 if ACK.match(t.strip()) else 0.0,
            np.log1p(len(PT.findall(t)))/3, np.log1p(len(CONJ.findall(t)))/3, 1.0 if CODEBLOCK.search(t) else 0.0,
            np.log1p(len(re.findall(r"\b(https?://|www\.)", t)))/2, np.log1p(len(re.findall(r"\d+", t)))/4,
            (sum(c.isupper() for c in t) / max(L,1)), 1.0 if L < 40 else 0.0]
ST = np.array([struct(t) if t else [0]*10 for t in text], float)
def pinball(y, q, p): d = y - q; return np.maximum(p * d, (p - 1) * d)
def loss_rows(y, preds): return sum(pinball(y, preds[:, i], p) for i, p in enumerate(Q))
def block_boot(diff, groups, n=2000):
    g = defaultdict(list)
    for d, k in zip(diff, groups): g[k].append(d)
    blocks = [np.array(v) for v in g.values()]; means = []
    for _ in range(n):
        idx = rng.integers(0, len(blocks), len(blocks)); means.append(np.concatenate([blocks[i] for i in idx]).mean())
    return diff.mean(), np.percentile(means, 2.5), np.percentile(means, 97.5)
def gbm(Xtr, ytr, Xte, seed):
    return np.column_stack([np.expm1(HistGradientBoostingRegressor(loss="quantile", quantile=p, max_iter=150, learning_rate=0.05,
        max_depth=3, min_samples_leaf=40, l2_regularization=1.0, random_state=seed).fit(Xtr, np.log1p(ytr)).predict(Xte)) for p in Q])
K = 5; blocks = np.array_split(np.array(order), K)
pooled = defaultdict(list); grp = []
print("per fold (3-seed mean loss on holdout text turns): meta | meta+struct | meta+tfidf | meta+struct+tfidf")
for k in range(K):
    ho = set(blocks[k]); te = np.array([s in ho for s in sess]); tr = ~te; trt, tet = tr & has_text, te & has_text
    tf = TfidfVectorizer(ngram_range=(1, 2), min_df=3, sublinear_tf=True, max_features=20000)
    T_tr = tf.fit_transform([text[i] for i in np.where(trt)[0]]); T_te = tf.transform([text[i] for i in np.where(tet)[0]])
    svd = TruncatedSVD(48, random_state=0).fit(T_tr); S_tr, S_te = svd.transform(T_tr), svd.transform(T_te)
    fold = defaultdict(list)
    for seed in range(3):
        fold["meta"].append(loss_rows(y[tet], gbm(X[trt], y[trt], X[tet], seed)))
        fold["meta+struct"].append(loss_rows(y[tet], gbm(np.hstack([X[trt], ST[trt]]), y[trt], np.hstack([X[tet], ST[tet]]), seed)))
        fold["meta+tfidf"].append(loss_rows(y[tet], gbm(np.hstack([X[trt], S_tr]), y[trt], np.hstack([X[tet], S_te]), seed)))
        fold["meta+struct+tfidf"].append(loss_rows(y[tet], gbm(np.hstack([X[trt], ST[trt], S_tr]), y[trt], np.hstack([X[tet], ST[tet], S_te]), seed)))
        grp.append(sess[tet])
    for n, l in fold.items(): pooled[n].extend(l)
    m = {n: np.mean(np.stack(l)) for n, l in fold.items()}
    print(f"fold {k} (n={tet.sum():3d}): {m['meta']:7.0f} | {m['meta+struct']:7.0f} ({100*(m['meta+struct']/m['meta']-1):+.1f}%) | {m['meta+tfidf']:7.0f} ({100*(m['meta+tfidf']/m['meta']-1):+.1f}%) | {m['meta+struct+tfidf']:7.0f} ({100*(m['meta+struct+tfidf']/m['meta']-1):+.1f}%)")
groups = np.concatenate(grp); ref = np.concatenate(pooled["meta"])
print("pooled, block bootstrap by session vs meta:")
for n, l in pooled.items():
    l = np.concatenate(l); m, lo, hi = block_boot(l - ref, groups)
    print(f"  {n:18s} loss={l.mean():7.0f}  {m:+6.0f} [{lo:+6.0f},{hi:+6.0f}] ({100*m/ref.mean():+.1f}%)")
