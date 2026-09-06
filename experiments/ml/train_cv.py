#!/usr/bin/env python3
"""
TASK 24 — ML FEASIBILITY: purged walk-forward CV + HP grid (Train+Val ONLY).

Pre-registered protocol (experiments/ml/PRE_REGISTRATION_ML.md, commits
115be8e + amendment 40d1370) with RUNTIME ADAPTATIONS (all made pre-results,
documented in PRE_REGISTRATION_ML.md §6.1 and committed BEFORE the first
completed CV run — zero CV results had been consumed):
  A1 train rows stride-2 (decision minutes with (t-T0)/60000 even) — halves
     train cost; overlapping fixed-time labels make this near-lossless.
     Reported fold metrics are computed on FULL validation folds.
  A2 early-stopping evaluation on a fixed 25% subsample of the val fold
     ((t-T0)/60000 % 4 == 0); the chosen round is tracked per-round on that
     subsample; final fold AUC/acc are recomputed on the FULL val fold at
     the chosen best round (reported numbers exact).
  A3 HP grid restricted to learning_rate=0.10 x num_leaves {63,127}
     (2 configs; lr=0.05 dropped for 2-core runtime).
  A4 checkpointed boosting in 150-round chunks (survives the sandbox's
     10-minute foreground tool-call limit) with EXACT patience-200 /
     max-2000 semantics: per-round val-sub AUC is recorded every round via
     evals_result, the best round is tracked globally, and a run finalizes
     when the last 200 rounds show no improvement or 2000 rounds are reached.

HARD GUARDS (fail loudly):
  - every row used must have ts < validation.end  -> Test is unreachable here
  - fold train rows all < fold val start - 60m    -> purge verified in code
  - run artifacts are idempotent; completed runs are skipped; chunks resume
    from saved boosters (pass --budget-seconds N and re-invoke to continue).

Run:  python3 experiments/ml/train_cv.py --budget-seconds 470 [--phase grid|cv|pruned]
"""
import json
import os
import sys
import time
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, "backtest", "data", "ml_features")
RUNS = os.path.join(ROOT, "experiments", "ml", "cv_runs")
PAIRS = ["BTCUSDT", "ETHUSDT", "XRPUSDT", "SOLUSDT"]
HORIZONS = [5, 7, 10]
LABEL_FIELD = {5: "l5", 7: "l7", 10: "l10"}

DT = np.dtype([  # packed 208B — must match build_features.mjs
    ("ts", "<i8"), ("c_t", "<f8"),
    ("l5", "u1"), ("l7", "u1"), ("l10", "u1"), ("pad", "u1"),
    ("cH5", "<f8"), ("cH7", "<f8"), ("cH10", "<f8"),
    ("f", "<f4", (41,)),
])
assert DT.itemsize == 208, DT.itemsize

T0_MS = 1635724800000          # 2021-11-01T00:00Z (frozen window open)
HP_GRID = [                    # A3: declared grid reduced to lr=0.10 (pre-results)
    {"learning_rate": 0.10, "num_leaves": 63},
    {"learning_rate": 0.10, "num_leaves": 127},
]
BASE_PARAMS = {
    "objective": "binary", "metric": ["auc"],
    "min_data_in_leaf": 500, "feature_fraction": 0.8,
    "bagging_fraction": 0.8, "bagging_freq": 1,
    "num_threads": 2, "seed": 42, "deterministic": True,
    "force_row_wise": True, "verbosity": -1,
}
PURGE_MS = 60 * 60 * 1000
MAX_ROUNDS = 2000
PATIENCE = 200
CHUNK = 150

os.makedirs(RUNS, exist_ok=True)

memmaps = {}


def log(msg):
    print(msg, flush=True)


def parse_ms(s):
    return int(np.datetime64(s.replace("Z", "+00:00")).astype("datetime64[ms]").astype("int64"))


def load_split():
    with open(os.path.join(ROOT, "experiments", "ml", "split_dates.json")) as f:
        return json.load(f)


def load_pair(sym):
    return np.memmap(os.path.join(DATA, f"{sym}.bin"), dtype=DT, mode="r")


def decided_mask(lbl):
    return (lbl == 0) | (lbl == 1)


def materialize(ts_lo, ts_hi, horizon, stride=1, stride_phase=0, keep_idx=None):
    """X, y for all pairs, ts_lo <= ts < ts_hi, decided only, strided rows.
    Stride applies on the frozen grid minute k = (ts-T0)/60000."""
    lf = LABEL_FIELD[horizon]
    parts = []
    for sym in PAIRS:
        mm = memmaps[sym]
        lo = int(np.searchsorted(mm["ts"], ts_lo, side="left"))
        hi = int(np.searchsorted(mm["ts"], ts_hi, side="left"))
        m = decided_mask(mm[lf][lo:hi])
        if stride > 1:
            m &= ((mm["ts"][lo:hi] - T0_MS) // 60000 % stride) == stride_phase
        parts.append((sym, lo, hi, m, int(m.sum())))
    n = sum(p[4] for p in parts)
    ncol = len(keep_idx) if keep_idx is not None else 41
    X = np.empty((n, ncol), dtype=np.float32)
    y = np.empty(n, dtype=np.int8)
    off = 0
    for sym, lo, hi, m, k in parts:
        mm = memmaps[sym]
        block = mm["f"][lo:hi][m]
        X[off:off + k] = block[:, keep_idx] if keep_idx is not None else block
        y[off:off + k] = mm[lf][lo:hi][m]
        off += k
    return X, y


def run_tag(phase, cfg_idx, fold, horizon):
    return f"{phase}_cfg{cfg_idx}_f{fold}_h{horizon}" if cfg_idx is not None else f"{phase}_f{fold}_h{horizon}"


def importances_at(best_path, params, best_round, names):
    """Gain importances summed over trees < best_round (exact)."""
    import lightgbm as lgb
    b = lgb.Booster(params=params, model_file=best_path)
    df = b.trees_to_df()
    df = df[df["tree_index"] < best_round]
    out = {n: 0.0 for n in names}
    for idx, val in df.groupby("split_feature")["split_gain"].sum().items():
        key = idx if isinstance(idx, str) else names[int(idx)]
        out[key] = float(val)
    return out


def chunked_train(phase, cfg_idx, fold, horizon, params, ts_hi, vs, ve, names, t_start, budget,
                  keep_idx=None, val_end_guard=None):
    import lightgbm as lgb
    from sklearn.metrics import roc_auc_score

    tag = run_tag(phase, cfg_idx, fold, horizon)
    final_path = os.path.join(RUNS, tag + ".json")
    if os.path.exists(final_path):
        log(f"{tag}: already complete")
        return json.load(open(final_path))

    assert ts_hi < vs, "purge violated"
    assert val_end_guard is None or ve <= val_end_guard, "test unreachable guard violated"

    state_path = os.path.join(RUNS, tag + ".state.json")
    model_path = os.path.join(RUNS, tag + ".model.txt")
    best_path = os.path.join(RUNS, tag + ".best.txt")
    st = json.load(open(state_path)) if os.path.exists(state_path) else \
        {"rounds_done": 0, "best_round": 0, "best_auc": -1.0}

    Xtr, ytr = materialize(0, ts_hi, horizon, stride=2, stride_phase=0, keep_idx=keep_idx)      # A1
    Xev, yev = materialize(vs, ve, horizon, stride=4, stride_phase=0, keep_idx=keep_idx)        # A2
    dtrain = lgb.Dataset(Xtr, label=ytr, params=params, free_raw_data=True)
    deval = lgb.Dataset(Xev, label=yev, params=params, free_raw_data=True)
    log(f"{tag}: train={Xtr.shape[0]} (stride2) evalSub={Xev.shape[0]} rounds_done={st['rounds_done']}")

    while st["rounds_done"] < MAX_ROUNDS:
        if time.time() - t_start > budget:
            json.dump(st, open(state_path, "w"))
            log(f"{tag}: budget reached at round {st['rounds_done']} — re-invoke to resume")
            return None
        n_chunk = min(CHUNK, MAX_ROUNDS - st["rounds_done"])
        init = model_path if st["rounds_done"] > 0 else None
        booster = lgb.train(params, dtrain, num_boost_round=n_chunk, init_model=init,
                            valid_sets=[deval], callbacks=[lgb.log_evaluation(0)])
        st["rounds_done"] += n_chunk
        per_round = list(list(booster.evals_result().values())[0].values())[0]  # this chunk's per-round AUCs
        for j, a in enumerate(per_round):
            r = st["rounds_done"] - n_chunk + j + 1
            if a > st["best_auc"]:
                st["best_auc"] = float(a)
                st["best_round"] = r
        booster.save_model(model_path, num_iteration=st["rounds_done"])
        if st["best_round"] > st["rounds_done"] - n_chunk:  # new best inside this chunk
            booster.save_model(best_path, num_iteration=st["best_round"])
        if st["rounds_done"] - st["best_round"] >= PATIENCE:
            break

    # finalize: FULL-val metrics at the exact best round
    del Xtr, ytr, Xev, yev, dtrain, deval
    Xv, yv = materialize(vs, ve, horizon, stride=1, keep_idx=keep_idx)
    bb = lgb.Booster(params=params, model_file=best_path)
    p = bb.predict(Xv, num_iteration=st["best_round"])
    fm = {"auc": float(roc_auc_score(yv, p)),
          "acc": float(((p >= 0.5).astype(np.int8) == yv).mean()),
          "n_val": int(len(yv))}
    imp = importances_at(best_path, params, st["best_round"], names)
    out = {"phase": phase, "cfg_leaves": params.get("num_leaves"), "fold": fold, "horizon": horizon,
           "best_round": st["best_round"], "rounds_trained": st["rounds_done"],
           "val_sub_auc_at_best": st["best_auc"], **fm, "importances": imp, "purge_ok": True,
           "runtime_adaptations": "A1 stride2-train; A2 25pct-early-stop-eval; A3 lr0.10-only; A4 chunked"}
    json.dump(out, open(final_path, "w"))
    for pth in (state_path, model_path, best_path):
        if os.path.exists(pth):
            os.remove(pth)
    log(f"{tag}: FINAL best_round={st['best_round']} auc={fm['auc']:.5f} acc={fm['acc']:.5f} n_val={fm['n_val']}")
    return out


def main():
    budget = 470
    if "--budget-seconds" in sys.argv:
        budget = int(sys.argv[sys.argv.index("--budget-seconds") + 1])
    phase = sys.argv[sys.argv.index("--phase") + 1] if "--phase" in sys.argv else None

    sp = load_split()
    val_end = parse_ms(sp["validation"]["end"])
    folds = [(parse_ms(f["val_start"]), parse_ms(f["val_end"]))
             for f in sp["walk_forward_folds_within_trainval"]]
    memmaps.update({s: load_pair(s) for s in PAIRS})
    names = json.load(open(os.path.join(DATA, "BTCUSDT.meta.json")))["featureNames"]
    t_start = time.time()

    if phase in (None, "grid"):
        log(f"== PHASE grid (H=10m, {len(HP_GRID)} configs x {len(folds)} folds) ==")
        for ci, cfg in enumerate(HP_GRID):
            params = {**BASE_PARAMS, **cfg}
            for fi in range(len(folds)):
                vs, ve = folds[fi]
                chunked_train("grid", ci, fi, 10, params, vs - PURGE_MS, vs, ve, names, t_start, budget,
                              val_end_guard=val_end)

    if phase in (None, "cv"):
        need = [os.path.join(RUNS, f"grid_cfg{ci}_f{fi}_h10.json")
                for ci in range(len(HP_GRID)) for fi in range(len(folds))]
        if not all(os.path.exists(g) for g in need):
            log("grid phase incomplete — run --phase grid first"); return
        per_fold = [[json.load(open(os.path.join(RUNS, f"grid_cfg{ci}_f{fi}_h10.json")))["auc"]
                     for fi in range(len(folds))] for ci in range(len(HP_GRID))]
        mean_auc = [float(np.mean(a)) for a in per_fold]
        best_ci = int(np.argmax(mean_auc))
        log(f"grid mean full-val AUCs: {[round(a, 5) for a in mean_auc]} -> frozen cfg{best_ci} {HP_GRID[best_ci]}")
        json.dump({"mean_full_val_auc_by_cfg": mean_auc, "per_fold_auc_by_cfg": per_fold,
                   "best_cfg_idx": best_ci, "frozen_hp": HP_GRID[best_ci], "grid": HP_GRID},
                  open(os.path.join(RUNS, "grid_choice.json"), "w"))
        params = {**BASE_PARAMS, **HP_GRID[best_ci]}
        for fi in range(len(folds)):
            vs, ve = folds[fi]
            for H in HORIZONS:
                chunked_train("cv", None, fi, H, params, vs - PURGE_MS, vs, ve, names, t_start, budget,
                              val_end_guard=val_end)

    if phase == "pruned":
        cv_files = [os.path.join(RUNS, f"cv_f{fi}_h{H}.json")
                    for fi in range(len(folds)) for H in HORIZONS]
        if not all(os.path.exists(f) for f in cv_files):
            log("cv phase incomplete — run --phase cv first"); return
        runs = [json.load(open(f)) for f in cv_files]
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
            for H in HORIZONS:
                res = chunked_train("pruned", None, fi, H, params, vs - PURGE_MS, vs, ve, names,
                                    t_start, budget, keep_idx=keep_idx, val_end_guard=val_end)
                if res:
                    results.append(res)
        if len(results) == len(cv_files):
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
