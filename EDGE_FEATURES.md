# Edge Feature Layer v1

**Scope:** standard FOREX/CRYPTO engine. OTC keeps its separate synthetic-price scoring path; it receives the additive ATR/BB instrumentation only.

## Architecture and calibration boundary

The new factors run in `runDeterministicVoteAndFilters()` **before** the existing confidence floor and AI layer. They modify eligibility/raw confidence only. `getCalibratedGradeAndConfidence()` remains the one final output mapping; an accepted weekly snapshot may replace CALIB's empirical `structWR` and `confBucketWR` lookup values, but does not add another probability layer.

`/api/signal` now exposes additive `edgeContext` and `timeContext`. History's `signalIndicators` keeps the original fields and adds:

- `atrPercentile`, `atrState`
- `bbWidthRatio`, `volatilityState`
- `sessionRangePosition`, `sessionRangeState`
- `utcHour`, `dayOfWeek`

## Features and config

All thresholds and multipliers are in `EDGE_FEATURE_CONFIG` (`src/config.js`).

| Feature | Runtime behavior | Config | Validation disposition |
|---|---|---|---|
| UTC hour/day | 24-entry factor map, bounded 0.85–1.10; hour/day emitted | `HOUR` | Enabled; exact holdout is non-harmful with Wilson overlap |
| Session-range position | Today's high/low from 15-minute request candles; direction-aware mean-reversion context | `SESSION_RANGE` | **Observe only** (`enabled:false`) until train+holdout snapshots exist |
| RSI × direction | BUY RSI >55 and SELL RSI <45 are hard blocks; AI cannot rescue | `RSI_DIRECTION` | Enabled from reviewer-provided source slice; explicitly provisional because the archived exact train split predates instrumentation |
| BB volatility | Current bandwidth / median of prior 20; `<0.2` dead block, `0.2–0.8` ×0.90, wide normal | `BB_VOLATILITY` | Enabled from reviewer-provided source slice; explicitly provisional for the same archive limitation |
| ATR percentile | Current ATR rank against prior 20–50; SQUEEZE/NORMAL/EXPANSION | `ATR_PERCENTILE` | **Observe only** (`enabled:false`) until chronological holdout exists |
| Recent pair form | Prior rolling 20 results; WR <35% applies ×0.85 | `RECENT_FORM` | Enabled; positive train and holdout lift |
| Rolling adaptive tables | Last 14 days, latest 3 days held out; recomputes CALIB lookups and hour/pair/session multipliers | `ADAPTIVE` | Enabled only when weekly candidate passes sample, coverage, and Wilson-overlap guard |

The R7.1 structure-free pass receives the same wall clock, adaptive snapshot, raw indicator arrays, and deterministic edge evaluator. Its best timeframe is selected from shadow votes, not production's structure-influenced votes.

## Reproducible train → holdout result

Command:

```bash
python3 scripts/feature_validation.py \
  --data /path/to/phase_f_forward
```

On the Workplace-drive `phase_f_forward_2026-08-09.tar.gz` archive, excluding circuit-breaker counterfactual rows:

- TRAIN 2026-08-01..06: **n=2666, WR 42.0%**
- HOLDOUT 2026-08-07..09: **n=635, WR 48.0%**

| Feature | TRAIN OFF → ON | HOLDOUT OFF → ON | Holdout coverage | Result |
|---|---:|---:|---:|---|
| Hour multiplier | 42.0% (2666) → 41.9% (2558) | 48.0% (635) → 47.6% (599) | 94.3% | Wilson CIs overlap; non-harm criterion met |
| Recent-form gate | 42.0% (2666) → 42.5% (2571) | 48.0% (635) → 48.2% (614) | 96.7% | Holdout lift |
| Adaptive hour/pair/session | 42.0% (2666) → 42.5% (2538) | 48.0% (635) → 47.9% (609) | 95.9% | Wilson CIs overlap; non-harm criterion met |
| Rolling CALIB output | 42.0% → 42.0% | 48.0% → 48.0% | 100% | Direction/coverage invariant |
| RSI direction | unavailable in exact split | unavailable in exact split | 0% | **Flagged provisional**; archive predates `signalIndicators` |
| BB state | unavailable in exact split | unavailable in exact split | 0% | **Flagged provisional**; archive predates ratio/state fields |
| ATR percentile | unavailable in exact split | unavailable in exact split | 0% | Observe only; no score effect shipped |
| Session range | unavailable in exact split | unavailable in exact split | 0% | Observe only; no score effect shipped |

The script prints Wilson 95% intervals and coverage for every ON/OFF row. It deliberately does **not** infer RSI, BB ratio, ATR percentile, or daily range from entry/outcome data. Fresh drive snapshots can be passed to the same script; once the new fields span both chronological windows, the two observe-only switches can earn promotion.

## Weekly refresh mechanism

The `*/2` result-check cron calls `maybeRefreshAdaptiveCalibration()`:

1. One KV freshness read on normal ticks.
2. At most once every 7 days, load standard-engine `sig:*` history.
3. Keep the last 14 days; reserve the latest 3 as holdout.
4. Fit empirical CALIB structure/confidence tables and bounded hour/pair/session factors on the earlier 11 days only, with a 20-observation prior.
5. Simulate the frozen candidate on holdout and store WR, Wilson CI, and coverage.
6. Mark the snapshot `ACTIVE` only with ≥100 train rows, ≥50 holdout rows, ≥20 per fitted bucket, ≥20% coverage, non-harm/lift (or overlapping Wilson CIs), and no statistically separated inversion in holdout grade/confidence ladders. Rejected snapshots are retained for audit, while runtime fails open to static values.
7. Active snapshots expire after 30 days. Runtime never uses stale/rejected data.

KV keys:

- `adaptive:edge-calibration:v1`
- `adaptive:edge-calibration:lock:v1` (10-minute best-effort refresh lock)

## Deliberately not added

No fake proxy is derived for data the Worker does not receive:

| Future feature | Required source |
|---|---|
| VWAP distance | Intraday typical-price candles with trustworthy volume (forex needs a real volume/tick-volume source) |
| DXY / BTC dominance | Synchronized DXY benchmark and BTC-dominance market candles |
| Funding / open interest | Exchange derivatives funding and OI APIs, timestamp-aligned to the signal |
| News during trade | Timestamped economic/news feed with impact, currency, release, and revision fields |

These remain future data integrations, not hidden heuristics.
