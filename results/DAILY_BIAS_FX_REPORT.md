# Daily Liquidity-Sweep Bias (FX) — Full-History Backtest Report

**VERDICT: FAIL** — the strategy does **not** clear breakeven on any bucket; the
overall win rate lands **below even the matched no-skill baseline**.

> **বাংলা সারমর্ম:** নতুন standalone কনসেপ্ট — daily liquidity-sweep bias
> (গতকালের দিন D-1 যদি তার-আগের দিন D-2-এর high sweep করে আবার তার নিচে
> close করে → PUT) — ২২+ বছরের daily FX history-তে (৪ পেয়ার, ২৪,১৮৫ evaluated
> দিন, Yahoo daily, কোনো fabrication/interpolation নেই) পুরো process
> discipline মেনে একবার চালানো হয়েছে। Win rate **৪৫.১%** (Wilson-LO ৪৩.৬%) —
> breakeven ৫৫.৬%-এর অনেক নিচে, no-skill baseline-এরও নিচে। **ফলাফল: FAIL।**
> Spec-এর evaluation order হুবহু মানা হয়েছে; কোনো rescue-filter, re-order বা
> re-interpretation করা হয়নি। গুরুত্বপূর্ণ structural finding: mandated
> order-এ BULLISH ও VERY_BEARISH শ্রেণি গাণিতিকভাবে unreachable — spec
> আক্ষরিকভাবে শুধুমাত্র PUT ট্রেড করে (রিপোর্ট §৫-এ প্রমাণসহ)।

---

## 1. What was tested (frozen before the first run)

The rule is fully mechanical from D-2/D-1 daily values — **there is no
parameter to tune**, so the usual tuning-after-results risk does not exist
here; the discipline applied instead is: implement the spec literally, run
the whole history once, report plainly, add nothing afterwards.

| Item | Value |
|---|---|
| Classifier order | **exactly as specified**: sweep-both → very-bearish → bearish → bullish → consolidation → else `UNCLASSIFIED` (never guessed into a direction) |
| Trades | BULLISH → CALL · BEARISH / VERY_BEARISH → PUT · anything else → NO_TRADE that day |
| Entry / expiry | open of day D (next available candle after D-1) / close of day D (24h) |
| Result | WIN if D's close moved in the entered direction from D's open, LOSS otherwise, TIE if exactly flat |
| Scope | EUR/USD, GBP/USD, USD/JPY, AUD/USD — daily OHLC only, longest available history |
| Split | **none, by spec**: daily resolution was never touched by this project → entire history = one block, one pass |
| Min bucket | 30 decided trades (smaller → `INSUFFICIENT`, never a rate) |
| Breakeven gate | Wilson 95% lower bound > 55.56% at 0.80 payout; PASS additionally requires consistency across pairs |
| Audit | every evaluated day (traded **and** AVOID) logged with raw values → JSONL |

No classification constant, ordering, or bucket was changed after results
were seen. One bug found and fixed during plumbing (a gate margin computed
with mixed percent/fraction units) changed only the summary's margin display
— decisions, rows and rates were byte-identical between runs, and the
independent verifier re-derives the gate from scratch.

## 2. Data (real, public, no synthesis)

| Pair | Yahoo symbol | Daily span | Candles | Dropped at source | Gaps ≥ 5d |
|---|---|---|---|---|---|
| EUR/USD | EURUSD=X | 2003-12-01 → 2026-09-04 | 5,778 | 162 (2.7%) | 3 |
| GBP/USD | GBPUSD=X | 2003-12-01 → 2026-09-04 | 5,815 | 125 (2.1%) | 1 |
| USD/JPY | USDJPY=X | 1996-10-30 → 2026-09-04 | 7,464 | 324 (4.2%) | 5 |
| AUD/USD | AUDUSD=X | 2006-05-16 → 2026-09-04 | 5,136 | 163 (3.1%) | 0 |

Total 24,193 candles; the first 2 days of each pair are warmup (no D-2
exists), leaving **24,185 evaluated days**. Data-quality notes, all handled
loudly and logged in `backtest/data/daily/*_d1.json` meta:

- **`range=max` is a trap** on this endpoint: Yahoo silently degrades FX to
  *monthly* candles (`dataGranularity: 1mo` was observed). The fetcher uses
  explicit `period1/period2` and asserts 1d granularity.
- **Timestamps**: Yahoo stamps FX daily bars at *London midnight* (00:00Z in
  winter, 23:00Z of the previous UTC day in BST) and ships them UNSORTED.
  Day labels in the audit use `dayLabel()` = UTC date of (t+1h) — display
  only; the strategy consumes the **sequence** of available candles, per the
  non-trading-day convention in the spec.
- **Invalid bars** (2.1–4.2% per pair, e.g. holiday partial sessions like
  2024-01-01 with `close > high`) are **dropped, counted and dated**
  (`meta.droppedDates`) — never repaired, interpolated or fabricated.
- **Source holes** exist and are listed, not papered over: EUR/USD and
  USD/JPY are missing ~13 trading days in Aug-2008 at Yahoo itself; full
  list of ≥5-day gaps in each meta (`gapsOver5Days`). The spec's
  "consecutive AVAILABLE candles" convention absorbs them by construction.
- **Live tail bar**: each pair's last candle is a still-forming snapshot
  (odd intraday stamp / zero-range placeholder) — dropped and logged.
- **Exact-tie artifact**: 23.0% of EUR/USD candles (and 12–20% of the
  others) have `open == close` exactly, with normal high/low ranges — a
  Yahoo single-snapshot stitching artifact, not dead bars. This inflates
  TIEs among trades (19.5% pooled). Report convention handles it honestly:
  headline W/(W+L), conservative W/(W+L+T) also shown.

## 3. Method

- **Candidates:** every available candle from the 3rd onward; its D-2/D-1
  are the two immediately preceding *available* candles (weekends, holidays
  and source holes simply do not exist in the sequence).
- **Outcome:** entry = D's open, exit = D's close; exact equality = TIE.
- **No-lookahead:** the decision reads nothing but D-1 and D-2; day D's own
  high/low (and every later candle) are structurally unread.
  `scripts/daily_bias_tests.mjs` proves this by mutation (46 checks green),
  including a harness-faithful series test where mutating *all* candles
  after day D leaves day D's row byte-identical.
- **Audit trail:** `results/DAILY_BIAS_FX_audit.jsonl` — one row per
  evaluated day: pair, day labels + raw timestamps, **raw D-2/D-1
  high/low/close**, day-D open/close, classification, decision, reason,
  entry, exit, priceDelta, result. Every AVOID day carries its reason
  (`SWEEP_BOTH` / `CONSOLIDATION` / `UNCLASSIFIED`).

## 4. Results (full available history, one block, one pass)

**Headline (n = 4,379 decided, 1,064 ties):**

| Bucket | W | L | T | WR | Wilson 95% CI | Note |
|---|---|---|---|---|---|---|
| **Overall** | **1,973** | **2,406** | **1,064** | **45.1%** | **[43.6%, 46.5%]** | **FAIL vs 55.6%** |
| EUR/USD | 404 | 565 | 354 | 41.7% | [38.6%, 44.8%] | tie-heavy (Yahoo o==c artifact) |
| GBP/USD | 517 | 653 | 133 | 44.2% | [41.4%, 47.0%] | |
| USD/JPY | 604 | 653 | 296 | 48.1% | [45.3%, 50.8%] | |
| AUD/USD | 448 | 535 | 281 | 45.6% | [42.5%, 48.7%] | |
| BULLISH | 0 | 0 | 0 | — | — | **n=0 — unreachable under the spec's own order (§5)** |
| BEARISH | 1,973 | 2,406 | 1,064 | 45.1% | [43.6%, 46.5%] | every trade the literal spec can emit |
| VERY_BEARISH | 0 | 0 | 0 | — | — | **n=0 — unreachable under the spec's own order (§5)** |
| Direction: PUT | 1,973 | 2,406 | 1,064 | 45.1% | [43.6%, 46.5%] | the literal spec is PUT-only |

Conservative WR (ties as losses): **36.2%**. No bucket's point estimate
reaches 50%, let alone breakeven — the *upper* CI bound of the best pair
(USD/JPY, 50.8%) sits below breakeven. This is as clean a FAIL as the
project's gate can produce.

## 5. Structural finding in the spec itself (documented, not patched)

While writing the tests, a mathematical property of the mandated evaluation
order surfaced, and it changes what this strategy *is*:

- **VERY_BEARISH is unreachable.** It requires `D-1.high > D-2.high` AND
  `D-1.close < D-2.low`. Valid OHLC gives `D-1.low ≤ D-1.close < D-2.low`,
  so `D-1.low < D-2.low` also holds → the sweep-both check, which the spec
  mandates be evaluated FIRST, always captures such a day first.
- **BULLISH is unreachable too.** It requires `D-1.low < D-2.low` AND
  `D-1.close > D-2.high` while NOT being a double sweep (i.e.
  `D-1.high ≤ D-2.high`). But valid OHLC gives `D-1.high ≥ D-1.close >
  D-2.high` — contradiction. Every bullish-shaped day is necessarily a
  double sweep → `SWEEP_BOTH` fires first.

An exhaustive enumeration of 102,541 valid D-2/D-1 combinations
(`scripts/probe_spec_reachability.mjs`, run once) confirms: **BULLISH = 0,
VERY_BEARISH = 0**; the 46-check suite asserts it on random tuples as well.

Consequences, handled per the spec's own rules:

- The literal spec is a **PUT-only fade of failed upside sweeps**
  (high swept, low not swept, close back below D-2's high). That is the
  strategy this report actually measures.
- The spec says "evaluate in the exact order given", "don't guess" for
  anything unclassified, and the project rules say no rescue conditions.
  Therefore the order was **not** re-arranged, BULLISH was **not**
  re-interpreted, and no symmetric bullish leg was **added** — any of those
  would be a different strategy.
- If the intended design was the symmetric fade (a true BULLISH analog),
  that is a legitimate **new hypothesis to pre-register on fresh,
  not-yet-seen data only**. The window above is now seen and cannot be
  reused for it. The UNCLASSIFIED bucket (which absorbed all low-sweep
  days) is intentionally left un-analyzed for the same reason — its day
  counts are in the audit; its outcomes were not mined.

## 6. No-skill baseline (plain daily up-rate, same history)

| Pair | up | down | tie | up-rate | down-rate |
|---|---|---|---|---|---|
| EUR/USD | 2,384 | 2,066 | 1,328 | 53.6% | 46.4% |
| GBP/USD | 2,805 | 2,511 | 499 | 52.8% | 47.2% |
| USD/JPY | 3,207 | 3,214 | 1,043 | 50.0% | 50.0% |
| AUD/USD | 2,234 | 1,899 | 1,003 | 54.0% | 46.0% |
| **Pooled** | 10,630 | 9,690 | 3,873 | **52.3%** | **47.7%** |

The spec's baseline is the up-rate; since the literal spec only ever trades
PUT, the **matched** no-skill rate is the down-rate: pooled **47.7%**. The
strategy's 45.1% is **2.6pp below** that — the pattern is not merely
edgeless, it is *anti*-predictive on this history.

Diagnostic (descriptive only, no filter may be built on it): on the 5,443
days the rule chose to PUT, the day actually closed UP 58.3% (EUR/USD),
55.8% (GBP/USD), 52.0% (USD/JPY) and 54.4% (AUD/USD) of the time — all
*above* those pairs' own base up-rates. Days that sweep D-2's high and fail
to hold it resolve **up** more often than average on daily FX — the exact
opposite of the fade thesis.

## 7. Decision funnel (every day logged, AVOID days included)

| Stage | Days |
|---|---|
| Available candles (4 pairs) | 24,193 |
| Warmup (no D-2 yet; 2 per pair) | 8 |
| **Evaluated days** | **24,185** |
| Traded (all PUT) | 5,443 (22.5%) |
| AVOID — UNCLASSIFIED | 12,988 (53.7% of all days) |
| AVOID — CONSOLIDATION | 3,393 |
| AVOID — SWEEP_BOTH | 2,361 |

The mandated ordering pushes an absolute majority of all trading days into
`UNCLASSIFIED` (single-side low sweeps that don't close above D-2's high,
and high-sweep continuation days that close above it) — logged with that
reason on every such day in the audit, exactly as the spec requires.

## 8. Payout sensitivity

Breakeven WR = 1/(1+payout). With the overall Wilson-LO fixed at 43.6%,
this strategy stays negative for **every** payout below ~129% — no
realistic broker payout rescues it. At 0.70 → breakeven 58.8%; at 0.80 →
55.6%; at 0.90 → 52.6% (all far above 43.6%, and above every pair's
upper CI bound too).

## 9. Reproducibility

```bash
node backtest/fetch_daily_fx.mjs        # real daily candles -> backtest/data/daily/ (gitignored)
node backtest/harness_daily_bias.mjs    # one block, one pass -> results/ + audit JSONL
node scripts/daily_bias_tests.mjs       # 46 checks incl. no-lookahead mutation proofs
node scripts/verify_daily_bias_audit.mjs # independent recount of every headline number
```

- `results/DAILY_BIAS_FX_audit.jsonl` (24,185 rows, committed) — every
  evaluated day with raw D-2/D-1/D values, classification, decision,
  reason, entry, exit, result.
- `scripts/verify_daily_bias_audit.mjs` re-derives every number in this
  report from that file with an **independently re-implemented** classifier
  and Wilson formula (94 checks): rows traced to raw candles, funnel,
  all buckets, structural zeros, baselines recomputed from the raw candle
  files, gate recomputed from scratch.
- The standalone module imports nothing from any prior strategy file.

## 10. Verdict

**FAIL.** The daily liquidity-sweep bias, exactly as specified, has no edge
on 22+ years of daily FX history across all four pairs — it underperforms
even the matched no-skill baseline. Per the project's standing rule this
test **stands alone**: nothing was combined with it, no rescue condition was
added, and no bucket was re-cut after the fact. The structural §5 finding
(unreachable BULLISH/VERY_BEARISH under the mandated order) is reported for
the spec author's decision; any symmetric or re-ordered variant is a new
strategy that must be pre-registered and tested on fresh, untouched data.
