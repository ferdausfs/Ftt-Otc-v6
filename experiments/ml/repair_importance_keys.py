#!/usr/bin/env python3
"""One-off repair: remap LightGBM's auto 'Column_i' importance keys to the
frozen feature names in completed cv_runs/grid run JSONs. The stored dicts
have 41 zero-valued name keys + 41 Column_i gain keys; this merges them
(pure rename + sum; values untouched). Idempotent."""
import glob
import json
import re

NAMES = json.load(open("backtest/data/ml_features/BTCUSDT.meta.json"))["featureNames"]
n = 0
for f in glob.glob("experiments/ml/cv_runs/*.json"):
    if f.endswith(".state.json"):
        continue
    d = json.load(open(f))
    old = d.get("importances")
    if not old or not any(str(k).startswith("Column_") for k in old):
        continue
    out = {}
    for k, v in old.items():
        m = re.fullmatch(r"Column_(\d+)", str(k))
        key = NAMES[int(m.group(1))] if m else str(k)
        out[key] = out.get(key, 0.0) + float(v)
    for k in NAMES:
        out.setdefault(k, 0.0)
    d["importances"] = {k: out[k] for k in NAMES}
    json.dump(d, open(f, "w"))
    n += 1
print(f"repaired {n} run files")
