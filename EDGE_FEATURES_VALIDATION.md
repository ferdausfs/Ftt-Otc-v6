## feature_validation — R1 train→holdout tables

Data: TRAIN < 2026-08-07 · HOLDOUT >= 2026-08-07 · thresholds from src/config.js (R4)

### Baseline

| window | WR | n |
|---|---|---|
| TRAIN 08-01..06 |  41.8% (n=4462) CI[40.3-43.2] | 4462 |
| HOLDOUT 08-07..09 |  48.0% (n= 635) CI[44.2-51.9] | 635 |

### A1 — hour-of-day gate (config bad hours [10, 15, 16, 19, 20, 23], ×0.85)

| window | OFF (all) | ON (skip bad hours) | excluded | Δ pts |
|---|---|---|---|---|
| TRAIN |  41.8% (n=4462) CI[40.3-43.2] |  44.3% (n=3443) CI[42.7-46.0] |  33.1% (n=1019) CI[30.3-36.0] | +2.6 |
| HOLDOUT |  48.0% (n= 635) CI[44.2-51.9] |  49.5% (n= 537) CI[45.3-53.8] |  39.8% (n=  98) CI[30.7-49.7] | +1.5 |

Hour multipliers (TRAIN-derived, clamped 0.85-1.10): bad [10, 15, 16, 19, 20, 23] · good [1, 7, 9, 17, 18, 21, 22]

Per-hour WR (TRAIN):

| hour | WR | n | mult |
|---|---|---|---|
| 00 |  43.3% (n= 210) CI[36.8-50.1] | 210 | x1.04 |
| 01 |  48.7% (n= 226) CI[42.2-55.2] | 226 | x1.10 |
| 02 |  43.3% (n= 217) CI[36.9-50.0] | 217 | x1.04 |
| 03 |  40.1% (n= 192) CI[33.4-47.2] | 192 | x0.96 |
| 04 |  40.2% (n= 184) CI[33.4-47.4] | 184 | x0.96 |
| 05 |  38.5% (n= 169) CI[31.5-46.0] | 169 | x0.92 |
| 06 |  42.2% (n= 211) CI[35.7-48.9] | 211 | x1.00 |
| 07 |  43.9% (n= 221) CI[37.5-50.5] | 221 | x1.05 |
| 08 |  43.5% (n= 237) CI[37.3-49.8] | 237 | x1.04 |
| 09 |  57.7% (n= 227) CI[51.2-64.0] | 227 | x1.10 |
| 10 |  28.6% (n= 182) CI[22.5-35.5] | 182 | x0.85 |
| 11 |  42.7% (n= 192) CI[35.9-49.8] | 192 | x1.00 |
| 12 |  39.8% (n= 176) CI[32.8-47.1] | 176 | x0.95 |
| 13 |  41.3% (n= 196) CI[34.7-48.3] | 196 | x1.00 |
| 14 |  41.2% (n= 194) CI[34.5-48.3] | 194 | x1.00 |
| 15 |  33.2% (n= 220) CI[27.3-39.6] | 220 | x0.85 |
| 16 |  29.6% (n= 199) CI[23.7-36.3] | 199 | x0.85 |
| 17 |  49.2% (n= 187) CI[42.1-56.3] | 187 | x1.10 |
| 18 |  43.6% (n= 165) CI[36.3-51.3] | 165 | x1.05 |
| 19 |  35.9% (n= 131) CI[28.2-44.4] | 131 | x0.85 |
| 20 |  37.3% (n= 150) CI[30.0-45.3] | 150 | x0.89 |
| 21 |  54.6% (n= 108) CI[45.2-63.7] | 108 | x1.10 |
| 22 |  45.0% (n= 131) CI[36.8-53.6] | 131 | x1.08 |
| 23 |  36.5% (n= 137) CI[28.9-44.8] | 137 | x0.87 |

Per-hour WR (HOLDOUT, n>=10):

| hour | WR | n |
|---|---|---|
| 00 |  47.3% (n=  55) CI[34.7-60.2] | 55 |
| 01 |  61.4% (n=  57) CI[48.4-72.9] | 57 |
| 02 |  45.5% (n=  55) CI[33.0-58.5] | 55 |
| 03 |  64.3% (n=  56) CI[51.2-75.5] | 56 |
| 04 |  48.9% (n=  45) CI[35.0-63.0] | 45 |
| 05 |  38.5% (n=  26) CI[22.4-57.5] | 26 |
| 06 |  26.1% (n=  23) CI[12.5-46.5] | 23 |
| 07 |  46.4% (n=  28) CI[29.5-64.2] | 28 |
| 08 |  61.9% (n=  21) CI[40.9-79.2] | 21 |
| 09 |  66.7% (n=  30) CI[48.8-80.8] | 30 |
| 10 |  38.9% (n=  18) CI[20.3-61.4] | 18 |
| 11 |  62.5% (n=  16) CI[38.6-81.5] | 16 |
| 12 |  52.9% (n=  17) CI[31.0-73.8] | 17 |
| 14 |  30.8% (n=  13) CI[12.7-57.6] | 13 |
| 16 |  47.1% (n=  17) CI[26.2-69.0] | 17 |
| 17 |  52.2% (n=  23) CI[33.0-70.8] | 23 |
| 18 |  27.8% (n=  18) CI[12.5-50.9] | 18 |
| 19 |  57.9% (n=  19) CI[36.3-76.9] | 19 |
| 20 |  23.1% (n=  13) CI[ 8.2-50.3] | 13 |
| 21 |  27.3% (n=  22) CI[13.2-48.2] | 22 |
| 22 |  37.5% (n=  24) CI[21.2-57.3] | 24 |
| 23 |  36.4% (n=  22) CI[19.7-57.0] | 22 |

### C8 — recent-form gate (pair prior-20 rolling WR < 0.35, n>=10)

| window | OFF (all) | ON (recent WR >= threshold) | excluded | Δ pts |
|---|---|---|---|---|
| TRAIN |  41.8% (n=4462) CI[40.3-43.2] |  43.9% (n=3390) CI[42.2-45.6] |  35.0% (n=1072) CI[32.2-37.9] | +2.1 |
| HOLDOUT |  48.0% (n= 635) CI[44.2-51.9] |  48.6% (n= 564) CI[44.5-52.7] |  43.7% (n=  71) CI[32.7-55.2] | +0.6 |

### Combined — hour gate + recent-form gate (available data)

| window | OFF (all) | ON (hour OK AND recent WR >= threshold) | excluded | Δ pts |
|---|---|---|---|---|
| TRAIN |  41.8% (n=4462) CI[40.3-43.2] |  46.4% (n=2651) CI[44.5-48.3] |  35.0% (n=1811) CI[32.8-37.2] | +4.6 |
| HOLDOUT |  48.0% (n= 635) CI[44.2-51.9] |  49.5% (n= 483) CI[45.0-53.9] |  43.4% (n= 152) CI[35.8-51.4] | +1.5 |

### B4/B5/B6 — indicator-gated features (instrumented rows only)

Instrumented coverage: TRAIN=0 HOLDOUT=0 (signalIndicators rows; drive snapshots before the 2026-08-09 deploy carry none)

**PENDING — no instrumented rows in the data.** The worker has been persisting signalIndicators since the 2026-08-09 deploy (~50-80 rows/day); re-run this script on the next drive snapshot. The engine gates are shipped config-first with reviewer slice evidence (BUY+RSI>55 = 32.3%, BB 0.2-0.8 = 35-36%, n=66) and are re-evaluated by this script as data accumulates (self-calibration refreshes them weekly).

### A2 — session-range position

**PENDING — needs signal-time candle snapshots (today high/low), which the drive does not archive.** The engine computes it per-request from candleData and exposes it via edgeFeatures.sessionRange + signalIndicators .sessionRange (shipped with this PR); snapshotting candles daily would unlock this table.

### D9 — future features (documented, NOT shipped)

| feature | needed data source | status |
|---|---|---|
| VWAP distance | TwelveData has no VWAP series; needs tick/1min volume-weighted feed | future |
| Cross-asset (DXY, BTC dominance) | new feed (e.g. FRED / CoinGecko) + per-request fetch | future |
| Funding / open interest | exchange API per asset (Binance/Bybit futures) | future |
| News-during-trade | event calendar feed + text pipeline | future |

