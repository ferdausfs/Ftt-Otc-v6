# ML Feasibility — Gradient-Boosted Trees on Crypto 1m/15m (Task 24)

**Verdict: FAIL.** A LightGBM classifier over 41 engineered features, trained
on ~4.3 years of pooled Bybit crypto history with pre-registered purged
walk-forward validation, reached the Test segment (2025-12-13T15:36Z →
2026-09-05T00:00Z, 1.5M decided predictions per horizon) at:

| horizon | decided | WR | Wilson 95% CI | no-skill (up / down) |
|---|---|---|---|---|
| 5m | 1,500,534 | **52.22%** | [52.14, 52.30] | 49.78% / 50.22% |
| 7m | 1,504,945 | **52.39%** | [52.31, 52.46] | 49.72% / 50.28% |
| 10m | 1,508,995 | **52.51%** | [52.43, 52.59] | 49.66% / 50.34% |

The best horizon's CI upper bound sits **3.0 percentage points below the
55.56% breakeven** (payout 0.80, the project-wide assumption). The model does
beat the no-skill baseline by ~2.5pp consistently — there *is* a faint,
statistically solid, learnable regularity — but it is far from cost-covering,
it decays with time, and its stable feature importances say the structure is
mostly *when* things happen (funding clock, session, weekday) plus slow 15m
trend state, not a directional edge that survives costs. Per the
pre-registration this is reported plainly, with no re-design, threshold
tuning, or subgroup rescue: the fourth disciplined negative result in this
project's series (FTT3 50.5%, FTT3-R 48.0%, EMA ribbon 49.0%, ML 52.2–52.5%).

## 1. What was tested

Feasibility question: *is there any learnable signal at all* for a gradient-
boosted-tree classifier over engineered features — explicitly NOT another
hand-coded indicator rule, and explicitly treated as carrying MORE overfitting
risk than TA, hence the same-or-stricter validation discipline. One pooled
LightGBM (lr=0.10, num_leaves=127, min_data_in_leaf=500, feature_fraction 0.8,
bagging 0.8/freq 1, seed 42, deterministic) per fixed-time horizon
(5/7/10 minutes), binary label `close[t+H] vs close[t]` — the same
entry-at-candle-close convention as every prior test here.

Features (41, all causal, all normalized level-free, frozen menu from the
pre-registration): 1m returns over 6 lookbacks, 3 realized-vol windows,
ATR(14)/RSI(14)/MACD(12,26,9)/BB(20,2σ)/EMA(5,13,55) distances on 1m, a 13-
feature 15m block on the last closed 15m candle, volume z-scores, funding
level / rate-of-change / hours-since-last-event (Bybit linear-perp funding —
the genuine crypto-specific input TA indicators never see), UTC hour,
day-of-week, pair id. No raw price levels (declared non-stationarity
exclusion).

## 2. Data — the longest clean history Bybit serves

| | |
|---|---|
| Candles | Bybit spot v5 klines, 1m + 15m (USDT quote — same proxy as all prior crypto fetches here) |
| Pairs | BTC/USD, ETH/USD, XRP/USD, SOL/USD |
| Depth | spot 1m exists from 2021-07-05 (BTC/ETH), 2021-07-20 (XRP), 2021-10-21 (SOL) — fetched 2021-10-25 → 2026-09-05T00:15Z |
| Funding | Bybit linear-perp funding history, all 4 pairs, 2021-09-25 → window end |
| Integrity | 1m: 2,557,456 unique candles/pair, **0 missing on the grid**, maxGap = grid step. 15m: complete except one server-side hole (2022-02-01T02:30Z → 02-05T06:45Z, all pairs — confirmed by direct API probes, nothing interpolated) |
| Window | 2021-11-01T00:00Z → 2026-09-05T00:00Z = 2,547,360 decision minutes/pair (~4.85 years, 10.19M rows pooled) |
| Hole handling | minutes whose last closed 15m context is >60m old are EXCLUDED (5,954/pair, all inside the 2022 hole region); counted in the funnel |

## 3. Split — frozen before a single feature existed

`split_dates.json` (pure grid arithmetic, commit `115be8e`) and
`PRE_REGISTRATION_ML.md` were committed before any feature or model code:

```
Train      2021-11-01T00:00Z → 2025-03-23T07:12Z   70.0%
Validation 2025-03-23T07:12Z → 2025-12-13T15:36Z   15.0%   (CV + tuning here)
Test       2025-12-13T15:36Z → 2026-09-05T00:00Z   15.0%   (touched exactly ONCE)
```

Walk-forward CV (5 expanding folds inside Train+Val, initial train block =
first 40%, contiguous 12% validation blocks, **60-minute purge** at every
boundary — ≥6× the longest label window) was used for all iteration. One
pre-results amendment (fold layout, commit `40d1370`) and four runtime
adaptations for the 2-core sandbox (stride-2 train rows, 25% early-stop eval
subsample with full-fold reported metrics, lr=0.10-only grid, checkpointed
150-round chunks with exact patience-200/max-2000 semantics — commit
`5bc2b1a`) are documented in `PRE_REGISTRATION_ML.md` §3/§6.1; none was made
after seeing any CV or Test result.

## 4. Validation-phase findings (Train+Val only — `ITERATION_SUMMARY.md`)

- HP grid: leaves 63 vs 127 were practically identical (mean full-val AUC
  0.53627 vs 0.53632); the pre-declared best-mean rule froze leaves=127.
- Declared one-pass pruning: **zero zero-gain features** → full menu stands.
- CV AUC/accuracy (full validation folds at chosen rounds):

| horizon | mean AUC | mean acc | per-fold AUC (oldest → newest) |
|---|---|---|---|
| 5m | 0.53125 | 0.52161 | 0.53823 → 0.53388 → 0.52946 → 0.52742 → 0.52729 |
| 7m | 0.53410 | 0.52385 | 0.53901 → 0.53808 → 0.53442 → 0.52934 → 0.52965 |
| 10m | 0.53632 | 0.52524 | 0.54140 → 0.54058 → 0.53689 → 0.53076 → 0.53198 |

- Importances are **stable** across folds (mean pairwise Spearman ρ = 0.88 /
  0.92 / 0.96) — the model finds real structure, but the structure is
  dominated by `f15_ed13` (15m EMA13 distance), `f_fund_hours_since` (the 8h
  funding clock), `f_utc_hour`, `f_dow`, and last-15m returns/volume: a
  when-to-trade effect, not a directional micro-edge.
- The edge decays monotonically with fold recency — the newest validation
  block is the weakest everywhere. Combined with the Test numbers below
  (~52.2–52.5%, vs ~52.2–52.9% in late validation), the honest read is a
  small effect that is eroding, not a buried strong signal.

## 5. Test funnel (the single Test touch)

Per pair, every Test minute was a candidate decision row:

| stage | per pair | pooled (×4) |
|---|---:|---:|
| Test grid minutes (2025-12-13T15:36Z → 2026-09-05T00:00Z) | 382,104 | 1,528,416 |
| 15m-context exclusions (2022-hole era — none in Test) | 0 | 0 |
| rows predicted | 382,104 | 1,528,416 |
| ties (label=2, excluded from WR) | 357–14,964 (tick-coarse pairs higher) | 27,882 (H=5) |
| decided | 367,140–381,747 | **1,500,534–1,508,995** |

Every decided row received exactly one CALL/PUT prediction at the fixed 0.5
threshold. No threshold search, no confidence filtering, no subgroup rescue —
all pre-declared.

## 6. Test results (all numbers re-derived from the raw prediction logs by an independent script)

Overall (Wilson 95%):

| horizon | decided | WR | CI | vs breakeven 55.56% | vs no-skill |
|---|---:|---:|---|---|---|
| 5m | 1,500,534 | 52.22% | [52.14, 52.30] | −3.34pp (CI hi −3.26) | +2.44pp |
| 7m | 1,504,945 | 52.39% | [52.31, 52.46] | −3.18pp (CI hi −3.10) | +2.66pp |
| 10m | 1,508,995 | 52.51% | [52.43, 52.59] | −3.05pp (CI hi −2.98) | +2.85pp |

Per pair (WR, Wilson CI, n):

| pair | 5m | 7m | 10m |
|---|---|---|---|
| BTC/USD | 52.20% [52.04,52.36] | 52.38% [52.22,52.54] | 52.56% [52.40,52.72] |
| ETH/USD | 52.82% [52.66,52.98] | 53.07% [52.91,53.23] | 53.22% [53.06,53.38] |
| XRP/USD | 51.69% [51.53,51.85] | 51.73% [51.57,51.89] | 51.89% [51.73,52.05] |
| SOL/USD | 52.17% [52.01,52.33] | 52.34% [52.18,52.50] | 52.33% [52.17,52.50] |

Per predicted direction (pooled, H=10m): CALL 52.00% (n=814,351), PUT
53.09% (n=694,644) — the model's DOWN calls are its stronger side on every
pair, consistent with the no-skill down-rate being slightly above 50%. Every
pair × horizon × direction bucket is ≫30, so no INSUFFICIENT flags apply.

Non-overlapping robustness (stride-H sampling per pair, removes label-overlap
CI inflation): 52.11% / 52.38% / 52.42% — materially identical to the
full-coverage numbers, so the CIs above are not an artifact of overlapping
fixed-time windows.

**Gate (pre-registered): PASS iff some horizon has WilsonLB > 55.56% AND WR >
up-rate AND WR > down-rate. Every horizon FAILS the breakeven bound by >3pp.**
Even at a fantasy payout of 0.95 (breakeven 51.28%) the 10m CI [52.43, 52.59]
would clear it — but 0.95 payouts do not exist in this market; at the project's
0.80 assumption the result is a clear, high-confidence FAIL.

## 7. Interpretation (honest, both directions)

- The learned ~+2.5–2.9pp over no-skill is a *real, reproducible regularity*
  (n ≈ 4.5M decided predictions, CIs ±0.08pp, stable importances, robust to
  overlap) — but it is an order of magnitude too small for fixed-time
  payout economics and it is decaying era over era.
- Its composition matters: the trees lean on the funding clock, session and
  weekday, and slow 15m trend state. These are regime/time effects that a
  cost-aware deployment would monetize (if at all) through *selectivity*
  (trading only high-information windows), not through always-on direction
  calls — and any selectivity layer would be a NEW modeling decision
  requiring a NEW pre-registered test, not a retrofit on this one.
- This is the fourth independent methodology to land at or near no-skill
  against the same breakeven (three TA rule families, now a learned model
  given a strict superset of their information). The consistent picture
  across 4.85 years, 4 pairs, 10.2M decision points: short-horizon
  fixed-time direction on these pairs carries no exploitable edge at 0.80
  payout economics.

## 8. Deployment feasibility (explicit note, per the task spec)

Cloudflare Workers cannot host a GBM runtime; if a future Test had passed,
the next step would have been distilling the model into a worker-evaluable
scoring function (small logistic approximation or exported tree-threshold
rules). **That distillation was NOT built in this phase** — and with a FAIL
verdict it is moot: there is nothing worth distilling at these margins.

## 9. Reproducibility

- Raw prediction logs (the single source for every Test number):
  `results/ML_FEASIBILITY_test_predictions_H{5,7,10}.jsonl.gz` (~25MB each;
  fields: pair, ts, t_ms, H, p_up, pred, label, win, c_t, c_tH — 1.53M rows
  each incl. ties).
- Independent aggregator/verifier: `experiments/ml/aggregate_and_verify.py`
  reads ONLY those logs + `split_dates.json` and re-derives every table
  above; it also re-checks per-row label vs stored closes, the win rule,
  segment membership, uniqueness, and cross-checks sampled closes against
  the raw feature binaries. **32,097,978 checks, 0 failures.**
- Aggregate: `results/ML_FEASIBILITY_test_aggregate.json`; Test funnels:
  `results/ML_FEASIBILITY_test_funnel_H*.json`; final boosters:
  `experiments/ml/final_models/H{5,7,10}.txt`.
- CV artifacts: `experiments/ml/cv_runs/` (25 run JSONs + `cv_summary.json`
  + `grid_choice.json`), summarized in `experiments/ml/ITERATION_SUMMARY.md`.
- Pipeline: `backtest/fetch_data_ml.mjs` → `experiments/ml/features_lib.mjs`
  (causal math, reuses `src/strategy/indicators.mjs` conventions; proven by
  `experiments/ml/leakage_tests.mjs`, 40/40) → `build_features.mjs` →
  `train_cv.py` → `final_test_eval.py` → `aggregate_and_verify.py`.
- Frozen artifacts: `experiments/ml/split_dates.json` +
  `PRE_REGISTRATION_ML.md` (commit `115be8e`, amendments `40d1370`/`5bc2b1a`
  — all pre-results, commit history is the audit trail).

## 10. Prohibitions honored

main untouched (all work on `feature/ml-feasibility`); no merge, no deploy,
no live wiring — the live FTT3 collector on main was never touched. Test
data was read exactly once, by `final_test_eval.py`, after every validation
decision was frozen; its aggregates were consumed only after the run
completed. No parameter, feature, threshold, or pair-specific adjustment of
any kind followed the Test numbers.
