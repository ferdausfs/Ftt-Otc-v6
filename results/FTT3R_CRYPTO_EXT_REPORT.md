# FTT3-R Crypto Validation on Extended, Never-Touched History — 2026-09-05

## Scope and data provenance

- **Window (frozen before the run):** evaluation span 2025-07-05T00:00:00Z .. 2026-07-05T00:00:00Z — a full 12-month crypto block that **predates every candle this project had ever fetched** (earliest prior data: 2026-07-05T00:00Z). Nobody involved in this project had seen, computed a statistic from, or motivated a hypothesis on any candle in this window.
- **Data:** bybit spot (BTCUSDT …), USDT quote, timeframes 1m/5m/15m for BTC/USD, ETH/USD, XRP/USD, SOL/USD. 12 files, **each 100% of expected candle count with 0 missing candles and 0 misaligned opens** (Bybit page-level pagination, dedup+sort, sanity checks in `backtest/fetch_data_ext.mjs`; no interpolation, no synthesis anywhere).
- **Warmup discipline:** candles from 2025-06-21 are fetched solely as indicator warmup (EMA50(15m), MACD(5m), ADX(14), ATR100(1m) need history before the first evaluable boundary); **no decision is evaluated before 2025-07-05T00:00Z**.
- **Burned-window discipline:** the fetch ends exactly at 2026-07-05T00:00Z — the 2026-07-05..09-05 window that produced the FTT3 verdict is **not fetched, not touched, not cross-referenced anywhere in this analysis**. The handful of tail boundaries whose expiry candle would open at/after that instant resolve `EXPIRY_GAP` and are excluded from stats (visible in the audit).
- **Single block by design:** FTT3-R's parameters were frozen in the pre-registration commit (ADX 25/20 textbook thresholds; Strategy A = FTT3 C1/C2/C3 unchanged; Strategy B = BB(20, 2σ population) + RSI(14) 70/30 + adjacency + snap-back; D3 = C3 math; expiry ladder 75/25 → 5/7/10m). There is **no tuning step here**, so there is no in-sample/OOS split — the whole window is reported as one block, per the pre-registered plan.

- **Engine:** regime-first dispatch on every 5m boundary — ADX(14) on the last closed 15m candle: `>=25 TRENDING → Strategy A`, `<20 RANGING → Strategy B`, `20..25 TRANSITION → NO_TRADE` (deliberate anti-flip-flop band, identical for every pair).
- **Outcome conventions:** TIE (exit == entry) excluded from the headline W/(W+L) and reported separately; conservative W/(W+L+T) also shown; missing exit candle → `EXPIRY_GAP`, excluded. Payout assumption 0.8 → breakeven 55.5556% WR. Minimum bucket 30 decided signals per rate; smaller buckets are flagged INSUFFICIENT, never presented as a finding.

## Headline result

- Evaluated boundary decisions: **420,480** (105,120 per pair × 4 pairs)
- Decided signals: **4,992** (ties 41, expiry gaps 0) — every reported bucket clears the n≥30 floor
- **Overall win rate: 48.0%** — Wilson 95% CI [46.6%, 49.4%] — conservative W/(W+L+T) 47.6%
- Weighted no-skill baseline WR (random direction, same rows/expiries): **49.45%** → edge **-1.4 pp**
- **GATE vs breakeven 55.56% (Wilson-LO > breakeven): FAIL** — the Wilson lower bound sits ~9.0 pp BELOW breakeven; the entire CI is under breakeven.

**This is a clear negative result, reported as found.** No parameter may be adjusted in response (frozen-parameter rule). A weak result here is the finding — exactly the scenario the pre-registration anticipated.

## Rates by strategy path

| Bucket | W | L | T (sep.) | Decided n | WR | Wilson 95% CI | Conservative W/(W+L+T) | n>=30 |
|---|---|---|---|---|---|---|---|---|
| Strategy TREND (A — trend-following C1-C3) | 1444 | 1656 | 24 | 3100 | 46.6% | [44.8%, 48.3%] | 46.2% | yes |
| Strategy MEANREV (B — mean-reversion D1-D3) | 952 | 940 | 17 | 1892 | 50.3% | [48.1%, 52.6%] | 49.9% | yes |

Strategy A (trend-following, TRENDING regime) and Strategy B (mean-reversion, RANGING regime) are **both below breakeven**; B outperforms A by ~3.7 pp but its Wilson-LO (48.1%) is still ~7.4 pp short of breakeven. The regime split did not rescue the engine — it reallocated losses.

## Rates by pair

| Bucket | W | L | T (sep.) | Decided n | WR | Wilson 95% CI | Conservative W/(W+L+T) | n>=30 |
|---|---|---|---|---|---|---|---|---|
| BTC/USD | 581 | 640 | 0 | 1221 | 47.6% | [44.8%, 50.4%] | 47.6% | yes |
| ETH/USD | 616 | 656 | 1 | 1272 | 48.4% | [45.7%, 51.2%] | 48.4% | yes |
| XRP/USD | 596 | 640 | 16 | 1236 | 48.2% | [45.4%, 51.0%] | 47.6% | yes |
| SOL/USD | 603 | 660 | 24 | 1263 | 47.7% | [45.0%, 50.5%] | 46.9% | yes |

Remarkably uniform: every pair's CI overlaps every other's, and all four sit below breakeven with the lower bound in the 45–48% band. The FTT3 OOS pattern of extreme per-pair divergence (41.8% vs 64.8%) does **not** reappear here — on never-touched data the four crypto pairs behave alike.

## Pair × strategy

| Bucket | W | L | T (sep.) | Decided n | WR | Wilson 95% CI | Conservative W/(W+L+T) | n>=30 |
|---|---|---|---|---|---|---|---|---|
| BTC/USD · TREND | 336 | 395 | 0 | 731 | 46.0% | [42.4%, 49.6%] | 46.0% | yes |
| BTC/USD · MEANREV | 245 | 245 | 0 | 490 | 50.0% | [45.6%, 54.4%] | 50.0% | yes |
| ETH/USD · TREND | 378 | 426 | 1 | 804 | 47.0% | [43.6%, 50.5%] | 47.0% | yes |
| ETH/USD · MEANREV | 238 | 230 | 0 | 468 | 50.9% | [46.3%, 55.4%] | 50.9% | yes |
| XRP/USD · TREND | 354 | 404 | 8 | 758 | 46.7% | [43.2%, 50.3%] | 46.2% | yes |
| XRP/USD · MEANREV | 242 | 236 | 8 | 478 | 50.6% | [46.2%, 55.1%] | 49.8% | yes |
| SOL/USD · TREND | 376 | 431 | 15 | 807 | 46.6% | [43.2%, 50.0%] | 45.7% | yes |
| SOL/USD · MEANREV | 227 | 229 | 9 | 456 | 49.8% | [45.2%, 54.4%] | 48.8% | yes |

No cell reaches breakeven; the closest (ETH·MEANREV, 50.9%) still has its upper CI bound under 55.5%. With 16 cells all consistent with sub-breakeven behavior, there is no pocket of evidence to justify a cherry-picked 'deploy B on ETH' story — and pair-specific parameterization is forbidden by the pre-registration anyway.

## Rates by regime, expiry tier, and direction

| Bucket | W | L | T (sep.) | Decided n | WR | Wilson 95% CI | Conservative W/(W+L+T) | n>=30 |
|---|---|---|---|---|---|---|---|---|
| TRENDING | 1444 | 1656 | 24 | 3100 | 46.6% | [44.8%, 48.3%] | 46.2% | yes |
| RANGING | 952 | 940 | 17 | 1892 | 50.3% | [48.1%, 52.6%] | 49.9% | yes |

| Bucket | W | L | T (sep.) | Decided n | WR | Wilson 95% CI | Conservative W/(W+L+T) | n>=30 |
|---|---|---|---|---|---|---|---|---|
| Expiry 5m | 1651 | 1835 | 26 | 3486 | 47.4% | [45.7%, 49.0%] | 47.0% | yes |
| Expiry 7m | 745 | 761 | 15 | 1506 | 49.5% | [46.9%, 52.0%] | 49.0% | yes |

**No 10m-tier row appears — and that is structural, not missing data.** The expiry ladder assigns 10m only when the ATR percentile is below 25, but the shared C3/D3 entry gate requires the current ATR to be at or above its own trailing median (percentile ≥ ~50). Under the frozen rules the 10m rung is therefore unreachable — true for FTT3 as deployed and unchanged here (no parameter may be touched in this analysis). Worth revisiting only if the gate/ladder ever gets redesigned in a future pre-registration.

| Bucket | W | L | T (sep.) | Decided n | WR | Wilson 95% CI | Conservative W/(W+L+T) | n>=30 |
|---|---|---|---|---|---|---|---|---|
| CALL | 1172 | 1214 | 20 | 2386 | 49.1% | [47.1%, 51.1%] | 48.7% | yes |
| PUT | 1224 | 1382 | 21 | 2606 | 47.0% | [45.1%, 48.9%] | 46.6% | yes |

## No-skill baseline (plain up-rate over the same expiry windows)

| Expiry window | Boundary rows with exit | Up | Down | Tie | Up-rate | Down-rate |
|---|---|---|---|---|---|---|
| 5m | 420480 | 207521 | 207954 | 5005 | 49.35% | 49.46% |
| 7m | 420476 | 207051 | 209402 | 4023 | 49.24% | 49.80% |
| 10m | 420476 | 207854 | 209252 | 3370 | 49.43% | 49.77% |

Baseline markers (`dir5/dir7/dir10`) are recorded on **every** evaluated boundary row in the audit JSONL, so these rates re-derive from the JSONL directly. The 5m-window up-rate (49.35%) is the honest yardstick: a coin-flip direction bet on the same rows would land near it, while FTT3-R lands below both it and breakeven.

## Decision funnel (every evaluated boundary)

| Blocking reason | Rows | Share of evaluated |
|---|---|---|
| `C2_NO_CROSS` | 179914 | 42.79% |
| `D1_NO_EXTENSION` | 123873 | 29.46% |
| `REGIME_TRANSITION` | 84654 | 20.13% |
| `D2_NO_EXHAUSTION` | 12739 | 3.03% |
| `C2_WRONG_DIRECTION` | 7878 | 1.87% |
| `C3_LOW_VOLATILITY` | 3715 | 0.88% |
| `C1_C2_C3_ALL_PASS` | 3124 | 0.74% |
| `D2_NO_SNAPBACK` | 2538 | 0.60% |
| `D1_D2_D3_ALL_PASS` | 1909 | 0.45% |
| `D3_LOW_VOLATILITY` | 136 | 0.03% |

REGIME_TRANSITION rows are the deliberate no-trade band (20 ≤ ADX < 25); C2_NO_CROSS dominates the TRENDING path (most 5m closes simply don't cross); D1_NO_EXTENSION dominates the RANGING path (most 5m closes stay inside the bands). No hidden filters exist beyond these frozen conditions.

## Sample-size statement

With 4,992 decided W/L signals (+41 ties = 5,033 total), every pair/regime/tier bucket has n ≥ 1,206 and every pair×strategy cell ≥ 456 — all far above the 30-signal floor, so **no bucket in this report is INSUFFICIENT**. The opposite caveat of the live status reports applies: these CIs are tight, and they say the engine is below breakeven with high confidence on this window.

## What this does and does not license

- **Does:** increase confidence in the *negative* direction — FTT3-R, with frozen textbook parameters, does not clear the breakeven gate on 12 months of unseen crypto history, in any pair, in either strategy path, at any expiry tier.
- **Does not:** license a merge to `main`, a live deployment, or any parameter adjustment. Per the pre-registered process, results feed the merge decision only together with fresh live-window evidence; the live FTT3 collector on `main` remains untouched and continues accumulating post-2026-09-05 data.
- **Still true:** this is crypto-only, historical (not production), and a single block rather than a true walk-forward. It is one more honest data point about the strategy family, not a validation seal.

## Reproducibility

- Audit: `results/FTT3R_CRYPTO_EXT_audit.jsonl.gz` (every one of the 420,480 evaluated boundary decisions with regime/strategy tags, full condition values, entry/exit, result, and dir5/dir7/dir10 baseline markers; decompress with `gunzip -k results/FTT3R_CRYPTO_EXT_audit.jsonl.gz`).
- Every number above is re-aggregated from that JSONL by `python3 scripts/build_crypto_ext_report.py`, which also cross-checks the harness summary (`results/FTT3R_CRYPTO_EXT_summary.json`) and refuses to write the report on any mismatch.
- Harness: `node backtest/harness_crypto_ext.mjs` (deterministic; ~3.7 min for all four pairs). Fetcher: `node backtest/fetch_data_ext.mjs`.
- Integrity check at build time: **PASS** (7 comparisons vs harness summary).
