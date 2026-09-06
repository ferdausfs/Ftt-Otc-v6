#!/usr/bin/env python3
"""
TASK 24 — FINAL TEST EVALUATION (the single, pre-registered Test touch).

Per horizon H in {5,7,10}:
  1. train the final LightGBM on ALL Train+Validation decided rows (stride-2,
     the frozen A1 basis) with the frozen HP (lr=0.10, leaves=127) and the
     pre-declared round count median(best_round across folds) x 1.1
     (H5=118, H7=57, H10=81) — no early stopping, Test influences nothing;
  2. predict EVERY decided Test row (2025-12-13T15:36Z -> 2026-09-05T00:00Z,
     all four pairs, no stride, ties included for the funnel but win=null);
  3. stream raw predictions to results/ML_FEASIBILITY_test_predictions_H.jsonl.gz
     (fields: pair, ts, t_ms, H, p_up, pred, label, win, c_t, c_tH);
  4. write the per-pair Test funnel to results/ML_FEASIBILITY_test_funnel.json.
No win-rate, CI, or verdict is computed here — the independent aggregator
(experiments/ml/aggregate_and_verify.py) derives every reported number from
the JSONL logs alone.

Run:  python3 experiments/ml/final_test_eval.py [--horizon 5|7|10]
"""
import gzip
import json
import os
import sys
import time
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, "backtest", "data", "ml_features")
RUNS = os.path.join(ROOT, "experiments", "ml", "cv_runs")
RESULTS = os.path.join(ROOT, "results")
PAIRS = ["BTCUSDT", "ETHUSDT", "XRPUSDT", "SOLUSDT"]
PAIR_NAME = {"BTCUSDT": "BTC/USD", "ETHUSDT": "ETH/USD", "XRPUSDT": "XRP/USD", "SOLUSDT": "SOL/USD"}
LABEL_FIELD = {5: "l5", 7: "l7", 10: "l10"}
CLOSE_FIELD = {5: "cH5", 7: "cH7", 10: "cH10"}
FINAL_ROUNDS = {5: 118, 7: 57, 10: 81}   # median(best_round) x 1.1, from cv_summary.json

DT = np.dtype([("ts", "<i8"), ("c_t", "<f8"),
               ("l5", "u1"), ("l7", "u1"), ("l10", "u1"), ("pad", "u1"),
               ("cH5", "<f8"), ("cH7", "<f8"), ("cH10", "<f8"),
               ("f", "<f4", (41,))])
T0_MS = 1635724800000
PARAMS = {"objective": "binary", "min_data_in_leaf": 500, "feature_fraction": 0.8,
          "bagging_fraction": 0.8, "bagging_freq": 1, "num_threads": 2, "seed": 42,
          "deterministic": True, "force_row_wise": True, "verbosity": -1,
          "learning_rate": 0.10, "num_leaves": 127}


def parse_ms(s):
    return int(np.datetime64(s.replace("Z", "+00:00")).astype("datetime64[ms]").astype("int64"))


def iso(ms):
    return np.datetime64(ms, "ms").astype("datetime64[s]").astype(str) + "Z"


def main():
    horizon = int(sys.argv[sys.argv.index("--horizon") + 1]) if "--horizon" in sys.argv else None
    sp = json.load(open(os.path.join(ROOT, "experiments", "ml", "split_dates.json")))
    val_end = parse_ms(sp["validation"]["end"])
    T1 = parse_ms(sp["T1"])
    horizons = [horizon] if horizon else [5, 7, 10]

    mms = {s: np.memmap(os.path.join(DATA, f"{s}.bin"), dtype=DT, mode="r") for s in PAIRS}
    names = json.load(open(os.path.join(DATA, "BTCUSDT.meta.json")))["featureNames"]

    for H in horizons:
        lf, cf = LABEL_FIELD[H], CLOSE_FIELD[H]
        out_path = os.path.join(RESULTS, f"ML_FEASIBILITY_test_predictions_H{H}.jsonl.gz")
        if os.path.exists(out_path):
            print(f"H={H}: predictions already exist — skipping (single-touch rule)")
            continue
        t0 = time.time()

        # 1. final model: ALL Train+Val decided rows, stride-2, frozen rounds
        Xs, ys = [], []
        for s in PAIRS:
            mm = mms[s]
            hi = int(np.searchsorted(mm["ts"], val_end, side="left"))
            lbl = mm[lf][:hi]
            m = (lbl == 0) | (lbl == 1)
            m &= ((mm["ts"][:hi] - T0_MS) // 60000 % 2) == 0
            Xs.append(np.asarray(mm["f"][:hi][m]))
            ys.append(lbl[m].astype(np.int8))
        X = np.concatenate(Xs); y = np.concatenate(ys)
        del Xs, ys
        import lightgbm as lgb
        dtrain = lgb.Dataset(X, label=y, params=PARAMS, feature_name=names)
        rounds = FINAL_ROUNDS[H]
        booster = lgb.train(PARAMS, dtrain, num_boost_round=rounds)
        booster.save_model(os.path.join(ROOT, "experiments", "ml", "final_models", f"H{H}.txt"))
        print(f"H={H}: final model trained on {X.shape[0]} stride-2 rows, {rounds} rounds "
              f"({time.time() - t0:.0f}s)")
        del X, y, dtrain

        # 2+3. predict every Test row, stream JSONL.gz
        funnel = {"horizon": H, "test_start": sp["validation"]["end"], "test_end": sp["T1"],
                  "expected_minutes_per_pair": int((T1 - val_end) // 60000), "pairs": {}}
        with gzip.open(out_path, "wt", compresslevel=6) as out:
            for s in PAIRS:
                mm = mms[s]
                lo = int(np.searchsorted(mm["ts"], val_end, side="left"))
                hi = int(np.searchsorted(mm["ts"], T1, side="left"))
                lbl = mm[lf][lo:hi]
                feats = mm["f"][lo:hi]
                c_t = mm["c_t"][lo:hi]
                c_tH = mm[cf][lo:hi]
                ts = mm["ts"][lo:hi]
                p = booster.predict(feats)
                decided = (lbl == 0) | (lbl == 1)
                n_rows = hi - lo
                n_up = int((lbl == 1).sum()); n_down = int((lbl == 0).sum())
                n_tie = int((lbl == 2).sum()); n_missing = int((lbl == 255).sum())
                buf = []
                for k in range(n_rows):
                    pred = "CALL" if p[k] >= 0.5 else "PUT"
                    if lbl[k] == 2:
                        win = None
                    elif lbl[k] == 255:
                        continue  # never fabricated; funnel counts it
                    else:
                        win = int((lbl[k] == 1 and pred == "CALL") or (lbl[k] == 0 and pred == "PUT"))
                    buf.append(json.dumps({
                        "pair": PAIR_NAME[s], "ts": iso(int(ts[k])), "t_ms": int(ts[k]), "H": H,
                        "p_up": round(float(p[k]), 6), "pred": pred,
                        "label": int(lbl[k]), "win": win,
                        "c_t": float(c_t[k]), "c_tH": float(c_tH[k]),
                    }, separators=(",", ":")))
                    if len(buf) >= 50000:
                        out.write("\n".join(buf) + "\n"); buf = []
                if buf:
                    out.write("\n".join(buf) + "\n")
                decided_n = n_up + n_down
                funnel["pairs"][PAIR_NAME[s]] = {
                    "expected_minutes": funnel["expected_minutes_per_pair"],
                    "rows_written": int(n_rows),
                    "excluded_stale15m": funnel["expected_minutes_per_pair"] - n_rows,
                    "decided": decided_n, "up_outcomes": n_up, "down_outcomes": n_down,
                    "ties": n_tie, "missing_target": n_missing,
                    "predicted": int(decided_n),
                    "predicted_CALL": int(((p >= 0.5) & decided).sum()),
                    "predicted_PUT": int(((p < 0.5) & decided).sum()),
                }
                print(f"  {PAIR_NAME[s]}: rows={n_rows} decided={decided_n} ties={n_tie} "
                      f"missing={n_missing} ({time.time() - t0:.0f}s)")
        funnel["predicted_total"] = sum(v["predicted"] for v in funnel["pairs"].values())
        json.dump(funnel, open(os.path.join(RESULTS, f"ML_FEASIBILITY_test_funnel_H{H}.json"), "w"), indent=1)
        print(f"H={H}: DONE -> {out_path} ({time.time() - t0:.0f}s total)")


if __name__ == "__main__":
    os.makedirs(os.path.join(ROOT, "experiments", "ml", "final_models"), exist_ok=True)
    main()
