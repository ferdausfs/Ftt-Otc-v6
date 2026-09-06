#!/usr/bin/env python3
"""
TASK 24 — INDEPENDENT AGGREGATOR + VERIFIER.

Reads ONLY the raw prediction logs (results/ML_FEASIBILITY_test_predictions_H*.jsonl.gz)
plus split_dates.json for the segment boundary. Recomputes every reported
number from the rows and cross-verifies internal coherence:

  V1 row counts per pair/horizon == funnel JSONs
  V2 every row: win == ((label==1 and pred==CALL) or (label==0 and pred==PUT))
  V3 every row: label == 1 iff c_tH > c_t; 0 iff <; 2 iff ==  (label re-derived
     from the closes carried on the row itself)
  V4 all ts strictly inside the Test segment; no duplicate (pair, ts, H)
  V5 p_up in [0,1]; pred == CALL iff p_up >= 0.5
  V6 sampled cross-check of c_t / c_tH against the raw .bin memmaps
     (independent source: the fetched candles), every 1009th row

Outputs: results/ML_FEASIBILITY_test_aggregate.json + printed tables.
Gate (pre-registered): PASS iff some horizon has Wilson95_LB(WR) > 55.56%
AND WR > up-rate AND WR > down-rate; buckets < 30 decided -> INSUFFICIENT.
"""
import gzip
import json
import math
from collections import defaultdict

import numpy as np

ROOT = "/home/z/my-project/Ftt-Otc-v6"
RESULTS = f"{ROOT}/results"
PAIRS = ["BTC/USD", "ETH/USD", "XRP/USD", "SOL/USD"]
HORIZONS = [5, 7, 10]
T0_MS = 1635724800000
Z95 = 1.959963984540054


def parse_ms(s):
    return int(np.datetime64(s.replace("Z", "+00:00")).astype("datetime64[ms]").astype("int64"))


def wilson(w, n, z=Z95):
    if n == 0:
        return None, None, None
    p = w / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return p, c - half, c + half


def check(counter, name, cond):
    counter["total"] += 1
    if not cond:
        counter["fail"] += 1
        if counter["fail"] <= 5:
            print(f"  VERIFY FAIL: {name}")
    return cond


def aggregate_horizon(H):
    path = f"{RESULTS}/ML_FEASIBILITY_test_predictions_H{H}.jsonl.gz"
    funnel = json.load(open(f"{RESULTS}/ML_FEASIBILITY_test_funnel_H{H}.json"))
    val_end = parse_ms(funnel["test_start"]); T1 = parse_ms(funnel["test_end"])

    V = {"total": 0, "fail": 0}
    agg = {
        "H": H, "n": 0, "wins": 0, "calls": 0, "call_wins": 0,
        "puts": 0, "put_wins": 0, "ties": 0,
        "up_outcomes": 0, "down_outcomes": 0,
        "by_pair": {p: {"n": 0, "wins": 0, "calls": 0, "call_wins": 0, "puts": 0,
                        "put_wins": 0, "ties": 0, "up": 0, "down": 0} for p in PAIRS},
        "stride": {"n": 0, "wins": 0},
        "stride_by_pair": {p: {"n": 0, "wins": 0} for p in PAIRS},
        "seen": set(), "max_ts": 0, "min_ts": 1 << 62,
    }
    cross_samples = []
    with gzip.open(path, "rt") as f:
        for line in f:
            r = json.loads(line)
            p_, H_, ts = r["pair"], r["H"], r["t_ms"]
            check(V, "horizon field", H_ == H and p_ in agg["by_pair"])
            check(V, "ts in test segment", val_end <= ts < T1)
            check(V, "p_up in [0,1]", 0.0 <= r["p_up"] <= 1.0)
            # p_up stored at 6dp — two-sided rounding slack at the 0.5 boundary
            check(V, "pred matches p_up",
                  (r["p_up"] >= 0.5 - 5e-7) if r["pred"] == "CALL"
                  else (r["p_up"] < 0.5 + 5e-7))
            # V3: label re-derived from stored closes (label: 0=down 1=up 2=tie)
            d = (r["c_tH"] > r["c_t"]) - (r["c_tH"] < r["c_t"])
            label_derived = 1 if d > 0 else (0 if d < 0 else 2)
            check(V, "label == sign(c_tH - c_t)", label_derived == r["label"])
            if r["label"] == 2:
                check(V, "tie win is null", r["win"] is None)
            else:
                exp_win = int((r["label"] == 1 and r["pred"] == "CALL") or
                              (r["label"] == 0 and r["pred"] == "PUT"))
                check(V, "win == pred-vs-label rule", r["win"] == exp_win)
            key = (p_, ts)
            dup = key in agg["seen"]
            check(V, "no duplicate (pair, ts)", not dup)
            if not dup:
                agg["seen"].add(key)
            agg["max_ts"] = max(agg["max_ts"], ts); agg["min_ts"] = min(agg["min_ts"], ts)

            bp = agg["by_pair"][p_]
            if r["label"] == 2:
                agg["ties"] += 1; bp["ties"] += 1
                continue
            agg["n"] += 1; bp["n"] += 1
            agg["wins"] += r["win"]; bp["wins"] += r["win"]
            if r["label"] == 1:
                agg["up_outcomes"] += 1; bp["up"] += 1
            else:
                agg["down_outcomes"] += 1; bp["down"] += 1
            if r["pred"] == "CALL":
                agg["calls"] += 1; agg["call_wins"] += r["win"]
                bp["calls"] += 1; bp["call_wins"] += r["win"]
            else:
                agg["puts"] += 1; agg["put_wins"] += r["win"]
                bp["puts"] += 1; bp["put_wins"] += r["win"]
            # non-overlapping stride sample (k = grid minute index, phase 0)
            if (ts - T0_MS) // 60000 % H == 0:
                agg["stride"]["n"] += 1; agg["stride"]["wins"] += r["win"]
                agg["stride_by_pair"][p_]["n"] += 1
                agg["stride_by_pair"][p_]["wins"] += r["win"]
            if len(cross_samples) < 200000:
                cross_samples.append((p_, ts, r["c_t"], r["c_tH"]))
    agg.pop("seen")

    # V6: sampled cross-check against raw .bin memmaps (independent source)
    DT = np.dtype([("ts", "<i8"), ("c_t", "<f8"),
                   ("l5", "u1"), ("l7", "u1"), ("l10", "u1"), ("pad", "u1"),
                   ("cH5", "<f8"), ("cH7", "<f8"), ("cH10", "<f8"),
                   ("f", "<f4", (41,))])
    cf = {5: "cH5", 7: "cH7", 10: "cH10"}[H]
    mm = {s: np.memmap(f"{ROOT}/backtest/data/ml_features/{s}.bin", dtype=DT, mode="r")
          for s in ["BTCUSDT", "ETHUSDT", "XRPUSDT", "SOLUSDT"]}
    sym = {"BTC/USD": "BTCUSDT", "ETH/USD": "ETHUSDT", "XRP/USD": "XRPUSDT", "SOL/USD": "SOLUSDT"}
    checked = 0
    for i, (p_, ts, c_t, c_tH) in enumerate(cross_samples):
        if i % 1009 != 0:
            continue
        arr = mm[sym[p_]]
        k = int(np.searchsorted(arr["ts"], ts))
        check(V, "raw cross-check ts exists", k < len(arr) and int(arr["ts"][k]) == ts)
        if k < len(arr):
            check(V, "raw cross-check closes", float(arr["c_t"][k]) == c_t and
                  float(arr[cf][k]) == c_tH)
        checked += 1
    print(f"H={H}: verified rows, cross-checked {checked} samples against raw candles")

    # funnel vs rows
    for p_ in PAIRS:
        fp = funnel["pairs"][p_]
        bp = agg["by_pair"][p_]
        check(V, f"funnel rows {p_}", fp["rows_written"] == fp["expected_minutes"])
        check(V, f"funnel decided {p_}", fp["decided"] == bp["n"])
        check(V, f"funnel ties {p_}", fp["ties"] == bp["ties"])
        check(V, f"funnel up/down {p_}", fp["up_outcomes"] == bp["up"] and fp["down_outcomes"] == bp["down"])

    # tables
    def table(n, w):
        p, lo, hi = wilson(w, n)
        return {"n": n, "wins": w, "wr": p, "ci_lo": lo, "ci_hi": hi,
                "insufficient": n < 30}

    out = {"H": H, "overall": table(agg["n"], agg["wins"]),
           "calls": table(agg["calls"], agg["call_wins"]),
           "puts": table(agg["puts"], agg["put_wins"]),
           "stride_overall": table(agg["stride"]["n"], agg["stride"]["wins"]),
           "no_skill": {"up_rate": agg["up_outcomes"] / agg["n"] if agg["n"] else None,
                        "down_rate": agg["down_outcomes"] / agg["n"] if agg["n"] else None,
                        "n": agg["n"]},
           "ties": agg["ties"],
           "by_pair": {p_: {**table(bp["n"], bp["wins"]),
                            "calls": table(bp["calls"], bp["call_wins"]),
                            "puts": table(bp["puts"], bp["put_wins"]),
                            "up_rate": bp["up"] / bp["n"] if bp["n"] else None,
                            "stride": table(agg["stride_by_pair"][p_]["n"],
                                            agg["stride_by_pair"][p_]["wins"])}
                       for p_, bp in agg["by_pair"].items()},
           "verify": {"checks": V["total"], "failures": V["fail"],
                      "cross_checked_vs_raw": checked},
           "test_segment": {"start": funnel["test_start"], "end": funnel["test_end"],
                            "min_ts": np.datetime64(agg["min_ts"], "ms").astype("datetime64[s]").astype(str) + "Z",
                            "max_ts": np.datetime64(agg["max_ts"], "ms").astype("datetime64[s]").astype(str) + "Z"},
           }
    out["gate"] = {
        "breakeven": 0.5556, "payout_assumption": 0.80,
        "pass": bool(out["overall"]["ci_lo"] is not None and
                     out["overall"]["ci_lo"] > 0.5556 and
                     out["overall"]["wr"] > out["no_skill"]["up_rate"] and
                     out["overall"]["wr"] > out["no_skill"]["down_rate"]),
    }
    return out


all_out = {}
ver_tot = ver_fail = 0
for H in HORIZONS:
    o = aggregate_horizon(H)
    all_out[H] = o
    ver_tot += o["verify"]["checks"]; ver_fail += o["verify"]["failures"]
    ov = o["overall"]
    print(f"\nH={H}: n={ov['n']:,} WR={ov['wr']*100:.3f}%  Wilson95 [{ov['ci_lo']*100:.3f}, {ov['ci_hi']*100:.3f}]"
          f"  ties={o['ties']:,}")
    print(f"  calls {o['calls']['wr']*100:.3f}% (n={o['calls']['n']:,}) | puts {o['puts']['wr']*100:.3f}% (n={o['puts']['n']:,})")
    print(f"  no-skill: up {o['no_skill']['up_rate']*100:.3f}% / down {o['no_skill']['down_rate']*100:.3f}%")
    print(f"  stride(non-overlap): {o['stride_overall']['wr']*100:.3f}% (n={o['stride_overall']['n']:,})")
    print(f"  gate: {'PASS' if o['gate']['pass'] else 'FAIL'}")
    for p_, t in o["by_pair"].items():
        print(f"    {p_}: {t['wr']*100:.3f}% [{t['ci_lo']*100:.3f},{t['ci_hi']*100:.3f}] n={t['n']:,}"
              f"  (CALL {t['calls']['wr']*100:.2f}% / PUT {t['puts']['wr']*100:.2f}%)")

print(f"\nVERIFICATION: {ver_tot:,} checks, {ver_fail} failures")
json.dump(all_out, open(f"{RESULTS}/ML_FEASIBILITY_test_aggregate.json", "w"), indent=1)
print("written: results/ML_FEASIBILITY_test_aggregate.json")
if ver_fail:
    raise SystemExit("VERIFICATION FAILURES — do not report")
