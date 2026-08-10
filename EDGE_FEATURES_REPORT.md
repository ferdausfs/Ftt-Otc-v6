# EDGE FEATURES — Phase F Round 2 (missing edge: time context, indicator gates, volatility state, adaptive self-calibration)

**Date:** 2026-08-10 · **Branch:** `arena/019fea9d-ftt-otc-v6` · **Base:** `main` `d696c6b`

Everything here is input-side (score multipliers/gates) feeding the **same calibrated output layer** (`calibration.js` stays the final grade/confidence mapping — R3). Every threshold lives in `src/config.js` `EDGE_FEATURES` / `SELF_CALIB` (R4). Raw signal-time indicators continue to be captured in `signalIndicators` (R5, additive).

---

## 1. Feature table — evidence, ON/OFF holdout numbers, config key

Reproduced by `scripts/feature_validation.py` (re-runnable on fresh drive data; thresholds read from `src/config.js` via node). Full tables: `EDGE_FEATURES_VALIDATION.md`.

| # | Feature | Evidence (TRAIN 08-01..06) | HOLDOUT 08-07..09 (ON vs OFF) | Config key | Status |
|---|---|---|---|---|---|
| A1 | **Hour-of-day WR multiplier** | bad hours {10,15,16,19,20,23} WR 33.1% (n=1019) vs 44.3% rest (n=3443) | **49.5% vs 48.0% (+1.5)**; excluded 39.8% (n=98) — direction consistent, no reversal | `EDGE_FEATURES.HOUR_MULTIPLIERS` (24 values, clamped 0.85–1.10, quantized ±0.02) | ✅ shipped |
| A2 | **Session-range position** | no signal-time candle archive — engine computes it per request, exposes `edgeFeatures.sessionRange` + `signalIndicators.sessionRange` | PENDING (needs daily candle snapshots) | `EDGE_FEATURES.SESSION_RANGE` (extreme ≤0.15/≥0.85 → ×1.05) | ⚠️ shipped, flagged PENDING |
| B4 | **RSI × direction gate** | reviewer instrumented evidence: BUY+RSI>55 = 32.3% (chasing) | PENDING (no instrumented rows in the 08-09 drive snapshot; ~50-80 rows/day accumulating since the 08-09 deploy) | `EDGE_FEATURES.RSI_DIRECTION_GATE` (BUY rsi>55 / SELL rsi<45, mode=penalty ×0.85) | ⚠️ shipped config-first, flagged PENDING |
| B5 | **Volatility state (BB bandwidth)** | reviewer instrumented: BB>0.8 = 54.3% vs BB 0.2-0.8 = 35-36% (n=66, provisional) | PENDING (same as B4) | `EDGE_FEATURES.VOL_STATE` (dead ≤0.20 crypto / ≤0.04 forex → block; mid ≤0.80/0.08 → ×0.90) | ⚠️ shipped config-first, flagged PENDING |
| B6 | **ATR percentile** | squeeze/expansion state from ATR's own 50-bar history | PENDING (atrPercentile ships with this PR; history rows will carry it) | `EDGE_FEATURES.ATR_PERCENTILE` (window 50, squeeze <30 → ×0.95, expansion >80 → ×1.05) | ⚠️ shipped, flagged PENDING |
| C7 | **Weekly self-calibration** | mechanism ships with initial values = static CALIB + config maps | N/A (data-refresh mechanism) | `SELF_CALIB` (cron `0 0 * * 1`, window 14d, MIN_OBS 100, MIN_HOUR_OBS 20, MAX_AGE 8d) | ✅ shipped |
| C8 | **Recent-form gate** | pair prior-20 rolling WR <35%: 35.0% (n=1072) vs 44.4% (n=3242) — non-overlapping CIs | **48.6% vs 48.0% (+0.6)**; excluded 43.7% (n=71) — direction consistent | `EDGE_FEATURES.RECENT_FORM` (minSample 10, badWr 0.35, ×0.85) | ✅ shipped |

**Combined (available data):** hour gate + recent-form gate together — TRAIN **46.4% vs 41.8% (+4.6)**, HOLDOUT **49.5% vs 48.0% (+1.5)** (excluded 43.4%, n=152). The indicator features will join the combined row as instrumented data accumulates.

## 2. Honesty notes (evidence that did NOT survive)

1. **The reviewer's "bad hours 0-3,10,15,16" list is REJECTED by the drive data.** On TRAIN 01:00 is the **best** hour (48.7%, n=226) and the reviewer list **reverses on HOLDOUT** (bad 52.1% vs good 45.1%). The shipped map is train-derived and holds out-of-sample (+1.5 pts). The reviewer's per-hour numbers (23:00=71%, 01:00=21%, n=28/14) are not reproducible from the drive snapshot — documented in the script output.
2. **SELL+RSI<45 = 47.4% (reviewer's own slice) is ABOVE the pool WR** — gating it is provisional. Both sides are shipped symmetric per spec (`mode=penalty`), and the weekly self-calibration refresh will relax/strengthen each side from forward instrumented data.
3. **Mid-BB evidence is n=66** — CI is wide. `VOL_STATE` is shipped as penalty (×0.90), not block, for the mid band; only the dead-squeeze is a hard block. The block thresholds reuse the engine's own BB-dead references.
4. No fake/derived versions of unmeasurable features (D9 — see §5).

## 3. R2 suite matrix (all green on the feature branch)

| Suite | Result |
|---|---|
| `fix_tests` (incl. new T35–T42) | **266P / 0F** (was 192) |
| `phase10_integration` | 19 / 0 |
| `phase7_integration` | 36 / 0 |
| `d2_tests` | 39 / 0 |
| `probe_tests` | 34 / 0 |
| `entry_hit_tests` | 7 / 0 |
| `fx_mode_tests` | 20 / 0 |
| `phase10_smoke` | 61 / 0 |
| `phase7_smoke` | 68 / 0 |
| `r71_tests` | **117P / 0F** |
| `calibration_validation.py` | R1 PASSED (grade/confidence monotonic on holdout — calibration intact) |
| `feature_validation.py` | R1 tables reproduced from drive data |

**r71 baseline refresh (justified divergence update):** the edge features are the next approved engine release, so `BASELINE_COMMIT` moved `e56cd33 → ec6ed65` via the F3-20 mechanism documented in `r71_tests.mjs` (the same mechanism used when F3-20 moved 71e87eb → e56cd33). `#14` (OTC structure-cap contract) pins `edgeFeatures:false` + a fixed clock so it keeps guarding its own contract; edge features are guarded by T35-T42 and the #1/#17 byte-equality fuzz.

**Test-determinism work (F3-16 pattern):** the hour factor is wall-clock-derived, so existing suites that assert pre-feature behavior pass `edgeFeatures:false` (+ pinned `now`/session where the OTC time-context minute window or session mattered — this also fixed a latent real-clock flake in `getOTCTimeContext` that made T8 fail at UTC minutes ≤2/≥57).

## 4. Self-calibration mechanism + refresh plan (C7)

- **Mechanism:** `src/history/selfCalib.js` — `recomputeCalibration(env)` reads the last `SELF_CALIB.WINDOW_DAYS` (14) of decided history from `sig:*` KV, recomputes `base / structWR / confBucketWR / hourWR / pairWR / sessionWR`, writes `calib:latest` (TTL window+2d). `loadCalibration(env)` returns it only when fresh (≤ `MAX_AGE_DAYS` 8) and valid.
- **Engine consumption:** per signal — the calibrated output layer uses `structWR/confBucketWR` (cells < `MIN_CELL_OBS` fall back to static CALIB), and the hour multiplier uses `hourWR` when a cell has ≥ `MIN_HOUR_OBS` (20) rows, else the static map.
- **Refresh cadence:** weekly, Monday 00:00 UTC cron (`0 0 * * 1` in `wrangler.toml`; `index.js` routes it to `recomputeCalibration`), or on demand via the same function. Guards: < `MIN_OBS` (100) decided rows → previous tables kept (no write); stale tables ignored by the engine.
- **Initial values:** the static `CALIB` block + `EDGE_FEATURES.HOUR_MULTIPLIERS` (both TRAIN 08-01..06 derived) are the fallback and the first generation. Grade/confidence thresholds stay quantile-derived; re-derive them via `calibration_validation.py` when monotonicity breaks (documented refresh plan).
- **pairWR/sessionWR** are computed and surfaced on `/api/calib` for the weekly review; the live recent-form gate reads the rolling-20 stats directly (no double counting), and `SESSION_PAIR_WEIGHTS` stay static until a review applies the sessionWR tables.

## 5. Deliberately NOT added (future data sources — D9)

| Feature | Needed data source | Status |
|---|---|---|
| VWAP distance | tick/1min volume-weighted feed (TwelveData has no VWAP series) | future |
| Cross-asset (DXY, BTC dominance) | new feed (FRED / CoinGecko) + per-request fetch | future |
| Funding / open interest | exchange API per asset (Binance/Bybit futures) | future |
| News-during-trade | event calendar feed + text pipeline | future |

No fake or derived stand-ins were shipped for these (Phase F discipline).

## 6. /api/signal live-check fields (after merge+deploy)

- `edgeFeatures` on every emitted signal: `{ hourUtc, hourMult, sessionRange, sessionRangeMult, rsi, rsiGate, bbBandwidth, bbState, volMult, atrPercentile, atrMult, recentFormWr, recentFormMult, totalMult, blockedBy }`
- `filtersApplied` gains `HOUR_FACTOR x0.85 (UTC 10)`, `RSI_DIRECTION_GATE_PENALTY x0.85 (BUY rsi=61.7 > 55)`, `VOL_STATE_DEAD_SQUEEZE_BLOCK (bb=0.1 <= 0.2)`, `VOL_STATE_MID_SQUEEZE x0.90 (bb=0.59 <= 0.8)`, `ATR_PERCENTILE_SQUEEZE x0.95 (pct=2)`, `SESSION_RANGE_EXTREME x1.05 (pos=0.91)`, `RECENT_FORM_PENALTY x0.85 (wr=0.3, n=20)`, `BELOW_FLOOR_AFTER_EDGE_FEATURES (72%)`
- `signalIndicators` (history rows) extended additively: `atrPercentile, bbState, sessionRange, hourUtc, hourMult, totalMult` (existing `rsi/atrPct/adx/bbBandwidth` unchanged)
- `/api/calib` shows the active static + dynamic tables and the refresh config.
