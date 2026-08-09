# D4 v2 — AVOIDANCE MODEL (Phase F) — Analysis Report

**Date:** 2026-08-09 · **Author:** Arena worker/analysis agent · **Status:** ANALYSIS-ONLY, no gate shipped
**Script:** `scripts/d4_v2_avoidance.py` (re-runnable, deterministic, pure-numpy core)
**Artifact:** `scripts/d4v2_avoidance_gate.js` (portable JS gate — **NOT live**, holdout failed)
**Data:** `phase_f_forward/` (Workplace-drive- snapshot 2026-08-09)

---

## 0. TL;DR — the honest verdict

> **No avoidance gate clears R1 on the holdout with the available signal-time features.**
> The model finds a **real but weak** edge (holdout rank-AUC ≈ 0.56), pushes the
> TRADE-subset win-rate **above breakeven** (≈ 55–58 %), but the **Wilson-CI lower
> bound stays below 50 %** — i.e. the edge is **not statistically robust** on 635
> holdout signals. A flexible XGBoost oracle **overfits and does worse** on holdout,
> proving the features — not the model — are the ceiling.

| Split (primary: AUG TRAIN 08-01..08-06) | n | WR | Wilson 95 % CI | cov | edge/trade | R1 |
|---|---|---|---|---|---|---|
| Engine pool (all decided) | 5083 | **42.5 %** | 41.1–43.9 % | 100 % | −0.135 | — |
| VAL holdout (08-07..09), all signals | 635 | 48.0 % | 44.2–51.9 % | 100 % | −0.135 | — |
| **VAL TRADE-subset @ frozen TRAIN τ** | **121** | **57.9 %** | **48.9–66.3 %** | **19 %** | **+0.041** | **FAIL** |

R1 requires WR ≥ 55.6 % **and** CI-low ≥ 50 % **and** coverage ≥ 15 %. We get
WR ✓ (57.9 %), coverage ✓ (19 %), but **CI-low 48.9 % < 50 % ✗**. One criterion short.

The single best *post-hoc* point on the holdout curve (k=190, 30 % cov) reads
WR 57.9 % CI[50.8–64.7] — a technical "pass" — but it is the **maximum over 540
thresholds scanned on the holdout itself** (multiple-comparison / threshold-fishing)
and is **not** a pre-committed gate. The pre-committed TRAIN-selected gate fails.

**Bottom line:** honest edge &gt; fake edge. We do not ship a gate. The actionable
next step is concrete: **persist raw signal-time indicators** (RSI / ATR % / ADX /
BB-bandwidth) — they are computed by the engine today but thrown away before
history is saved (see §7). That is the most likely source of real, separable edge.

---

## 1. Data & method

### 1.1 Universe
- Loaded `phase_f_forward/*/[A-Z]*_*.json` (18 pairs × 8 daily snapshots).
- **Dedup by signal `id`** (keep the most complete record across snapshots) —
  matches the established convention in `d4_run.py` / `slice_mine.py`.
- Keep only decided `WIN`/`LOSS`. TIE / UNKNOWN / null excluded.
- **Universe = 5083 decided signals.** Engine pool WR = 2160/5083 = **42.5 %**
  (CI 41.1–43.9 %). This reproduces the reviewer's "engine pool 42.5 %" exactly.

### 1.2 Chronological split (no shuffling — data is day-clustered)
- **VAL (holdout) = 2026-08-07 … 2026-08-09** (n = 635) — fixed, per R1.
- **TRAIN** learned two ways, both reported:
  - **AUG (primary):** 2026-08-01 … 2026-08-06 (n = 2652). Matches the prompt's
    literal split.
  - **FULL (robustness):** everything ≤ 2026-08-06 (n = 4448, includes July).

**Why AUG is primary — non-stationarity.** The grade→WR ladder is **not stable**
across the history because calibration (PR #10, "live") re-fixed the label ladder:

| Date band | grade A+ WR | grade A WR | grade B WR | grade C WR |
|---|---|---|---|---|
| 07-29..07-31 (pre-calib) | 37 % | 38 % | 44 % | **45 %** (C best, ladder inverted) |
| 08-01..08-03 | **53 %** | 50 % | 41 % | 46 % (A+ now best — fixed) |
| 08-04..08-06 | 30 % | 38 % | 40 % | 48 % |
| 08-07..08-09 (VAL) | 31 % | 53 % | 51 % | 49 % |

Mixing pre-calibration July labels into TRAIN would teach the model a stale
grade→outcome relationship. AUG-only TRAIN avoids that. (FULL is reported for
robustness; it does **not** rescue the result — see §3.)

### 1.3 Features — signal-time only (R2: no leakage)
Categorical (one-hot): `pair, assetType, direction, bestTF, marketRegime,
sessionQuality, grade, alignment, structureVerdict`.
Numeric (standardised): `confidence, coreConfidence, hour(UTC), dow`.

**Explicitly excluded (would be leakage):** `result, entryHit, exitPrice,
checkedAt, entryPrice, entryHitWindow*`. `entryHit` in particular is post-hoc and
a tautology with `result` (see `d4_run.py` leakage-diagnostic notes).

**Gaps vs the requested feature set (data does not contain them):**
- `avgConfluence` — **not persisted** (the engine has `signal.averageConfluence`
  in memory but `saveSignalToHistory` drops it). Computed indirectly into `grade`.
- `structureVerdict.overall` — present, but already collapsed to a flat string at
  persist time (`ALIGNED/AGAINST/MIXED/NEUTRAL`). Used as-is.
- **Raw indicators (RSI / ATR / ADX / BB-bandwidth) — NOT persisted at all.** This
  is §7's instrumentation gap — the single most important finding for next steps.

### 1.4 Model
- **Deliverable:** ridge **logistic regression in pure numpy** (full-batch GD,
  L2=1.0, deterministic: zero-init, fixed iterations). Chosen because it is fully
  auditable and its coefficients map 1:1 to a JS gate (R4).
- **Cross-checks (optional libs, graceful skip if absent):**
  - sklearn `LogisticRegression(C=1, l2)` — **rank-correlation with the numpy
    model = 1.000 on VAL** (validates the hand-rolled solver is correct).
  - **XGBoost oracle** — a flexible ceiling probe (see §4).

### 1.5 Threshold protocol (no VAL peeking)
1. Fit on TRAIN. Rank TRAIN signals by P(WIN).
2. **On TRAIN only**, pick the operating point that maximises TRAIN-subset WR
   subject to coverage ≥ 15 % (the R1 floor). → freeze τ.
3. Apply that **absolute** τ to the untouched VAL. Report WR + Wilson CI +
   coverage. This is the only pre-committed gate; everything else is flagged
   post-hoc.

---

## 2. Results — primary (AUG TRAIN)

```
TRAIN n=2652  WR=41.9 %   VAL n=635  WR=48.0 % (CI 44.2–51.9 %)
numpy logistic: TRAIN rank-AUC=0.605   VAL rank-AUC=0.559
τ (TRAIN-selected) = 0.507   (TRAIN picks 15 % coverage)

HOLDOUT TRADE-subset @ frozen τ:
  TRAIN-subset : n=398  (15 % cov) WR=54.8 % CI[49.9–59.6] edge=-0.014
  VAL-subset   : n=121  (19 % cov) WR=57.9 % CI[48.9–66.3] edge=+0.041  ← R1 FAIL (CI)
```

**Post-hoc VAL coverage sweep (illustration only — not the selected gate):**

| keep % | n | WR | CI 95 % | edge |
|---|---|---|---|---|
| 15 % | 95 | 58.9 % | 48.9–68.3 | +0.061 |
| 20 % | 127 | 57.5 % | 48.8–65.7 | +0.035 |
| 30 % | 190 | 57.9 % | 50.8–64.7 | +0.042 |
| 40 % | 254 | 54.3 % | 48.2–60.3 | −0.022 |
| 50 % | 318 | 52.5 % | 47.0–57.9 | −0.055 |
| 100 % | 635 | 48.0 % | 44.2–51.9 | −0.135 |

WR clears 55.6 % at 15–30 % coverage, but **no coverage level yields a Wilson
lower bound ≥ 50 %** (the best is 50.8 % at 30 % cov — and that is post-hoc).

**Per-day holdout stability @ frozen τ** (edge direction is consistent across all
3 days, but no single day's CI excludes breakeven):

| day | ALL n / WR | TRADE-subset n / WR (CI) |
|---|---|---|
| 08-07 | 413 / 46.0 % | 56 / 55.4 % (42.4–67.6) |
| 08-08 | 165 / 49.1 % | 34 / 58.8 % (42.2–73.6) |
| 08-09 | 57 / 59.6 % | 31 / 61.3 % (43.8–76.3) |

**Honesty audit (best post-hoc point):** scanning all 540 thresholds (cov ≥ 15 %)
on VAL, the best is k=190 (30 % cov) WR 57.9 % CI[50.8–64.7]. It "passes" R1, but
it is the **max over 540 holdout-peaked thresholds** — a textbook
multiple-comparisons artifact, **not a credible gate**. The pre-committed
TRAIN-selected gate is the only defensible choice, and it fails the CI.

## 3. Results — robustness (FULL TRAIN, includes July)

```
TRAIN n=4448  WR=41.7 %   VAL n=635  WR=48.0 %
numpy logistic: TRAIN rank-AUC=0.590   VAL rank-AUC=0.549  (worse than AUG — July noise)
τ (TRAIN-selected) = 0.491
VAL-subset @ frozen τ: n=174 (27 % cov) WR=55.2 % CI[47.8–62.4] edge=-0.007  ← R1 FAIL
```
Adding the pre-calibration July data **lowers** holdout AUC (0.559 → 0.549) and
does not clear R1. This confirms the non-stationarity argument for AUG-primary.

## 4. Model diagnostics — the features are the ceiling

| Model | TRAIN AUC | VAL AUC | VAL TRADE-subset @τ |
|---|---|---|---|
| **numpy logistic (shipped)** | 0.605 | **0.559** | 57.9 % CI[48.9–66.3] |
| sklearn logistic (cross-check) | — | rank-corr **1.000** vs numpy | 58.2 % CI[49.3–66.6] |
| **XGBoost oracle (flexible)** | **0.754** | **0.523** | 46.3 % CI[36.6–56.3] |

The XGBoost oracle fits TRAIN hard (AUC 0.754) but **generalises worse than the
simple logistic** (VAL AUC 0.523 < 0.559; its TRADE-subset is *below* the engine
base). A more expressive model **overfits** — the predictive ceiling is set by the
features, not the model class. **No amount of modelling cleverness on these
features will produce a robust gate.** This is the core negative result.

## 5. The "loser slices" do not hold on holdout (overfit demo)

The prompt's candidate SKIP slices were mined on TRAIN. On VAL they **flip**:

| Slice | TRAIN WR | VAL WR | verdict |
|---|---|---|---|
| FOREX (all) | 27 % | **52 %** | flipped (forex *better* on holdout) |
| GBP/USD | 22 % | **69 %** | flipped hard |
| EUR/USD | 25 % | 56 % | flipped |
| AUD/USD | 27 % | 57 % | flipped |
| HIGHEST session | 25 % (n=12) | 100 % (n=1) | untestable |
| conf 80–84 | 39 % | 42 % | low (stable-ish) |
| grade A+ | 40 % | 31 % | low (stable-ish) |
| bestTF 1min | 38 % | 41 % | low (stable-ish) |

Hand-rule baseline (skip AUD/USD, USD/JPY, GBP/USD, EUR/USD, DOT/USD, HIGHEST,
conf 80–84, grade A+): **VAL WR 52.2 % (CI 47.1–57.3), 57 % cov → FAIL.** The
pair-based rules are overfit to the training regime. Only a few features
(1 min TF, grade A+, VOLATILE regime) are stably weak — too few to build a gate
that both clears 55.6 % and keeps ≥ 15 % coverage with a tight CI.

## 6. Feature importance / the auditable rule (AUG model)

Numeric coefficients (standardised scale): `confidence +0.010`, `coreConfidence
−0.031`, `hour −0.103` (later UTC hour ⇒ worse), `dow +0.047`. Confidence/core are
**near-zero** — confirming calibration's finding that conf/grade carry little
separable signal.

Most WIN-associated (KEEP) categorical levels: `alignment=ALL_BEARISH +0.35`,
`marketRegime=TRENDING +0.34`, `marketRegime=BREAKOUT +0.33`, `pair=USD/JPY +0.29`,
`pair=XRP/USD +0.26`, `sessionQuality=HIGH +0.24`.

Most LOSS-associated (SKIP): `marketRegime=VOLATILE −0.82`, `alignment=MOSTLY_BEARISH
−0.38`, `alignment=MOSTLY_BULLISH −0.37`, `pair=GBP/USD −0.35`, `assetType=FOREX
−0.34`, `sessionQuality=MEDIUM/LOW −0.24`, `grade=A+ −0.20`, `bestTF=1min −0.14`.

> ⚠️ **Audit caveat (non-stationarity):** several of these are *TRAIN-period*
> relationships that **invert on holdout** — e.g. `pair=USD/JPY` is +0.29 (KEEP)
> in AUG-TRAIN but USD/JPY's VAL WR is only 35 %; `pair=GBP/USD` is −0.35 (SKIP)
> but GBP/USD's VAL WR is 69 %. **Do not read individual coefficients as a
> standalone rule.** This is exactly why a coefficient table alone is not shipped
> as a live gate — the stable signal lives in the *ensemble*, and even the
> ensemble is too weak (§4).

The full frozen coefficients + τ are in `scripts/d4v2_avoidance_gate.js`
(auto-generated, cross-language-verified to reproduce the Python P(WIN) to
**0.000000 max error**).

## 7. Instrumentation gap — the path to real edge (§4 of the task)

**Finding:** the engine **already computes** RSI, ATR, ADX and Bollinger Bands per
timeframe (`worker/src/indicators/index.js` → `calculateAllIndicators`), and the
in-memory signal object carries `signal.timeframeAnalysis[bestTF].indicators` plus
`signal.bestTimeframe`. **But `saveSignalToHistory` (`worker/src/history/stats.js`)
discards all of it** — only the aggregates (grade/confidence/alignment/
structureVerdict.overall) survive into history. So every forward row D4 v2 can
train on is missing the features most likely to carry separable edge.

**Why this matters:** calibration already showed conf/grade predict only ~40–45 %.
This analysis shows the *full* signal-time categorical set tops out at holdout
AUC ≈ 0.56. The raw indicator regime (is RSI extended? is ADX > 25? is BB
squeezed?) is the natural next feature layer — and it is free, already-computed
data we are throwing away.

**Proposed worker change (separate, PR-first, additive — NOT a live gate):**
persist a tiny `signalIndicators` snapshot (4–6 numbers, ~40 bytes/row) on each
history record:

```js
// in saveSignalToHistory(), after building `record` (stats.js)
// D4 v2.1 instrumentation: persist a best-TF indicator snapshot so future
// avoidance models can use raw signal-time indicators. Read-only diagnostic;
// NO runtime consumer yet. Fail-open (diagnostics must never break a save).
try {
  const bestTF = signal.bestTimeframe && signal.bestTimeframe.timeframe;
  const tfa = bestTF && signal.timeframeAnalysis ? signal.timeframeAnalysis[bestTF] : null;
  const ind = tfa && tfa.indicators;
  const lastNum = (a) => Array.isArray(a) ? a[a.length - 1] : a;
  if (ind && bestTF) {
    const atr = lastNum(ind.atr);
    const close = tfa.entry ? tfa.entry.price : null;
    record.signalIndicators = {
      bestTF,
      rsi:        ind.rsi        ? Number(lastNum(ind.rsi).toFixed(2))             : null,
      atrPct:     (atr && close) ? Number((atr / close * 100).toFixed(3))          : null,
      adx:        ind.adx        ? Number(lastNum(ind.adx.adx).toFixed(2))         : null,
      bbBandwidth: ind.bollinger && Array.isArray(ind.bollinger.bandwidth)
                     ? Number(lastNum(ind.bollinger.bandwidth).toFixed(3))         : null,
    };
  }
} catch (e) { /* diagnostic only */ }
```

This is **additive**, wrapped in try/catch (fail-open), and read-only. It cannot
change any live signal decision. Once ~5–7 days of rows accumulate the snapshot,
**D4 v2.1** retrains with `rsi/atrPct/adx/bbBandwidth` added to the feature set and
re-tests R1 on a fresh holdout. A concrete patch is staged at
`diff/signalIndicators_instrumentation.patch` for a separate worker PR.

**Verification of the staged patch** (applied to a throwaway copy, suite run, then
reverted — the live `src/` on this branch is unchanged):

| suite | result |
|---|---|
| fix_tests | **160 P / 0 F** |
| d2_tests | 39 P / 0 F |
| phase10_smoke | 61 P / 0 F |
| phase7_smoke | 68 P / 0 F |
| phase7_integration | 36 P / 0 F |
| phase10_integration | 19 P / 0 F |
| probe_tests | 34 P / 0 F |
| fx_mode_tests | 20 P / 0 F |
| entry_hit_tests | 7 P / 0 F |
| r71_tests | could not run in this env — needs baseline commit `e56cd33` (`git archive`); **fails identically on the unpatched tree** (shallow-clone artifact), so unrelated to this patch |

`node --check` on the patched file: **SYNTAX OK**. The change is additive + fail-open
(one new optional `record.signalIndicators` field inside try/catch), so by
construction it cannot alter any existing signal/stat outcome.

**Do NOT fake these from post-hoc data.** They must be captured at signal time
(they already are, in memory) and persisted as-is.

## 8. R-matrix (the bar)

| Req | Requirement | Result |
|---|---|---|
| **R1** | VAL TRADE-subset WR ≥ 55.6 % **and** Wilson-low ≥ 50 % **and** cov ≥ 15 % | WR 57.9 % ✓, cov 19 % ✓, **Wilson-low 48.9 % ✗** → **NOT MET** |
| **R2** | No leakage; train only on TRAIN | ✅ vocab + standardisation + τ all fit on TRAIN; result/entryHit/exitPrice/checkedAt/entryPrice never used as features |
| **R3** | Monotonic / sane (not a 2-signal cherry-pick) | ✅ coverage 15–19 %, full sweep reported, τ chosen on TRAIN, hand-rule + oracle baselines shown |
| **R4** | Worker-portable deterministic artifact | ✅ `scripts/d4v2_avoidance_gate.js` — pure JS, no deps, reproduces Python P(WIN) to 0.000000 error |

## 9. Leakage statement (R2)

- The encoder (categorical vocabulary + numeric mean/std) is **fit on TRAIN only**.
  VAL rows with unseen categories are encoded as all-zero (no information leak).
- The threshold τ is **selected on TRAIN only** (TRAIN WR maximised at coverage ≥
  the 15 % R1 floor). VAL is touched once, for the final holdout read.
- Features are strictly signal-time. `result`, `entryHit`, `entryHitLegacy`,
  `exitPrice`, `checkedAt`, `entryPrice`, `entryHitWindow*` are **never** features.
- Per-day and sweep views are explicitly labelled post-hoc/illustrative and are
  **not** the basis of any "pass" claim.

## 10. Recommendation / next steps

1. **Do not ship a D4 v2 gate.** R1 is not met; shipping would be a fake edge.
2. **Land the `signalIndicators` instrumentation** (§7) as a separate additive
   worker PR. Zero risk, unblocks the real feature layer.
3. **Re-run `d4_v2_avoidance.py` daily** as data accrues (it is deterministic and
   reads whatever is under `phase_f_forward/`). The script already extends
   gracefully — more holdout rows will tighten the Wilson CIs.
4. **D4 v2.1** = D4 v2 + `rsi/atrPct/adx/bbBandwidth` features, re-tested on a
   fresh 2+ holdout window once instrumentation data exists. This is the most
   promising route to a gate that clears R1.
5. Treat the **VOLATILE regime / 1 min TF / grade-A+** stably-weak slices as
   candidates for the existing D2 hard-block layer (data-backed, like the current
   TRENDING/HIGHEST-session blocks) — but only after a 2-window validation, per
   the Phase-F rule that no gate goes live without it.

## 11. Reproduction

```bash
# from the drive repo root (data under phase_f_forward/)
python3 scripts/d4_v2_avoidance.py --data-dir phase_f_forward
# deterministic; numpy required, sklearn/xgboost optional (cross-checks).
# full console output of this run is captured alongside this report.
```
