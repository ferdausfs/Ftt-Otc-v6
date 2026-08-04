#!/usr/bin/env python3
"""
D4 — ML Prototype: can a model extract edge the hand-coded engine cannot?

Purpose (honest framing):
  The engine is a hand-coded weighted-vote system. Phase F forward data shows
  ~46% WR, sub-breakeven, with forex SELL especially weak (~20%). D4 tests
  whether a gradient-boosted model trained on ENGINE SIGNALS + context can
  predict WIN/LOSS well enough to CLEAR BREAKEVEN (55.6% @ 80% payout) — i.e.
  learn the weak anti-correlation without a hand-coded flip.

Prototype rules:
  - TRAIN on engine signals as-is (features = engine outputs + context).
  - CHRONOLOGICAL split ONLY (no random shuffle) — data is clustered by day.
  - Report Wilson CI. 55.6% breakeven is the bar, not 50%.
  - Never claim edge from < 6 distinct days / small test n.
  - Re-runnable: `python3 d4_prototype.py` — uses whatever forward snapshots
    exist under phase_f_forward/. Data accumulates, results evolve.

Usage:
  python3 d4_prototype.py [--min-date 2026-08-01] [--test-days 1]
"""
import argparse, glob, json, os, math, sys
from collections import defaultdict

import numpy as np
import pandas as pd
from xgboost import XGBClassifier
from sklearn.metrics import accuracy_score

# ── config ───────────────────────────────────────────────────────────────
BREAKEVEN = 0.556   # 80% payout
PAIR_FEATURES = ["USD/JPY","AUD/USD","EUR/USD","GBP/USD","DOT/USD"]
REGIMES = ["RANGING","TRENDING","BREAKOUT","VOLATILE"]
GRADES = ["A","A+","B","C","D","F"]
SESSIONS = ["ASIAN","LONDON","NEW_YORK","SYDNEY","24/7"]

def load_forward(floor="2026-08-01T00:00:00", data_dir="phase_f_forward"):
    """Load all snapshots, de-dup by id, filter forward window, keep decided."""
    seen = {}
    for day in sorted(glob.glob(os.path.join(data_dir, "*/"))):
        day = day.rstrip("/")
        for f in glob.glob(day + "/*.json"):
            name = os.path.basename(f)
            if name in ("pairs.json", "health.json"): continue
            try:
                data = json.load(open(f))
            except Exception:
                continue
            for s in data.get("signals", []):
                if s.get("id"):
                    seen[s["id"]] = s
    rows = []
    for s in seen.values():
        ts = s.get("timestamp", "")
        if ts < floor: continue
        if s.get("result") not in ("WIN", "LOSS"): continue
        rows.append(s)
    return rows

def grade_of(s):
    g = s.get("grade")
    if isinstance(g, dict): return g.get("grade", "?")
    return g or "?"

def conf_num(s):
    c = s.get("confidence", "0%").replace("%", "")
    try: return float(c)
    except: return 50.0

def build_frame(rows):
    recs = []
    for s in rows:
        pair = s.get("pair", "?")
        sessions = s.get("session") or []
        sess = sessions[0] if sessions else "?"
        rec = {
            "pair": pair,
            "asset_type": "FOREX" if pair in ("EUR/USD","GBP/USD","GBP/CHF","USD/CAD","USD/CHF","USD/JPY","AUD/USD") else "CRYPTO",
            "direction": s.get("direction", "?"),
            "confidence": conf_num(s),
            "grade": grade_of(s),
            "regime": s.get("marketRegime", "?"),
            "alignment": s.get("alignment", "?"),
            "structure": s.get("structureVerdict", "?"),
            "session": sess,
            "hour": int(s["timestamp"][11:13]),
            "dow": int(pd.Timestamp(s["timestamp"]).dayofweek),
            "win": 1 if s["result"] == "WIN" else 0,
            "ts": s["timestamp"],
        }
        recs.append(rec)
    df = pd.DataFrame(recs)
    # one-hot encode categoricals (avoid dummy trap-ish noise is fine for prototype)
    df = pd.get_dummies(df, columns=["pair","asset_type","direction","grade","regime","alignment","structure","session"],
                        prefix=["p","at","dir","g","reg","align","str","sess"])
    return df

def wilson(w, n, z=1.96):
    if n == 0: return (0, 0, 0)
    p = w / n
    d = 1 + z*z/n
    c = (p + z*z/(2*n)) / d
    h = z * math.sqrt((p*(1-p) + z*z/(4*n))/n) / d
    return p, max(0, c-h), min(1, c+h)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-date", default="2026-08-01T00:00:00")
    ap.add_argument("--test-days", type=int, default=1, help="last N days held out as test")
    ap.add_argument("--data-dir", default="phase_f_forward", help="snapshot root")
    args = ap.parse_args()

    rows = load_forward(args.min_date, args.data_dir)
    if len(rows) < 50:
        print(f"❌ শুধু {len(rows)}টা decided signal — prototype-এর জন্য যথেষ্ট না (≥50)। data জমতে দিন।")
        return

    days = sorted(set(r["timestamp"][:10] for r in rows))
    print(f"═══ D4 ML PROTOTYPE ═══")
    print(f"Forward decided: {len(rows)}  |  days: {len(days)}  →  {days}")
    print(f"Breakeven bar (80% payout): {BREAKEVEN*100:.1f}%")

    df = build_frame(rows)
    df = df.sort_values("ts").reset_index(drop=True)
    feat_cols = [c for c in df.columns if c not in ("win", "ts")]

    # ── baseline: engine itself ──
    engine_w = df["win"].sum()
    p, lo, hi = wilson(engine_w, len(df))
    print(f"\n── Baseline: engine WR ──")
    print(f"  engine: {engine_w}/{len(df)} = {p*100:.1f}%  (CI {lo*100:.1f}-{hi*100:.1f}%)")

    # ── chronological split ──
    test_days = days[-args.test_days:]
    train_days = days[:-args.test_days]
    train = df[df["ts"].str[:10].isin(train_days)]
    test = df[df["ts"].str[:10].isin(test_days)]
    print(f"\n── Chronological split ──")
    print(f"  TRAIN: {train_days}  (n={len(train)})")
    print(f"  TEST : {test_days}  (n={len(test)})")

    if len(test) < 30:
        print(f"\n⚠️ TEST n={len(test)} < 30 — result tentative (clustering-aware: দিনগুলো আলাদা নয়)।")

    # ── train XGBoost ──
    X_train, y_train = train[feat_cols], train["win"]
    X_test, y_test = test[feat_cols], test["win"]

    model = XGBClassifier(
        n_estimators=120, max_depth=3, learning_rate=0.08,
        subsample=0.8, colsample_bytree=0.8,
        eval_metric="logloss", random_state=42, verbosity=0,
    )
    model.fit(X_train, y_train)

    proba = model.predict_proba(X_test)[:, 1]
    pred = (proba >= 0.5).astype(int)
    acc = accuracy_score(y_test, pred)

    # only confident predictions: proba >= 0.55 or <= 0.45
    mask = (proba >= 0.55) | (proba <= 0.45)
    sel_pred = pred[mask]
    sel_y = y_test[mask]
    sel_n = len(sel_y)
    sel_w = int(sel_y.sum())

    print(f"\n── Model (test set) ──")
    print(f"  all preds accuracy: {acc*100:.1f}%")
    if sel_n >= 10:
        sp, slo, shi = wilson(sel_w, sel_n)
        print(f"  confident-only (n={sel_n}, {sel_n/len(test)*100:.0f}% of test): WR {sp*100:.1f}%  (CI {slo*100:.1f}-{shi*100:.1f}%)")
        print(f"    {'✅ breakeven পেরিয়েছে (tentative)' if slo > BREAKEVEN else ('⚠️ CI breakeven-এর নিচে — edge নয়' if shi < BREAKEVEN else '⚠️ ambiguous — আরো data দরকার')}")
    else:
        print(f"  confident-only n={sel_n} — খুব ছোট, বলার মতো না")

    # ── feature importance (top 12) ──
    imp = sorted(zip(feat_cols, model.feature_importances_), key=lambda x: -x[1])[:12]
    print(f"\n── Top features ──")
    for name, v in imp:
        print(f"  {name:28s} {v:.3f}")

    # ── per-direction learned bias (model's view) ──
    dir_cols = [c for c in feat_cols if c.startswith("dir_")]
    print(f"\n── Model-এর দিক-পক্ষপাত (feature importance থেকে) ──")
    for c in dir_cols:
        impv = dict(imp).get(c, 0)
        print(f"  {c:10s} importance {impv:.3f}")

    print(f"\n═══ সতর্কতা ═══")
    print(f"  ১. মাত্র {len(days)}টা দিন — day-clustering-এ train/test আলাদা দিনের হলেও regime overlap থাকতে পারে।")
    print(f"  ২. এটা prototype — production-এ কিছু লাগে না। data জমলে আবার চালান: python3 d4_prototype.py")
    print(f"  ৩. যদি confident-only WR-র CI ৫৫.৬% পেরোয় (একাধিক দিনে), তবেই conditional strategy বিবেচনা।")

if __name__ == "__main__":
    main()
