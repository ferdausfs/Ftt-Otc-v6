#!/usr/bin/env python3
"""
Edge feature validation (Phase F): fixed chronological train -> holdout tables.

TRAIN   2026-08-01..2026-08-06
HOLDOUT 2026-08-07..2026-08-09

For every feature this prints OFF vs ON win rate, Wilson 95% CI, retained
coverage, and signal-time-field availability.  It never fills missing RSI/BB/
ATR/session-range fields from outcomes or entry/exit prices.  Older drive rows
predate signalIndicators; those features are reported PROVISIONAL rather than
being supported with fabricated evidence.

The ON simulation mirrors the Worker:
  * factors scale raw confidence, then the 72 floor is re-applied;
  * hard gates remove the matching row;
  * recent form uses only outcomes strictly before each signal;
  * adaptive weights are fitted on TRAIN only and frozen for HOLDOUT.

Usage:
  python3 scripts/feature_validation.py --data /path/to/phase_f_forward
  python3 scripts/feature_validation.py --data /path/to/tar.gz
  python3 scripts/feature_validation.py --data ... --json validation.json
  python3 scripts/feature_validation.py --data ... --strict

--strict exits non-zero when an ACTIVE behaviour feature lacks both-window data
or hurts holdout beyond CI overlap.  Instrument-only features are still shown
but do not fail strict mode.
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import math
import os
import sys
import tarfile
import tempfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Optional

TRAIN_START = "2026-08-01"
TRAIN_END = "2026-08-06"
HOLDOUT_START = "2026-08-07"
HOLDOUT_END = "2026-08-09"
CONFIDENCE_FLOOR = 72.0

# src/config.js EDGE_FEATURE_CONFIG (kept explicit so this script is stdlib-only
# and drive-ready; the config parity check below fails loudly on missing hours).
HOUR_MULTIPLIERS = {
    0:1.08, 1:1.10, 2:0.95, 3:1.04, 4:0.86, 5:0.97,
    6:0.92, 7:0.93, 8:1.10, 9:1.10, 10:0.85, 11:0.99,
    12:0.90, 13:1.02, 14:0.89, 15:0.85, 16:0.88, 17:1.10,
    18:1.07, 19:0.85, 20:0.85, 21:1.10, 22:1.10, 23:0.85,
}

FEATURE_STATUS = {
    "hour_of_day": "ACTIVE",
    "rsi_direction": "INSTRUMENT_ONLY",
    "volatility_state": "INSTRUMENT_ONLY",
    "atr_percentile": "INSTRUMENT_ONLY",
    "session_range": "INSTRUMENT_ONLY",
    "recent_form": "ACTIVE",
    # CALIB changes output labels, not trade admission, so ON/OFF WR/coverage is
    # intentionally identical here; calibration_validation.py checks monotonicity.
    "adaptive_calibration": "ACTIVE",
    # These are the adaptive input pair/session dimensions. Config recomputes
    # them but does not yet consume them after the holdout result below.
    "adaptive_pair_session": "INSTRUMENT_ONLY",
}


@dataclass
class Metrics:
    n: int
    wins: int
    wr: Optional[float]
    ci_low: Optional[float]
    ci_high: Optional[float]
    coverage: float
    available: int
    total: int


@dataclass
class FeatureResult:
    feature: str
    status: str
    window: str
    off: Metrics
    on: Metrics
    delta_points: Optional[float]
    availability: float
    note: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=False, help="phase_f_forward root or .tar.gz")
    parser.add_argument("--json", dest="json_path", help="also write machine-readable results")
    parser.add_argument("--strict", action="store_true")
    return parser.parse_args()


def default_roots() -> list[str]:
    return [
        "phase_f_forward", "wd/phase_f_forward", "../wd/phase_f_forward",
        "/tmp/wd/phase_f_forward", "/tmp/phase_f_forward",
        "/tmp/workplace-drive/data/phase_f_forward_2026-08-09.tar.gz",
    ]


def files_under(root: str) -> list[str]:
    patterns = [
        os.path.join(root, "*", "*.json"),
        os.path.join(root, "phase_f_forward", "*", "*.json"),
        os.path.join(root, "phase_f_forward", "phase_f_forward", "*", "*.json"),
        os.path.join(root, "*", "*", "*.json"),
    ]
    files: set[str] = set()
    for pattern in patterns:
        files.update(glob.glob(pattern))
    return sorted(files)


def discover_files(data: Optional[str]) -> tuple[list[str], Optional[tempfile.TemporaryDirectory]]:
    candidates = [data] if data else default_roots()
    temp: Optional[tempfile.TemporaryDirectory] = None
    for candidate in candidates:
        if not candidate or not os.path.exists(candidate):
            continue
        if tarfile.is_tarfile(candidate):
            temp = tempfile.TemporaryDirectory(prefix="feature-validation-")
            with tarfile.open(candidate, "r:gz") as archive:
                root = os.path.realpath(temp.name)
                for member in archive.getmembers():
                    destination = os.path.realpath(os.path.join(root, member.name))
                    if destination != root and not destination.startswith(root + os.sep):
                        raise ValueError("unsafe tar member: " + member.name)
                archive.extractall(temp.name)
            files = files_under(temp.name)
        else:
            files = files_under(candidate)
        if files:
            files = [f for f in files if os.path.basename(f) not in {
                "health.json", "pairs.json", "manifest.json",
            }]
            return files, temp
    return [], temp


def load_rows(files: Iterable[str]) -> list[dict]:
    seen: dict[str, dict] = {}
    for file_name in files:
        try:
            with open(file_name, encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, ValueError, TypeError):
            continue
        for row in payload.get("signals") or []:
            row_id = row.get("id")
            if row_id:
                seen[row_id] = row
    return sorted(
        [r for r in seen.values() if r.get("result") in ("WIN", "LOSS") and not r.get("cbShadow")],
        key=lambda r: r.get("timestamp") or "",
    )


def date_of(row: dict) -> str:
    return str(row.get("timestamp") or "")[:10]


def confidence(row: dict) -> float:
    # New rows persist the exact post-filter raw confidence. Legacy pre-CALIB
    # rows reported that value directly in `confidence`; coreConfidence is only
    # a last-resort pre-filter proxy.
    for key in ("calibrationRawConfidence", "confidence", "coreConfidence"):
        value = row.get(key)
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value.rstrip("%"))
            except ValueError:
                pass
    return CONFIDENCE_FLOOR


def number(value) -> Optional[float]:
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    if isinstance(value, str):
        try:
            parsed = float(value.rstrip("%"))
            return parsed if math.isfinite(parsed) else None
        except ValueError:
            return None
    return None


def indicator(row: dict, key: str) -> Optional[float]:
    values = row.get("signalIndicators") or {}
    return number(values.get(key))


def edge_value(row: dict, key: str):
    return (row.get("edgeContext") or {}).get(key)


def wilson(wins: int, n: int, z: float = 1.96) -> tuple[Optional[float], Optional[float]]:
    if n == 0:
        return None, None
    p = wins / n
    denominator = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denominator
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    return max(0.0, centre - margin), min(1.0, centre + margin)


def metrics(rows: list[dict], total: int, available: int) -> Metrics:
    wins_count = sum(r.get("result") == "WIN" for r in rows)
    low, high = wilson(wins_count, len(rows))
    return Metrics(
        n=len(rows), wins=wins_count,
        wr=wins_count / len(rows) if rows else None,
        ci_low=low, ci_high=high,
        coverage=len(rows) / total if total else 0.0,
        available=available, total=total,
    )


def evaluate(
    feature: str,
    window: str,
    rows: list[dict],
    availability_fn: Callable[[dict], bool],
    keep_fn: Callable[[dict], bool],
    note: str,
) -> FeatureResult:
    eligible = [r for r in rows if availability_fn(r)]
    selected = [r for r in eligible if keep_fn(r)]
    off = metrics(eligible, len(rows), len(eligible))
    on = metrics(selected, len(rows), len(eligible))
    delta = None if off.wr is None or on.wr is None else (on.wr - off.wr) * 100
    return FeatureResult(
        feature=feature, status=FEATURE_STATUS[feature], window=window,
        off=off, on=on, delta_points=delta,
        availability=len(eligible) / len(rows) if rows else 0.0,
        note=note,
    )


def hour_keep(row: dict) -> bool:
    try:
        hour = int(str(row.get("timestamp"))[11:13])
    except (TypeError, ValueError):
        return False
    return confidence(row) * HOUR_MULTIPLIERS[hour] >= CONFIDENCE_FLOOR


def rsi_available(row: dict) -> bool:
    return indicator(row, "rsi") is not None


def rsi_keep(row: dict) -> bool:
    rsi = indicator(row, "rsi")
    direction = row.get("direction")
    return not ((direction == "BUY" and rsi is not None and rsi > 55)
                or (direction == "SELL" and rsi is not None and rsi < 45))


def vol_available(row: dict) -> bool:
    ratio = indicator(row, "bbBandwidthRatio")
    state = edge_value(row, "volatilityState") or (row.get("signalIndicators") or {}).get("volatilityState")
    return ratio is not None or state in ("DEAD_SQUEEZE", "MID_SQUEEZE", "WIDE")


def volatility_keep(row: dict) -> bool:
    ratio = indicator(row, "bbBandwidthRatio")
    state = edge_value(row, "volatilityState") or (row.get("signalIndicators") or {}).get("volatilityState")
    if state == "DEAD_SQUEEZE" or (ratio is not None and ratio < 0.20):
        return False
    if state == "MID_SQUEEZE" or (ratio is not None and ratio < 0.80):
        return confidence(row) * 0.90 >= CONFIDENCE_FLOOR
    return True


def atr_available(row: dict) -> bool:
    return indicator(row, "atrPercentile") is not None


def atr_keep(row: dict) -> bool:
    percentile = indicator(row, "atrPercentile")
    if percentile is None:
        return False
    if percentile <= 0.10:
        return False
    if percentile <= 0.25:
        return confidence(row) * 0.90 >= CONFIDENCE_FLOOR
    return True


def range_available(row: dict) -> bool:
    return number(edge_value(row, "sessionRangePosition")) is not None


def range_keep(row: dict) -> bool:
    # Bonus-only feature never removes a historically emitted row. This table
    # still establishes field availability/WR at compatible extremes; activation
    # requires a full engine replay to measure rescued-signal coverage.
    return True


def attach_recent_form(rows: list[dict]) -> None:
    histories: dict[str, collections.deque[str]] = collections.defaultdict(lambda: collections.deque(maxlen=20))
    for row in sorted(rows, key=lambda r: r.get("timestamp") or ""):
        history = histories[row.get("pair") or "UNKNOWN"]
        row["__recent_n"] = len(history)
        row["__recent_wr"] = (sum(v == "WIN" for v in history) / len(history)) if history else None
        history.append(row.get("result"))


def recent_available(row: dict) -> bool:
    return row.get("__recent_n", 0) >= 20


def recent_keep(row: dict) -> bool:
    win_rate = row.get("__recent_wr")
    if win_rate is not None and win_rate < 0.35:
        return confidence(row) * 0.85 >= CONFIDENCE_FLOOR
    return True


def train_adaptive_weights(train: list[dict]) -> tuple[dict[str, float], dict[str, float]]:
    base = sum(r["result"] == "WIN" for r in train) / len(train) if train else 0.5

    def derive(key_fn: Callable[[dict], str]) -> dict[str, float]:
        groups: dict[str, list[dict]] = collections.defaultdict(list)
        for row in train:
            groups[key_fn(row)].append(row)
        output = {}
        for key, values in groups.items():
            if len(values) < 20:
                continue
            rate = (sum(v["result"] == "WIN" for v in values) + 20 * base) / (len(values) + 20)
            output[key] = max(0.85, min(1.10, rate / base)) if base else 1.0
        return output

    pairs = derive(lambda r: r.get("pair") or "UNKNOWN")
    sessions = derive(lambda r: str((r.get("session") or ["UNKNOWN"])[0]))
    return pairs, sessions


def adaptive_keep(row: dict, pair_weights: dict[str, float], session_weights: dict[str, float]) -> bool:
    session = str((row.get("session") or ["UNKNOWN"])[0])
    factor = pair_weights.get(row.get("pair") or "UNKNOWN", 1.0) * session_weights.get(session, 1.0)
    return confidence(row) * factor >= CONFIDENCE_FLOOR


def fmt_pct(value: Optional[float]) -> str:
    return "N/A" if value is None else f"{value * 100:.1f}%"


def print_result(result: FeatureResult) -> None:
    print(
        f"{result.feature:24s} {result.status:15s} {result.window:7s} | "
        f"OFF n={result.off.n:4d} WR={fmt_pct(result.off.wr):>6s} "
        f"CI[{fmt_pct(result.off.ci_low)},{fmt_pct(result.off.ci_high)}] | "
        f"ON n={result.on.n:4d} WR={fmt_pct(result.on.wr):>6s} "
        f"CI[{fmt_pct(result.on.ci_low)},{fmt_pct(result.on.ci_high)}] | "
        f"delta={'N/A' if result.delta_points is None else f'{result.delta_points:+.1f}pp':>7s} "
        f"coverage={result.on.coverage * 100:5.1f}% avail={result.availability * 100:5.1f}%"
    )
    if result.note:
        print(f"  note: {result.note}")


def intervals_overlap(a: Metrics, b: Metrics) -> bool:
    if None in (a.ci_low, a.ci_high, b.ci_low, b.ci_high):
        return False
    return max(a.ci_low, b.ci_low) <= min(a.ci_high, b.ci_high)


def main() -> int:
    args = parse_args()
    if set(HOUR_MULTIPLIERS) != set(range(24)):
        print("ERROR: hour map must contain exactly 0..23", file=sys.stderr)
        return 2
    files, temp = discover_files(args.data)
    if not files:
        print("No Phase F JSON files found. Pass --data ROOT_OR_TAR_GZ.", file=sys.stderr)
        return 2
    rows = load_rows(files)
    # Seed rolling recent form with any pre-TRAIN history present in the drive,
    # exactly as worker `/api/stats` would be seeded on 08-01. Outcomes after
    # HOLDOUT_END are harmless because each row only sees strictly prior rows.
    attach_recent_form(rows)
    fixed = [r for r in rows if TRAIN_START <= date_of(r) <= HOLDOUT_END]
    train = [r for r in fixed if TRAIN_START <= date_of(r) <= TRAIN_END]
    holdout = [r for r in fixed if HOLDOUT_START <= date_of(r) <= HOLDOUT_END]
    print(f"files={len(files)} decided_fixed={len(fixed)} train={len(train)} holdout={len(holdout)}")
    print("Wilson=95%; coverage is retained rows / all decided rows in that window.\n")
    if not train or not holdout:
        print("ERROR: both fixed windows require decided rows", file=sys.stderr)
        return 2

    pair_weights, session_weights = train_adaptive_weights(train)
    specs = [
        ("hour_of_day", lambda r: len(str(r.get("timestamp") or "")) >= 13, hour_keep,
         "UTC map fitted on TRAIN only; factor then 72-floor."),
        ("rsi_direction", rsi_available, rsi_keep,
         "Requires signalIndicators.rsi; missing legacy rows are never imputed."),
        ("volatility_state", vol_available, volatility_keep,
         "Requires normalised BB ratio/state, not legacy absolute bandwidth proxy."),
        ("atr_percentile", atr_available, atr_keep,
         "Counterfactual only; config applyFactor=false pending both-window history."),
        ("session_range", range_available, range_keep,
         "Bonus-only and config applyFactor=false; full replay needed to measure rescued signals."),
        ("recent_form", recent_available, recent_keep,
         "Rolling pair history contains only outcomes strictly before signal time."),
        ("adaptive_calibration", lambda _r: True, lambda _r: True,
         "Output-label refresh changes no trade admission; run calibration_validation.py for grade/conf monotonicity."),
        ("adaptive_pair_session", lambda _r: True,
         lambda r: adaptive_keep(r, pair_weights, session_weights),
         "Weights fitted on TRAIN and frozen; config recomputes but does not consume these dimensions."),
    ]

    results: list[FeatureResult] = []
    for feature, available, keep, note in specs:
        for window, subset in (("TRAIN", train), ("HOLDOUT", holdout)):
            result = evaluate(feature, window, subset, available, keep, note)
            results.append(result)
            print_result(result)
        print()

    if args.json_path:
        path = Path(args.json_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps([asdict(r) for r in results], indent=2), encoding="utf-8")
        print(f"wrote {path}")

    failures = []
    for feature, status in FEATURE_STATUS.items():
        if status != "ACTIVE":
            continue
        train_result = next(r for r in results if r.feature == feature and r.window == "TRAIN")
        holdout_result = next(r for r in results if r.feature == feature and r.window == "HOLDOUT")
        if train_result.off.n == 0 or holdout_result.off.n == 0:
            failures.append(f"{feature}: no both-window signal-time data")
            continue
        # Requirement: improve, or at least not hurt with Wilson overlap.
        if (holdout_result.delta_points or 0) < 0 and not intervals_overlap(holdout_result.off, holdout_result.on):
            failures.append(f"{feature}: holdout degradation outside CI overlap")

    print("STRICT STATUS:")
    if failures:
        for failure in failures:
            print("  FLAGGED " + failure)
        if args.strict:
            return 1
    else:
        print("  PASS — every active feature has both-window data and no non-overlap harm")
    print("  Instrument-only features are deliberately excluded from activation claims.")
    if temp:
        temp.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
