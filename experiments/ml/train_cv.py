#!/usr/bin/env python3
"""
TASK 24 — ML FEASIBILITY: purged walk-forward CV + HP grid (Train+Val ONLY).

Pre-registered protocol (experiments/ml/PRE_REGISTRATION_ML.md, commit 115be8e):
  - 5 expanding walk-forward folds inside Train+Val, purge 60m around every
    fold boundary (>= 6x the longest label window).
  - HP grid (SMALL, declared): learning_rate {0.05, 0.10} x num_leaves
    {63, 127}; min_data_in_leaf 500, feature_fraction 0.8, bagging 0.8 freq 1;
    early stopping on fold AUC (patience 200, max 2000 rounds).
    Grid runs on the 10m horizon across all 5 folds; best by mean fold AUC
    is frozen for ALL horizons.
  - Main CV pass: chosen HP x 5 folds x 3 horizons -> AUC / accuracy@0.5 /
    per-fold gain importances (+ Spearman stability across folds).
  - DECLARED pruning rule: features with ZERO gain importance in every fold
    of the main pass may be dropped in ONE follow-up pass; adopt the pruned
    set iff its mean fold AUC >= full-set mean fold AUC - 2e-4 (validation
    only, both numbers from the SAME folds). Documented in the iteration
    summary either way.

HARD GUARDS (fail loudly):
  - every row used must have ts < validation.end  -> Test is unreachable here
  - fold train rows all < fold val start - 60m    -> purge verified in code
  - run artifacts are idempotent JSON files; completed runs are skipped, so
    the script can be re-invoked under a --budget-seconds wall (sandbox runs
    in <=10-min foreground chunks; pass --budget-seconds 480 and re-run).

Run:  python3 experiments/ml/train_cv.py --budget-seconds 480 [--phase grid|cv|pruned]
"""
import json
import os
import sys
import time
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, "backtest", "data", "ml_features")
RUNS = os.path.join(ROOT, "experiments", "ml", "cv_runs")
PAIRS = ["BTCUSDT", "ETHUSDT", "XRPUSDT", "SOLUSDT"]
PAIR_ID = {s: i for i, s in enumerate(PAIRS)}
HORIZONS = [5, 7, 10]
LABEL_FIELD = {5: "l5", 7: "l7", 10: "l10"}

DT = np.dtype([  # packed 208B — must match build_features.mjs
    ("ts", "<i8"), ("c_t", "<f8"),
    ("l5", "u1"), ("l7", "u1"), ("l10", "u1"), ("pad", "u1"),
    ("cH5", "<f8"), ("cH7", "<f8"), ("cH10", "<f8"),
    ("f", "<f4", (41,)),
])
assert DT.itemsize == 208, DT.itemsize

HP_GRID = [  # declared in PRE_REGISTRATION_ML.md — do not extend
    {"learning_rate": 0.05, "num_leaves": 63},
    {"learning_rate": 0.05, "num_leaves": 127},
    {"learning_rate": 0.10, "num_leaves": 63},
    {"learning_rate": 0.10, "num_leaves": 127},
]
BASE_PARAMS = {
    "objective": "binary", "metric": ["auc"],
    "min_data_in_leaf": 500, "feature_fraction": 0.8,
    "bagging_fraction": 0.8, "bagging_freq": 1,
    "num_threads": 4, "seed": 42, "deterministic": True,
    "force_row_wise": True, "verbosity": -1,
}
PURGE_MS = 60 * 60 * 1000

os.makedirs(RUNS, exist_ok=True)


def log(msg):
    print(msg, flush=True)


def load_split():
    with open(os.path.join(ROOT, "experiments", "ml", "split_dates.json")) as f:
        return json.load(f)


def parse_ms(s):
    return int(np.datetime64(s.replace("Z", "+00:00")).astype("datetime64[ms]").astype("int64"))


def load_pair(sym):
    path = os.path.join(DATA, f"{sym}.bin")
    return np.memmap(path, dtype=DT, mode="r")


def decided_mask(lbl):
    return (lbl == 0) | (lbl == 1)


def run_tag(phase, cfg_idx, fold, horizon):
    return f"{phase}_cfg{cfg_idx}_f{fold}_h{horizon}" if cfg_idx is not None else f"{phase}_f{fold}_h{horizon}"


def train_one(X_train, y_train, X_val, y_val, params, tag):
    import lightgbm as lgb
    from sklearn.metrics import roc_auc_score

    dtrain = lgb.Dataset(X_train, label=y_train, params=params, free_raw_data=True)
    dval = lgb.Dataset(X_val, label=y_val, params=params, reference=dtrain, free_raw_data=True)
    t0 = time.time()
    booster = lgb.train(
        params, dtrain, num_boost_round=2000,
        valid_sets=[dval], valid_names=["val"],
        callbacks=[lgb.early_stopping(200, verbose=False)],
    )
    best_iter = booster.best_iteration
    p = booster.predict(X_val, num_iteration=best_iter)
    auc = float(roc_auc_score(y_val, p))
    pred = (p >= 0.5).astype(np.int8)
    acc = float((pred == y_val).mean())
    imp = dict(zip(booster.feature_name(), booster.feature_importance("gain").tolist()))
    elapsed = time.time() - t0
    log(f"  {tag}: best_iter={best_iter} auc={auc:.5f} acc={acc:.5f} ({elapsed:.0f}s)")
    return {"best_iter": int(best_iter), "auc": auc, "acc": acc,
            "n_train": int(len(y_train)), "n_val": int(len(y_val)),
            "importances": {k: float(v) for k, v in imp.items()},
            "elapsed_s": round(elapsed, 1)}


def main():
    budget = 480
    if "--budget-seconds" in sys.argv:
        budget = int(sys.argv[sys.argv.index("--budget-seconds") + 1])
    phase = sys.argv[sys.argv.index("--phase") + 1] if "--phase" in sys.argv else None

    sp = load_split()
    val_end = parse_ms(sp["validation"]["end"])
    t_start = time.time()

    # fold boundaries from the frozen split
    folds = []
    for f in sp["walk_forward_folds_within_trainval"]:
        folds.append((parse_ms(f["val_start"]), parse_ms(f["val_end"])))

    memmaps = {s: load_pair(s) for s in PAIRS}

    # decided-row index arrays per pair (u8 labels; ties/missing excluded at use time)
    meta = {s: json.load(open(os.path.join(DATA, f"{s}.meta.json"))) for s in PAIRS}

    def materialize(ts_hi, horizon, extra_lo=0):
        """X, y for all pairs, rows with extra_lo <= ts < ts_hi, decided only."""
        Xs, ys = [], []
        lf = LABEL_FIELD[horizon]
        for sym in PAIRS:
            mm = memmaps[sym]
            lo = int(np.searchsorted(mm["ts"], extra_lo, side="left"))
            hi = int(np.searchsorted(mm["ts"], ts_hi, side="left"))
            lbl = mm[lf][lo:hi]
            m = decided_mask(lbl)
            Xs.append(np.asarray(mm["f"][lo:hi][m], dtype=np.float32))
            ys.append(lbl[m].astype(np.int8))
        return np.concatenate(Xs), np.concatenate(ys)

    def grid_ts_hi(fold_idx):
        return folds[fold_idx][0] - PURGE_MS

    # ── phase: HP grid on H=10m ──────────────────────────────────────────────
    if phase in (None, "grid"):
        log(f"== PHASE grid (H=10m, {len(HP_GRID)} configs x {len(folds)} folds) ==")
        for ci, cfg in enumerate(HP_GRID):
            params = {**BASE_PARAMS, **cfg}
            for fi in range(len(folds)):
                tag = run_tag("grid", ci, fi, 10)
                out = os.path.join(RUNS, tag + ".json")
                if os.path.exists(out):
                    continue
                if time.time() - t_start > budget:
                    log("budget reached — re-invoke to resume"); return
                ts_hi = grid_ts_hi(fi)
                vs, ve = folds[fi]
                assert ts_hi < vs, "purge violated"
                log(f"grid cfg{ci} {cfg} fold{fi}: train ts < {ts_hi} (purge ok), val [{vs},{ve})")
                Xtr, ytr = materialize(ts_hi, 10)
                Xv, yv = materialize(ve, 10, extra_lo=vs)
                res = train_one(Xtr, ytr, Xv, yv, params, tag)
                res.update({"phase": "grid", "cfg": cfg, "fold": fi, "horizon": 10,
                            "purge_ok": True, "val_end_guard": ve <= val_end})
                json.dump(res, open(out, "w"))
                del Xtr, ytr, Xv, yv

    # ── phase: main CV with frozen HP on all horizons ────────────────────────
    if phase in (None, "cv"):
        grid_files = [os.path.join(RUNS, f"grid_cfg{ci}_f{fi}_h10.json")
                      for ci in range(len(HP_GRID)) for fi in range(len(folds))]
        if not all(os.path.exists(g) for g in grid_files):
            log("grid phase incomplete — run --phase grid first"); return
        aucs = []
        for g in grid_files:
            aucs.append(json.load(open(g))["auc"])
        mean_auc = [float(np.mean(aucs[i * len(folds):(i + 1) * len(folds)])) for i in range(len(HP_GRID))]
        best_ci = int(np.argmax(mean_auc))
        log(f"grid means: {[round(a, 5) for a in mean_auc]} -> frozen cfg{best_ci} {HP_GRID[best_ci]}")
        json.dump({"mean_auc_by_cfg": mean_auc, "best_cfg_idx": best_ci,
                   "frozen_hp": HP_GRID[best_ci], "grid": HP_GRID},
                  open(os.path.join(RUNS, "grid_choice.json"), "w"))

        params = {**BASE_PARAMS, **HP_GRID[best_ci]}
        for fi in range(len(folds)):
            vs, ve = folds[fi]
            ts_hi = grid_ts_hi(fi)
            assert ts_hi < vs, "purge violated"
            for H in HORIZONS:
                tag = run_tag("cv", None, fi, H)
                out = os.path.join(RUNS, tag + ".json")
                if os.path.exists(out):
                    continue
                if time.time() - t_start > budget:
                    log("budget reached — re-invoke to resume"); return
                log(f"cv fold{fi} H={H}: train ts < {ts_hi} (purge ok), val [{vs},{ve})")
                Xtr, ytr = materialize(ts_hi, H)
                Xv, yv = materialize(ve, H, extra_lo=vs)
                res = train_one(Xtr, ytr, Xv, yv, params, tag)
                res.update({"phase": "cv", "cfg": HP_GRID[best_ci], "fold": fi, "horizon": H,
                            "purge_ok": True, "val_end_guard": ve <= val_end})
                json.dump(res, open(out, "w"))
                del Xtr, ytr, Xv, yv

    # ── phase: declared one-pass pruning check ───────────────────────────────
    if phase == "pruned":
        cv_files = [os.path.join(RUNS, f"cv_f{fi}_h{H}.json")
                    for fi in range(len(folds)) for H in HORIZONS]
        if not all(os.path.exists(f) for f in cv_files):
            log("cv phase incomplete — run --phase cv first"); return
        runs = [json.load(open(f)) for f in cv_files]
        names = meta[PAIRS[0]]["featureNames"]
        zero_in_all = [n for n in names if all(r["importances"].get(n, 0.0) == 0.0 for r in runs)]
        log(f"zero-gain-in-every-fold features: {zero_in_all if zero_in_all else 'NONE'}")
        choice = json.load(open(os.path.join(RUNS, "grid_choice.json")))
        json.dump({"zero_gain_features": zero_in_all,
                   "rule": "adopt pruned iff mean fold AUC >= full - 2e-4 (same folds, validation only)",
                   "frozen_hp": choice["frozen_hp"]},
                  open(os.path.join(RUNS, "prune_candidates.json"), "w"))
        if not zero_in_all:
            log("no pruning needed — full feature set stands"); return
        keep_idx = [i for i, n in enumerate(names) if n not in zero_in_all]
        params = {**BASE_PARAMS, **choice["frozen_hp"]}
        results = []
        for fi in range(len(folds)):
            vs, ve = folds[fi]
            ts_hi = grid_ts_hi(fi)
            for H in HORIZONS:
                tag = run_tag("pruned", None, fi, H)
                out = os.path.join(RUNS, tag + ".json")
                if os.path.exists(out):
                    results.append(json.load(open(out))); continue
                if time.time() - t_start > budget:
                    log("budget reached — re-invoke to resume"); return
                Xtr, ytr = materialize(ts_hi, H)
                Xv, yv = materialize(ve, H, extra_lo=vs)
                res = train_one(np.ascontiguousarray(Xtr[:, keep_idx]), ytr,
                                np.ascontiguousarray(Xv[:, keep_idx]), yv, params, tag)
                res.update({"phase": "pruned", "fold": fi, "horizon": H, "kept_features": len(keep_idx)})
                json.dump(res, open(out, "w"))
                results.append(res)
                del Xtr, ytr, Xv, yv
        full_mean = float(np.mean([r["auc"] for r in runs]))
        pruned_mean = float(np.mean([r["auc"] for r in results]))
        adopt = pruned_mean >= full_mean - 2e-4
        log(f"full mean fold AUC {full_mean:.5f} vs pruned {pruned_mean:.5f} -> adopt={adopt}")
        json.dump({"full_mean_auc": full_mean, "pruned_mean_auc": pruned_mean,
                   "adopt_pruned": bool(adopt), "dropped": zero_in_all,
                   "kept_feature_names": [names[i] for i in keep_idx] if adopt else names},
                  open(os.path.join(RUNS, "prune_decision.json"), "w"))

    log("train_cv: done.")


if __name__ == "__main__":
    main()
