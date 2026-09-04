#!/usr/bin/env python3
"""
Stage 3 encoder probe: does a fine-tuned MiniLM encoder head beat the shipped
38-feature metadata model where the hashed n-gram head stalled, and does it
transfer to the local corpus better than the hashed head does?

Everything here is aggregates.  No prompt text is printed or written anywhere.

    python3 probe_encoder.py smoke   --turns <public.jsonl> [--fold 0] [--seed 0]
    python3 probe_encoder.py part1   --turns <turns.jsonl> [--label NAME] [--seeds N]
    python3 probe_encoder.py part2   --public <public.jsonl> --local <local.jsonl>

Protocol, learner, loss and bootstrap are imported from
`probe_semantic_scale.py` so the numbers sit in the same table as the 2
September Step B results: rows with non-empty text only, sessions ordered by
first `firstMs`, five chronological session blocks, leave-one-block-out,
summed pinball at p50/p90/p99 on the RAW token scale, 2,000-resample
session-block bootstrap on the paired per-row difference against the
metadata-only quantile GBM control.

The metadata control and every "meta" input use columns 0..37 only.  The local
export carries 42 columns: 38-40 are the shipped hashed base head's log1p
quantiles and 41 is a presence bit; those four are never fed to a "meta" arm.

Encoder head (docs: Stage 3):
  sentence-transformers/all-MiniLM-L6-v2, mean pooling over the attention
  mask, text truncated to the first 2,000 UTF-16 code units (the shipped rule,
  `text_hash.truncate_utf16`) then tokenised at max_length=256.
  concat[pooled 384 (+ standardised 38 meta)] -> Linear(64) -> GELU ->
  Linear(3); order enforced with cumulative softplus
  (q50 = z0, q90 = q50 + softplus(z1), q99 = q90 + softplus(z2)).
  Targets log1p(total); training loss the summed pinball in log space.
  AdamW, lr 2e-5 encoder / 1e-3 head, weight decay 0.01, batch 32, 6% linear
  warmup then linear decay, up to 4 epochs.  The chronologically last 10% of
  the TRAINING sessions is held out as inner validation and the epoch with the
  best raw-scale pinball there is the one applied to the holdout, so the
  encoder trains on ~90% of the training rows while the GBM control trains on
  100% of them.
"""

import argparse
import math
import os
import sys
import time
import warnings
from collections import defaultdict

import numpy as np

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")

# The MPS caching allocator never hands a freed block back to the driver until
# the total crosses its LOW watermark, which defaults to 1.0 x the recommended
# maximum (12.9 GB on this box) -- i.e. effectively never.  Cycling batches
# through the eight padded width buckets therefore parks a different set of
# cached blocks per width and the process settles at ~5.9 GB of driver memory
# while only ~3.0 GB is ever live.  On an 18 GB machine that is the difference
# between running and swapping, and once it swaps the GPU work slows by 15-20x.
# Purge the cache above 1.5 GiB (0.12) and keep an 8.4 GiB ceiling (0.7) so a
# runaway raises instead of wedging the machine (the unconstrained steady state
# is 5.5 GiB, so the ceiling can never fire on the workload as it stands).  Both
# must be set before torch is imported; measured cost: none, 6.64 vs 6.73
# steps/s over a full cycle of the eight width buckets at batch 32.
os.environ.setdefault("PYTORCH_MPS_LOW_WATERMARK_RATIO", "0.12")
os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.7")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

warnings.filterwarnings("ignore")

import text_hash  # noqa: E402
import base_head_eval  # noqa: E402
from probe_semantic_scale import (  # noqa: E402
    K_FOLDS,
    Q,
    blend,
    block_boot,
    folds_of,
    gbm,
    load,
    log,
    loss_rows,
    print_table,
    save,
    summarise,
)

from scipy.stats import spearmanr  # noqa: E402
from sklearn.decomposition import TruncatedSVD  # noqa: E402
from sklearn.feature_extraction.text import TfidfVectorizer  # noqa: E402
from sklearn.linear_model import QuantileRegressor  # noqa: E402

import torch  # noqa: E402
import torch.nn as nn  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from transformers import AutoModel, AutoTokenizer  # noqa: E402
from transformers.utils import logging as hf_logging  # noqa: E402

hf_logging.set_verbosity_error()

MODEL = "sentence-transformers/all-MiniLM-L6-v2"
MAX_LEN = 256
BATCH = 32
INFER_BATCH = 128
INFER_TOKENS = 8192
EPOCHS = 4
LR_ENCODER = 2e-5
LR_HEAD = 1e-3
WEIGHT_DECAY = 0.01
WARMUP_FRAC = 0.06
INNER_VAL_FRAC = 0.10
META_COLS = 38
BASE_ASSET = os.path.normpath(
    os.path.join(
        HERE, "..", "..", "..", "packages", "predictor", "src", "text-head",
        "base-text-head.json",
    )
)

DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"

_STEP_TIMES = []  # (steps, seconds) for the steps/s report


def _mem():
    """Driver-side MPS footprint, so a swapping run is obvious in the log."""
    if DEVICE != "mps":
        return ""
    return (f", {torch.mps.driver_allocated_memory() / 2**30:.1f} GiB mps"
            f"/{torch.mps.current_allocated_memory() / 2**30:.1f} live")


# --------------------------------------------------------------------------- data


def load_checked(path, expect_cols):
    D = load(path)
    got = D["X"].shape[1]
    assert got == expect_cols, f"{path}: expected {expect_cols} feature columns, got {got}"
    return D


def tokenise(D, tok):
    """Truncate exactly as the shipped head does, then tokenise once."""
    texts = [text_hash.truncate_utf16(t) for t in D["text"]]
    enc = tok(texts, truncation=True, max_length=MAX_LEN, add_special_tokens=True)["input_ids"]
    ids = [np.asarray(e, dtype=np.int64) for e in enc]
    lens = np.array([len(e) for e in ids])
    log(f"  tokenised {len(ids)} docs: mean {lens.mean():.0f} tokens, "
        f"median {np.median(lens):.0f}, {100 * (lens == MAX_LEN).mean():.1f}% at the cap")
    return ids, lens


def inner_split(D, train_mask):
    """Chronologically LAST 10% of the TRAINING sessions become inner validation."""
    train = set(D["sess"][train_mask])  # hoisted: this was rebuilt per session
    train_sessions = [s for s in D["order"] if s in train]
    n_val = max(1, int(round(INNER_VAL_FRAC * len(train_sessions))))
    val_sessions = set(train_sessions[len(train_sessions) - n_val:])
    is_val = np.array([s in val_sessions for s in D["sess"]]) & train_mask
    is_fit = train_mask & ~is_val
    return np.where(is_fit)[0], np.where(is_val)[0]


def standardise(X, fit_idx):
    mu = X[fit_idx].mean(axis=0)
    sd = X[fit_idx].std(axis=0)
    sd[sd == 0] = 1.0
    return ((X - mu) / sd).astype(np.float32)


# ------------------------------------------------------------------- encoder head


class EncoderHead(nn.Module):
    def __init__(self, meta_dim):
        super().__init__()
        self.enc = AutoModel.from_pretrained(MODEL)
        self.fc1 = nn.Linear(384 + meta_dim, 64)
        self.fc2 = nn.Linear(64, 3)

    def forward(self, ids, mask, meta):
        h = self.enc(input_ids=ids, attention_mask=mask).last_hidden_state
        m = mask.unsqueeze(-1).to(h.dtype)
        pooled = (h * m).sum(1) / m.sum(1).clamp(min=1e-9)
        if meta is not None:
            pooled = torch.cat([pooled, meta], dim=1)
        z = self.fc2(F.gelu(self.fc1(pooled)))
        q50 = z[:, 0]
        q90 = q50 + F.softplus(z[:, 1])
        q99 = q90 + F.softplus(z[:, 2])
        return torch.stack([q50, q90, q99], dim=1)


WIDTH_STEP = 32  # pad batch widths to a multiple of this: MPS recompiles per shape


def _collate(batch_idx, ids, pad_id):
    width = max(len(ids[i]) for i in batch_idx)
    width = min(MAX_LEN, WIDTH_STEP * math.ceil(width / WIDTH_STEP))
    a = np.full((len(batch_idx), width), pad_id, dtype=np.int64)
    m = np.zeros((len(batch_idx), width), dtype=np.int64)
    for r, i in enumerate(batch_idx):
        e = ids[i]
        a[r, : len(e)] = e
        m[r, : len(e)] = 1
    return torch.from_numpy(a), torch.from_numpy(m)


def _length_batches(idx, lens, rng, bs=BATCH, group=50):
    """
    Length-grouped batches: shuffle, cut into megabatches of `group * bs`, sort
    each by token length, chop into batches, then shuffle the batch order.  A
    padding-efficiency device only (the standard `group_by_length` sampler); it
    does not change which rows are seen per epoch.
    """
    idx = rng.permutation(np.asarray(idx))
    out = []
    mega = bs * group
    for s in range(0, len(idx), mega):
        chunk = idx[s: s + mega]
        chunk = chunk[np.argsort(lens[chunk], kind="stable")]
        for b in range(0, len(chunk), bs):
            out.append(chunk[b: b + bs])
    return [out[i] for i in rng.permutation(len(out))]


def _pinball_torch(pred, target, qt):
    d = target.unsqueeze(1) - pred
    return torch.maximum(qt * d, (qt - 1) * d).sum(1).mean()


@torch.no_grad()
def _predict(model, ids, lens, idx, meta_std):
    model.eval()
    idx = np.asarray(idx)
    order = idx[np.argsort(lens[idx], kind="stable")]
    pos = {int(v): i for i, v in enumerate(idx)}
    out = np.zeros((len(idx), 3), dtype=np.float64)
    pad = _predict.pad_id
    for bi in _token_budget_batches(order, lens):
        a, m = _collate(bi, ids, pad)
        meta_t = (
            torch.from_numpy(meta_std[bi]).to(DEVICE) if meta_std is not None else None
        )
        z = model(a.to(DEVICE), m.to(DEVICE), meta_t).float().cpu().numpy()
        for r, i in enumerate(bi):
            out[pos[int(i)]] = z[r]
    model.train()
    return out  # log1p scale


def _raw(logq):
    return np.expm1(np.clip(logq, -5.0, 20.0))


def train_encoder(ids, lens, y, fit_idx, val_idx, apply_idx, meta_std, seed, epochs=EPOCHS,
                  tag=""):
    """
    Returns (raw-scale quantiles on apply_idx, best_epoch, inner-val raw pinball,
    seconds, steps).
    """
    torch.manual_seed(seed)
    np.random.seed(seed)
    rng = np.random.default_rng(seed)
    meta_dim = 0 if meta_std is None else meta_std.shape[1]
    model = EncoderHead(meta_dim).to(DEVICE)
    model.train()
    enc_params = list(model.enc.parameters())
    head_params = list(model.fc1.parameters()) + list(model.fc2.parameters())
    opt = torch.optim.AdamW(
        [
            {"params": enc_params, "lr": LR_ENCODER},
            {"params": head_params, "lr": LR_HEAD},
        ],
        weight_decay=WEIGHT_DECAY,
    )
    steps_per_epoch = math.ceil(len(fit_idx) / BATCH)
    total_steps = epochs * steps_per_epoch
    warm = max(1, int(WARMUP_FRAC * total_steps))

    def lr_lambda(step):
        if step < warm:
            return step / warm
        return max(0.0, (total_steps - step) / max(1, total_steps - warm))

    sched = torch.optim.lr_scheduler.LambdaLR(opt, lr_lambda)
    qt = torch.tensor(Q, dtype=torch.float32, device=DEVICE)
    ly = torch.from_numpy(np.log1p(y).astype(np.float32))
    pad = _predict.pad_id

    best = (np.inf, -1, None)
    t0 = time.time()
    steps = 0
    for ep in range(epochs):
        te = time.time()
        for batch in _length_batches(fit_idx, lens, rng):
            a, m = _collate(batch, ids, pad)
            meta_t = (
                torch.from_numpy(meta_std[batch]).to(DEVICE) if meta_std is not None else None
            )
            pred = model(a.to(DEVICE), m.to(DEVICE), meta_t)
            loss = _pinball_torch(pred, ly[batch].to(DEVICE), qt)
            loss.backward()
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            steps += 1
        vl = _raw(_predict(model, ids, lens, val_idx, meta_std))
        vloss = float(loss_rows(y[val_idx], np.maximum(vl, 0.0)).mean())
        mark = ""
        if vloss < best[0]:
            best = (vloss, ep, _raw(_predict(model, ids, lens, apply_idx, meta_std)))
            mark = " *"
        log(f"    {tag} epoch {ep}: inner-val pinball {vloss:.1f}{mark} "
            f"({time.time() - te:.0f}s, {steps_per_epoch / max(1e-9, time.time() - te):.1f} steps/s"
            f"{_mem()})")
    dt = time.time() - t0
    _STEP_TIMES.append((steps, dt))
    del model, opt, sched, enc_params, head_params
    if DEVICE == "mps":
        torch.mps.empty_cache()
    return np.maximum(best[2], 0.0), best[1], best[0], dt, steps


def _token_budget_batches(order, lens, budget=INFER_TOKENS):
    """Inference batches of at most `budget` padded tokens (attention is O(L^2))."""
    out, cur = [], []
    for i in order:
        w = min(MAX_LEN, WIDTH_STEP * math.ceil(lens[i] / WIDTH_STEP))
        if cur and (len(cur) + 1) * w > budget:
            out.append(np.asarray(cur))
            cur = []
        cur.append(int(i))
        if len(cur) >= INFER_BATCH:
            out.append(np.asarray(cur))
            cur = []
    if cur:
        out.append(np.asarray(cur))
    return out


@torch.no_grad()
def frozen_embeddings(ids, lens):
    """Mean-pooled frozen MiniLM embeddings, one pass over the corpus."""
    t0 = time.time()
    enc = AutoModel.from_pretrained(MODEL).to(DEVICE).eval()
    n = len(ids)
    out = np.zeros((n, 384), dtype=np.float32)
    order = np.argsort(lens, kind="stable")
    pad = _predict.pad_id
    for j, bi in enumerate(_token_budget_batches(order, lens)):
        a, m = _collate(bi, ids, pad)
        h = enc(input_ids=a.to(DEVICE), attention_mask=m.to(DEVICE)).last_hidden_state
        mm = m.to(DEVICE).unsqueeze(-1).to(h.dtype)
        pooled = (h * mm).sum(1) / mm.sum(1).clamp(min=1e-9)
        out[bi] = pooled.float().cpu().numpy()
        if j % 100 == 0:
            log(f"    frozen batch {j} ({time.time() - t0:.0f}s)")
    del enc
    if DEVICE == "mps":
        torch.mps.empty_cache()
    log(f"  frozen embeddings for {n} docs ({time.time() - t0:.0f}s)")
    return out


# --------------------------------------------------------- hashed base head (local)


def hashed_base_quantiles(D):
    """
    The shipped hashed head's three log1p quantiles for every row.

    The exporter writes columns 38-40 only when it is handed a text head; when
    they are all zero (as in the export this probe reads) they are recomputed
    here from the SAME committed asset the TypeScript evaluator walks, so arm
    `h` is still the paired reference for the same rows.
    """
    X = D["X"]
    if X.shape[1] >= 42 and np.abs(X[:, 38:41]).max() > 0:
        assert (X[:, 41] == 1).all(), "presence bit is not set on text rows"
        log("  hashed head quantiles: taken from export columns 38-40")
        return X[:, 38:41].astype(float), "export columns 38-40"
    asset = base_head_eval.load_asset(BASE_ASSET)
    deq = base_head_eval.dequantise(asset)
    t0 = time.time()
    out = np.array([base_head_eval.evaluate(asset, t, deq) for t in D["text"]], dtype=float)
    log(f"  hashed head quantiles: export columns 38-41 are all zero, recomputed from "
        f"{os.path.basename(BASE_ASSET)} (bits={asset['bits']}, dims={asset['dims']}) "
        f"for {len(out)} rows ({time.time() - t0:.0f}s)")
    return out, f"recomputed from {os.path.basename(BASE_ASSET)}"


# ----------------------------------------------------------- local rescale recipes


def _shift_consts(y_tr, base_tr):
    lb = np.log1p(np.maximum(base_tr, 0.0))
    ly = np.log1p(y_tr)
    return np.array([np.quantile(ly - lb[:, i], p) for i, p in enumerate(Q)])


def rescale_raw(y_tr, base_tr, base_te):
    return np.maximum(base_te, 0.0)


def rescale_shift(y_tr, base_tr, base_te):
    c = _shift_consts(y_tr, base_tr)
    return np.expm1(np.log1p(np.maximum(base_te, 0.0)) + c[None, :])


def rescale_linear(y_tr, base_tr, base_te):
    ly = np.log1p(y_tr)
    out = np.zeros((base_te.shape[0], 3))
    for i, p in enumerate(Q):
        xtr = np.log1p(np.maximum(base_tr[:, i], 0.0)).reshape(-1, 1)
        xte = np.log1p(np.maximum(base_te[:, i], 0.0)).reshape(-1, 1)
        qr = QuantileRegressor(quantile=p, alpha=0.0, solver="highs").fit(xtr, ly)
        out[:, i] = qr.predict(xte)
    out = np.maximum.accumulate(out, axis=1)
    return np.expm1(out)


def rescale_isotonic(y_tr, base_tr, base_te, nbins=10, min_rows=30):
    ly = np.log1p(y_tr)
    c = _shift_consts(y_tr, base_tr)
    out = np.zeros((base_te.shape[0], 3))
    for i, p in enumerate(Q):
        xtr = np.log1p(np.maximum(base_tr[:, i], 0.0))
        xte = np.log1p(np.maximum(base_te[:, i], 0.0))
        edges = np.unique(np.quantile(xtr, np.linspace(0, 1, nbins + 1)[1:-1]))
        btr = np.digitize(xtr, edges)
        centres, values = [], []
        for b in range(len(edges) + 1):
            m = btr == b
            if m.sum() == 0:
                continue
            centre = float(xtr[m].mean())
            centres.append(centre)
            values.append(float(np.quantile(ly[m], p)) if m.sum() >= min_rows else centre + c[i])
        centres = np.array(centres)
        values = np.maximum.accumulate(np.array(values))
        if len(centres) == 1:
            out[:, i] = values[0]
        else:
            out[:, i] = np.interp(xte, centres, values)
    out = np.maximum.accumulate(out, axis=1)
    return np.expm1(out)


RESCALES = [
    ("raw", rescale_raw),
    ("shift", rescale_shift),
    ("linear", rescale_linear),
    ("isotonic", rescale_isotonic),
]


# ----------------------------------------------------------------- Part 1 (public)


def run_part1(path, label, seeds, epochs, folds=None, tag=None):
    D = load_checked(path, META_COLS)
    y, X, sess, tool = D["y"], D["X"], D["sess"], D["tool"]
    tok = AutoTokenizer.from_pretrained(MODEL)
    _predict.pad_id = tok.pad_token_id
    ids, lens = tokenise(D, tok)
    blocks = folds_of(D["order"])
    fold_list = list(range(K_FOLDS)) if folds is None else folds
    log(f"Part 1 {label}: {D['n']} turns, {len(D['order'])} sessions, "
        f"{len(fold_list)} folds x {seeds} seeds, device={DEVICE}")

    frozen = frozen_embeddings(ids, lens)

    acc = defaultdict(list)
    per_fold = defaultdict(list)
    grp, tools_pooled = [], []
    pool_ref, pool_arm4, pool_y = [], [], []
    pool_p50_ref, pool_p50_arm4 = [], []
    epochs_selected = {"encoder only": [], "encoder + meta": []}
    inner_val = {"encoder only": [], "encoder + meta": []}
    t_start = time.time()

    for k in fold_list:
        t0 = time.time()
        ho = set(blocks[k])
        te = np.array([s in ho for s in sess])
        tr = ~te
        ite = np.where(te)[0]
        fit_idx, val_idx = inner_split(D, tr)
        Z = standardise(X, np.where(tr)[0])
        log(f"  fold {k}: train {tr.sum()} (encoder fit {len(fit_idx)} / inner-val "
            f"{len(val_idx)}) test {te.sum()} rows, {len(ho)} sessions")
        fl = defaultdict(list)
        for seed in range(seeds):
            meta = gbm(X[tr], y[tr], X[te], seed)
            froz = gbm(
                np.hstack([X[tr], frozen[tr]]), y[tr], np.hstack([X[te], frozen[te]]), seed
            )
            enc_only, ep_o, v_o, _, _ = train_encoder(
                ids, lens, y, fit_idx, val_idx, ite, None, seed, epochs,
                tag=f"f{k}s{seed} enc-only",
            )
            enc_meta, ep_m, v_m, _, _ = train_encoder(
                ids, lens, y, fit_idx, val_idx, ite, Z, seed, epochs,
                tag=f"f{k}s{seed} enc+meta",
            )
            epochs_selected["encoder only"].append(int(ep_o))
            epochs_selected["encoder + meta"].append(int(ep_m))
            inner_val["encoder only"].append(float(v_o))
            inner_val["encoder + meta"].append(float(v_m))
            preds = {
                "control meta GBM": meta,
                "frozen MiniLM + meta GBM": froz,
                "encoder only": enc_only,
                "encoder + meta": enc_meta,
            }
            for lam in (0.35, 0.50, 0.75):
                preds[f"blend lam={lam:.2f}"] = blend(meta, enc_meta, lam)
            for name, p in preds.items():
                L = loss_rows(y[te], np.maximum(p, 0.0))
                acc[name].append(L)
                fl[name].append(L.mean())
            grp.append(sess[te])
            tools_pooled.append(tool[te])
            pool_ref.append(loss_rows(y[te], np.maximum(meta, 0.0)))
            pool_arm4.append(loss_rows(y[te], np.maximum(enc_meta, 0.0)))
            pool_y.append(y[te])
            pool_p50_ref.append(meta[:, 0])
            pool_p50_arm4.append(enc_meta[:, 0])
        for name in fl:
            per_fold[name].append(float(np.mean(fl[name])))
        log(f"  fold {k} done in {time.time() - t0:.0f}s")

    groups = np.concatenate(grp)
    res = summarise(acc, groups, "control meta GBM", per_fold)
    print(f"\n=== Part 1 {label}: n(pooled holdout rows) = {len(groups)}, "
          f"{len(fold_list)} folds x {seeds} seeds ===")
    print_table(res, "control meta GBM")

    yy = np.concatenate(pool_y)
    sp_ctrl = float(spearmanr(np.concatenate(pool_p50_ref), yy).statistic)
    sp_arm4 = float(spearmanr(np.concatenate(pool_p50_arm4), yy).statistic)
    print(f"\nSpearman(p50, y) pooled holdout: control {sp_ctrl:.4f}, "
          f"encoder + meta {sp_arm4:.4f}")

    tt = np.concatenate(tools_pooled)
    rr, mm = np.concatenate(pool_ref), np.concatenate(pool_arm4)
    by_tool = {}
    print("\nencoder + meta vs control, per tool (pooled holdout rows):")
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
        print(f"  {t:12s} n={m.sum():6d} control={base:8.1f} enc+meta={mm[m].mean():8.1f} "
              f"{d:+8.1f} [{lo:+8.1f},{hi:+8.1f}] ({100 * d / base:+.1f}%)")

    payload = dict(
        dataset=label,
        rows=D["n"],
        sessions=len(D["order"]),
        pooled_holdout_rows=int(len(groups)),
        folds=len(fold_list),
        fold_ids=[int(f) for f in fold_list],
        seeds=seeds,
        epochs_max=epochs,
        epochs_selected=epochs_selected,
        inner_val_pinball=inner_val,
        device=DEVICE,
        encoder=MODEL,
        max_len=MAX_LEN,
        truncate_chars=text_hash.TRUNCATE_CHARS,
        wall_clock_seconds=float(time.time() - t_start),
        steps_per_second=float(
            sum(s for s, _ in _STEP_TIMES) / max(1e-9, sum(d for _, d in _STEP_TIMES))
        ),
        spearman_p50_y=dict(control=sp_ctrl, encoder_meta=sp_arm4),
        gates=_gates(res, "control meta GBM"),
        models=res,
        per_tool_encoder_meta=by_tool,
        note=(
            "encoder arms train on the ~90% of each training fold that is not the inner "
            "validation split; the GBM control trains on 100% of the training fold"
        ),
    )
    save("encoder", tag or f"b1:{label}", payload)
    return payload


def _gates(res, ref_name):
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


# ------------------------------------------------------------------ Part 2 (local)


def run_part2(public_path, local_path, seeds, epochs):
    t_start = time.time()
    P = load_checked(public_path, META_COLS)
    L = load_checked(local_path, 42)
    tok = AutoTokenizer.from_pretrained(MODEL)
    _predict.pad_id = tok.pad_token_id
    log(f"Part 2: public {P['n']} turns / {len(P['order'])} sessions, "
        f"local {L['n']} text turns / {len(L['order'])} sessions, device={DEVICE}")
    log("  tokenising public")
    ids_p, lens_p = tokenise(P, tok)
    log("  tokenising local")
    ids_l, lens_l = tokenise(L, tok)

    hashed_log, hashed_source = hashed_base_quantiles(L)
    hashed_raw = np.expm1(hashed_log)

    # ---- one fit per seed on ALL public rows, applied to the local rows.
    # Both corpora share one index space so the encoder can be applied across.
    ids_all = ids_p + ids_l
    lens_all = np.concatenate([lens_p, lens_l])
    y_all = np.concatenate([P["y"], L["y"]])
    n_p = P["n"]
    pub_idx = np.arange(n_p)
    loc_idx = np.arange(n_p, n_p + L["n"])
    pub_all_mask = np.zeros(len(ids_all), bool)
    pub_all_mask[:n_p] = True
    Dp_for_split = dict(order=P["order"], sess=np.concatenate([P["sess"], L["sess"]]))
    fit_idx, val_idx = inner_split(Dp_for_split, pub_all_mask)
    log(f"  public fit {len(fit_idx)} rows / inner-val {len(val_idx)} rows")

    X_all_meta = np.vstack([P["X"][:, :META_COLS], L["X"][:, :META_COLS]])
    Z_all = standardise(X_all_meta, pub_idx)

    base_text, base_meta = [], []
    pub_epochs = {"encoder only": [], "encoder + meta": []}
    for seed in range(seeds):
        bt, ep_t, v_t, _, _ = train_encoder(
            ids_all, lens_all, y_all, fit_idx, val_idx, loc_idx, None, seed, epochs,
            tag=f"public s{seed} enc-only",
        )
        bm, ep_m, v_m, _, _ = train_encoder(
            ids_all, lens_all, y_all, fit_idx, val_idx, loc_idx, Z_all, seed, epochs,
            tag=f"public s{seed} enc+meta",
        )
        base_text.append(bt)
        base_meta.append(bm)
        pub_epochs["encoder only"].append(int(ep_t))
        pub_epochs["encoder + meta"].append(int(ep_m))
        log(f"  public base heads seed {seed} fitted "
            f"(epochs {ep_t}/{ep_m}, {time.time() - t_start:.0f}s)")

    # ---- local five-fold protocol
    y, sess, text = L["y"], L["sess"], L["text"]
    X38 = L["X"][:, :META_COLS]
    X41 = L["X"][:, :41].copy()
    if np.abs(X41[:, 38:41]).max() == 0:
        X41[:, 38:41] = hashed_log  # export columns were empty; use the same asset
    blocks = folds_of(L["order"])

    acc = defaultdict(list)
    per_fold = defaultdict(list)
    grp = []
    ratio_hashed, ratio_encoder = [], []
    pool_y, pool_p50 = [], defaultdict(list)

    CTRL = "a control local meta GBM"
    for k in range(K_FOLDS):
        t0 = time.time()
        ho = set(blocks[k])
        te = np.array([s in ho for s in sess])
        tr = ~te
        itr, ite = np.where(tr)[0], np.where(te)[0]

        tf = TfidfVectorizer(ngram_range=(1, 2), min_df=3, sublinear_tf=True, max_features=20000)
        T_tr = tf.fit_transform([text[i] for i in itr])
        T_te = tf.transform([text[i] for i in ite])
        lsvd = TruncatedSVD(48, random_state=0).fit(T_tr)
        LS_tr, LS_te = lsvd.transform(T_tr), lsvd.transform(T_te)

        fl = defaultdict(list)
        for seed in range(seeds):
            meta = gbm(X38[tr], y[tr], X38[te], seed)
            local_txt = gbm(
                np.hstack([X38[tr], LS_tr]), y[tr], np.hstack([X38[te], LS_te]), seed
            )
            enc_t = base_text[seed]
            enc_m = base_meta[seed]

            preds = {
                CTRL: meta,
                "c local tfidf blend lam=0.35": blend(meta, local_txt, 0.35),
                "h d1 hashed head feats": gbm(X41[tr], y[tr], X41[te], seed),
                "e1 d1 encoder-text feats": gbm(
                    np.hstack([X38[tr], np.log1p(enc_t[tr])]), y[tr],
                    np.hstack([X38[te], np.log1p(enc_t[te])]), seed,
                ),
                "e2 d1 encoder-meta feats": gbm(
                    np.hstack([X38[tr], np.log1p(enc_m[tr])]), y[tr],
                    np.hstack([X38[te], np.log1p(enc_m[te])]), seed,
                ),
            }
            for bname, base in (("hashed", hashed_raw), ("encoder", enc_t)):
                for rname, fn in RESCALES:
                    preds[f"{bname} base {rname}"] = fn(y[tr], base[tr], base[te])

            ratio_hashed.append(float(np.median(y[tr] / np.maximum(hashed_raw[tr, 0], 1.0))))
            ratio_encoder.append(float(np.median(y[tr] / np.maximum(enc_t[tr, 0], 1.0))))

            for name, p in preds.items():
                loss = loss_rows(y[te], np.maximum(p, 0.0))
                acc[name].append(loss)
                fl[name].append(loss.mean())
            grp.append(sess[te])
            pool_y.append(y[te])
            pool_p50["control"].append(meta[:, 0])
            pool_p50["hashed base"].append(hashed_raw[te, 0])
            pool_p50["encoder base"].append(enc_t[te, 0])
        for name in fl:
            per_fold[name].append(float(np.mean(fl[name])))
        log(f"  local fold {k}: train {tr.sum()} test {te.sum()} ({time.time() - t0:.0f}s)")

    groups = np.concatenate(grp)
    res = summarise(acc, groups, CTRL, per_fold)
    yy = np.concatenate(pool_y)
    spear = {k: float(spearmanr(np.concatenate(v), yy).statistic) for k, v in pool_p50.items()}

    d1_names = [CTRL, "c local tfidf blend lam=0.35", "h d1 hashed head feats",
                "e1 d1 encoder-text feats", "e2 d1 encoder-meta feats"]
    rs_names = [CTRL] + [f"{b} base {r}" for b in ("hashed", "encoder") for r, _ in RESCALES]
    d1 = {k: res[k] for k in d1_names}
    rs = {k: res[k] for k in rs_names}

    print(f"\n=== Part 2 B.3 d1 transfer: n(pooled local holdout rows) = {len(groups)} ===")
    print_table(d1, CTRL)
    print(f"\n=== Part 2 global ranks, local rescales ===")
    print_table(rs, CTRL)
    print(f"\nSpearman(p50, y) pooled local holdout: "
          + ", ".join(f"{k} {v:.4f}" for k, v in spear.items()))
    print(f"median(local total / base p50) on TRAIN folds: "
          f"hashed {np.median(ratio_hashed):.2f} "
          f"(range {min(ratio_hashed):.2f}..{max(ratio_hashed):.2f}), "
          f"encoder {np.median(ratio_encoder):.2f} "
          f"(range {min(ratio_encoder):.2f}..{max(ratio_encoder):.2f})")

    common = dict(
        public=os.path.basename(os.path.dirname(os.path.abspath(public_path))),
        public_rows=P["n"],
        local_rows=L["n"],
        local_sessions=len(L["order"]),
        pooled_holdout_rows=int(len(groups)),
        folds=K_FOLDS,
        seeds=seeds,
        epochs_max=epochs,
        public_fit_epochs_selected=pub_epochs,
        device=DEVICE,
        encoder=MODEL,
        hashed_head_source=hashed_source,
        spearman_p50_y=spear,
        scale_ratio_median=dict(
            hashed=float(np.median(ratio_hashed)), encoder=float(np.median(ratio_encoder))
        ),
        scale_ratio_range=dict(
            hashed=[float(min(ratio_hashed)), float(max(ratio_hashed))],
            encoder=[float(min(ratio_encoder)), float(max(ratio_encoder))],
        ),
        wall_clock_seconds=float(time.time() - t_start),
    )
    save("encoder", "b3:d1", dict(common, models=d1, gates=_gates(d1, CTRL)))
    save("encoder", "b3:rescale", dict(common, models=rs, gates=_gates(rs, CTRL)))
    return d1, rs


# ------------------------------------------------------------------------- smoke


def run_smoke(path, fold, seed, epochs):
    D = load_checked(path, META_COLS)
    tok = AutoTokenizer.from_pretrained(MODEL)
    _predict.pad_id = tok.pad_token_id
    ids, lens = tokenise(D, tok)
    blocks = folds_of(D["order"])
    ho = set(blocks[fold])
    te = np.array([s in ho for s in D["sess"]])
    tr = ~te
    ite = np.where(te)[0]
    fit_idx, val_idx = inner_split(D, tr)
    Z = standardise(D["X"], np.where(tr)[0])
    log(f"smoke: fold {fold} seed {seed}, fit {len(fit_idx)} inner-val {len(val_idx)} "
        f"test {te.sum()}, device={DEVICE}")

    t0 = time.time()
    meta = gbm(D["X"][tr], D["y"][tr], D["X"][te], seed)
    t_gbm = time.time() - t0
    log(f"  control GBM {t_gbm:.0f}s, loss {loss_rows(D['y'][te], meta).mean():.1f}")

    t0 = time.time()
    fz = frozen_embeddings(ids, lens)
    t_frozen = time.time() - t0
    t0 = time.time()
    froz = gbm(
        np.hstack([D["X"][tr], fz[tr]]), D["y"][tr], np.hstack([D["X"][te], fz[te]]), seed
    )
    t_fgbm = time.time() - t0
    log(f"  frozen+meta GBM {t_fgbm:.0f}s, loss {loss_rows(D['y'][te], froz).mean():.1f}")

    p, ep, v, dt, steps = train_encoder(
        ids, lens, D["y"], fit_idx, val_idx, ite, Z, seed, epochs, tag="smoke enc+meta"
    )
    sps = steps / dt
    log(f"  encoder {steps} steps in {dt:.0f}s = {sps:.2f} steps/s; holdout loss "
        f"{loss_rows(D['y'][te], p).mean():.1f}")

    steps_per_epoch = math.ceil(len(fit_idx) / BATCH)
    print("\n=== smoke timings ===")
    print(f"device {DEVICE}; {steps_per_epoch} steps/epoch; {sps:.2f} steps/s")
    print(f"control GBM {t_gbm:.0f}s; frozen embed pass {t_frozen:.0f}s; "
          f"frozen+meta GBM {t_fgbm:.0f}s")
    per_run = EPOCHS * steps_per_epoch / sps
    print(f"one 4-epoch encoder run on this corpus/fold: {per_run / 60:.1f} min")
    return sps


# --------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("smoke", help="timing smoke on one fold/seed")
    s.add_argument("--turns", required=True)
    s.add_argument("--fold", type=int, default=0)
    s.add_argument("--seed", type=int, default=0)
    s.add_argument("--epochs", type=int, default=1)

    p1 = sub.add_parser("part1", help="public b1 with the encoder arms")
    p1.add_argument("--turns", required=True)
    p1.add_argument("--label", default=None)
    p1.add_argument("--seeds", type=int, default=3)
    p1.add_argument("--epochs", type=int, default=EPOCHS)
    p1.add_argument("--folds", default=None, help="comma-separated fold ids (debug only)")
    p1.add_argument("--key", default=None)

    p2 = sub.add_parser("part2", help="B.3 d1 transfer + global ranks, local rescales")
    p2.add_argument("--public", required=True)
    p2.add_argument("--local", required=True)
    p2.add_argument("--seeds", type=int, default=3)
    p2.add_argument("--epochs", type=int, default=EPOCHS)

    a = ap.parse_args()
    if a.cmd == "smoke":
        run_smoke(a.turns, a.fold, a.seed, a.epochs)
    elif a.cmd == "part1":
        label = a.label or os.path.basename(os.path.dirname(os.path.abspath(a.turns)))
        folds = [int(x) for x in a.folds.split(",")] if a.folds else None
        run_part1(a.turns, label, a.seeds, a.epochs, folds, a.key)
    else:
        run_part2(a.public, a.local, a.seeds, a.epochs)


if __name__ == "__main__":
    main()
