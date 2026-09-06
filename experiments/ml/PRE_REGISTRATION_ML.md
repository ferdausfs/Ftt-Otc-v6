# PRE-REGISTRATION — Task 24: ML Feasibility (Gradient-Boosted Trees)

**Status:** frozen BEFORE any feature or model code exists. `split_dates.json`
(the machine-readable freeze artifact) and this document are committed first;
every later commit must obey them. If reality later makes an item impossible
(e.g. a data hole), the deviation is DOCUMENTED in the report — never silently
re-designed.

## 1. Question and scope

Feasibility phase only: *is there any learnable signal at all* in this market
for a gradient-boosted-tree classifier over engineered features, judged by the
same standard as the three prior TA tests (FTT3 50.5%, FTT3-R 48.0%, EMA
ribbon 49.0% — all at/below no-skill, all far under the 55.56% breakeven).
This is NOT a production model attempt. Higher overfitting risk than TA is
assumed, so validation discipline is at least as strict: split frozen before
feature work, Test touched exactly once, every number reproducible from a raw
prediction log. No deployment wiring in this phase (Cloudflare Workers cannot
run a GBM runtime; distillation is explicitly out of scope here).

## 2. Data (fetched before feature code existed; raw files never committed)

| | |
|---|---|
| Source | Bybit spot v5 klines 1m + 15m, USDT quote (same proxy as every prior crypto fetch here) + Bybit linear-perp funding history |
| Pairs | BTC/USD, ETH/USD, XRP/USD, SOL/USD (BTCUSDT/ETHUSDT/XRPUSDT/SOLUSDT) |
| Span fetched | 2021-10-25T00:00Z → 2026-09-05T00:15Z (warmup 7d + window + 15m tail) |
| Actual depth | spot 1m exists from 2021-07-05 (BTC/ETH), 2021-07-20 (XRP), 2021-10-21 (SOL) — the longest Bybit serves for these pairs |
| Funding | all 4 pairs, 2021-09-25 → 2026-09-05 (5,419 records/pair; SOL 5,779 — cadence varied, features are as-of so any cadence works) |
| Integrity (audited) | 1m: 2,557,456 unique candles/pair, 0 missing on the full grid, maxGap = grid step. 15m: complete except ONE server-side hole (2022-02-01T02:30Z → 2022-02-05T06:45Z, all 4 pairs — confirmed server-side by direct API probes; nothing is interpolated) |
| Hole policy | decision minutes with no closed 15m context are EXCLUDED from all splits (not invented), counted in the funnel (~401 minutes/pair), and the exclusion is stated in the report |

## 3. Split (from split_dates.json — grid arithmetic only, no price content)

```
T0 2021-11-01T00:00Z   T1 2026-09-05T00:00Z   (1m grid: 2,547,360 minutes)
Train      2021-11-01T00:00Z → 2025-03-23T07:12Z   70.0%
Validation 2025-03-23T07:12Z → 2025-12-13T15:36Z   15.0%   (iterate freely here)
Test       2025-12-13T15:36Z → 2026-09-05T00:00Z   15.0%   (touched exactly ONCE)
```

Note (declared): the Test segment necessarily overlaps the windows the three
prior TA tests ran on (they burned 2025-07-05 onward; Test additionally
contains 2025-12-13 → 2026-09-05 that no project test has touched). The spec
prescribes "most recent ~15%", so this is accepted — no ML decision of any
kind was ever made on those windows, and nothing learned from the TA tests'
aggregate WRs can shape these features (the menu below was fixed by the task
spec, not by results). The split boundary itself was computed from the grid
count only.

Walk-forward folds (purged, expanding) inside Train+Validation only:

| fold | validation block |
|---|---|
| 1 | 2021-11-01T00:00Z → 2022-08-28T17:31Z |
| 2 | 2022-08-28T17:31Z → 2023-06-25T11:02Z |
| 3 | 2023-06-25T11:02Z → 2024-04-21T04:33Z |
| 4 | 2024-04-21T04:33Z → 2025-02-15T22:04Z |
| 5 | 2025-02-15T22:04Z → 2025-12-13T15:36Z |

Purge: **60 minutes** around every fold boundary (≥ 6× the longest label
window of 10m — prevents overlap leakage from forward-return labels).
Train side of fold k = [T0, block_start − 60m); validate on the block.

## 4. Decision grid and labels (frozen)

- One decision row per 1m candle-open t in [T0, T1) per pair, evaluated at
  the candle's close (identical convention to every prior engine here).
- All features use only candles with open ≤ t (1m) and the last CLOSED 15m
  candle (open T with T + 15m ≤ t + 1m), plus funding events with timestamp ≤ t.
- label_H for H ∈ {5, 7, 10}: `1` if close[t+H] > close[t]; `0` if <; `2`
  (exact tie) excluded from training and WR, counted in the funnel.
- No lookahead anywhere; this is proven by mutation tests (§7), not assumed.

## 5. Feature menu (frozen — the model gets a menu, importance decides)

All normalized (no raw price levels — non-stationary, declared exclusion).
Indicators reuse the repo's `indicators.mjs` math conventions exactly (EMA
seeded by SMA, Wilder ATR; RSI/BB implemented in the same causal style):

- **1m returns (6):** simple close-to-close returns over 1, 5, 15, 60, 240, 1440 minutes
- **1m realized vol (3):** std of 1m returns over trailing 15/60/240
- **1m indicators (10):** ATR(14)/close; RSI(14); MACD(12,26,9) line/signal/hist each /close
- **1m Bollinger (2):** BB(20,2σ) width (up−lo)/mid and %B position
- **1m EMA distances (5):** (EMA5−c)/c, (EMA13−c)/c, (EMA55−c)/c, (EMA5−EMA13)/c, (EMA13−EMA55)/c
- **1m volume (1):** z-score of volume over trailing 1440
- **15m block (13):** RSI(14); MACD hist/close; ATR(14)/close; BB width, %B;
  the five EMA distances/spreads as above; 1-bar and 4-bar returns; volume
  z-score over trailing 96 bars — all on the last closed 15m candle
- **Funding (3):** latest funding rate; rate-of-change vs previous event;
  fractional hours since last event
- **Calendar (2):** UTC hour (0–23), UTC day-of-week (0–6) — categorical
- **Pair (1):** pair id 0–3 (pooled model; per-pair reported separately)

Total: **41 features**. Funding is the genuine crypto-specific input TA
indicators never see.

## 6. Model, tuning, evaluation protocol (frozen)

- LightGBM 4.5.0, binary objective, one model per horizon (5/7/10m), pooled
  across pairs; seed 42, deterministic mode.
- HP grid (SMALL, declared now): learning_rate ∈ {0.05, 0.10} ×
  num_leaves ∈ {63, 127}; min_data_in_leaf 500; feature_fraction 0.8;
  bagging 0.8/1 (freq 1); early stopping on fold AUC (patience 200, max 2000
  rounds). Grid runs on the 10m horizon across all 5 folds; the best config
  by mean fold AUC is frozen for ALL horizons.
- Feature pruning: at most ONE declared pass — features with ~zero gain
  importance in every fold may be dropped, documented in the iteration
  summary. Nothing else may change after this.
- Final models: trained on ALL Train+Val rows with rounds = median(best_iter
  across folds) × 1.1 rounded up (no early stopping — Test never influences
  anything), then run ONCE on Test.
- Test output: raw prediction log `results/ML_FEASIBILITY_test_predictions_H.jsonl.gz`
  per horizon (pair, t, p_up, pred=CALL if p_up ≥ 0.5 else PUT, label, win,
  close[t], close[t+H]) — every reported number must be re-derivable from
  these logs by an independent script.

## 7. Leakage / no-lookahead proofs (must pass before any modeling)

1. **Future-mutation invariance:** perturb all candles strictly after t
   → feature row at t unchanged; label at t DOES change (proves the label is
   not inside the features).
2. **Truncated-recompute equality:** recompute the feature row at t using
   only data up to t → identical to the full-batch row (catches accidental
   global normalization/centering).
3. **15m alignment:** the 15m context candle's close time ≤ decision time,
   verified on synthetic boundaries incl. boundary-exact cases.
4. **Label derivation:** for sampled rows, re-derive label from raw candles
   by a separate verifier.
5. **Purge assertion:** in code, every fold's train/val timestamps separated
   by ≥ 60m; Test never appears in any Train/Val index range.

## 8. Reporting (fixed before the Test run)

- Funnel: decision minutes → feature-valid → label-valid (ties broken out) →
  predicted, overall and per split.
- Validation-phase summary: per-fold AUC/accuracy, feature importances and
  their stability across folds (flat/noisy importances are themselves a
  finding), what was tried and dropped.
- Test report (once): Wilson 95% CI for WR — overall, per horizon, per pair,
  per predicted direction (CALL/PUT); no-skill comparison = always-UP rate
  and always-DOWN rate from the same rows; buckets < 30 decided →
  INSUFFICIENT; overlap-inflation check via stride-sampled (non-overlapping)
  CI; explicit PASS/FAIL gate:
  **PASS iff some horizon has WilsonLB(WR) > 55.56% AND WR > up-rate AND WR > down-rate.**
  Otherwise FAIL, reported plainly — the fourth disciplined negative result
  is a valid outcome and no re-design, re-threshold, or sub-group rescue is
  permitted in this run.
- Deployment feasibility note: Workers cannot host GBM runtimes; a promising
  result would require distillation (linear/logistic or simplified
  tree-threshold export) — noted, NOT built in this phase.

## 9. Prohibitions (restated from project rules)

- No peeking at Test content or aggregate statistics before the single final
  evaluation — not even "just checking the date range" beyond the frozen
  boundary arithmetic.
- No parameter, threshold, feature, or pair-specific change after seeing any
  Test number.
- No interpolation or synthesis of missing candles — the 2022 15m hole is
  excluded, documented, and nothing more.
- main is untouched; all work on `feature/ml-feasibility`; no merge, no
  deploy, no live wiring in this phase.
