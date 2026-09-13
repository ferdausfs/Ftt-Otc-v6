# PRE-REGISTRATION — Task 25: ML Feasibility Extension (Sentiment + Macro Features)

**Status:** frozen BEFORE any new feature code exists and BEFORE any external
data (FRED / sentiment / Polymarket) is fetched. This document is committed
first on `feature/ml-sentiment-macro`; every later commit must obey it. If
reality later makes an item impossible, the deviation is DOCUMENTED in the
report as an amendment — never silently re-designed. Base branch:
`feature/ml-feasibility` (HEAD `026e1b1`). Nothing on that branch, on `main`,
or on any other branch is modified.

## 1. Question and scope

The frozen 41-feature GBM feasibility model (Test WR 52.22/52.39/52.51% at
5/7/10m vs breakeven 55.56%, verdict FAIL) leaned on the funding clock,
session/weekday, and 15m trend state. This task asks ONE question:

> Do externally-sourced regime features — macro policy (FRED) and market
> sentiment — add predictive power to the SAME model on the SAME frozen
> split, and does the model actually use them?

This is a feature-addition test only. It is NOT an adoption decision and NOT
a re-tuning exercise. The model type, split dates, label convention, existing
41 features, hyperparameters, evaluation protocol, and reporting format are
inherited from `experiments/ml/PRE_REGISTRATION_ML.md` (and its §6.1 runtime
adaptations A1–A4) UNCHANGED. The only degrees of freedom added here are the
six new features below.

## 2. New feature menu (frozen — appended AFTER the original 41)

All six are point-in-time as-of merges of slowly-updating external series
onto the 1m decision grid (decision instant = candle open t + 60s, same
convention as every existing feature). Indices 41–46; the original 41 names
and values stay byte-identical (verified by the extended leakage suite).

| # | name | definition |
|---|------|------------|
| 41 | `f_macro_ff_level` | Effective federal funds rate (FRED `DFF`, %) as-of the decision instant |
| 42 | `f_macro_ff_chg_90d` | `DFF_asof(t) − DFF_asof(t − 90 calendar days)` |
| 43 | `f_macro_curve_10y2y` | 10Y−2Y Treasury spread (FRED `T10Y2Y`, %) as-of the decision instant |
| 44 | `f_macro_curve_chg_90d` | `T10Y2Y_asof(t) − T10Y2Y_asof(t − 90 calendar days)` |
| 45 | `f_sent_fng` | Crypto Fear & Greed Index (alternative.me, 0–100) as-of the decision instant |
| 46 | `f_sent_fng_chg_7d` | `FNG_asof(t) − FNG_asof(t − 7 calendar days)` |

Rationale for the menu (stated now, not post hoc): fed-funds level/change is
the policy-regime input the source repo's TradingAgents pattern uses; the
10Y-2Y spread is the standard risk-cycle gauge; F&G is the only free,
historical, daily, crypto-relevant sentiment aggregate that exists (§4);
each gets one level and one change feature so the model can use either the
state or the momentum of the regime. Feature importance decides what matters
— nothing is hand-picked out or in beyond this frozen menu.

Normalization: NONE for these six (unlike the price features). The levels
ARE the signal and are bounded (DFF 0–6%, spread −2..+6%, F&G 0–100); the
trees are scale-invariant. Declared here so nobody "fixes" it later.

Row validity: a decision row whose decision instant precedes the first
`known_from` of any of the six series (or whose 90d/7d reference instant
does) is INVALID → excluded from all splits, counted in the funnel. With
external data fetched from 2021-07-01 (FRED) / 2021-02-01 (F&G) and T0 =
2021-11-01, ZERO exclusions are expected; the count is reported regardless.

## 3. Publication-lag pinning (the single most important frozen rule)

Every external observation carries a frozen `known_from` instant. The as-of
join for a decision at time t returns the observation with the LARGEST
`known_from ≤ t`. An observation with `known_from > t` is UNREACHABLE by
construction — this is the property the mandatory tests prove.

- **FRED `DFF` and `T10Y2Y`** (daily): an observation dated business day D is
  `known_from = the next business day after D, at 21:30 UTC`
  (next-business-day 4:30pm ET). This is conservatively LATER than every
  plausible actual publication of these series (same-day H.15-style ~21:15
  UTC or next-morning EFFR-style ~12:00 UTC). Any actual earlier availability
  is deliberately NOT claimed. Weekend observations of DFF (calendar-fill
  copies of Friday) are DROPPED at fetch time (they carry no new value);
  observations whose CSV cell is `.` are dropped (T10Y2Y holidays).
- **F&G** (daily): the value stamped date D is
  `known_from = D + 1 day at 00:00 UTC` — one full day after the source
  publishes it (~00:00 UTC on D). Again deliberately conservative.
- **90d / 7d changes** reference `asof(t − window)` — i.e. the value that
  was knowable at the reference instant, NOT the current value back-projected.
  Both endpoints of every change are pinned by the same `known_from` rule.
- Business day = Mon–Fri (US holiday calendar is NOT subtracted — using
  Mon–Fri makes `known_from` no earlier than reality under all release
  conventions checked in §4, which is the safety direction).

Explicit vintage disclosure (stated up front, mirrors TradingAgents'
`test_fundamentals_lookahead` discipline): these FRED series are essentially
never revised retroactively, but the CURRENT series is used, not historical
vintages — the frozen `known_from` lag is the safety boundary that makes
current-snapshot merging equivalent to vintage-aware merging for a feature
that changes at most once per day. The test suite must demonstrate the
boundary property on real fetched data (§6 S3), not assume it.

## 4. Data sources (frozen endpoints; fetched only AFTER this commit)

| Source | Endpoint | Span fetched | Access |
|---|---|---|---|
| FRED DFF | `https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF` | 2021-07-01 → 2026-09-05 | public CSV, no key (probed OK 2026-09-13) |
| FRED T10Y2Y | `...fredgraph.csv?id=T10Y2Y` | same | public CSV, no key (probed OK 2026-09-13) |
| F&G | `https://api.alternative.me/fng/?limit=0` | full history (2021-02-01 → fetch day) | public API, no key (probed OK 2026-09-13) |

- Fetcher scripts are committed BEFORE fetching (fetcher-first rule, same as
  Task 24 / Autocal). Raw files land in `backtest/data/external/` with a
  `PROVENANCE_EXTERNAL.md` (URLs, fetch timestamps, row counts, sha256 of
  every file). Raw external data is NOT committed (same policy as candles).
- Coverage disclosure (required by the task): the four pairs are BTC/ETH/
  XRP/SOL — no free per-pair historical sentiment source exists (StockTwits
  public API = recent messages only, auth required, no 2021–2026 history;
  Reddit historical bulk = Pushshift dead since 2023, official API pricing
  incompatible). The F&G index is therefore a MARKET-WIDE aggregate applied
  to all four rows — explicitly NOT pair-specific; no pair is excluded and no
  zeros are filled. This limitation is restated in the report next to the
  sentiment importances.

## 5. Polymarket odds — pre-registered availability rule

Include a Polymarket-derived feature ONLY if the Gamma/CLOB APIs yield a
continuous, point-in-time-safe odds series covering ≥ 80% of the frozen
window (2021-11-01 → 2026-09-05) for a crypto-price-threshold or macro
market family. Probe results (2026-09-13, pre-freeze, documented):
Polymarket's crypto markets are EPISODIC — each market is one threshold with
a days-to-weeks lifetime (e.g. "Bitcoin above $X on DATE"); hourly
up/down crypto markets do not exist before ~2024; the window's first ~2.5
years have no crypto-price markets at all. No continuous instrument series
can be stitched without fabricating cross-market splices → **Polymarket is
EXCLUDED** and this is reported in the deliverable, per the task's own
"report clearly if no usable market series exists" instruction. No proxy
will be forced into the feature set.

## 6. No-lookahead tests (mandatory — extended `leakage_tests.mjs`)

The original 40 assertions must still pass (the original 41 features and
labels are untouched), and the following NEW suite must pass BEFORE any
model runs:

- **S1 — synthetic as-of boundary:** constructed series with known
  boundaries; decisions at `known_from − 1ms`, `known_from`,
  `known_from + 1ms` return old/new/old values respectively (inclusive at
  the boundary). Tested for both FRED and F&G conventions.
- **S2 — change-window pinning:** a synthetic series where the value moved
  after the reference instant: `chg(t)` must equal `asof(t) − asof(t−window)`
  using the OLD value at the reference instant — never the latest value.
- **S3 — real-source property test:** for ≥ 2,000 random decision instants
  per source across the frozen window, the joined value equals the
  observation with max `known_from ≤ t`, and the join provably cannot return
  any observation with `known_from > t` (direct property test of the merge
  function, mirroring the source repo's lookahead regression tests).
- **S4 — weekend/holiday handling:** a Saturday 12:00 UTC decision uses
  THURSDAY's FRED observations (Friday's `known_from` = Monday 21:30 UTC
  under the frozen rule) and Friday's F&G (known_from Saturday 00:00 UTC) —
  exactly the frozen conventions, no invented values.
- **S5 — future-mutation invariance (full row):** perturbing all candles
  strictly after t leaves ALL 47 features unchanged (the six new ones do not
  read candles at all) while labels still change.
- **S6 — truncated-recompute equality (full row):** recompute from truncated
  data at t → identical 47-feature row (no global normalization anywhere).
- **S7 — provenance gate:** the external-data loader refuses files whose
  sha256 does not match `PROVENANCE_EXTERNAL.md` (fail loud, no silent swap).

## 7. Model and evaluation protocol (inherited, unchanged)

- LightGBM binary, pooled across pairs, one model per horizon H ∈ {5,7,10};
  frozen HP from `cv_runs/grid_choice.json`: lr=0.10, num_leaves=127
  (min_data_in_leaf 500, feature_fraction 0.8, bagging 0.8/1, seed 42,
  deterministic) — the original grid decision is NOT re-run.
- Runtime adaptations A1–A4 inherited verbatim (stride-2 train rows, 25%
  early-stop eval subsample, checkpointed 150-round chunks with exact
  patience-200/max-2000, budget-resumable invocations).
- The CV phase (5 purged walk-forward folds × 3 horizons, Train+Val only,
  60-minute purge) is re-run WITH the new features for exactly one purpose:
  deriving the final round counts by the SAME pre-declared rule
  (rounds_H = ceil(median best_round across folds × 1.1)) and reporting
  fold AUC + per-fold importances of the new features. NO HP search, NO
  pruning pass (the original's one-pass prune rule is NOT re-invoked; zero
  new features will be dropped for any reason).
- Final models: trained on ALL Train+Val decided stride-2 rows at the derived
  round counts, then predict EVERY decided Test row exactly ONCE
  (2025-12-13T15:36Z → 2026-09-05T00:00Z) → raw logs
  `results/ML_SENTIMACRO_test_predictions_H{5,7,10}.jsonl.gz` (same row
  schema as the original). All reported numbers re-derived from those logs by
  the extended independent aggregator.

## 8. Reporting (same format as the original, plus comparison)

1. Funnel: decision minutes → feature-valid (incl. the six new features) →
   label-valid → predicted, per split — with the new-feature exclusion count
   (expected 0) shown separately.
2. CV summary: per-fold AUC vs the original folds; new-feature gain
   importances (mean, rank, per-fold min/max) next to `f_fund_*`,
   `f_utc_hour`, `f_dow` — the apples-to-apples comparison the task asks for.
3. Test report (single touch): Wilson 95% CI for WR — overall, per horizon,
   per pair, per direction; no-skill (always-UP / always-DOWN) from the same
   rows; stride-H overlap check; buckets < 30 → INSUFFICIENT.
4. **Direct comparison vs the original:** per horizon — original WR/CI
   (52.22 [52.14,52.30] / 52.39 [52.31,52.46] / 52.51 [52.43,52.59]) vs this
   run's WR/CI, plus ΔWR with a two-proportion z-test on the paired samples
   (same decision rows), and the rank/share of each new feature.
5. Explicit PASS/FAIL gate (inherited verbatim):
   **PASS iff some horizon has WilsonLB(WR) > 55.56% AND WR > up-rate AND
   WR > down-rate.** Otherwise FAIL, reported plainly. No re-design,
   re-threshold, or subgroup rescue is permitted in this run.

Honest expectation (declared now): the original model's entire edge was
+2.5–2.9pp over no-skill with the breakeven 3.0pp ABOVE its CI upper bound.
Six slow-moving regime features are unlikely to close a 3pp gap; the
informative outputs are (a) whether the trees assign any gain to the new
features relative to the funding/session block, and (b) whether Test WR
moves at all. Both outcomes — "used but insufficient" and "ignored" — are
valid, pre-framed results.

## 9. Prohibitions (restated)

- No change to the original 41 features, split, labels, HP, folds, purge.
- No feature addition/removal after any CV number is seen (the §2 menu is
  final; Polymarket's exclusion is decided by the §5 rule, not by results).
- No peeking at Test content or aggregates before the single final
  evaluation; Test logs consumed only via the aggregator after the run.
- No parameter/threshold change after seeing any Test number.
- `main`, `feature/ml-feasibility`, and every other branch untouched; all
  work on `feature/ml-sentiment-macro`. No deployment wiring of any kind.
