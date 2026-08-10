# Edge feature layer — evidence, activation, and refresh plan

**Version:** `edge-v1-2026-08-10`  
**Fixed validation windows:** TRAIN `2026-08-01..06`; HOLDOUT `2026-08-07..09`  
**Source used locally:** Workplace-drive `phase_f_forward_2026-08-09.tar.gz`

## Evidence policy

A calculation can ship as additive instrumentation before it has historical coverage, but it cannot change production admission/confidence until it has a train→holdout table. This distinction is explicit in `EDGE_FEATURE_CONFIG` (`applyGate` / `applyFactor`) and `/health`; there is no hidden fallback or reconstructed indicator.

`python3 scripts/feature_validation.py --data <root-or-tar.gz> --strict` reproduces the table. WR intervals below are Wilson 95% intervals. Coverage is retained ON rows divided by all decided rows in that window.

| Feature | Config key | Status | TRAIN OFF → ON | HOLDOUT OFF → ON | Decision |
|---|---|---:|---|---|---|
| Hour of day (UTC) | `HOUR_OF_DAY` | **ACTIVE** | 42.0% `[40.1,43.9]` n=2666 → 44.1% `[42.0,46.3]` n=2047; 76.8% cov | 48.0% `[44.2,51.9]` n=635 → 49.2% `[44.8,53.6]` n=494; 77.8% cov | Earned; +1.2 pp holdout, CIs overlap |
| RSI × direction | `RSI_DIRECTION` | **INSTRUMENT ONLY** | N/A: 0 fixed-window rows have signal-time RSI | N/A: 0 fixed-window rows have signal-time RSI | Gate implemented/tested, `applyGate:false`; no fake holdout claim |
| Normalised BB state | `VOLATILITY_STATE` | **INSTRUMENT ONLY** | N/A: 0 rows have BB/current-own-median ratio | N/A | Penalty/block implemented/tested, `applyFactor:false` |
| ATR percentile | `ATR_PERCENTILE` | **INSTRUMENT ONLY** | N/A: pre-instrumentation history | N/A | State emitted; behaviour disabled |
| UTC session-range position | `SESSION_RANGE` | **INSTRUMENT ONLY** | N/A: pre-instrumentation history | N/A | Request-local calculation emitted; mean-reversion bonus disabled |
| Recent pair form (last 20) | `RECENT_FORM` | **ACTIVE** | 42.0% `[40.1,43.9]` n=2666 → 43.6% `[41.5,45.7]` n=2203; 82.6% cov | 48.0% `[44.2,51.9]` n=635 → 48.5% `[44.3,52.7]` n=542; 85.4% cov | Earned; +0.5 pp holdout, no double penalty |
| Rolling CALIB refresh | `ADAPTIVE_CALIBRATION` | **ACTIVE** | Same WR/coverage (output labels only) | Same WR/coverage | Existing CALIB remains the one final output mapper; `calibration_validation.py` tests monotonic labels |
| Adaptive pair/session factors | `ADAPTIVE_CALIBRATION.applyPairWeights/applySessionWeights` | **INSTRUMENT ONLY** | 42.0% → 44.0%, 87.2% cov | 48.0% → 47.6%, 89.9% cov | **Not activated**: holdout -0.4 pp (CI overlaps, but no positive edge) |

The reviewer-provided aggregate RSI and absolute-BB slices motivated the implementations. They are not substituted for the mandatory fixed-window tables: the drive archive predates `signalIndicators` (PR #13), and absolute BB width is not the new normalised BB state. Fresh rows now persist every required field so the next honest window can activate or reject them with a config-only change.

## Runtime order and calibration boundary

1. Existing per-TF score/vote pipeline runs.
2. Active input-side factors (hour, recent form) scale **raw** engine confidence before the floor.
3. Provisional gates can be activated only by config after validation.
4. D2, AI, and the final confidence floor retain their existing boundaries.
5. `getCalibratedGradeAndConfidence()` runs once at output time. An adaptive CALIB profile replaces empirical lookup tables; it does not add a second mapper.

The public signal includes additive `edgeContext`. History keeps a bounded version plus extended `signalIndicators`:

- `atrPercentile`, `atrState`
- `bbBandwidthRatio`, `volatilityState`
- existing `rsi`, `atrPct`, `adx`, `bbBandwidth` unchanged

## Weekly self-calibration

The result-check cron calls `refreshAdaptiveCalibration()` idempotently:

- refresh cadence: every **7 days**;
- data window: last **14 days**, never lifetime counters;
- minimum: 100 decided, non-shadow rows globally and 20 per bucket;
- stability: 20-row shrinkage toward window base WR; multipliers clipped to `0.85..1.10`;
- recomputed: structure WR table, raw-confidence WR table, hour weights, pair weights, and session weights;
- KV key: `calibration:adaptive:v1`, 35-day TTL;
- fail-open: stale/invalid/missing profiles use static `CALIB` and configured hour values;
- output trace: calibration version/source and adaptive version are visible in `/api/signal`; profile status is visible in `/health`.

Pair/session factors are computed and published for review but deliberately not consumed until their holdout result improves. Grade/confidence thresholds remain the holdout-validated CALIB mapper; only empirical WR inputs refresh.

## Optional future context — not faked

These are **not implemented as synthetic proxies** because they require new signal-time data sources:

| Context | Required source |
|---|---|
| VWAP distance | Reliable intraday price **and volume** feed; for spot FX, venue/tick-volume provenance must be defined |
| Cross-asset DXY / BTC dominance | Time-aligned DXY market feed and a reputable total-crypto/BTC-market-cap feed |
| Funding / open interest | Perpetual-futures exchange API with symbol mapping, timestamp, funding, and OI history |
| News during trade | Timestamped economic/news provider with currency/asset impact and revision-safe event IDs |

None of entry/exit price, result, or post-expiry movement is used to derive these fields.
