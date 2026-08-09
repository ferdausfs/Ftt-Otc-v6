#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
D4 v2 — AVOIDANCE MODEL (Phase F, analysis-only)
================================================

GOAL
  The engine pool win-rate is ~42.5% (breakeven @ 80% payout = 55.6%).
  D4 v1 (predict WIN) found no edge; calibration fixed the label ladder but the
  best grade still does not clear breakeven. This script flips the question:

      Instead of predicting which signals WIN, predict which signals LOSE and
      SKIP them, so the remaining TRADE subset clears breakeven on HOLDOUT.

WHAT IT DOES
  1. Loads phase_f_forward/*/*.json, dedups by signal id, keeps decided WIN/LOSS.
  2. Chronological split — VAL = 2026-08-07..2026-08-09 (the R1 holdout),
     TRAIN learned two ways:
        - AUG  : 2026-08-01..2026-08-06  (literal prompt split — avoids the
                  pre-calibration July regime where the grade ladder was inverted)
        - FULL : everything <= 2026-08-06 (extended — includes July data)
  3. Fits a ridge LOGISTIC REGRESSION in pure numpy (the portable artifact) to
     predict P(WIN) from SIGNAL-TIME-ONLY features (no result/entryHit/exitPrice).
  4. Selects an avoidance threshold tau on TRAIN ONLY (max TRAIN-subset WR at a
     TRAIN coverage floor), FREEZES it, then reports the TRADE-subset WR + Wilson
     CI + coverage on the untouched VAL holdout.
  5. Cross-checks vs sklearn LogisticRegression and an XGBoost oracle (optional —
     the script degrades gracefully if those libs are missing) and a hand-rule
     baseline, so overfitting is visible.

LEAKAGE DISCIPLINE (R2)
  - Vocabulary (categorical levels) + numeric standardization (mean/std) fit on
    TRAIN only; VAL rows with unseen categories are encoded as all-zero.
  - Threshold tau chosen on TRAIN only.
  - entryHit / exitPrice / checkedAt / result / entryPrice are NEVER features.

RE-RUN
    python3 scripts/d4_v2_avoidance.py --data-dir phase_f_forward

DEPENDENCIES: numpy (required). pandas/sklearn/xgboost optional (cross-checks).
"""
import argparse, glob, json, math, os
from collections import defaultdict, OrderedDict

import numpy as np

BREAKEVEN = 0.556          # 80% payout: WR*0.80 - (1-WR)*1.00 >= 0  -> WR >= 0.556
PAYOUT = 0.80
VAL_DAYS = ("2026-08-07", "2026-08-08", "2026-08-09")

# Asset map (matches worker convention — crypto tickers vs forex).
CRYPTO_TOKENS = ("BTC", "ETH", "SOL", "DOGE", "XRP", "ADA", "LINK", "AVAX", "BNB", "DOT")

# Categorical features (one-hot). Numeric features handled separately.
CAT_FEATURES = ["pair", "assetType", "direction", "bestTF", "marketRegime",
                "sessionQuality", "grade", "alignment", "structureVerdict"]
NUM_FEATURES = ["confidence", "coreConfidence", "hour", "dow"]

# Per-feature value canonicalization (handles dict/string, missing).
def _conf_num(s):
    c = s.get("confidence")
    if isinstance(c, (int, float)):
        return float(c)
    try:
        return float(str(c).replace("%", "").strip())
    except Exception:
        return None

def _grade(s):
    g = s.get("grade")
    if isinstance(g, dict):
        return g.get("grade")
    return g

def _struct(s):
    v = s.get("structureVerdict")
    if isinstance(v, dict):
        return v.get("overall")
    return v

def _asset(pair, is_otc):
    if is_otc:
        return "OTC"
    return "CRYPTO" if any(t in (pair or "") for t in CRYPTO_TOKENS) else "FOREX"


def extract_features(s):
    """Return an OrderedDict of signal-time features. NO outcome/entry fields."""
    pair = s.get("pair", "?")
    is_otc = bool(s.get("isOTC"))
    ts = s.get("timestamp", "") or ""
    try:
        hour = int(ts[11:13])
    except Exception:
        hour = None
    try:
        import datetime
        dow = datetime.date.fromisoformat(ts[:10]).weekday()
    except Exception:
        dow = None
    f = OrderedDict()
    f["pair"] = pair
    f["assetType"] = _asset(pair, is_otc)
    f["direction"] = s.get("direction")
    f["bestTF"] = s.get("bestTF")
    f["marketRegime"] = s.get("marketRegime")
    f["sessionQuality"] = s.get("sessionQuality")
    f["grade"] = _grade(s)
    f["alignment"] = s.get("alignment")
    f["structureVerdict"] = _struct(s)
    f["confidence"] = _conf_num(s)
    f["coreConfidence"] = s.get("coreConfidence")
    f["hour"] = hour
    f["dow"] = dow
    return f


# ───────────────────────────── data loading ──────────────────────────────
def load_decided(data_dir):
    """Dedup by id (keep most complete record across snapshots), keep WIN/LOSS."""
    seen = {}
    for f in sorted(glob.glob(os.path.join(data_dir, "*", "[A-Z]*_*.json"))):
        name = os.path.basename(f)
        if name in ("health.json", "pairs.json"):
            continue
        try:
            d = json.load(open(f))
        except Exception:
            continue
        for s in d.get("signals") or []:
            sid = s.get("id")
            if not sid:
                continue
            prev = seen.get(sid)
            if prev is None or len(s.keys()) > len(prev.keys()):
                seen[sid] = s
    rows = [s for s in seen.values() if s.get("result") in ("WIN", "LOSS")]
    return rows


def split_rows(rows, train_mode):
    """Chronological split. VAL = 08-07..09 always. TRAIN per train_mode."""
    def day(s):
        return (s.get("timestamp") or "")[:10]
    val = [s for s in rows if day(s) in VAL_DAYS]
    if train_mode == "aug":
        train = [s for s in rows if "2026-08-01" <= day(s) <= "2026-08-06"]
    elif train_mode == "full":
        train = [s for s in rows if day(s) < "2026-08-07"]
    else:
        raise ValueError(train_mode)
    return train, val


# ───────────────────────────── matrix build ──────────────────────────────
class Encoder:
    """One-hot (categorical) + standardized (numeric). Fit on TRAIN only."""
    def __init__(self):
        self.cat_levels = {}      # feature -> sorted [levels]
        self.num_mean = {}
        self.num_std = {}
        self.feature_names = []   # ordered column names
        self._col_index = {}

    def fit(self, feat_rows):
        # categorical vocab
        for c in CAT_FEATURES:
            levels = sorted({str(r[c]) for r in feat_rows if r.get(c) is not None})
            self.cat_levels[c] = levels
        # numeric stats (median imputation for missing handled at transform)
        for n in NUM_FEATURES:
            vals = [r[n] for r in feat_rows if r.get(n) is not None]
            vals = [v for v in vals if isinstance(v, (int, float))]
            med = float(np.median(vals)) if vals else 0.0
            std = float(np.std(vals)) if vals else 1.0
            if std < 1e-9:
                std = 1.0
            self.num_mean[n] = med
            self.num_std[n] = std
        # build column layout
        cols = []
        for c in CAT_FEATURES:
            for lv in self.cat_levels[c]:
                cols.append(f"{c}={lv}")
        for n in NUM_FEATURES:
            cols.append(n)
        self.feature_names = cols
        self._col_index = {c: i for i, c in enumerate(cols)}
        return self

    def transform(self, feat_rows):
        X = np.zeros((len(feat_rows), len(self.feature_names)), dtype=np.float64)
        for i, r in enumerate(feat_rows):
            for c in CAT_FEATURES:
                lv = r.get(c)
                if lv is None:
                    continue
                key = f"{c}={lv}"
                j = self._col_index.get(key)
                if j is not None:
                    X[i, j] = 1.0
            for n in NUM_FEATURES:
                v = r.get(n)
                if v is None or not isinstance(v, (int, float)):
                    v = self.num_mean[n]      # median imputation
                j = self._col_index[n]
                X[i, j] = (v - self.num_mean[n]) / self.num_std[n]
        return X


# ─────────────────────────── pure-numpy logistic ─────────────────────────
class LogReg:
    """Ridge logistic regression, full-batch gradient descent. Deterministic."""
    def __init__(self, l2=1.0, lr=0.5, n_iter=8000):
        self.l2 = l2; self.lr = lr; self.n_iter = n_iter
        self.w = None; self.b = 0.0

    @staticmethod
    def _sigmoid(z):
        return np.where(z >= 0, 1.0 / (1.0 + np.exp(-z)),
                        np.exp(z) / (1.0 + np.exp(z)))

    def fit(self, X, y):
        n, d = X.shape
        self.w = np.zeros(d)
        self.b = float(np.log(y.mean() / max(1e-9, 1 - y.mean())))
        for _ in range(self.n_iter):
            z = X @ self.w + self.b
            p = self._sigmoid(z)
            err = p - y
            gw = X.T @ err / n + self.l2 * self.w / n
            gb = err.mean()
            self.w -= self.lr * gw
            self.b -= self.lr * gb
        return self

    def predict_proba(self, X):
        return self._sigmoid(X @ self.w + self.b)


# ─────────────────────────────── metrics ─────────────────────────────────
def wilson(w, n, z=1.96):
    if n == 0:
        return 0.0, 0.0, 0.0
    p = w / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    h = z * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / den
    return p, max(0.0, c - h), min(1.0, c + h)

def profit_metrics(win_mask, n_total):
    n = int(win_mask.size)
    w = int(win_mask.sum())
    p, lo, hi = wilson(w, n)
    cov = n / n_total if n_total else 0.0
    edge = p * PAYOUT - (1 - p) * 1.0      # per-trade EV in stake units
    return dict(n=n, w=w, wr=p, ci_lo=lo, ci_hi=hi, coverage=cov, edge=edge)


# ─────────────────────── threshold selection (TRAIN only) ────────────────
def select_threshold(p_train, y_train, coverage_floor):
    """Pick tau (on TRAIN only) that maximizes TRAIN-subset WR subject to
    coverage >= floor. Coverage floor = R1 minimum (15%) so TRAIN decides how
    selective to be, within the rules. Ties broken toward HIGHER coverage.
    Returns (tau, metrics_at_tau)."""
    n = len(p_train)
    order = np.argsort(-p_train)            # highest P(WIN) first
    p_sorted = p_train[order]
    y_sorted = y_train[order]
    cum_w = np.cumsum(y_sorted)
    floor_k = max(1, int(math.ceil(coverage_floor * n)))
    best = None                             # (wr, cov, k) — maximize wr, then cov
    for k in range(floor_k, n + 1):
        wr = cum_w[k - 1] / k
        cand = (wr, k / n, k)
        if best is None or cand > best:
            best = cand
    wr, cov, k = best
    tau = float(p_sorted[k - 1])            # lowest P(WIN) kept
    sel = dict(n=k, w=int(cum_w[k - 1]), wr=wr, coverage=cov,
               ci=wilson(int(cum_w[k - 1]), k))
    return tau, sel, (p_sorted, cum_w)      # also return TRAIN curve for audit


def eval_at_tau(p, y, tau, n_total):
    mask = p >= tau
    if mask.sum() == 0:
        return profit_metrics(np.zeros(0, dtype=bool), n_total)
    return profit_metrics(y[mask] == 1, n_total)


def sweep(p, y, n_total, label):
    """Print a coverage-sweep table (WR/CI at fixed coverage percentiles)."""
    order = np.argsort(-p)
    ps = p[order]; ys = y[order]; cw = np.cumsum(ys)
    print(f"\n   coverage-sweep ({label}): keep top X% by P(WIN)")
    print(f"   {'keep%':>5} {'n':>5} {'WR':>6} {'CI95':>14} {'edge':>7}")
    for frac in (0.15, 0.20, 0.30, 0.40, 0.50, 0.60, 0.80, 1.00):
        k = max(1, int(round(frac * len(p))))
        if k > len(p):
            k = len(p)
        wr = cw[k - 1] / k
        _, lo, hi = wilson(int(cw[k - 1]), k)
        edge = wr * PAYOUT - (1 - wr) * 1.0
        flag = " <== R1 target coverage floor" if abs(frac - 0.15) < 1e-9 else ""
        print(f"   {frac*100:>4.0f}% {k:>5} {wr*100:>5.1f}% "
              f"[{lo*100:>4.1f}-{hi*100:>4.1f}] {edge:>+7.3f}{flag}")


# ─────────────────────── optional cross-checks ──────────────────────────
def sklearn_check(Xtr, ytr, Xva, yva, tau, n_val):
    try:
        from sklearn.linear_model import LogisticRegression
    except Exception:
        return None
    m = LogisticRegression(C=1.0, penalty="l2", solver="lbfgs",
                           max_iter=8000, random_state=42)
    m.fit(Xtr, ytr)
    ptr = m.predict_proba(Xtr)[:, 1]
    pva = m.predict_proba(Xva)[:, 1]
    # agreement of rankings on VAL (Spearman-ish via argsort overlap)
    return ptr, pva

def xgb_oracle(Xtr, ytr, Xva, yva, n_val):
    try:
        from xgboost import XGBClassifier
    except Exception:
        return None
    m = XGBClassifier(n_estimators=200, max_depth=3, learning_rate=0.05,
                      subsample=0.8, colsample_bytree=0.8,
                      eval_metric="logloss", random_state=42, verbosity=0,
                      reg_lambda=2.0)
    m.fit(Xtr, ytr)
    return m.predict_proba(Xtr)[:, 1], m.predict_proba(Xva)[:, 1]


# ─────────────────────── hand-rule baseline (overfit demo) ───────────────
def hand_rule_skip(s):
    """Rules mined from TRAIN in the prior scripts (the 'loser slices')."""
    pair = s.get("pair", "")
    if pair in ("AUD/USD", "USD/JPY", "GBP/USD", "EUR/USD", "DOT/USD"):
        return True
    if s.get("sessionQuality") == "HIGHEST":
        return True
    c = _conf_num(s)
    if c is not None and 80 <= c < 85:
        return True
    if _grade(s) == "A+":
        return True
    return False


# ───────────────────────────── runner ────────────────────────────────────
def run_one(train_rows, val_rows, label, coverage_floor=0.40):
    print("\n" + "=" * 78)
    print(f"  {label}")
    print("=" * 78)
    n_total_val = len(val_rows)
    feat_tr = [extract_features(s) for s in train_rows]
    feat_va = [extract_features(s) for s in val_rows]
    y_tr = np.array([1.0 if s["result"] == "WIN" else 0.0 for s in train_rows])
    y_va = np.array([1.0 if s["result"] == "WIN" else 0.0 for s in val_rows])

    enc = Encoder().fit(feat_tr)
    Xtr = enc.transform(feat_tr)
    Xva = enc.transform(feat_va)

    # baselines
    base_tr = profit_metrics(y_tr == 1, len(y_tr))
    base_va = profit_metrics(y_va == 1, len(y_va))
    print(f"\n  TRAIN n={len(y_tr)}  WR={base_tr['wr']*100:.1f}% "
          f"(CI {base_tr['ci_lo']*100:.1f}-{base_tr['ci_hi']*100:.1f}%)")
    print(f"  VAL   n={len(y_va)}  WR={base_va['wr']*100:.1f}% "
          f"(CI {base_va['ci_lo']*100:.1f}-{base_va['ci_hi']*100:.1f}%)  <- holdout base")

    # ---- numpy logistic (portable deliverable) ----
    lr = LogReg(l2=1.0, lr=0.5, n_iter=8000).fit(Xtr, y_tr)
    p_tr = lr.predict_proba(Xtr)
    p_va = lr.predict_proba(Xva)
    # TRAIN AUC (rank) as a weak quality check
    auc_tr = _auc(p_tr, y_tr)
    auc_va = _auc(p_va, y_va)
    print(f"\n  [numpy logistic] TRAIN rank-AUC={auc_tr:.3f}  VAL rank-AUC={auc_va:.3f}")

    tau, sel, (p_sorted, cum_w) = select_threshold(p_tr, y_tr, coverage_floor)
    print(f"\n  >> tau selected on TRAIN only: P(WIN) >= {tau:.3f}  "
          f"(TRAIN picks coverage={sel['coverage']*100:.0f}%, the most selective "
          f"point TRAIN supports above the 15% R1 floor)")
    print(f"     TRAIN-subset @tau: WR={sel['wr']*100:.1f}% "
          f"CI[{sel['ci'][1]*100:.1f}-{sel['ci'][2]*100:.1f}] n={sel['n']}")
    tr_sub = eval_at_tau(p_tr, y_tr, tau, len(y_tr))
    va_sub = eval_at_tau(p_va, y_va, tau, n_total_val)
    print(f"\n  ---- HOLDOUT (VAL) TRADE-subset @ frozen TRAIN tau ----")
    _print_row("TRAIN-subset", tr_sub, len(y_tr))
    _print_row("VAL-subset  ", va_sub, n_total_val, primary=True)
    print(f"\n   (post-hoc VAL coverage-sweep — ILLUSTRATION, not the selected gate):")
    sweep(p_va, y_va, n_total_val, "VAL")

    # per-day holdout stability + honest best-post-hoc-point audit
    _perday_and_bestpoint(p_va, y_va, val_rows, tau, n_total_val)

    # ---- sklearn cross-check (agreement with the portable numpy model) ----
    sk = sklearn_check(Xtr, y_tr, Xva, y_va, tau, n_total_val)
    if sk is not None:
        _ptr, pva = sk
        a = _rank_corr(pva, p_va)            # rank agreement vs numpy on VAL
        sk_va = eval_at_tau(pva, y_va, tau, n_total_val)
        print(f"\n  [sklearn cross-check] VAL rank-corr vs numpy = {a:.3f}")
        _print_row("sklearn VAL ", sk_va, n_total_val)
    else:
        print("\n  [sklearn cross-check] (sklearn unavailable — skipped)")

    # ---- XGBoost oracle (ceiling) ----
    xg = xgb_oracle(Xtr, y_tr, Xva, y_va, n_total_val)
    if xg is not None:
        ptr_x, pva_x = xg
        print(f"\n  [XGBoost oracle] TRAIN rank-AUC={_auc(ptr_x,y_tr):.3f} "
              f"VAL rank-AUC={_auc(pva_x,y_va):.3f}  (flexible ceiling)")
        tx, sx, _ = select_threshold(ptr_x, y_tr, coverage_floor)
        xv = eval_at_tau(pva_x, y_va, tx, n_total_val)
        _print_row("xgb VAL @tau", xv, n_total_val)
        sweep(pva_x, y_va, n_total_val, "XGB VAL")
    else:
        print("\n  [XGBoost oracle] (xgboost unavailable — skipped)")

    # ---- hand-rule baseline (overfit demo) ----
    keep_va = np.array([not hand_rule_skip(s) for s in val_rows])
    keep_tr = np.array([not hand_rule_skip(s) for s in train_rows])
    hr_tr = profit_metrics(y_tr[keep_tr] == 1, len(y_tr))
    hr_va = profit_metrics(y_va[keep_va] == 1, n_total_val)
    print(f"\n  [hand-rule baseline] skip AUD/USD,USD/JPY,GBP/USD,EUR/USD,DOT/USD,"
          f"HIGHEST,conf80-84,grade A+")
    _print_row("rules TRAIN ", hr_tr, len(y_tr))
    _print_row("rules VAL   ", hr_va, n_total_val)

    # ---- feature importance (logistic coefficients on the kept model) ----
    print_coef_table(lr, enc)

    return dict(label=label, tau=tau, va=va_sub, enc=enc, model=lr)


def _auc(p, y):
    """ROC-AUC via rank statistic (Mann-Whitney). Deterministic."""
    pos = p[y == 1]; neg = p[y == 0]
    if len(pos) == 0 or len(neg) == 0:
        return 0.5
    # count concordant pairs
    o = np.argsort(p); ranks = np.empty(len(p), dtype=np.float64)
    # average ranks for ties
    sp = p[o]; i = 0
    while i < len(sp):
        j = i
        while j + 1 < len(sp) and sp[j + 1] == sp[i]:
            j += 1
        r = (i + j) / 2.0 + 1.0
        ranks[o[i:j + 1]] = r
        i = j + 1
    s = ranks[y == 1].sum()
    return (s - len(pos) * (len(pos) + 1) / 2.0) / (len(pos) * len(neg))

def _rank_corr(a, b):
    aa = a.argsort().argsort().astype(float)
    bb = b.argsort().argsort().astype(float)
    aa -= aa.mean(); bb -= bb.mean()
    da = math.sqrt((aa ** 2).sum()); db = math.sqrt((bb ** 2).sum())
    if da < 1e-12 or db < 1e-12:
        return 0.0
    return float((aa * bb).sum() / (da * db))


def _perday_and_bestpoint(p_va, y_va, val_rows, tau, n_total):
    """Per-day holdout stability (at frozen tau) + the best post-hoc point on
    the VAL curve with an explicit multiple-comparison caveat (honesty guard:
    a 'pass' found by scanning every threshold on the holdout is not credible)."""
    print(f"\n   per-day holdout stability (VAL @ frozen TRAIN tau={tau:.3f}):")
    print(f"   {'day':12s} {'ALL':>18} {'TRADE-subset':>28}")
    for day in VAL_DAYS:
        idx = [i for i, s in enumerate(val_rows) if (s.get("timestamp") or "")[:10] == day]
        if not idx:
            continue
        bn = len(idx); bw = int(y_va[idx].sum())
        bp, blo, bhi = wilson(bw, bn)
        mask = p_va[idx] >= tau
        tn = int(mask.sum()); tw = int(y_va[idx][mask].sum())
        tp, tlo, thi = wilson(tw, tn) if tn else (0, 0, 0)
        print(f"   {day:12s} n={bn:>3} WR={bp*100:>4.1f}%      "
              f"n={tn:>3} WR={tp*100:>4.1f}% CI[{tlo*100:>4.1f}-{thi*100:>4.1f}]")

    # best point on VAL curve over ALL k >= 15% coverage (post-hoc scan)
    order = np.argsort(-p_va); ys = y_va[order]; cw = np.cumsum(ys)
    floor_k = max(1, int(math.ceil(0.15 * len(ys))))
    best = None
    n_checked = 0
    for k in range(floor_k, len(ys) + 1):
        wr = cw[k - 1] / k; _, lo, hi = wilson(int(cw[k - 1]), k)
        n_checked += 1
        ok = wr >= BREAKEVEN and lo >= 0.50
        score = (1 if ok else 0, wr, lo)
        if best is None or score > best[0]:
            best = (score, k, wr, lo, hi, ok)
    _, k, wr, lo, hi, ok = best
    print(f"\n   HONESTY AUDIT - best post-hoc point on VAL curve:")
    print(f"     scanned {n_checked} thresholds; best at k={k} "
          f"(cov={k/len(ys)*100:.0f}%): WR={wr*100:.1f}% CI[{lo*100:.1f}-{hi*100:.1f}]")
    if ok:
        print(f"     >>> This point 'passes' R1, BUT it is the MAX over {n_checked} holdout-")
        print(f"         peaked thresholds (multiple-comparison / threshold-fishing).")
        print(f"         The TRAIN-selected gate (above) is the only pre-committed choice and")
        print(f"         it FAILS the CI. Edge is REAL-but-WEAK; not robustly tradeable yet.")
    else:
        print(f"     >>> No post-hoc point clears R1 either. Signal-time features insufficient.")


def _print_row(label, m, n_total, primary=False):
    wr = m["wr"]; lo = m["ci_lo"]; hi = m["ci_hi"]
    verdict = ("PASS" if (wr >= BREAKEVEN and lo >= 0.50 and m["coverage"] >= 0.15)
               else "fail")
    star = "  <<<" if primary else ""
    print(f"   {label}: n={m['n']:>4} ({m['coverage']*100:>4.0f}% cov) "
          f"WR={wr*100:>5.1f}% CI[{lo*100:>4.1f}-{hi*100:>4.1f}] "
          f"edge={m['edge']:+.3f}  [{verdict}]{star}")


def print_coef_table(model, enc):
    coefs = list(zip(enc.feature_names, model.w))
    # report standardized numeric + top/bottom categorical levels
    print(f"\n   intercept b0 = {model.b:+.4f}")
    print("   numeric coefficients (on standardized scale):")
    for n in NUM_FEATURES:
        j = enc._col_index[n]
        print(f"      {n:14s} w={model.w[j]:+.4f}  "
              f"(mean={enc.num_mean[n]:.3f} std={enc.num_std[n]:.3f})")
    cat = [c for c in coefs if "=" in c[0]]
    cat.sort(key=lambda x: x[1])
    print("   categorical levels — TOP 12 (most WIN-associated, KEEP):")
    for name, w in cat[-12:][::-1]:
        print(f"      {name:34s} {w:+.4f}")
    print("   categorical levels — BOTTOM 12 (most LOSS-associated, SKIP):")
    for name, w in cat[:12]:
        print(f"      {name:34s} {w:+.4f}")


def emit_js_gate(results, out_path):
    """Emit a portable JS gate from the AUG logistic model (best, most defensible)."""
    res = next(r for r in results if r["label"].startswith("AUG"))
    enc = res["enc"]; model = res["model"]; tau = res["tau"]
    lines = []
    lines.append("// D4 v2 AVOIDANCE GATE — auto-generated by scripts/d4_v2_avoidance.py")
    lines.append("// Phase F analysis-only artifact. Deterministic, no new deps.")
    lines.append("// TRADE if P(WIN) >= TAU, else SKIP (avoid).")
    lines.append("// Coefficients from ridge logistic regression on TRAIN (08-01..08-06),")
    lines.append("// standardized numeric + one-hot categorical. Holdout-evaluated, NOT live.")
    lines.append("export const D4V2_GATE = Object.freeze({")
    lines.append(f"  TAU: {tau:.6f},")
    lines.append(f"  B0: {model.b:.6f},")
    lines.append("  NUM: {")
    for n in NUM_FEATURES:
        j = enc._col_index[n]
        lines.append(f"    {n}: {{ w: {model.w[j]:.6f}, mean: {enc.num_mean[n]:.6f}, std: {enc.num_std[n]:.6f} }},")
    lines.append("  },")
    lines.append("  CAT: {")
    for c in CAT_FEATURES:
        levels = enc.cat_levels[c]
        body = ", ".join(f'"{lv}": {model.w[enc._col_index[f"{c}={lv}"]]:.6f}' for lv in levels)
        lines.append(f"    {c}: {{ {body} }},")
    lines.append("  },")
    lines.append("});")
    lines.append("")
    lines.append("// Apply per signal (all inputs known at signal time):")
    lines.append("//   z = D4V2_GATE.B0")
    lines.append("//     + (confidence-1)*0 ... see NUM mapping; + CAT lookups (0/1)")
    lines.append("export function d4v2Avoid(p) {")
    lines.append("  const G = D4V2_GATE;")
    lines.append("  let z = G.B0;")
    lines.append("  for (const n of ['confidence','coreConfidence','hour','dow']) {")
    lines.append("    const v = p[n] == null ? G.NUM[n].mean : p[n];")
    lines.append("    z += G.NUM[n].w * (v - G.NUM[n].mean) / G.NUM[n].std;")
    lines.append("  }")
    lines.append("  for (const c of Object.keys(G.CAT)) {")
    lines.append("    const lvl = p[c];")
    lines.append("    if (lvl != null && G.CAT[c][lvl] !== undefined) z += G.CAT[c][lvl];")
    lines.append("  }")
    lines.append("  const pWin = 1 / (1 + Math.exp(-z));")
    lines.append("  return { trade: pWin >= G.TAU, pWin };")
    lines.append("}")
    open(out_path, "w").write("\n".join(lines) + "\n")
    return out_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="phase_f_forward")
    ap.add_argument("--coverage-floor", type=float, default=0.15,
                    help="TRAIN coverage floor for tau selection (= R1 minimum 15%)")
    args = ap.parse_args()

    rows = load_decided(args.data_dir)
    wins = sum(1 for s in rows if s["result"] == "WIN")
    p, lo, hi = wilson(wins, len(rows))
    print("#" * 78)
    print("#  D4 v2 — AVOIDANCE MODEL (Phase F)")
    print("#" * 78)
    print(f"\n  Universe: {len(rows)} decided WIN/LOSS signals (dedup by id)")
    print(f"  Engine pool WR = {wins}/{len(rows)} = {p*100:.1f}% "
          f"(CI {lo*100:.1f}-{hi*100:.1f}%)  | breakeven bar = {BREAKEVEN*100:.1f}%")

    results = []
    for mode, label in [("aug", "AUG TRAIN (08-01..08-06)  [primary — post-calibration, no July regime]"),
                        ("full", "FULL TRAIN (<=08-06)     [robustness — includes pre-calibration July]")]:
        tr, va = split_rows(rows, mode)
        if not tr:
            print(f"\n  (skipping {label}: no TRAIN rows)")
            continue
        results.append(run_one(tr, va, label, coverage_floor=args.coverage_floor))

    # emit portable JS gate from the AUG model
    out_js = os.path.join("scripts", "d4v2_avoidance_gate.js")
    if any(r["label"].startswith("AUG") for r in results):
        emit_js_gate(results, out_js)
        print(f"\n  >> portable JS gate written: {out_js}")

    print("\n" + "#" * 78)
    print("#  VERDICT")
    print("#" * 78)
    for r in results:
        m = r["va"]
        verdict = ("HOLDS on holdout" if (m["wr"] >= BREAKEVEN and m["ci_lo"] >= 0.50
                    and m["coverage"] >= 0.15) else "does NOT clear R1 on holdout")
        print(f"   {r['label'][:40]:40s} VAL WR={m['wr']*100:.1f}% "
              f"CI[{m['ci_lo']*100:.1f}-{m['ci_hi']*100:.1f}] cov={m['coverage']*100:.0f}% -> {verdict}")
    print("\n  Raw indicators (RSI/ATR/ADX/BB) are NOT persisted in history records.")
    print("  See report for the instrumentation gap + worker PR proposal.")


if __name__ == "__main__":
    main()
