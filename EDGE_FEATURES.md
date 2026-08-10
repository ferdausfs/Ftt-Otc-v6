# Phase F edge inputs

## Shipped input-side features

| Feature | Config | Behavior |
|---|---|---|
| UTC hour context | `CONFIG.EDGE_FEATURES.hourMultipliers` | bounded raw-confidence multiplier |
| RSI × direction | `rsiBuyBlockAbove`, `rsiSellBlockBelow` | blocks chasing BUY / oversold SELL |
| BB state | `bb*` | dead squeeze blocks; mid squeeze penalizes raw confidence |
| ATR percentile | `atr*` | low-volatility state penalizes raw confidence |
| session-range position | `sessionRange*` | small mean-reversion extreme bonus when same-day candles are available |
| recent form | `recentForm*` | 20-result pair window below 35% WR gets a 0.85 multiplier |

All changes happen **before** `getCalibratedGradeAndConfidence`; CALIB remains the sole output grade/confidence mapper. `edgeFeatures` is returned in `/api/signal`, and additive values are persisted in `signalIndicators`.

## Rolling refresh

The result-checker invokes `refreshRollingCalibration` with a due guard (168 hours). It uses only resolved rows from the prior 14 days and stores a bounded snapshot at `calibration:rolling:v1`: base/structure/confidence-bucket WR tables and hour multipliers. Hour multipliers and empirical base/structure/confidence-bucket lookup tables are consumed live; grade/confidence **thresholds** are intentionally not silently refit. A refresh requires 20 resolved rows per aggregate/slice. This is deliberately conservative against tiny-slice drift.

## Validation

Run `python3 scripts/feature_validation.py --input history.json`. It reports fixed-window TRAIN (2026-08-01..06) and HOLDOUT (2026-08-07..09), coverage, WR and Wilson intervals, ON vs OFF for every feature. Do not promote a changed threshold unless holdout improves or has overlapping CI without harm.

No supplied checkout dataset contains the requested dated resolved drive export, so this repository does not fabricate ON/OFF numbers. The script is the reproducible evidence path for the reviewer’s drive data.

## Deliberately not implemented

VWAP distance requires intraday volume suitable for VWAP; cross-asset context requires DXY and BTC-dominance feeds; funding/OI requires a derivatives venue API; news-during-trade requires a timestamped news feed. None is approximated from current candles.
