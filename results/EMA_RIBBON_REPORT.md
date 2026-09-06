# EMA Ribbon — 12-Month Never-Touched History Report

**Verdict: FAIL.** The strategy does not reach breakeven, does not reach the
no-skill baseline, and no sub-bucket comes close. 61,589 decided signals over
a fully unseen 12-month window put the Wilson 95% CI at [48.6%, 49.4%] —
the upper bound is 6.2 percentage points below the 55.56% breakeven. This is
reported plainly, per the pre-registration: a clean high-confidence FAIL is a
valid, useful finding, and no filter, condition, or parameter may be added to
rescue it in this run.

Pre-registered in commit `cce3071` (`PRE_REGISTRATION_EMA_RIBBON.md`) before
the harness ever touched the target data. Parameters are frozen textbook
values; the whole window was run as ONE block — no split, no tuning step, one
pass, this report.

## 1. What was tested

A standalone EMA ribbon strategy (`src/strategy/emaRibbon.mjs`, unrelated to
and importing nothing from FTT3's `engine.mjs` or FTT3-R's
`regime.mjs`/`meanReversion.mjs`):

- **C1 — bias (15m):** EMA(5)/EMA(13)/EMA(55) on the last closed 15m candle.
  Full bullish order → CALL only; full bearish order → PUT only; any other
  order (tangled, including equalities) → NO_TRADE.
- **C2 — trigger (1m):** EMA(5)/EMA(7)/EMA(13) on 1m candles. Trigger fires
  only on the flip candle — the first closed 1m candle in full alignment
  matching C1's bias whose immediately prior candle was not. Direction
  disagreement → NO_TRADE.
- **Expiry:** the FTT3 ATR ladder reused verbatim (ATR(14) 1m, trailing-100
  percentile; ≥75th → 5m, 25–75th → 7m, <25th → 10m). Duration selector
  only — no volatility gate exists in this strategy.
- Entry at the trigger candle's close; exit at the close n minutes later
  (same fixed-time convention as every prior engine here).

## 2. Data — genuinely unused, and gapless

| | |
|---|---|
| Window | 2024-07-05T00:00:00Z → 2025-07-05T00:00:00Z (12 months, decisions) |
| Warmup | 2024-06-28 → window open, indicators only, never evaluated (10,079 1m candles/pair skipped) |
| Tail | 15 min past the end for expiry resolution |
| Pairs | BTC/USD, ETH/USD, XRP/USD, SOL/USD (Bybit spot USDT quote — the same ~basis-level proxy as all prior crypto fetches in this project) |
| Timeframes | 1m + 15m only (all this strategy needs) |
| Quality | 535,696 1m + 35,714 15m candles per pair; **0 missing on the grid** for every pair/TF; max gap = grid step |
| Evaluated boundaries | 525,600 per pair × 4 = **2,102,400** (every 1m candle close inside the window) |

Every crypto candle this project had fetched before covers 2025-07-05T00:00Z
onwards (FTT3's window plus FTT3-R's extension), so no candle in this window
had been seen, evaluated, or tuned on by anyone involved. Zero-candle and
missing-warmup fetch checks failed loudly if tripped (they never tripped).

## 3. Decision funnel (all 2,102,400 evaluated boundaries)

| Stage | Boundaries | Share |
|---|---:|---:|
| Evaluated | 2,102,400 | 100% |
| C1 blocked — ribbon tangled (incl. equalities) | 624,645 | 29.7% |
| C2 blocked — no flip this candle | 1,350,624 | 64.2% |
| C2 blocked — flip disagrees with bias | 65,042 | 3.1% |
| **Signals (C1+C2 pass)** | **62,089** | **2.95%** |
| Ties | 500 | |
| EXPIRY_GAP | 0 | |

The blocking convention matches every prior engine: C1 blocks carry the 15m
ribbon values, C2 blocks carry C1 + C2 values, and the 1m flip is never
computed on a C1-blocked row (audit.c2 = null — nothing claimed that was not
evaluated). Boundaries whose prior 1m candle is missing from the source block
as `C2_PRIOR_CANDLE_GAP` rather than fabricating adjacency (0 such rows
occurred in this gapless dataset; the reason is covered by tests).

## 4. Results — headline and every bucket

Win rate = W/(W+L), decided signals only; Wilson 95% CI; ties excluded from
the headline and listed separately. Conservative W/(W+L+T) noted below. All
buckets here exceed the 30-signal minimum, so none is INSUFFICIENT.

| Bucket | W | L | T | WR | Wilson 95% CI |
|---|---:|---:|---:|---:|---|
| **Overall** | 30,190 | 31,399 | 500 | **49.0%** | **[48.6%, 49.4%]** |
| CALL | 15,923 | 16,751 | 274 | 48.7% | [48.2%, 49.3%] |
| PUT | 14,267 | 14,648 | 226 | 49.3% | [48.8%, 49.9%] |
| Expiry 5m | 7,093 | 7,618 | 151 | 48.2% | [47.4%, 49.0%] |
| Expiry 7m | 11,805 | 12,301 | 200 | 49.0% | [48.3%, 49.6%] |
| Expiry 10m | 11,292 | 11,480 | 149 | 49.6% | [48.9%, 50.2%] |
| BTC/USD | 7,551 | 7,824 | 3 | 49.1% | [48.3%, 49.9%] |
| ETH/USD | 7,558 | 8,055 | 26 | 48.4% | [47.6%, 49.2%] |
| XRP/USD | 7,309 | 7,641 | 322 | 48.9% | [48.1%, 49.7%] |
| SOL/USD | 7,772 | 7,879 | 149 | 49.7% | [48.9%, 50.4%] |

Conservative overall rate (ties in the denominator): 48.6%. No bucket's
CI lower bound reaches even 50%, let alone breakeven. The best bucket
(SOL 49.7% [48.9, 50.4]) and the best tier (10m 49.6%) are statistically
indistinguishable from a coin flip, and from each other — there is no
pair- or tier-specific pocket of edge to misread here.

## 5. No-skill baseline comparison

Up-rate over the same expiry windows across ALL 2,102,400 evaluated
boundaries, same gap/tie handling as the strategy (ties stay in the
denominator — this is P(up), not a win rate):

| Window | n | up | down | tie | Up-rate |
|---|---:|---:|---:|---:|---:|
| 5m | 2,102,400 | 1,042,516 | 1,037,473 | 22,411 | 49.59% |
| 7m | 2,102,400 | 1,045,405 | 1,038,017 | 18,978 | 49.72% |
| 10m | 2,102,400 | 1,048,314 | 1,038,486 | 15,600 | 49.86% |

The strategy wins 49.0% — **below every no-skill window** (−0.6pp vs the
5m window, −0.9pp vs 10m). Following a ribbon flip signal was, if anything,
slightly worse than always guessing "up" with the same expiry. To clear
breakeven at 0.80 payout a strategy needs roughly +5.9pp over this baseline;
this one starts −0.7pp under it.

## 6. PASS/FAIL gate and payout

Gate (pre-registered): overall Wilson-LO strictly above breakeven with
n ≥ 30. Actual: Wilson-LO 48.6% vs breakeven 55.56% → **FAIL**.

Payout assumption 0.80 → breakeven 55.56%, identical to every prior test in
this project. **The actual broker payout must be confirmed before finalizing
any live decision.** Sensitivity of breakeven: 0.70 → 58.82%, 0.75 → 57.14%,
0.80 → 55.56%, 0.85 → 54.05%. Even at an unrealistic 0.85 payout the entire
CI [48.6, 49.4] stays below breakeven, so the FAIL verdict is robust to any
plausible payout.

## 7. Reproducibility

Every number above is re-derived from the committed audit by an independent
script — 80/80 checks passed:

```
node backtest/fetch_data_ext2.mjs          # data (cached under backtest/data/ext2, not committed)
node backtest/harness_ema_ribbon.mjs       # one pass over the frozen block
node scripts/verify_ema_ribbon_audit.mjs   # recount from results/EMA_RIBBON_audit.jsonl.gz
node scripts/ema_ribbon_tests.mjs          # 100 checks + 7,192 per-row checks
```

- `results/EMA_RIBBON_audit.jsonl.gz` — one row per evaluated boundary:
  pair, ts, decision, stage, reason, full C1/C2 condition values (EMAs to
  8 decimals; prices to 6), expiryMinutes, atrPercentile, entry/exit,
  result, priceDelta, and per-row no-skill markers **dir5/dir7/dir10**
  (+1 up / −1 down / 0 tie / null gap) over every boundary — an
  improvement over older audits, where the baseline could not be
  recomputed from rows alone.
- The verifier re-computes the funnel, all four rate tables, all Wilson
  bounds, and the baselines from those markers alone, and cross-checks that
  every signal's result agrees with the absolute direction marker of its own
  expiry window (CALL wins on up, PUT wins on down), and that
  priceDelta = exit − entry on every resolved signal.
- Strategy correctness: 100 assertions + 7,192 per-row checks against
  fixtures frozen by the independent Python calculator
  (`scripts/fixture_calc_ema_ribbon.py`), including no-lookahead mutation
  proofs (mutating any candle not fully closed before entry cannot change
  the decision on either value path) and leakage canaries (mutating the
  entry candle, the prior candle, or the last-closed 15m candle DOES change
  the output — the suite can detect leakage).

## 8. Reading of the result

Within this 12-month, 4-pair, 1m/15m crypto block, the retail EMA ribbon
setup — higher-timeframe full-order bias plus 1m fast-ribbon flip trigger —
has no predictive edge for fixed-time outcomes at the 5/7/10-minute ATR
ladder expiries. Three independent strategy families have now been tested on
clean unseen windows with the same discipline (FTT3 3-condition trend:
50.5%; FTT3-R regime split: 48.0%; this ribbon: 49.0%), and all three land
within a point of the no-skill up-rate and well under breakeven. That
consistent pattern is itself a finding: nothing in this project's testing
has produced evidence of exploitable short-horizon structure in these
markets, and the burden of proof stays on any future hypothesis.

Per the pre-registration: this result is final for this run — no parameters
may change, no third condition may be added, and nothing may be merged into
`main` or deployed on the strength of this test. `main` continues running
FTT3 as the live audited collector, untouched by this branch.
