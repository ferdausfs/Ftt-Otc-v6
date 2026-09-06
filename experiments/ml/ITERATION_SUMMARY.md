# CV Iteration Summary — Task 24 ML Feasibility (Train+Validation only)

All numbers below come from the 5-fold purged walk-forward CV inside
Train+Validation (2021-11-01T00:00Z → 2025-12-13T15:36Z) and its HP grid —
**Test (2025-12-13T15:36Z → 2026-09-05T00:00Z) was never touched at any point
in this phase.** Raw per-run artifacts: `experiments/ml/cv_runs/*.json`;
aggregate: `experiments/ml/cv_runs/cv_summary.json`.

## 1. What was tried (chronological, with pre-results amendments)

1. **Protocol as pre-registered** (commits 115be8e + fold-layout amendment
   40d1370, both before any model ran): 5 expanding purged walk-forward folds,
   60-minute purge, LightGBM binary, 2×2 HP grid.
2. **Runtime adaptations A1–A4** (commit 5bc2b1a, still pre-results): the
   2-core sandbox cannot run the as-declared compute in available time, so:
   train rows stride-2; early-stop eval on a fixed 25% of each validation
   fold (reported metrics are always recomputed on the FULL fold at the
   chosen round); HP grid restricted to lr=0.10 (the 0.05 arm dropped);
   boosting checkpointed in 150-round chunks with exact patience-200 /
   max-2000 semantics. Hardware timing was the only input to these choices.
3. **HP grid (H=10m, 5 folds each):** leaves=63 → mean full-val AUC
   0.53627; leaves=127 → 0.53632. Practically identical; the pre-declared
   rule (best mean) froze **lr=0.10, num_leaves=127** for all horizons.
4. **Feature-pruning pass (declared rule):** features with zero gain
   importance in every one of the 15 main-CV runs — **none found**; the full
   41-feature menu stands. No post-hoc feature engineering happened.
5. **Final-round rule (pre-declared):** rounds = median(best round across
   folds) × 1.1 rounded up → H=5m: 118, H=7m: 57, H=10m: 81.

## 2. CV results (full validation folds, chosen rounds)

| horizon | mean AUC | mean acc@0.5 | per-fold AUC (folds 1→5) |
|---|---|---|---|
| 5m | 0.53125 | 0.52161 | 0.53823 → 0.53388 → 0.52946 → 0.52742 → 0.52729 |
| 7m | 0.53410 | 0.52385 | 0.53901 → 0.53808 → 0.53442 → 0.52934 → 0.52965 |
| 10m | 0.53632 | 0.52524 | 0.54140 → 0.54058 → 0.53689 → 0.53076 → 0.53198 |

**Reading:** the model is consistently a little better than coin-flip
out-of-sample, but (a) the edge is tiny (≈ 2–3 pp of accuracy, far below the
55.56% breakeven), and (b) it **decays monotonically with fold recency** —
the most recent validation block (2025H2) is the weakest everywhere. There is
no sign of a hidden strong signal that better tuning would unlock; the shape
is a small, eroding, mostly time-structural effect.

## 3. Feature importance and stability

Spearman rank correlation of gain importances between every fold pair:
H=5m ρ̄ = 0.88, H=7m ρ̄ = 0.92, H=10m ρ̄ = 0.96 — **importances are stable**,
so the model is finding the same structure everywhere, not noise. Top
features by mean gain (all three horizons agree):

1. `f15_ed13` — distance of the 15m EMA13 from current price (slow trend state)
2. `f_fund_hours_since` — time since the last perpetual funding event (8h clock)
3. `f_utc_hour`, `f_dow` — time-of-day / day-of-week session structure
4. `f15_ret_1b`, `f15_ret_4b`, `f15_volz_96` — last 15m returns / volume z
5. `f_ret_1440m` — 1-day return

**Honest interpretation:** the "learnable signal" the trees find is
dominated by *when* things happen (funding clock, session, weekday) plus
slow 15m trend state — not by 1m micro-structure. A calendar-and-clock
effect of this size can barely clear costs even before decay is considered;
it does not resemble a tradable directional edge.

## 4. What was dropped

- lr=0.05 arm (pre-results, runtime only — never evaluated).
- Nothing else. No feature was hand-dropped, no fold was excluded, no
  re-weighting, no threshold tuning. The declared pruning pass ran and found
  nothing to drop.

## 5. Leakage discipline

- `experiments/ml/leakage_tests.mjs`: 40/40 green (future-mutation
  invariance, truncated-recompute equality, 15m boundary alignment, label
  conventions, fold/purge integrity).
- In-code guards: every CV row ts < validation.end (asserted), purge 60m
  asserted at every fold, Test segment unreachable from the CV code path.
- Pre-registration and all amendments committed before results existed
  (commit history is the audit trail).
