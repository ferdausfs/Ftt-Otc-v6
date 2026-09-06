#!/usr/bin/env python3
"""Task 24 (ML feasibility) — SPLIT FREEZE.

Computes the three-way chronological split boundaries from pure calendar/grid
arithmetic on the frozen window (T0=2021-11-01T00:00Z, T1=2026-09-05T00:00Z).
NO price data is read here — nothing about Test's content is known or used;
only its duration determines the boundary timestamps (unavoidable and
declared). Output: experiments/ml/split_dates.json (committed BEFORE any
feature/model code is written; never re-drawn afterwards).

AMENDMENT (pre-results, committed before ANY model ran): the initial fold
layout gave fold 1 an empty training set (its val block began at T0 — an
expanding walk-forward fold cannot train on nothing). Corrected to the
standard walk-forward shape: initial train block = first 40% of
Train+Validation, then 5 contiguous validation blocks of 12% each. The
70/15/15 segment boundaries and every other frozen element are UNCHANGED.
No result-driven bias was possible: zero models had been fit when amended.
"""
import json
from datetime import datetime, timedelta, UTC

T0 = datetime(2021, 11, 1, tzinfo=UTC)
T1 = datetime(2026, 9, 5, tzinfo=UTC)
N_MIN = int((T1 - T0).total_seconds() // 60)          # decision-minute grid size
TRAIN_FRAC, VAL_FRAC = 0.70, 0.15                      # test gets the remaining 0.15
PURGE_MIN = 60                                         # fold purge (>= 6x longest label window 10m)
K_FOLDS = 5

def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")

train_end = T0 + timedelta(minutes=int(N_MIN * TRAIN_FRAC))
val_end = T0 + timedelta(minutes=int(N_MIN * (TRAIN_FRAC + VAL_FRAC)))

# walk-forward: initial train = first 40% of Train+Val, then 5 contiguous
# validation blocks over the remaining 60% (expanding window, purged cuts)
tv_minutes = int((val_end - T0).total_seconds() // 60)
init_train_min = int(tv_minutes * 0.40)
rest = tv_minutes - init_train_min
block = rest // K_FOLDS
fold_bounds = []
cursor = init_train_min
for i in range(1, K_FOLDS + 1):
    vs = T0 + timedelta(minutes=cursor)
    blk = rest - block * (K_FOLDS - 1) if i == K_FOLDS else block
    ve = T0 + timedelta(minutes=cursor + blk)
    fold_bounds.append({"fold": i, "val_start": iso(vs), "val_end": iso(ve)})
    cursor += blk

out = {
    "task": "Task 24 — ML feasibility (gradient-boosted trees), frozen split",
    "grid": "1m candle-open minutes; decision at each candle close",
    "T0": iso(T0), "T1": iso(T1),
    "minutes_total": N_MIN,
    "days_total": round(N_MIN / 1440, 3),
    "train": {"start": iso(T0), "end": iso(train_end), "minutes": int((train_end - T0).total_seconds() // 60), "frac": TRAIN_FRAC},
    "validation": {"start": iso(train_end), "end": iso(val_end),
                   "minutes": int((val_end - train_end).total_seconds() // 60), "frac": VAL_FRAC},
    "test": {"start": iso(val_end), "end": iso(T1),
             "minutes": int((T1 - val_end).total_seconds() // 60), "frac": round(1 - TRAIN_FRAC - VAL_FRAC, 4)},
    "purge_minutes_between_folds": PURGE_MIN,
    "walk_forward_shape": "initial train = first 40% of Train+Val; 5 contiguous val blocks of 12% (expanding, purged cuts)",
    "walk_forward_initial_train_minutes": init_train_min,
    "amendment_note": "pre-results correction (before any model ran): original layout left fold 1 with no training data; 70/15/15 segments unchanged",
    "label_windows_minutes": [5, 7, 10],
    "walk_forward_folds_within_trainval": fold_bounds,
    "pairs": ["BTC/USD", "ETH/USD", "XRP/USD", "SOL/USD"],
    "source": {"candles": "Bybit spot v5 klines 1m+15m (USDT quote, project-wide proxy)",
               "funding": "Bybit v5 funding/history category=linear (perp funding, market-state feature)"},
    "label_convention": "label_H = 1 if close[t+H] > close[t]; 0 if <; 2 (tie) excluded from training and WR, counted in funnel; entry/exit at fixed-time candle closes, same convention as every prior test in this project",
    "payout_assumption": {"payout": 0.80, "breakeven_wr": 0.5556, "note": "identical to all prior project reports"},
    "gate": "PASS iff some horizon H has Wilson95_lower_bound(WR_H) > 55.56% AND WR_H > up-rate_H AND WR_H > down-rate_H (no-skill both directions); per-pair buckets < 30 decided -> INSUFFICIENT",
    "frozen_before": "any feature or model code (this file is the freeze artifact)",
    "committed_at_commit": "see git log for this file's commit — it MUST precede feature-builder commits",
}

path = "/home/z/my-project/Ftt-Otc-v6/experiments/ml/split_dates.json"
with open(path, "w") as f:
    json.dump(out, f, indent=1)
print(json.dumps(out, indent=1))
print(f"\nwritten: {path}")
