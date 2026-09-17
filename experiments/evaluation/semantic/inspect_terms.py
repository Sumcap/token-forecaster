import json, sys, numpy as np, re
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import Ridge
rows = [json.loads(l) for l in open(sys.argv[1])]
rows = [r for r in rows if r["text"]]
y = np.log1p(np.array([r["total"] for r in rows], float)); text = [r["text"] for r in rows]
tf = TfidfVectorizer(ngram_range=(1, 2), min_df=5, sublinear_tf=True, max_features=20000)
T = tf.fit_transform(text); m = Ridge(alpha=1.0).fit(T, y - y.mean())
names = np.array(tf.get_feature_names_out()); w = m.coef_
# only show terms that look like ordinary words (no paths / identifiers), to keep your own prompt content out of the report
ok = np.array([bool(re.fullmatch(r"[a-z][a-z ]{1,24}", n)) for n in names])
idx = np.argsort(w)
print("LONGER turns  <-  terms:", ", ".join(f"{names[i]}({w[i]:+.2f})" for i in idx[ok[idx]][::-1][:40]))
print("SHORTER turns <-  terms:", ", ".join(f"{names[i]}({w[i]:+.2f})" for i in idx[ok[idx]][:40]))
# structure stats
L = np.array([len(t) for t in text]); nl = np.array([t.count("\n") for t in text]); q = np.array([t.rstrip().endswith("?") for t in text])
tot = np.array([r["total"] for r in rows])
for name, mask in [("question mark", q), ("multi-line", nl >= 2), ("len<80", L < 80), ("len 80-400", (L >= 80) & (L < 400)), ("len>=400", L >= 400)]:
    print(f"{name:14s} n={mask.sum():4d} median total={np.median(tot[mask]):7.0f} p90={np.quantile(tot[mask],.9):7.0f}")
