# PRE-REGISTRATION — Task 26: FRVP Sentiment-Regime Confluence Filter

**Status:** frozen BEFORE the filter is computed. This document is committed
first on `feature/frvp-regime-filter` (base: `origin/feature/frvp-rr` HEAD
`93a9787`). `main` and the original `feature/frvp-rr` /
`feature/frvp-rr-fx1h` branches are NOT modified. No variant search: the
regime definition, thresholds, and direction mapping below are the single
frozen design, committed before the first number exists.

## 1. Hypothesis (new, standalone)

> Does gating FRVP fade entries on a coarse daily sentiment regime improve
> NET expectancy, versus taking every FRVP signal unconditionally (the
> already-tested baseline)?

FRVP (fade at value-area edges with triple-barrier R:R exits) is the only
gross-positive concept in this project's history (gross +0.054 / +0.125 /
+0.237R per trade for TP=1.5R / 3R / POC, net −3.5…−3.7R at 0.10%/side —
verdict FAIL on costs). The fade logic buys dips (CALL) and sells rips (PUT).
The hypothesis: fades that fight a strong one-way sentiment regime are the
losing subset; removing them should improve average net expectancy — at the
price of removing volume, which is reported side by side, never hidden.

## 2. Data — reuse of the already-run FRVP window (stated explicitly)

- Trade outcomes: `results/FRVP_audit.jsonl.gz` (37,708 `TRD` rows: pair,
  entry timestamp, direction CALL/PUT, entry/SL prices, `ra` R in price,
  `rf` = R as fraction of price, and per-variant resolution + realized
  gross R for TP=1.5R / 3R / POC-frozen-at-decision). This log is the
  verified raw record of the unconditional run (191 + 65 assertion suites).
- Window: 2023-07-05T00:00Z → 2024-07-05T00:00Z — the SAME historical window
  the FRVP test already used.
- **Window-reuse legitimacy (required statement):** this filter is a NEW
  hypothesis derived from no outcome of the FRVP test itself (the regime
  signal, thresholds, and mapping below come from the task spec's generic
  risk-on/risk-off framing, not from inspecting which FRVP trades won). The
  precedent is the crypto FRVP → FX-1h reuse: a genuinely new hypothesis
  family may reuse a burned window; what it may NOT do is re-cut parameters
  of the original concept. The exit mechanics, zone/trigger logic, costs,
  and window here are byte-identical to the original run; the only new
  object is the ex-ante regime gate.
- Equivalence of post-hoc filtering to engine-level gating (frozen
  argument): the original engine took EVERY trigger as an independent
  position (no capital, overlap, or position-count interaction between
  triggers — 88.3% overlap share existed and was reported, not acted on).
  Therefore removing TRD rows by a rule evaluated at their entry instants is
  EXACTLY the run the engine would have produced had the gate been coded
  inside it. No candle re-walk is needed and none is performed.

## 3. Regime signal (frozen single design)

- **Source:** Crypto Fear & Greed Index (alternative.me), daily values.
  Free, public, full history covering the window (starts 2021-02-01).
- **Refresh cadence (stated per the task):** DAILY. All decisions within a
  UTC day share the same regime value.
- **Publication pinning (same discipline as Task 25):** the value stamped
  date D is `known_from = D + 1 day at 00:00 UTC` — deliberately one full
  day later than the source's actual ~00:00 UTC publication. During day D
  the regime uses the value stamped D−1.
- **States:** `risk-on` if value ≥ 60 · `risk-off` if value ≤ 40 ·
  `neutral` if 41–59. (The 40/60 cuts are the standard F&G
  fear/greed band boundaries; the extreme 25/75 variant was considered and
  rejected at design time because it would gate < 5% of days and make the
  hypothesis nearly untestable — this choice is frozen before running, not
  selected after seeing trade outcomes.)
- **Why no macro input:** FRED policy variables (fed funds, 10Y-2Y) move in
  steps of weeks-to-months and are quasi-constant across this 12-month
  window (fed funds within a 25–50bp band for most of it); they cannot
  condition daily entries in any defensible frozen mapping, so the regime
  is sentiment-only. This is the "simpler standalone version" the task
  spec permits.

## 4. Direction mapping (frozen verbatim)

A fade trade's direction contradicts the regime when it fights the prevailing
sentiment trend:

- **CALL fade** (bought a dip below VAL, expecting reversion up) is
  **BLOCKED when regime = risk-off** (F&G ≤ 40).
- **PUT fade** (sold a rip above VAH, expecting reversion down) is
  **BLOCKED when regime = risk-on** (F&G ≥ 60).
- `neutral` blocks nothing. No other combination blocks.

This is the task spec's example mapping ("don't take a CALL fade during a
strongly risk-off regime") made exhaustive and symmetric. The regime for a
trade is looked up at its ENTRY DECISION instant = trigger candle open
`T` + 60s (the engine's own decision instant), using the frozen
`known_from` rule.

## 5. Evaluation (frozen)

- **Variants:** all three exit variants of the original run (TP=1.5R,
  TP=3R, TP=POC) — the filter is the only new object; the exit variants are
  inherited frozen artifacts of the original pre-registration, reported all
  three, no new exit variant is created.
- **Costs:** identical to the original: gross = zero cost; net subtracts
  round-trip taker fees per trade, cost in R = `(2 × perSide) / rf` with
  base perSide = 0.10% and sensitivity rows at 0.05% / 0.20%. The filter
  does not change `rf` (entry/SL mechanics untouched), so per-trade cost is
  unchanged; filtering only changes the trade mix.
- **Statistics per variant, filtered set:** kept n; WR on TP-resolved
  trades with Wilson 95% CI; gross expectancy with normal-approx 95% CI AND
  seeded bootstrap 95% CI (10,000 resamples, seed 20260913, new seed frozen
  here); net expectancy at base cost with the same CIs; TIMEOUT rows keep
  their realized R in expectancy (original convention); the frozen gate is
  **n ≥ 30 AND net expectancy CI-LO (base cost) > 0** — the original gate,
  applied unchanged.
- **Baseline recomputation:** the unconditional numbers (37,708 trades) are
  re-derived from the SAME audit log in this run with the same seed rule —
  both as the side-by-side baseline and as a consistency check against the
  published +0.054 / +0.125 / +0.237R. Any mismatch is an audit finding
  reported before anything else.
- **Filtered-out accounting (mandated by the task):** removed trade count
  and share per variant-identical total, split by direction (CALL vs PUT
  removals), by pair, and by calendar month; expectancy of the REMOVED
  subset (gross and net) — i.e. exactly what the filter threw away — is
  reported for honesty, not as a rescue path.
- **Min-bucket-30:** every per-pair × direction kept-bucket below 30 is
  flagged INSUFFICIENT, no exceptions.
- **F&G data provenance:** raw JSON saved to
  `backtest/data/external/fng_full.json` + sha256 in a provenance note;
  fetcher script committed BEFORE the fetch; fetch timestamps recorded.
  F&G fetch failures would be a disclosed amendment (pre-results only).

## 6. Reporting format

`results/FRVP_REGIME_FILTER_REPORT.md` with: (1) the frozen design as §3–4;
(2) the day-level regime distribution over the window (share of risk-on /
risk-off / neutral days) — the filter's theoretical reach shown BEFORE the
trade-level numbers; (3) headline side-by-side table per variant:
unconditional vs filtered — n, WR, gross expectancy + CI, net expectancy +
CI, gate verdict; (4) filtered-out accounting per §5; (5) per-pair and
per-direction splits; (6) plain-language verdict; (7) reproducibility
(script, log sha256, seed, F&G provenance).

## 7. Honest expectations (declared now, before running)

F&G was ≥ 60 on a large majority of days in this window (greed-dominated
year), so the filter is expected to remove a LARGE share of PUT fades —
possibly 25–40% of all trades. Two pre-framed outcomes: (a) if the removed
subset was the negative-drift subset, filtered net expectancy improves
toward zero but must still clear CI-LO > 0 against ~2.3R median costs to
PASS — the honest prior is that NO cost-side gate flips here, and the
report will say so; (b) if the removed subset was neutral or positive
(fading greed is exactly what worked in this window), the filter WORSENS
expectancy and the verdict says that plainly. Either outcome is a valid
result; the filter is not iterated, re-thresholded, or re-mapped after any
number is seen.

## 8. Prohibitions (restated)

- No threshold/state re-cut after seeing any expectancy number.
- No change to FRVP mechanics (profile, trigger, SL/TP, hold, costs).
- No rescue filter on the removed subset; no "keep both and pick the
  better" reporting — the frozen design is reported as-is, win or lose.
- No claim that post-hoc removal differs from engine gating beyond the §2
  frozen equivalence argument.
- `main`, `feature/frvp-rr`, `feature/frvp-rr-fx1h` untouched.
