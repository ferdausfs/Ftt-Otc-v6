# ML Feasibility Extension — Sentiment + Macro Features (Task 25)

**Verdict: FAIL (gate unchanged), and the added features did not help —
Test WR is flat-to-slightly-WORSE than the original 41-feature model at
every horizon, significantly so at 10m.** The model genuinely *uses* the
external regime block (≈18–21% of total gain; the 10Y-2Y spread ranks 4–5
and the Fear & Greed index 6–7 of 47 features) — but the fifth of the
decision surface it absorbs produces no AUC gain in any fold and no WR
improvement on Test. Pre-registered reporting, no rescue, no re-design.

> **বাংলা সারমর্ম:** আগের ৪১-ফিচার ML মডেলে ৬টা নতুন regime ফিচার যোগ করা
> হলো — Fed funds rate (level + ৯০-দিন পরিবর্তন), ১০Y−২Y Treasury spread
> (level + পরিবর্তন), Crypto Fear & Greed Index (level + ৭-দিন পরিবর্তন)।
> সবগুলো point-in-time নিয়মে merge করা হয়েছে (macro ডেটা যেদিন প্রকাশ হয়
> তার পরের ব্যবসার দিন থেকে "জানা" ধরা হয়েছে — lookahead ঠেকাতে একদিন
> অতিরিক্ত নিরাপত্তা), ৭ রকমের no-lookahead টেস্ট ৩৬/৩৬ PASS। ফলাফল:
> মডেল ফিচারগুলো **ব্যবহার করে** (curve spread ও F&G importance-এ ৪র্থ-৭ম
> স্থানে) — কিন্তু AUC বাড়েনি, Test WR আরও সামান্য খারাপ হয়েছে (10m:
> 52.51% → 52.34%)। Breakeven 55.56%-এর চেয়ে ৩.২pp নিচে — **FAIL**।
> Polymarket কোনো continuous series দেয় না — আগেই বাদ ছিল।

---

## 1. What was tested (and what was NOT)

The frozen Task-24 GBM pipeline was re-run with EXACTLY one change: six
appended external-regime features (indices 41–46). Model type, split dates,
labels, the original 41 features (byte-identical values, verified by
assertion), hyperparameters (lr=0.10, leaves=127 — inherited frozen from the
original grid decision), folds, purge, stride adaptations, round-derivation
rule, and the gate are all unchanged
(`experiments/ml/PRE_REGISTRATION_SENTIMACRO.md`, commit `4c08e9f`, frozen
before any external data was fetched).

New features: `f_macro_ff_level`, `f_macro_ff_chg_90d` (FRED DFF),
`f_macro_curve_10y2y`, `f_macro_curve_chg_90d` (FRED T10Y2Y), `f_sent_fng`,
`f_sent_fng_chg_7d` (alternative.me F&G). Publication pinning frozen
conservatively: FRED observation D knowable from the NEXT business day
21:30 UTC; F&G stamp D knowable from D+1 00:00 UTC; every 90d/7d change
references the value knowable at the reference instant, never the current
value back-projected. Polymarket: excluded by the pre-registered
availability rule (episodic markets; no continuous 2021–2026 series —
documented in the pre-reg §5). Per-pair sentiment does not exist for free
(StockTwits recent-only, Reddit historical dead) — the market-wide F&G
aggregate is applied to all four pairs with that limitation disclosed; no
zeros filled, no pair excluded.

## 2. No-lookahead discipline (the core of this task)

- Original suite re-run green: **43/43** (candle/funding causality with the
  external block threaded as a frozen constant — external series are
  candle-independent by construction).
- New suite: **36/36** (`leakage_sentimacro_tests.mjs`): S1 as-of boundary
  inclusivity (FRED + F&G conventions); S2 pinned change references
  (synthetic moving series — the change uses the value knowable at t−90d,
  never back-projected); S3 property test — 7,500 random (instant, source)
  draws over the real fetched series prove the join returns the latest
  observation with known_from ≤ t and provably cannot reach any later one;
  S4 real weekend/holiday handling (a Saturday decision consumes THURSDAY's
  FRED observations under the frozen rule; F&G Friday stamp covers the
  weekend); S5/S6 full-row future-mutation invariance and truncated-recompute
  equality including the external block; S7 provenance gate — the builder
  refuses external files whose sha256 does not match the committed
  `results/PROVENANCE_EXTERNAL_ML.md`.
- Two loader-hardening findings fixed pre-run (documented for the audit
  trail): the alternative.me payload is NEWEST-FIRST with STRING timestamps
  — `prepFngKf` now coerces, sorts ascending, and fails loudly on duplicates;
  the builder verifies every external file sha256 before use.

## 3. Data (same frozen window; external sources fetched after the freeze)

- Candles/funding: refetched fresh from Bybit (same endpoints, same spans)
  — 2,557,456 unique 1m candles/pair, 0 grid holes, maxGap 1m; 15m complete
  except the known server-side hole (missing 400, 2022-02-01→02-05); funding
  5,419 records/pair. Byte-comparable with the original run's data.
- External: `fred_DFF.csv` (1,352 business-day obs), `fred_T10Y2Y.csv`
  (1,295), `fng_full.json` (3,143 daily stamps) — sha256 pinned in the
  committed provenance note, fetch timestamps recorded.
- Funnel: 2,541,406 rows/pair (2,547,360 grid − 5,954 stale-15m) — identical
  to the original run's funnel; **extExcluded = 0** (every decision instant
  had both level and change references available, as predicted).

## 4. CV (Train+Val only — Test untouched)

Frozen HP, 5 purged walk-forward folds × 3 horizons, stride-2 basis (A1–A4
inherited):

| horizon | mean AUC (this run) | mean AUC (original 41f) | mean acc | importance stability (mean ρ) |
|---|---|---|---|---|
| 5m | 0.53161 | 0.53125 | 0.52166 | 0.905 |
| 7m | 0.53292 | 0.53410 | 0.52285 | 0.924 |
| 10m | 0.53496 | 0.53632 | 0.52432 | 0.950 |

Fold AUC is FLAT-to-lower everywhere: the external block adds no
discrimination. Final round counts by the frozen rule
(ceil(median best_round × 1.1)): **H5 = 38, H7 = 35, H10 = 31** (the
original run's were 118/57/81 — the larger 47-feature model early-stops much
sooner).

## 5. Feature importance — the model DOES use the external block

Mean gain share and rank across the 5 folds (47 features total):

| feature | rank (h5 / h7 / h10) | gain share h10 | vs the funding/session block |
|---|---|---|---|
| `f_macro_curve_10y2y` | 5 / 5 / **4** | **5.24%** | ≈ `f_utc_hour` (5.68%) |
| `f_sent_fng` | 6 / 6 / 7 | 4.57% | — |
| `f_macro_curve_chg_90d` | 7 / 8 / 6 | 4.76% | — |
| `f_sent_fng_chg_7d` | 10 / 12 / 9 | 3.49% | ≈ `f_dow` (3.64%) |
| `f_macro_ff_level` | 33 / 26 / 23 | 1.44% | low |
| `f_macro_ff_chg_90d` | 24 / 21 / 21 | 1.70% | low |
| **external block total** | — | **21.2%** (h10), 18.0% (h5), 18.4% (h7) | `f_fund_hours_since` 9.11%, `f_utc_hour` 5.68% |

Fold ranges are tight (no single-fold blowout — e.g. `f_macro_curve_10y2y`
4,130→13,922 raw gain across folds at h5), and importance stability stays
high (ρ̄ 0.90–0.95). The fed-funds level is nearly useless as a split
feature (rank 23–33) — it is quasi-constant on multi-week scales.

**The informative negative:** the trees absorb ≈ one-fifth of their splits
in slow macro/sentiment regime state, yet validation AUC does not move. The
external block is redundant with the timing/regime information the model
already had (funding clock, UTC hour, weekday, 15m trend state) — it
re-expresses "which regime am I in" without adding directional content.

## 6. Test results (the single Test touch)

Every decided Test row (2025-12-13T15:36Z → 2026-09-05T00:00Z) predicted
exactly once at the 0.5 threshold; all numbers re-derived from the raw
prediction logs by the independent aggregator (**32,097,978 checks,
0 failures** — same check count as the original run, identical row counts).

| horizon | decided | WR | Wilson 95% CI | no-skill (up/down) | stride (non-overlap) |
|---|---|---|---|---|---|
| 5m | 1,500,534 | **52.19%** | [52.11, 52.27] | 49.78% / 50.22% | 52.13% |
| 7m | 1,504,945 | **52.34%** | [52.26, 52.42] | 49.72% / 50.28% | 52.44% |
| 10m | 1,508,995 | **52.34%** | [52.26, 52.42] | 49.66% / 50.34% | 52.08% |

### Direct comparison vs the original 41-feature model (same split, same rows)

| horizon | original WR | this run WR | ΔWR | note |
|---|---|---|---|---|
| 5m | 52.22% [52.14, 52.30] | 52.19% [52.11, 52.27] | −0.03pp | CIs overlap |
| 7m | 52.39% [52.31, 52.46] | 52.34% [52.26, 52.42] | −0.05pp | CIs touch |
| 10m | 52.51% [52.43, 52.59] | 52.34% [52.26, 52.42] | **−0.17pp** | CIs DISJOINT — significantly worse |

Two-proportion z on the pooled decided rows (declared method): h10 z ≈ −2.9
(p < 0.01) — the degradation at 10m is small but real, consistent with the
extra features spending model capacity on regime identity instead of the
(weak) directional signal. Per pair (h10): BTC 52.29%, ETH 52.78%, XRP
51.95%, SOL 52.34% — same ordering as the original run (ETH best, XRP
worst). Per direction (h10): CALL 52.21% / PUT 52.45% (original: CALL
52.00% / PUT 53.09% — the model's stronger PUT side degraded most).

## 7. Gate and verdict

Pre-registered gate (inherited verbatim): **PASS iff some horizon has
WilsonLB(WR) > 55.56% AND WR > up-rate AND WR > down-rate.**

Every horizon fails by ≥ 3.1pp at the CI upper bound. The verdict is FAIL —
the sixth consecutive disciplined negative on this project's binary-payout
economics, and the direct answer to this task's question:

1. **Does the model use the new features?** Yes — materially (≈18–21% of
   gain; curve spread and F&G in the top 7).
2. **Does that help?** No — zero fold-AUC improvement, Test WR flat to
   significantly worse. Slow external regimes are already implied by the
   calendar/funding/15m-trend block; making them explicit buys nothing and
   costs a little (capacity dilution).
3. **Honest framing:** this closes the "would adding regime context move
   the 52.2–52.5% baseline toward breakeven?" question with a clean no. Any
   further feature-family additions to this pipeline need a genuinely new
   information source, not re-weightings of public aggregates — and even a
   +1pp move would still leave the gate 2pp unmet.

## 8. Reproducibility

- Pipeline: `backtest/fetch_data_ml.mjs` (candles) + `backtest/fetch_external_ml.mjs`
  (external, fetcher-first commit `c3a8021`) → `experiments/ml/features_lib.mjs`
  (47-feature causal row + pinned as-of joins) → `build_features.mjs`
  (232B rows, sha256-gated external load) → `train_cv.py --phase cvfrozen`
  → `final_test_eval.py` (single Test touch) → `aggregate_and_verify.py`.
- Raw Test logs: `results/ML_SENTIMACRO_test_predictions_H{5,7,10}.jsonl.gz`
  (~25MB each; same row schema as the original). Funnels:
  `results/ML_SENTIMACRO_test_funnel_H*.json`; aggregate:
  `results/ML_SENTIMACRO_test_aggregate.json`; final boosters:
  `experiments/ml/final_models/H{5,7,10}.txt`.
- CV artifacts: `experiments/ml/cv_runs/cv_f*_h{5,7,10}.json` (15 finals) +
  `cv_summary.json` (+ the inherited `grid_choice.json` retained as the
  frozen-HP provenance; the original 41-feature CV results were REMOVED from
  this branch — documented in the commit — and remain on
  `feature/ml-feasibility`).
- Pre-registration: `experiments/ml/PRE_REGISTRATION_SENTIMACRO.md` — commit
  `4c08e9f` demonstrably precedes the external fetch (`aa5030c`), the feature
  code (`3beb9b5`), the CV (`89c34ba`), and the Test run. Commit history is
  the audit trail; no parameter, feature, or threshold changed after any
  result was seen.

## 9. Prohibitions honored

`main` untouched; `feature/ml-feasibility` untouched (all work on
`feature/ml-sentiment-macro`); no deployment wiring; Test data read exactly
once; no subgroup rescue, no threshold tuning, no feature re-cut after any
number was seen.
