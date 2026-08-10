#!/usr/bin/env python3
"""Chronological validation for the v1 edge-feature layer.

Exact discipline:
  TRAIN   2026-08-01..2026-08-06 (thresholds/tables are selected here)
  HOLDOUT 2026-08-07..2026-08-09 (never used to select a threshold)

Each row reports feature OFF vs ON, WR, Wilson 95% CI, and coverage. New fields
that did not exist in the historical snapshot are reported as FLAGGED_NO_DATA;
they are never fabricated from entry prices or later candles.

Usage:
  python3 scripts/feature_validation.py --data /path/to/phase_f_forward
  python3 scripts/feature_validation.py --data /path --json report.json

The data root may contain date directories directly or a nested
phase_f_forward/ directory, as in the Workplace-drive- archive.
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sys
from collections import defaultdict
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Callable, Iterable, Optional

TRAIN_START = "2026-08-01"
TRAIN_END = "2026-08-06"
HOLDOUT_START = "2026-08-07"
HOLDOUT_END = "2026-08-09"
CONFIDENCE_FLOOR = 72.0

# Synchronized with src/config.js EDGE_FEATURE_CONFIG.HOUR.multipliers.
HOUR_MULTIPLIERS = {
    0:.85, 1:.85, 2:.85, 3:.85, 4:1.00, 5:1.00,
    6:1.00, 7:1.00, 8:1.05, 9:1.10, 10:.85, 11:1.05,
    12:1.00, 13:1.00, 14:1.00, 15:.85, 16:.85, 17:1.10,
    18:1.05, 19:1.00, 20:1.00, 21:1.10, 22:1.10, 23:1.10,
}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", help="Phase-F data root")
    parser.add_argument("--json", dest="json_path", help="also write machine-readable report")
    return parser.parse_args()


def discover_files(root: Optional[str]) -> list[str]:
    roots = [root] if root else []
    roots += [
        "phase_f_forward", "wd/phase_f_forward", "../wd/phase_f_forward",
        "/tmp/wd/phase_f_forward", "/tmp/phasef/phase_f_forward",
    ]
    patterns = [
        "*/*.json", "phase_f_forward/*/*.json",
        "phase_f_forward/phase_f_forward/*/*.json", "*/*/*.json",
    ]
    found = set()
    for candidate in roots:
        if not candidate:
            continue
        for pattern in patterns:
            found.update(glob.glob(os.path.join(candidate, pattern)))
    ignored = {"health.json", "pairs.json"}
    return sorted(path for path in found if os.path.basename(path) not in ignored)


def load_rows(files: Iterable[str]) -> list[dict]:
    by_id: dict[str, dict] = {}
    for path in files:
        try:
            with open(path, encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, ValueError):
            continue
        for row in payload.get("signals") or []:
            if row.get("id"):
                by_id[row["id"]] = row
    rows = [row for row in by_id.values()
            if row.get("result") in ("WIN", "LOSS") and row.get("cbShadow") is not True]
    return sorted(rows, key=lambda row: row.get("timestamp") or "")


def date_of(row: dict) -> str:
    return (row.get("timestamp") or "")[:10]


def raw_confidence(row: dict) -> Optional[float]:
    for key in ("coreConfidence", "confidence"):
        value = row.get(key)
        if isinstance(value, (int, float)) and math.isfinite(value):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value.rstrip("%"))
            except ValueError:
                pass
    return None


def indicator(row: dict, key: str):
    values = row.get("signalIndicators")
    return values.get(key) if isinstance(values, dict) else None


def number(value) -> Optional[float]:
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    if isinstance(value, str):
        try:
            parsed = float(value)
            return parsed if math.isfinite(parsed) else None
        except ValueError:
            return None
    return None


def wins(rows: list[dict]) -> int:
    return sum(row.get("result") == "WIN" for row in rows)


def win_rate(rows: list[dict]) -> Optional[float]:
    return wins(rows) / len(rows) if rows else None


def wilson_ci(rows: list[dict], z: float = 1.96) -> tuple[Optional[float], Optional[float]]:
    n = len(rows)
    if not n:
        return None, None
    p = wins(rows) / n
    denominator = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denominator
    delta = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    return max(0.0, center - delta), min(1.0, center + delta)


@dataclass
class Side:
    n: int
    wr: Optional[float]
    ci_low: Optional[float]
    ci_high: Optional[float]
    coverage: float


@dataclass
class Result:
    feature: str
    split: str
    off: Side
    on: Side
    status: str
    note: str


def side(rows: list[dict], split_total: int) -> Side:
    low, high = wilson_ci(rows)
    return Side(len(rows), win_rate(rows), low, high,
                len(rows) / split_total if split_total else 0.0)


def compare(feature: str, split: str, off: list[dict], on: list[dict], split_total: int,
            note: str = "", observe_only: bool = False) -> Result:
    off_side, on_side = side(off, split_total), side(on, split_total)
    if not off:
        status = "FLAGGED_NO_DATA"
    elif observe_only:
        status = "OBSERVE_ONLY_CI_IDENTICAL"
    elif not on:
        status = "FLAGGED_ZERO_COVERAGE"
    elif on_side.wr >= off_side.wr:
        status = "PASS_LIFT"
    else:
        overlap = off_side.ci_low <= on_side.ci_high and on_side.ci_low <= off_side.ci_high
        status = "PASS_CI_OVERLAP" if overlap else "FAIL_HURT"
    return Result(feature, split, off_side, on_side, status, note)


def with_recent_form(all_rows: list[dict]) -> None:
    history: dict[str, list[str]] = defaultdict(list)
    for row in all_rows:
        prior = history[row.get("pair") or "UNKNOWN"]
        row["_recent_form"] = (sum(value == "WIN" for value in prior) / len(prior)) if len(prior) >= 20 else None
        prior.append(row["result"])
        del prior[:-20]


def apply_hour(row: dict) -> bool:
    stamp = row.get("timestamp") or ""
    confidence = raw_confidence(row)
    try:
        hour = int(stamp[11:13])
    except (TypeError, ValueError):
        return False
    return confidence is not None and confidence * HOUR_MULTIPLIERS[hour] >= CONFIDENCE_FLOOR


def apply_rsi(row: dict) -> bool:
    rsi = number(indicator(row, "rsi"))
    if rsi is None:
        return False
    return not ((row.get("direction") == "BUY" and rsi > 55)
                or (row.get("direction") == "SELL" and rsi < 45))


def apply_volatility(row: dict) -> bool:
    state = indicator(row, "volatilityState")
    ratio = number(indicator(row, "bbWidthRatio"))
    if state is None and ratio is not None:
        state = "DEAD_SQUEEZE" if ratio < .20 else "MID_SQUEEZE" if ratio < .80 else "WIDE_NORMAL"
    confidence = raw_confidence(row)
    if state == "DEAD_SQUEEZE":
        return False
    if state == "MID_SQUEEZE":
        return confidence is not None and confidence * .90 >= CONFIDENCE_FLOOR
    return state in ("WIDE_NORMAL", "UNKNOWN") and confidence is not None


def derive_multiplier_table(train: list[dict], key: Callable[[dict], str],
                            minimum_n: int = 20) -> dict[str, float]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in train:
        groups[str(key(row))].append(row)
    base = win_rate(train) or .5
    table = {}
    for group, values in groups.items():
        if len(values) < minimum_n:
            continue
        smoothed = (wins(values) + 20 * base) / (len(values) + 20)
        table[group] = max(.85, min(1.10, smoothed / base))
    return table


def session_name(row: dict) -> str:
    sessions = row.get("session") or []
    names = set(sessions)
    if "LONDON" in names and "NEW_YORK" in names:
        return "LONDON_NY"
    if "ASIAN" in names and "LONDON" in names:
        return "ASIAN_LONDON"
    return sessions[0] if sessions else "UNKNOWN"


def hour_key(row: dict) -> str:
    return str(int((row.get("timestamp") or "")[11:13]))


def adaptive_gate(row: dict, hours: dict[str, float], pairs: dict[str, float],
                  sessions: dict[str, float]) -> bool:
    confidence = raw_confidence(row)
    if confidence is None:
        return False
    factor = hours.get(hour_key(row), 1.0)
    adaptive = pairs.get(str(row.get("pair")), 1.0) * sessions.get(session_name(row), 1.0)
    factor *= max(.85, min(1.10, adaptive))
    return confidence * factor >= CONFIDENCE_FLOOR


def feature_rows(split_rows: list[dict], feature: str) -> tuple[list[dict], list[dict], str, bool]:
    if feature == "hour_multiplier":
        off = [row for row in split_rows if raw_confidence(row) is not None and len(row.get("timestamp") or "") >= 13]
        return off, [row for row in off if apply_hour(row)], "UTC, bounded 0.85..1.10", False
    if feature == "rsi_direction_gate":
        off = [row for row in split_rows if number(indicator(row, "rsi")) is not None]
        return off, [row for row in off if apply_rsi(row)], "BUY RSI>55 / SELL RSI<45 removed", False
    if feature == "bb_volatility_state":
        off = [row for row in split_rows if indicator(row, "volatilityState") is not None
               or number(indicator(row, "bbWidthRatio")) is not None]
        return off, [row for row in off if apply_volatility(row)], "dead block; mid x0.90", False
    if feature == "atr_percentile_state":
        off = [row for row in split_rows if number(indicator(row, "atrPercentile")) is not None]
        return off, list(off), "classification/instrumentation; score effect disabled", True
    if feature == "session_range_position":
        off = [row for row in split_rows if number(indicator(row, "sessionRangePosition")) is not None]
        return off, list(off), "calculation/instrumentation; score effect disabled", True
    if feature == "recent_form_gate":
        off = [row for row in split_rows if row.get("_recent_form") is not None and raw_confidence(row) is not None]
        on = [row for row in off if not (row["_recent_form"] < .35
              and raw_confidence(row) * .85 < CONFIDENCE_FLOOR)]
        return off, on, "rolling prior 20; WR<35% x0.85", False
    if feature == "time_context":
        return list(split_rows), list(split_rows), "hour/day fields only; no independent gate", True
    if feature == "rolling_calib_output":
        return list(split_rows), list(split_rows), "output labels only; direction/coverage unchanged", True
    raise KeyError(feature)


def fmt_pct(value: Optional[float]) -> str:
    return "N/A" if value is None else f"{value * 100:.1f}%"


def fmt_ci(item: Side) -> str:
    return "N/A" if item.ci_low is None else f"[{item.ci_low*100:.1f}, {item.ci_high*100:.1f}]"


def main() -> int:
    args = parse_args()
    files = discover_files(args.data)
    if not files:
        print("No Phase-F JSON files found. Pass --data /path/to/phase_f_forward", file=sys.stderr)
        return 1
    all_rows = load_rows(files)
    with_recent_form(all_rows)
    train = [row for row in all_rows if TRAIN_START <= date_of(row) <= TRAIN_END]
    holdout = [row for row in all_rows if HOLDOUT_START <= date_of(row) <= HOLDOUT_END]
    if not train or not holdout:
        print(f"Exact split unavailable: train={len(train)}, holdout={len(holdout)}", file=sys.stderr)
        return 1

    results: list[Result] = []
    features = [
        "time_context", "hour_multiplier", "session_range_position",
        "rsi_direction_gate", "bb_volatility_state", "atr_percentile_state",
        "recent_form_gate", "rolling_calib_output",
    ]
    for feature in features:
        for name, rows in (("TRAIN", train), ("HOLDOUT", holdout)):
            off, on, note, observe = feature_rows(rows, feature)
            results.append(compare(feature, name, off, on, len(rows), note, observe))

    # Adaptive weights are fit on TRAIN only, then frozen for HOLDOUT.
    hour_table = derive_multiplier_table(train, hour_key)
    pair_table = derive_multiplier_table(train, lambda row: str(row.get("pair")))
    session_table = derive_multiplier_table(train, session_name)
    for name, rows in (("TRAIN", train), ("HOLDOUT", holdout)):
        off = [row for row in rows if raw_confidence(row) is not None]
        on = [row for row in off if adaptive_gate(row, hour_table, pair_table, session_table)]
        results.append(compare("adaptive_hour_pair_session", name, off, on, len(rows),
                               "tables fit on TRAIN; HOLDOUT frozen"))

    print(f"files={len(files)} decided={len(all_rows)}")
    print(f"TRAIN {TRAIN_START}..{TRAIN_END}: n={len(train)} WR={fmt_pct(win_rate(train))}")
    print(f"HOLDOUT {HOLDOUT_START}..{HOLDOUT_END}: n={len(holdout)} WR={fmt_pct(win_rate(holdout))}")
    print("\n| Feature | Split | OFF n/WR (Wilson 95%) | ON n/WR (Wilson 95%) | ON coverage | Status |")
    print("|---|---:|---:|---:|---:|---|")
    for result in results:
        print(f"| {result.feature} | {result.split} | {result.off.n} / {fmt_pct(result.off.wr)} {fmt_ci(result.off)} "
              f"| {result.on.n} / {fmt_pct(result.on.wr)} {fmt_ci(result.on)} "
              f"| {result.on.coverage*100:.1f}% | {result.status} |")

    print("\nFlags are intentional: the 08-01..06 archive predates signalIndicators. "
          "No RSI/BB/ATR/session-range values are backfilled or inferred from outcome data.")
    print("Optional future inputs not modeled: VWAP needs intraday volume/typical-price candles; "
          "DXY/BTC dominance needs synchronized benchmark candles; funding/OI needs exchange APIs; "
          "news-during-trade needs a timestamped economic-news feed.")

    if args.json_path:
        payload = {
            "windows": {"train": [TRAIN_START, TRAIN_END], "holdout": [HOLDOUT_START, HOLDOUT_END]},
            "samples": {"train": len(train), "holdout": len(holdout)},
            "results": [asdict(result) for result in results],
            "adaptiveTables": {"hour": hour_table, "pair": pair_table, "session": session_table},
        }
        with open(args.json_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
