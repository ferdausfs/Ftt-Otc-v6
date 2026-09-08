# FRVP Fade + Triple-Barrier R:R Exit — Report

**VERDICT: FAIL (net of costs) — but the first GROSS-POSITIVE result of this project.**
Under the frozen gate (net expectancy CI lower bound > 0 at stated costs) all three TP
variants fail: the gross edge is real but ~30× smaller than realistic transaction costs.
No parameter was changed after seeing results; no rescue condition is proposed.

> **বাংলা সারমর্ম:** এই টেস্টে নতুন exit model — আগের সব টেস্টের fixed-time binary payout
> নয়, বরং TP/SL triple-barrier (R-multiple target, ১২০ মিনিট max hold)। Entry: trailing-24h
> volume profile (৫০ bins), Value Area (৭০% volume) — price VAH/VAL ভেদ করে আবার ভেতরে
> close করলে fade (PUT/CALL), SL = trigger wick ± 0.1×range। ফলাফল: **gross expectancy
> তিনটা TP variant-এই positive — এই প্রজেক্টের প্রথম gross-positive ফলাফল** (1.5R: +0.054R,
> 3R: +0.125R, POC target: +0.237R; তিনটাই CI-LO > 0, ১৩ মাসের মধ্যে ১১–১৩ মাস positive)।
> কিন্তু 1m fade-এর stop distance (R) median মাত্র price-এর ~0.088% — Bybit taker fee
> (0.1%/side → round trip 0.2%) trade-প্রতি median ~2.3R খরচ করে। Net expectancy
> −1.6R থেকে −3.7R। Gross edge খরচের ~৩০ গুণ ছোট → **tradeable নয়, verdict FAIL**।
> Breakeven fee হতে হতো ~0.0035–0.015%/side — Bybit base tier-এর ৭–৩০ ভাগের ১।
> কোনো parameter পরে বদলানো হয়নি, কোনো rescue-filter নেই, main-এ merge হয়নি।

---

## 1. What is different here (and why the old breakeven does not apply)

Every prior test in this project (FTT3 50.5%, FTT3-R 48.0%, EMA Ribbon 49.0%,
Market Structure 48.3%, Daily-Bias FX 45.1%) resolved each signal as a fixed-time
binary bet against the 55.56% breakeven at 0.80 payout. This test changes the EXIT
MODEL, not just the indicator: each trade carries a structural stop-loss, one of three
take-profit targets, and a 120-minute time barrier. With asymmetric R:R, **win rate
alone does not decide profitability — expectancy (average realized R per trade) does**:

```
Expectancy (R) = mean(realized R) over TP (+target R), SL (−1R),
                 TIMEOUT (actual R at the 120-minute close)
```

A 42% win rate with 1.5R winners is +0.05R; a 13% win rate with 5.8R winners can also
be positive. The old "WR vs 55.56%" framing is therefore **not applicable** here and is
not used anywhere in this report.

The correct statistical null for this exit model is elegant: for a driftless price
process (any martingale), expected realized R is **exactly 0 for ANY barrier geometry**
(optional stopping). So `expectancy CI lower bound > 0` is a direct, assumption-light
statement that price drifts in the fade direction after the trigger. That is the test.

## 2. Commitments frozen before the first run

All parameters and rules below were committed to git (**`691dd10`**, pre-registration
commit, message states "NO results yet") before the harness ever ran. Nothing changed
afterwards; the harness ran three times only to fix code bugs *before* any result was
consumed (a trigger-dispatch bug that produced zero trade rows, a null-guard crash in
the console printer, and a `point`/`mean` naming slip — all display/plumbing, decision
math untouched and re-verified end to end).

| Item | Value |
|---|---|
| Profile | trailing 24h of 1m candles = exactly 1440 closed candles **closing strictly before** the decision candle (trigger candle excluded from its own profile); 50 equal bins over [24h min low, 24h max high]; volume = real Bybit `v`, spread uniformly across the bins a candle's [low, high] spans |
| POC | max-volume bin (tie → lowest-priced bin); POC price = bin midpoint |
| Value Area | greedy expansion from POC, richer neighbor first, **exact tie → UP first**, until cumulative ≥ 70% of window volume; VAH/VAL = edges of the accumulated range |
| Trigger (1m, strict) | PUT: high > VAH AND close < VAH · CALL: low < VAL AND close > VAL · both pierced in one candle → NO_TRADE (`BOTH_PIERCED`) · zero-range candle → NO_TRADE (`ZERO_RANGE`) |
| Entry / SL / R | entry = trigger candle close · SL = trigger high + 0.1×range (PUT) / trigger low − 0.1×range (CALL) · R = \|entry − SL\| |
| TP variants (3, all reported) | (a) 1.5R · (b) 3R · (c) POC price frozen at decision time; POC not strictly beyond entry → that trade runs with **no** profit barrier, flagged `pocDegenerate` |
| Resolution | walk 1m candles strictly after entry; inclusive touches; **both barriers in one candle → SL** (conservative, no intra-candle path assumption); fills at barrier price; TIMEOUT at the 120-minute candle's close (own bucket, own R, excluded from headline WR); data-end → CENSORED |
| Overlap | every trigger taken (independent positions); overlap share reported |
| Costs | gross = zero cost; NET = round-trip taker fees, cost in R = (2×perSide)/(R/price); base 0.10%/side, sensitivities 0.05% / 0.20% |
| Gate (frozen) | per variant: n ≥ 30 AND **net** expectancy (base cost) bootstrap/normal CI-LO > 0 |
| Window | 2023-07-05T00:00Z → 2024-07-05T00:00Z, one pass, no split (frozen textbook params) |
| Inference | Wilson 95% on WR; normal-approx 95% + seeded bootstrap 95% (5,000 resamples, seed 20260908) on expectancy |

## 3. Data and the reuse question (stated explicitly, as required)

| Pair | Source | 1m span | 1m candles | gaps |
|---|---|---|---|---|
| BTC/USD | Bybit spot | 2023-06-21T00:00Z → 2024-07-05T01:00Z | 547,261 | 0 |
| ETH/USD | Bybit spot | same | 547,261 | 0 |
| XRP/USD | Bybit spot | same | 547,261 | 0 |
| SOL/USD | Bybit spot | same | 547,261 | 0 |

The evaluable block is 2023-07-05T00:00Z → 2024-07-05T00:00Z (527,041 1m decisions per
pair, 2,108,164 total); the 14 preceding days are warmup for the 1440-candle profile and
the 1 trailing hour lets late entries resolve (result: **0 censored trades**).

**Why reusing history is legitimate here** (and was NOT in the FTT3 → FTT3-R case):
the ML-feasibility block (2021-11-01 → 2026-09-05) was consumed by earlier work, but
FRVP+R:R is a genuinely new hypothesis family — a value-area fade ENTRY plus a
triple-barrier EXIT — derived from no prior outcome of this project. Nothing in this
spec was tuned or selected using any previous test's results. Per the task spec, the
preferred window is the 2023-07-05 → 2024-07-05 block (fetched for the Market Structure
test with warmup + tail, zero gaps), and that is what was used. One honest caveat: the
Market Structure test has *seen* this exact block (for a different concept — BOS/CHoCH
breakout entries, binary expiry). No derivation link exists between that test and this
spec, but this window is no longer virginal for the project as a whole; a confirmatory
walk on fresh future data would be the clean next step before anyone weights the gross
finding heavily.

## 4. Funnel

| Stage | Count | Share |
|---|---|---|
| Evaluated 1m decisions (4 pairs, 12 months) | 2,108,164 | 100% |
| NO_TRIGGER (candle entirely inside value area) | 1,345,600 | 63.8% |
| PIERCE_NO_REJECT (pierced VAH/VAL, closed outside) | 724,845 | 34.4% |
| BOTH_PIERCED (noise candle, frozen NO_TRADE) | 11 | 0.0005% |
| **Trades** (PUT 18,403 / CALL 19,305) | **37,708** | 1.79% |
| POC target degenerate (no profit barrier) | 100 | 0.27% of trades |
| ZERO_RANGE / WARMUP / CENSORED trades | 0 / 0 / 0 | — |

Per pair: BTC 8,740 · ETH 8,743 · XRP 10,076 · SOL 10,149 trades — every reported
bucket clears the minimum-30 rule by two orders of magnitude.

## 5. Results — all three TP variants, reported side by side

### Headline table (n = 37,708 per variant)

| Metric | TP = 1.5R | TP = 3R | TP = POC |
|---|---|---|---|
| Win rate W/(W+L) | 42.1% | 27.8% | 13.4% |
| Wilson 95% CI | [41.6, 42.6] | [27.3, 28.2] | [13.0, 13.7] |
| Conservative rate (TO as loss) | 41.9% | 27.3% | 12.6% |
| Timeout rate | 0.5% (188) | 1.8% (692) | 6.0% (2,257) |
| Avg win R | +1.500 | +3.000 | +5.796 |
| Avg timeout R | +0.199 | +0.839 | +5.378 |
| **Expectancy, gross (R)** | **+0.054** | **+0.125** | **+0.237** |
| Normal 95% CI | [+0.042, +0.066] | [+0.107, +0.143] | [+0.196, +0.278] |
| Bootstrap 95% CI | [+0.042, +0.067] | [+0.106, +0.143] | [+0.195, +0.279] |
| **Expectancy, net @ 0.10%/side (R)** | **−3.695** | **−3.625** | **−3.512** |
| Net 95% CI (base) | [−3.915, −3.476] | [−3.844, −3.406] | [−3.734, −3.290] |
| Net @ 0.05%/side | −1.821 | −1.750 | −1.638 |
| Net @ 0.20%/side | −7.445 | −7.374 | −7.262 |
| **Frozen gate (net CI-LO > 0)** | **FAIL** | **FAIL** | **FAIL** |

Sanity check of the expectancy arithmetic (1.5R): 0.421×1.5 − 0.576×1 + timeouts ≈
+0.05R ✓. The same shape holds for 3R and POC.

### Per pair (gross expectancy in R; WR in %)

| Pair | 1.5R WR [CI] | 1.5R exp | 3R exp | POC exp | POC WR |
|---|---|---|---|---|---|
| BTC/USD | 42.1 [41.1, 43.2] | +0.055 [LO +0.029] | +0.136 | +0.286 | 13.9% |
| ETH/USD | 42.6 [41.6, 43.7] | +0.066 [LO +0.040] | +0.162 | +0.339 | 13.9% |
| XRP/USD | 42.1 [41.1, 43.1] | +0.054 [LO +0.030] | +0.128 | +0.188 | 13.0% |
| SOL/USD | 41.7 [40.7, 42.7] | +0.043 [LO +0.019] | +0.079 | +0.156 | 12.9% |

Every pair is individually positive on gross expectancy for every variant — the edge
is not one coin's artifact. By direction: PUT +0.056 / CALL +0.052 (1.5R) — balanced.

### Monthly consistency (gross, R — see `results/FRVP_monthly.json`)

1.5R: positive in 11 of 13 months (worst full month −0.005, March 2024 +0.015; the
truncated July-2024 stub is negative at n=338). 3R: positive in **13 of 13** months.
POC: positive in 12 of 13. The edge is temporally diffuse, not a one-month blowout —
which matters because the naive CI below treats 37,708 heavily-overlapping trades as
independent and is therefore anti-conservative (88.3% of triggers fired while a
previous trade was still open; effective n is materially smaller, though monthly
dispersion suggests the sign of the gross edge survives).

## 6. Why a real gross edge dies: the cost swamp

The trigger candle defines R, and on 1m candles that stop distance is tiny:

| R as fraction of price (`rf`) | value |
|---|---|
| p05 / p25 / **median** / p75 / p95 | 0.020% / 0.048% / **0.088%** / 0.156% / 0.363% |
| mean | 0.129% |

Round-trip taker cost of 0.20% therefore equals **~2.3R at the median trade** (1.55R at
the mean) — before slippage, before spread-crossing on entry, both of which the fill
model ignores (touch fills at barrier prices, entry at the trigger candle's close,
mid-based OHLC; SL gap-fills never occurred, `gapSensitive` count = 0, so the
barrier-price fill assumption is not doing hidden work here).

Set against a gross edge of +0.054R (1.5R variant), costs exceed the edge by ~30×.
Breakeven fees for this strategy would be **~0.0035%/side (1.5R) to ~0.015%/side
(POC)** — 7× to 30× below Bybit's base spot taker fee of 0.10%, and below plausible
maker+maker tiers too. No realistic cost scenario turns net positive; the net column
is not a modeling technicality, it is the verdict driver.

**Cost/spread assumption stated plainly:** entries at trigger-candle close (last-trade
OHLC), exits at exact barrier prices, zero slippage, zero spread, taker fee 0.10%/side
base (sensitivities 0.05%/0.20%). The gross row is what remains if someone believes
they can trade at ~0.003%/side all-in — that claim is not made here.

## 7. Verdict and what it means honestly

1. **Frozen gate verdict: FAIL on all three TP variants** (net expectancy CI-LO ≈
   −3.5R to −3.9R ≪ 0). As specified — spot entries, real fees — this strategy is not
   tradeable. Nothing merges; nothing deploys; the parameters are not to be re-cut on
   this window.
2. **The gross finding is nonetheless the first of its kind in this project.** Five
   prior TA-concept tests landed at or below no-skill. Here, all three exit variants,
   all four pairs, and 11–13 of 13 months show positive gross expectancy with CI-LO
   strictly above 0 — i.e., measurable conditional drift in the fade direction after a
   value-area pierce-and-reject. The R:R exit model did exactly what the task spec
   hoped: it exposed a small real regularity that the binary-payout framing could
   never have paid for.
3. **Magnitude discipline:** the edge is ≈ 0.05R per trade with R ≈ 0.09% of price —
   ≈ 0.005% of notional per trade. It is a microstructure-scale regularity, interesting
   as knowledge, not as a retail spot strategy.
4. **Rescue prohibition honored:** no fee fantasy, no maker-only assumption beyond the
   stated sensitivities, no bin/VA/buffer/hold re-tuning, no filter added post-hoc.
   Any follow-up (e.g., a maker-only pre-registered variant, or the same exit model on
   higher-timeframe profiles where R is larger relative to costs) must run on **fresh,
   previously-unseen data** with its own pre-registration.

## 8. Audit and reproducibility

- `results/FRVP_audit.jsonl.gz` — 2,108,164 `M1` rows (every evaluated 1m bar: decision,
  reason, full profile context) + 37,708 `TRD` rows (direction, entry, SL, R, all three
  TP levels with resolution type, realized R, minutes held, gap flag per variant,
  POC-degeneracy, overlap count). All numbers above re-aggregate from this file.
- `scripts/frvp_fixture_calc.py` + `frvp_fixtures.json` — independent Python
  implementation of the frozen spec; 6 profile fixtures + 12 triple-barrier fixtures
  (TP-first, SL-first, both-in-one→SL for both directions, exact-120m TIMEOUT, CENSORED,
  inclusive boundary touch, gap-through-SL, no-TP barrier, entry-candle-not-walked,
  hold-boundary).
- `scripts/frvp_tests.mjs` — 191 assertions green: fixture cross-check, incremental
  profile state vs full recompute at all 28,560 decision points of a 30k real-BTC slice
  (bins elementwise), no-lookahead mutation battery (trigger candle excluded from its
  own profile; in-window mutations change the profile; post-decision bars irrelevant).
- `backtest/harness_frvp.mjs` — the run; `backtest/tripleBarrier.mjs` — reusable
  resolution engine; params frozen in commit `691dd10` before the first run.
- `scripts/verify_frvp_audit.mjs` — **65/65 checks green**, fully independent
  re-implementation: every one of the 37,708 trades × 3 variants re-walked from raw
  candles with freshly written code (including exact-precision profile re-derivation
  per trade), funnel/WR/Wilson/expectancy/net/bootstrap/per-pair/per-direction/gate
  re-derived and matched; monthly table re-derived.
- Branch: `feature/frvp-rr` (two commits: pre-registration `691dd10`, results+report).
  `main` untouched; live FTT3 collector unaffected.
