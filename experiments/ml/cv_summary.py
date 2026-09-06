#!/usr/bin/env python3
"""TASK 24 — aggregate the completed CV runs into cv_summary.json:
per-horizon means, per-fold table, feature-importance stability across folds
(Spearman rank correlation of gain importances between every fold pair),
top features per horizon. Validation-phase ONLY (test rows never touched).
"""
import glob
import json
import numpy as np
from scipy.stats import spearmanr

RUNS = "experiments/ml/cv_runs"
NAMES = json.load(open("backtest/data/ml_features/BTCUSDT.meta.json"))["featureNames"]

runs = []
for f in sorted(glob.glob(f"{RUNS}/cv_f*_h*.json")):
    if f.endswith(".state.json"):
        continue
    runs.append(json.load(open(f)))
assert len(runs) == 15, len(runs)

by_h = {5: [], 7: [], 10: []}
for r in runs:
    by_h[r["horizon"]].append(r)
for h in by_h:
    by_h[h].sort(key=lambda r: r["fold"])

summary = {"frozen_hp": json.load(open(f"{RUNS}/grid_choice.json"))["frozen_hp"],
           "runtime_adaptations": "A1 stride2-train; A2 25pct-early-stop-eval (reported metrics = full fold); A3 lr0.10-only; A4 chunked exact patience",
           "horizons": {}}

for h, rs in by_h.items():
    aucs = [r["auc"] for r in rs]
    accs = [r["acc"] for r in rs]
    brs = [r["best_round"] for r in rs]
    # importance stability: Spearman rank corr between every fold pair
    imps = [[r["importances"][n] for n in NAMES] for r in rs]
    rhos = []
    for i in range(len(rs)):
        for j in range(i + 1, len(rs)):
            rho = spearmanr(imps[i], imps[j]).statistic
            rhos.append(float(rho))
    mean_imp = np.mean(np.array(imps), axis=0)
    order = np.argsort(-mean_imp)
    summary["horizons"][h] = {
        "per_fold": [{"fold": r["fold"], "best_round": r["best_round"], "auc": r["auc"],
                      "acc": r["acc"], "n_val": r["n_val"]} for r in rs],
        "mean_auc": float(np.mean(aucs)), "std_auc": float(np.std(aucs)),
        "mean_acc": float(np.mean(accs)),
        "best_rounds": brs, "median_best_round": int(np.median(brs)),
        "final_rounds_rule": "median(best_round across folds) * 1.1 rounded up",
        "final_rounds": int(np.ceil(np.median(brs) * 1.1)),
        "importance_spearman_between_folds": {"mean": float(np.mean(rhos)),
                                              "min": float(np.min(rhos)),
                                              "pairs": len(rhos)},
        "top10_features_by_mean_gain": [{"feature": NAMES[i], "mean_gain": float(mean_imp[i])}
                                        for i in order[:10]],
        "mean_gain_importances": {NAMES[i]: float(mean_imp[i]) for i in range(len(NAMES))},
    }

json.dump(summary, open(f"{RUNS}/cv_summary.json", "w"), indent=1)
print(json.dumps({h: {"mean_auc": v["mean_auc"], "mean_acc": v["mean_acc"],
                      "median_best_round": v["median_best_round"],
                      "final_rounds": v["final_rounds"],
                      "imp_stability_mean_rho": v["importance_spearman_between_folds"]["mean"]}
                  for h, v in summary["horizons"].items()}, indent=1))
for h, v in summary["horizons"].items():
    print(f"\nH={h} top features:", [t["feature"] for t in v["top10_features_by_mean_gain"]])
