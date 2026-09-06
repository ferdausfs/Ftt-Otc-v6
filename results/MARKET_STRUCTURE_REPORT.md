# Market Structure (BOS/CHoCH) — 12-Month Crypto Backtest Report

Standalone test of the Smart Money Concepts "market structure" idea (swing
high/low pivots with L=5, Break of Structure = continuation, Change of
Character = trend flip), implemented independently from the public concept —
no published Pine Script copied, transcribed, or paraphrased. Branch:
`feature/market-structure` (main untouched). No split: the parameters are
frozen textbook defaults, so the entire 12-month block ran once, one pass.

## সারসংক্ষেপ (Bengali summary)

এই পরীক্ষায় Smart Money Concepts-এর "market structure" ধারণাটি (swing
high/low, BOS = ট্রেন্ড চলমান, CHoCH = ট্রেন্ড উল্টানো) সম্পূর্ণ স্বাধীনভাবে
বাস্তবায়ন করে ২০২৩-০৭-০৫ থেকে ২০২৪-০৭-০৫ পর্যন্ত প্রায় ১২ মাসের আগে-কখনো-না-
ব্যবহৃত Bybit ক্রিপ্টো ডেটায় (BTC, ETH, XRP, SOL — ১m + ১৫m) চালানো হয়েছে।
ফলাফল: **FAIL**। ৫৩,৩৩৬টি ট্রিগারে হেডলাইন উইন-রেট **৪৮.২৭%** (Wilson 95% CI
[৪৭.৮৪%, ৪৮.৭০%]) — ব্রেকইভেন ৫৫.৫৬%-এর চেয়ে **৭.৭১ পয়েন্ট নিচে**, এবং
no-skill বেসলাইনের (৪৮.৭–৪৯.৩%) চেয়েও নিচে; অর্থাৎ দিক-নির্বাচনটি
anti-predictive। চারটি পেয়ারেই (৪৭.৪–৪৯.০%), BOS ও CHoCH দুই ধরনেই (৪৭.১% /
৪৯.৫%), তিনটি expiry টিয়ারেই — সব বালতির CI-এর উপরের সীমাও ৫০.৫%-এর নিচে।
কনফার্মেশন-ল্যাগ (pivot L বার পরে ব্যবহারযোগ্য) তিনভাবে প্রমাণিত; ২.২৫ মিলিয়ন
সারির অডিট থেকে ১.৩ কোটিরও বেশি স্বাধীন যাচাই সবুজ। নিয়ম অনুযায়ী কোনো rescue
condition যোগ করা হয়নি, কোনো প্যারামিটার পরিবর্তন হয়নি — ধারণাটি এই উইন্ডোতে
নিজের যোগ্যতায় ব্যর্থ হয়েছে। merge হবে না; শুধু রিপোর্ট।

## 1. What was tested (frozen before the first run)

- **Pivot (L=5, both timeframes):** bar i is a swing high iff `high[i]` is the
  max of `high[i-5..i+5]` (ties count); swing low symmetric. **Confirmation
  lag enforced:** the pivot at i becomes usable only at bar i+L — the
  category's classic leak is closed by construction (single forward pass) and
  proven three ways by tests.
- **C1 Bias (15m):** trend state machine over confirmed pivots — close above
  the last confirmed swing high flips UP (CHoCH) or continues UP (BOS); close
  below the last confirmed swing low mirrors it. Starts UNKNOWN. Each swing
  reference can fire at most once (`broken` flag). Bias = trend as of the
  last CLOSED 15m candle (a 15m bar closing exactly at the trigger close
  counts — knowable at the decision instant).
- **C2 Trigger (1m):** the 1m machine's event at the just-closed bar, in the
  SAME direction as C1's bias. BOS or CHoCH, either counts. Opposite break,
  no break, UNKNOWN bias, or BOTH on one candle -> NO_TRADE with the reason
  logged.
- **Expiry (frozen ladder, shared with every prior test):** ATR(14) on 1m,
  trailing-100 percentile rank at the trigger bar; >=75th -> 5m, 25th–75th ->
  7m, <25th -> 10m. NOTE: unlike FTT3 there is **no ATR-vs-median entry
  gate** — this spec has exactly two conditions; the median is logged for
  audit continuity only.
- **Result:** entry = trigger close; exit = close exactly 5/7/10m later
  (timestamp-checked); WIN/LOSS/TIE; breakeven 55.56% at 0.80 payout.

No parameter was tuned before or after the run. A bad result gets reported
plainly — no rescue condition may be added.

## 2. Data (real, public, no synthesis)

| pair | symbol | 1m candles | warmup | window | tail | gaps |
|------|--------|-----------:|-------:|-------:|-----:|-----:|
| BTC/USD | BTCUSDT | 547,261 | 20,160 | 527,040 | 61 | **0** |
| ETH/USD | ETHUSDT | 547,261 | 20,160 | 527,040 | 61 | **0** |
| XRP/USD | XRPUSDT | 547,261 | 20,160 | 527,040 | 61 | **0** |
| SOL/USD | SOLUSDT | 547,261 | 20,160 | 527,040 | 61 | **0** |

- Source: Bybit spot klines (USDT quote — the same honest ~basis-level proxy
  for /USD used by every prior crypto test in this project). 15m: 36,485
  candles per pair, also zero gaps.
- Window 2023-07-05T00:00Z -> 2024-07-05T00:00Z is the next genuinely unused
  block (prior windows: 2026-07-05..09-05 FTT3, 2025-07-05..2026-07-05
  FTT3-R, 2024-07-05..2025-07-05 EMA Ribbon). Nothing from this window has
  been touched by any earlier test or decision.
- 14-day warmup (from 2023-06-21) so pivots, the trend state and ATR-100 are
  valid at the first evaluated bar; 1h tail so every 5/7/10m expiry resolves.
  No decision is evaluated before the window itself: evaluated bars are
  those whose close time lies in [2023-07-05T00:00Z, 2024-07-05T00:00Z]
  (inclusive at the end; those exits resolve in the tail).
- Fetch discipline: fail loudly on zero candles or absurd gaps; OHLC
  invariants verified on every candle (h>=l, h>=o,c, l<=o,c, c>0); no
  interpolated, repaired, or fabricated bars anywhere. Crypto is 24/7 — all
  eight series are perfectly contiguous.

## 3. Method

One forward pass per pair per timeframe (`buildStructure`), then one pass
over the 1m series composing C1 (bias via a monotonic 15m alignment pointer)
and C2 (the bar's own event) plus the expiry ladder. The decision for bar i
reads only bars <= i (1m) and 15m bars closed at or before i's close time.
Key implementation semantics (all documented in the module header and unit
tested):

- a pivot at i registers at exactly i+L (never earlier) and is immediately
  breakable by that same confirmation bar's close — structurally impossible
  (close > high[i] would disqualify the pivot), which keeps same-bar ordering
  deterministic;
- breaks use strict inequalities (a close exactly AT a level is not a break);
- each swing reference fires at most once; a new event requires a new pivot
  (>= L bars later by construction);
- BOTH (bull and bear break on the same bar) is implemented, labeled, and
  dispatched to NO_TRADE/AMBIGUOUS — but see §5: it is unreachable under
  valid OHLC.

## 4. Results (one block, one pass)

Headline (W/(W+L), Wilson 95% CI; ties excluded from the headline and
reported separately):

| bucket | W | L | T | WR | CI |
|--------|---:|---:|---:|----|----|
| **overall** | 25,045 | 26,836 | 1,455 | **48.27%** | **[47.84%, 48.70%]** |
| break type: BOS | 12,437 | 13,952 | 686 | 47.13% | [46.53%, 47.73%] |
| break type: CHoCH | 12,608 | 12,884 | 769 | 49.46% | [48.85%, 50.07%] |
| event: BOS_BULL | 6,501 | 7,314 | 378 | 47.06% | [46.23%, 47.89%] |
| event: BOS_BEAR | 5,936 | 6,638 | 308 | 47.21% | [46.34%, 48.08%] |
| event: CHoCH_BULL | 6,466 | 6,564 | 398 | 49.62% | [48.77%, 50.48%] |
| event: CHoCH_BEAR | 6,142 | 6,320 | 371 | 49.29% | [48.41%, 50.16%] |
| direction: CALL | 12,967 | 13,878 | 776 | 48.30% | [47.71%, 48.90%] |
| direction: PUT | 12,078 | 12,958 | 679 | 48.24% | [47.62%, 48.86%] |
| expiry: 5m | 6,159 | 6,997 | 381 | 46.82% | [45.96%, 47.67%] |
| expiry: 7m | 10,052 | 10,413 | 633 | 49.12% | [48.43%, 49.80%] |
| expiry: 10m | 8,834 | 9,426 | 441 | 48.38% | [47.65%, 49.10%] |
| pair: BTC/USD | 6,554 | 6,814 | 38 | 49.03% | [48.18%, 49.88%] |
| pair: ETH/USD | 6,405 | 6,681 | 50 | 48.95% | [48.09%, 49.80%] |
| pair: XRP/USD | 6,007 | 6,669 | 805 | 47.39% | [46.52%, 48.26%] |
| pair: SOL/USD | 6,079 | 6,672 | 562 | 47.67% | [46.81%, 48.54%] |

- Conservative rate including ties: 46.96%. Every bucket above is
  SUFFICIENT (n >= 30 by a factor of ~1,000); the minimum-bucket rule never
  suppresses a row here.
- **Every single bucket's CI upper bound is below 50.5%** — far below the
  55.56% breakeven. There is no sub-population (pair, break type, expiry
  tier, direction) that even hints at an edge.
- Consistency: the four pairs land within 1.6pp of each other — consistently
  bad, not noisy.

**GATE (Wilson-LO > 55.56% and consistent across pairs): FAIL.**
Wilson-LO 47.84% vs breakeven 55.56% -> margin **-7.71pp**.

Caveat on independence: trades may overlap (a new trigger can fire while an
earlier 5/7/10m position is still open), so the effective sample size is
somewhat below n=51,881 and the CI slightly optimistic. With Wilson-LO at
47.84% the gap to breakeven is ~7.7pp — no plausible deflation closes it.

## 5. Structural findings (documented, not patched)

1. **The BOTH event is unreachable under valid OHLC.** A bull-and-bear break
   on one bar requires the last swing high to sit strictly below the last
   unbroken swing low; forming such a swing low requires closing above the
   swing high first, which breaks it (and a decline closing below a not-yet-
   confirmed swing low's level would disqualify the pivot via its own window
   minimum). Proven analytically, asserted across 16,000 random-walk bars in
   the property sweep, and confirmed empirically: zero BOTH events in 2.1M
   real bars. The branch stays implemented and tested via direct state
   injection.
2. **Direction selection is anti-predictive here.** Among decided trades the
   outcome split is almost exactly 50/50 (up-moves 25,925 vs down-moves
   25,956) — the C1+C2 selection picks coin-flip bars — and the direction
   choice then subtracts ~1.7pp against a random-direction bettor
   (48.27% vs ~50.0%). CHoCH (fresh flips, 49.5%) outperformed BOS
   (continuations, 47.1%), but both fail hard.
3. **The 2-condition spec has no volatility gate** — unlike FTT3, nothing
   blocks low-ATR entries; the expiry ladder alone reacts to ATR. The quiet-
   market 5m tier is the worst bucket (46.8%), consistent with noise.
4. **Confirmation lag** (the category's classic bug) is enforced by
   construction and proven three independent ways — see §9.

## 6. No-skill baseline

Plain up-rate over the SAME evaluated bars and expiry horizons (exact
timestamp requirement, ties counted, exits restricted to audited candles so
the numbers re-derive from the JSONL alone):

| horizon | n | up | down | tie | up-rate |
|---------|---:|---:|---:|---:|--------|
| 5m | 2,108,144 | 1,025,849 | 1,011,661 | 70,634 | 48.66% |
| 7m | 2,108,136 | 1,033,743 | 1,016,945 | 57,448 | 49.04% |
| 10m | 2,108,124 | 1,038,824 | 1,021,978 | 47,322 | 49.28% |

The strategy's 48.27% sits BELOW every horizon's plain up-rate. On the bars
it actually selected, a fixed-direction coin would score ~50.0%. The
structure filter plus direction rule does not merely fail to add edge — it
selects slightly worse-than-random bets in this window.

## 7. Decision funnel (every bar logged, NO_TRADE reasons included)

| stage | bars |
|-------|-----:|
| evaluated 1m bars (4 pairs) | 2,108,164 |
| no event (NO_BREAK) | 1,998,699 (94.8%) |
| structure event (BOS/CHoCH) | 109,465 (5.19%) |
| — break opposite the 15m bias (OPPOSITE_BREAK) | 56,129 |
| — break matching the bias -> trigger | 53,336 (2.53%) |
| UNKNOWN bias / AMBIGUOUS / EXPIRY_INSUFFICIENT / EXPIRY_GAP | 0 / 0 / 0 / 0 |
| results | 25,045 WIN / 26,836 LOSS / 1,455 TIE |

Every evaluated bar is in the audit with its raw OHLC, bias, event, swing
references in play (value + pivot timestamp + broken flag), decision, reason,
ATR percentile and result; every in-window 15m bar is logged with its
confirmed pivots, events and trend state (2,248,712 rows total).

## 8. Payout sensitivity

At the headline 48.27% W/(W+L) rate the strategy needs a payout of
**107.2%** merely to break even (1/0.4827 - 1); including ties it needs
112.9%. No legitimate broker offers anything close. There is no payout
window in which this edge becomes tradeable.

## 9. Reproducibility

- Tests: `node scripts/market_structure_tests.mjs` — 49,535 assertions, all
  green. Includes the three confirmation-lag proofs: (a) structural sweep —
  1,746 random pivots each confirm at exactly i+L and are invisible at
  i..i+L-1; (b) value mutation — mutating the pivot bar's high changes
  nothing before i+L and changes the reference exactly at i+L; (c) behavioral
  discriminator — a close between the old swing high and a newer higher
  swing high breaks the OLD level before the new pivot confirms (a leaked
  implementation would fire no event at all). Plus the standard no-lookahead
  mutation battery (13 sampled decision rows immutable under mutation of ALL
  later 1m and 15m bars), the 78-bar BOS/CHoCH fixture with a frozen 7-event
  sequence computed by an independent Python machine
  (`scripts/ms_fixture_calc.py`), the C2 dispatch truth table, expiry-ladder
  boundaries, the Wilder ATR fixture, and the break-once/trend-consistency
  property sweep.
- Independent audit verification:
  `node --max-old-space-size=6144 scripts/verify_market_structure_audit.mjs`
  — 13,062,403 checks, 0 failed: every funnel count, rate row (Wilson),
  baseline and gate value re-derived from
  `results/MARKET_STRUCTURE_audit.jsonl.gz` with fresh code; all 53,336
  traded rows traced (53,332 to audited exit rows, 4 to the fetched tail);
  109,465 event rows checked for break consistency; 200,004 bias-chain
  checks against the logged 15m trend states; 1m contiguity and OHLC
  invariants on every row.
- Rebuild from scratch: `node backtest/fetch_ms_data.mjs` (window
  2023-06-21..2024-07-05T01:00Z, cached under `backtest/data/ms/`,
  gitignored) then `node backtest/harness_market_structure.mjs`.
- Audit: `results/MARKET_STRUCTURE_audit.jsonl.gz` (54MB, 2,248,712 rows);
  summary: `results/MARKET_STRUCTURE_summary.json`.

## 10. Verdict

**FAIL.** The market-structure BOS/CHoCH strategy, implemented standalone on
the next unused 12-month crypto window, wins 48.27% [47.84%, 48.70%] against
a 55.56% breakeven — 7.71pp short at the CI lower bound, below the no-skill
baseline, with no pair, break type, expiry tier or direction bucket showing
even a hint of an edge. Per the project rules: the result is reported
plainly; no rescue condition, re-interpretation, or parameter change is
added; this window is now seen and burnt for this concept. Nothing is merged
to main; the branch `feature/market-structure` carries the module, harness,
tests, audit and this report.
