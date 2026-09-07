"""Semantic turn-total probe. Reads the local-only turns.jsonl, never writes text."""
import json, sys, numpy as np, warnings
from collections import defaultdict
warnings.filterwarnings("ignore")
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.decomposition import TruncatedSVD, PCA
from sklearn.neighbors import NearestNeighbors
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score

rng = np.random.default_rng(0)
Q = [0.5, 0.9, 0.99]
rows = [json.loads(l) for l in open(sys.argv[1])]
target = sys.argv[2] if len(sys.argv) > 2 else "total"   # total | openerTokens
y = np.array([r[target] for r in rows], float)
X = np.array([r["features"] for r in rows], float)
sess = np.array([r["sessionId"] or f"u:{r['turnRootId']}" for r in rows])
text = [r["text"] or "" for r in rows]
has_text = np.array([bool(r["text"]) for r in rows])
thinking = np.array([r["thinking"] for r in rows])

# ---- session-chronological 80/20 split (same rule as the JS probe)
first = {}
for i, r in enumerate(rows):
    first.setdefault(sess[i], r["firstMs"])
order = sorted(first, key=first.get)
cut = int(len(order) * 0.8)
train_sess = set(order[:cut])
tr = np.array([s in train_sess for s in sess]); te = ~tr
print(f"{len(rows)} turns, train {tr.sum()} holdout {te.sum()} in {len(order)-cut} sessions; text on {has_text.mean():.0%}; target={target}")

def pinball(y, q, p): d = y - q; return np.maximum(p * d, (p - 1) * d)
def loss_rows(y, preds): return sum(pinball(y, preds[:, i], p) for i, p in enumerate(Q))
def block_boot(diff, groups, n=2000):
    g = defaultdict(list)
    for d, k in zip(diff, groups): g[k].append(d)
    blocks = [np.array(v) for v in g.values()]
    means = []
    for _ in range(n):
        idx = rng.integers(0, len(blocks), len(blocks))
        s = np.concatenate([blocks[i] for i in idx]); means.append(s.mean())
    return diff.mean(), np.percentile(means, 2.5), np.percentile(means, 97.5)

# ---- baseline A: thinking ladder (empirical quantiles), min group 60
def ladder(keys_tr, y_tr, keys_te, mn=60):
    fits = {}
    for k in set(keys_tr):
        v = y_tr[keys_tr == k]
        if len(v) >= mn: fits[k] = np.quantile(v, Q)
    overall = np.quantile(y_tr, Q)
    return np.array([fits.get(k, overall) for k in keys_te])

# ---- embeddings
from sentence_transformers import SentenceTransformer
st = SentenceTransformer("all-MiniLM-L6-v2")
E = st.encode([t[:2000] for t in text], batch_size=64, normalize_embeddings=True, show_progress_bar=False)

def gbm_quantiles(Xtr, ytr, Xte, seed=0):
    out = []
    for p in Q:
        m = HistGradientBoostingRegressor(loss="quantile", quantile=p, max_iter=150, learning_rate=0.05,
                                          max_depth=3, min_samples_leaf=40, l2_regularization=1.0, random_state=seed)
        m.fit(Xtr, np.log1p(ytr)); out.append(np.expm1(m.predict(Xte)))
    return np.column_stack(out)

def knn_quantiles(Etr, ytr, Ete, k=40):
    nn = NearestNeighbors(n_neighbors=k, metric="cosine").fit(Etr)
    _, idx = nn.kneighbors(Ete)
    return np.array([np.quantile(ytr[i], Q) for i in idx])

def evaluate(name, pred_te, base_te, mask=None):
    m = te if mask is None else (te & mask)
    yy = y[m]; pr = pred_te[m[te]] if pred_te.shape[0] == te.sum() else pred_te[m]
    ba = base_te[m[te]] if base_te.shape[0] == te.sum() else base_te[m]
    l = loss_rows(yy, pr); lb = loss_rows(yy, ba)
    mean, lo, hi = block_boot(l - lb, sess[m])
    cov = [(yy <= pr[:, i]).mean() for i in range(3)]
    print(f"{name:34s} loss={l.mean():7.0f}  vs base {mean:+7.0f} [{lo:+7.0f},{hi:+7.0f}]  cov={cov[0]:.2f}/{cov[1]:.2f}/{cov[2]:.2f}  n={m.sum()}")
    return l

# ---- fit everything on train, score holdout
base = ladder(thinking[tr], y[tr], thinking[te])
print("\n== all holdout turns (rows without text fall back to base) ==")
evaluate("A thinking ladder (mt)", base, base)
meta = gbm_quantiles(X[tr], y[tr], X[te])
evaluate("B metadata GBM (38 feats)", meta, base)

# text-only models: train on train rows with text, predict on holdout rows with text, else base
trt = tr & has_text; tet = te & has_text
def fill(pred_text_rows):
    out = base.copy(); out[tet[te]] = pred_text_rows; return out

tf = TfidfVectorizer(ngram_range=(1, 2), min_df=3, sublinear_tf=True, max_features=20000)
T_tr = tf.fit_transform([text[i] for i in np.where(trt)[0]]); T_te = tf.transform([text[i] for i in np.where(tet)[0]])
svd = TruncatedSVD(48, random_state=0).fit(T_tr)
S_tr, S_te = svd.transform(T_tr), svd.transform(T_te)
pca = PCA(32, random_state=0).fit(E[trt]); P_tr, P_te = pca.transform(E[trt]), pca.transform(E[tet])

pred_tfidf = fill(gbm_quantiles(S_tr, y[trt], S_te))
pred_emb = fill(gbm_quantiles(P_tr, y[trt], P_te))
pred_knn = fill(knn_quantiles(E[trt], y[trt], E[tet]))
pred_meta_tfidf = fill(gbm_quantiles(np.hstack([X[trt], S_tr]), y[trt], np.hstack([X[tet], S_te])))
pred_meta_emb = fill(gbm_quantiles(np.hstack([X[trt], P_tr]), y[trt], np.hstack([X[tet], P_te])))
pred_meta_both = fill(gbm_quantiles(np.hstack([X[trt], P_tr, S_tr]), y[trt], np.hstack([X[tet], P_te, S_te])))
# knn + metadata: average quantiles of knn and metadata GBM (cheap stacking)
pred_knn_meta = fill(0.5 * knn_quantiles(E[trt], y[trt], E[tet]) + 0.5 * meta[tet[te]])

for n, p in [("C tfidf only GBM", pred_tfidf), ("D MiniLM PCA32 only GBM", pred_emb), ("E MiniLM kNN40 quantiles", pred_knn),
             ("F meta+tfidf GBM", pred_meta_tfidf), ("G meta+MiniLM GBM", pred_meta_emb), ("H meta+MiniLM+tfidf GBM", pred_meta_both),
             ("I avg(kNN, meta GBM)", pred_knn_meta)]:
    evaluate(n, p, base)

print("\n== same, restricted to holdout turns WITH text, vs metadata GBM (B) ==")
for n, p in [("A thinking ladder", base), ("C tfidf only", pred_tfidf), ("D MiniLM only", pred_emb), ("E MiniLM kNN", pred_knn),
             ("F meta+tfidf", pred_meta_tfidf), ("G meta+MiniLM", pred_meta_emb), ("H meta+both", pred_meta_both), ("I avg(kNN,meta)", pred_knn_meta)]:
    evaluate(n, p, meta, mask=has_text)

# ---- R² on log target, point (ridge / GBM median), text rows only, for comparability with §7.3
print("\n== R² on log1p(target), holdout rows with text ==")
ylog_tr, ylog_te = np.log1p(y[trt]), np.log1p(y[tet])
def r2(name, Xtr, Xte, alpha=10.0):
    m = Ridge(alpha=alpha).fit(Xtr, ylog_tr); print(f"{name:34s} R²={r2_score(ylog_te, m.predict(Xte)):.3f}")
r2("metadata (38)", X[trt], X[tet])
r2("tfidf svd48 alone", S_tr, S_te)
r2("MiniLM 384 alone", E[trt], E[tet], alpha=3.0)
r2("metadata + MiniLM", np.hstack([X[trt], E[trt]]), np.hstack([X[tet], E[tet]]), alpha=3.0)
r2("metadata + MiniLM + tfidf", np.hstack([X[trt], E[trt], S_tr]), np.hstack([X[tet], E[tet], S_te]), alpha=3.0)
# kNN R²
kq = knn_quantiles(E[trt], y[trt], E[tet]); print(f"{'MiniLM kNN40 median':34s} R²={r2_score(ylog_te, np.log1p(kq[:,0])):.3f}")

# ---- learning curve: how does kNN / meta+emb loss move with train size?
print("\n== learning curve (holdout-with-text loss, vs metadata GBM at full train) ==")
full_meta_loss = loss_rows(y[tet], meta[tet[te]]).mean()
idx = np.where(trt)[0]  # chronological already
for frac in [0.25, 0.5, 0.75, 1.0]:
    sub = idx[: int(len(idx) * frac)]
    pk = knn_quantiles(E[sub], y[sub], E[tet]); pg = gbm_quantiles(np.hstack([X[sub], pca.transform(E[sub])]), y[sub], np.hstack([X[tet], P_te]))
    pm = gbm_quantiles(X[sub], y[sub], X[tet])
    print(f"train={len(sub):5d}  meta={loss_rows(y[tet], pm).mean():7.0f}  kNN={loss_rows(y[tet], pk).mean():7.0f}  meta+emb={loss_rows(y[tet], pg).mean():7.0f}  (full-train meta {full_meta_loss:.0f})")
