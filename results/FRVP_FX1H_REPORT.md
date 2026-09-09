# FRVP Fade + Triple-Barrier R:R — FX 1h (Step 1 of higher-timeframe validation)

**VERDICT: FAIL (net of costs) — and, unlike the crypto version, no gross edge was
detectable on this window either.** Under the frozen gate (net expectancy CI lower
bound > 0 at the stated costs) all three TP variants fail. The one thing the
hypothesis predicted — that a higher timeframe would shrink cost-as-a-fraction-of-R —
did happen (~0.23R/trade vs crypto's ~2.3R, a ~10× improvement). But the gross edge
itself did not materialize on FX 1h: point estimates are slightly negative with
confidence intervals spanning zero. No parameter was changed after seeing results;
no rescue condition is proposed; the USD/JPY outlier is reported, not promoted.

> **বাংলা সারমর্ম:** এই টেস্ট crypto FRVP ফলাফলের পরের ধাপ — higher-timeframe
> validation-এর Step 1: একই FRVP fade + triple-barrier R:R exit, কিন্তু FX-এ 1h
> native timeframe-এ (EUR/USD, GBP/USD, USD/JPY, AUD/USD; histdata tick feed,
> ২০২৬ জুন → সেপ্টেম্বর; 480-candle warmup-এর পরে ~১,১৯০টা evaluable 1h candle
> প্রতি pair-এ)। হাইপোথিসিস: 1h-এ stop distance (R) বড় হবে → cost-as-fraction-of-R
> tradeable হবে। দুটো সতর্কতা সোজাসুজি বলে নিচ্ছি: (১) **FX volume হলো tick-count
> proxy — আসল traded volume নয়** (forex decentralized/OTC, আসল size মাপার কোনো
> central venue নেই); (২) **ডেটা ছোট** — evaluable window মাত্র ~৭৫ ক্যালেন্ডার
> দিন, তাই confidence interval চওড়া, যেকোনো ফলাফলে দৃঢ় বিশ্বাস করার সুযোগ নেই।
> ফলাফল: **gross edge নেই** — 1.5R: −0.057R CI[−0.24, +0.13], 3R: −0.065R
> CI[−0.32, +0.19], POC: −0.115R CI[−0.55, +0.31] — তিনটারই CI zero-কে ঘাঁটে।
> Cost হাইপোথিসিস অনুযায়ী কাজ করেছে: মোট খরচ ~0.23–0.26R/trade (crypto-র ~2.3R-এর
> ~১০ ভাগের ১) — কিন্তু gross edge না থাকায় net −0.28 থেকে −0.37R। Frozen gate
> (net CI-LO > 0): **তিন variant-ই FAIL**। USD/JPY-র POC variant-এ +1.14R net
> (n=39, CI [−0.42, +2.69]) — চার pair-এর মধ্যে একটা positive, CI zero-কে ঘাঁটে,
> একে finding দাবি করা যাবে না। কোনো parameter ফলাফল দেখার পরে বদলানো হয়নি, কোনো
> rescue-filter নেই, main-এ merge হয়নি।

---

## 1. What this test is (and the two caveats that frame every number)

This is **Step 1 of the higher-timeframe validation** of the crypto FRVP+R:R finding
(`feature/frvp-rr`: gross edge +0.05 to +0.24R/trade, swamped ~30× by 1m taker fees).
The single hypothesis: a **1h native timeframe** produces a proportionally larger R
(wider stops), bringing cost-as-fraction-of-R down to something tradeable. It is a
SINGLE fixed timeframe — profile AND trigger both on 1h, no timeframe mixing, and
deliberately **no adaptive timeframe selection** (regime-adaptive switching already
failed once in this project, FTT3-R; timeframe-adaptive selection carries analogous
risk and is out of scope by spec).

Entry: a 50-bin volume profile of the trailing **480 closed 1h candles** (~20 trading
days), Value Area = 70% by greedy expansion from the POC (richer neighbor first, tie
→ up), fade on pierce-and-reject at VAH/VAL (strict inequalities; both-pierced and
zero-range candles are NO_TRADE). Exit: the same triple-barrier model as the crypto
test — SL = trigger wick ± 0.1×range, TP variants **1.5R / 3R / POC-frozen**, max
hold **240 hours (10 days)**, same-candle double touch → SL (conservative), TIMEOUT
at the window's last close (own bucket, excluded from headline WR), data-end →
CENSORED. Win rate alone decides nothing here; **expectancy (mean realized R) does**,
and the old "WR vs 55.56%" breakeven framing is not used anywhere in this report.
The statistical null is the martingale one: for a driftless process, expected realized
R is exactly 0 for any barrier geometry, so `expectancy CI-LO > 0` is the test.

**Caveat 1 — FX volume is a tick-count proxy, stated plainly everywhere.** Forex is
decentralized/OTC: there is no central venue where actual traded size can be measured.
The volume field used here (histdata.com free tick feed; each 1h candle's `v` = the
number of quote updates in that hour) is a **tick-count proxy**. VAH/VAL/POC are built
from that proxy and must not be read as if built from genuine traded volume. (The
task's original TwelveData framing carried the same class of caveat — see §2 for why
the source switched.)

**Caveat 2 — the data is short.** The task scoped this test around a ~60-day history
cap. We fetched June 1 → September 8, 2026; after the 480-candle warmup the evaluable
window is **~75 calendar days (~1,190 1h candles per pair)** — much shorter than the
crypto test's 12 months. Expect wide confidence intervals; per-bucket counts are
reported and anything below the minimum-30 rule is flagged rather than reported as a
rate. No result here justifies strong confidence.

## 2. Data and the source switch (stated explicitly, as required)

| Pair | 1h candles | ticks | weekend/holiday gaps | duplicate-ms ticks | jitter-skipped | first | last | evaluable (post-warmup) |
|---|---|---|---|---|---|---|---|---|
| EUR/USD | 1,673 | 4,078,391 | 13 | 1,387,936 | 0 | 2026-06-01T00:00Z | 2026-09-04T16:00Z | 1,193 |
| GBP/USD | 1,673 | 6,159,267 | 13 | 2,527,907 | 0 | 2026-06-01T00:00Z | 2026-09-04T16:00Z | 1,193 |
| USD/JPY | 1,669 | 6,183,868 | 14 | 3,095,014 | 2 | 2026-06-01T00:00Z | 2026-09-04T16:00Z | 1,189 |
| AUD/USD | 1,673 | 4,254,116 | 13 | 1,297,565 | 0 | 2026-06-01T00:00Z | 2026-09-04T16:00Z | 1,193 |

- **Why not TwelveData (the task's assumed source):** no API key is accessible to
  this agent (the project's live keys are Cloudflare worker secrets); the public
  demo key whitelists only EUR/USD and USD/JPY (GBP/USD and AUD/USD return 401);
  and — decisively — TwelveData forex `time_series` rows carry **no volume field at
  all** (verified 2026-09-09: OHLC only). A volume proxy is structurally required:
  the entire hypothesis is a volume profile. Source switched to **histdata.com's
  free tick feed** (no key): hourly candles aggregated from bid/ask mids, volume =
  tick count. All of the task's tick-volume caveats apply verbatim to this source.
- Aggregation: 1h OHLC from bid/ask mid; weekend/holiday hours are absent (never
  fabricated); ~1-second backwards tick jitter in the feed is skipped and counted
  when it crosses an hour boundary (2 ticks total, USD/JPY) — never re-timed.
- The USD/JPY series carries one extra data hole: its Friday 2026-06-05 session
  ends ~3h early (hours 11:00–12:00 and 14:00–16:00 UTC absent; 52 skipped hours
  around that weekend vs the siblings' 48) — 1,669 candles vs 1,673. Reported per
  pair, **not padded** — exactly as the task requires. (The tick feed itself ends
  Sep 4 16:00Z for all four pairs, so the fetch predates "today" by the feed's
  generation lag; nothing was padded to the present.)
- There are **no zero-range 1h candles** in this dataset (median ~2,000 ticks/hour);
  the ZERO_RANGE trigger guard never fires here and is covered by unit tests only.

## 3. Commitments frozen before the first run

All parameters and rules below were committed to git (**`2af0ad2`**, pre-registration
commit, message states "NO results yet") before the harness ever ran. Nothing changed
afterwards; the harness ran twice only to fix a plumbing detail *before any result was
consumed* — the audit's `ra` (R in price units) field was carried at 6 decimals, too
coarse for an independent verifier to recompute net costs from rows alone; it was
widened to 8 decimals. No decision math, no statistic, no strategy input changed;
gross and net numbers are identical across both runs (fingerprint-checked).

| Item | Value |
|---|---|
| Profile | trailing 480 closed 1h candles **closing strictly before** the decision candle (trigger candle excluded from its own profile); 50 equal bins over [min low, max high]; volume = tick count, spread uniformly across the bins a candle's [low, high] spans |
| POC | max-volume bin (tie → lowest-priced bin); POC price = bin midpoint |
| Value Area | greedy expansion from POC, richer neighbor first, **exact tie → UP first**, until cumulative ≥ 70% of window volume; VAH/VAL = edges |
| Trigger (1h, strict) | PUT: high > VAH AND close < VAH · CALL: low < VAL AND close > VAL · both pierced in one candle → NO_TRADE (`BOTH_PIERCED`) · zero-range → NO_TRADE (`ZERO_RANGE`) |
| Entry / SL / R | entry = trigger candle close (mid) · SL = trigger high + 0.1×range (PUT) / trigger low − 0.1×range (CALL) · R = \|entry − SL\| |
| TP variants (3, all reported) | (a) 1.5R · (b) 3R · (c) POC price frozen at decision time; POC not strictly beyond entry → no profit barrier, flagged `pocDegenerate` |
| Resolution | walk 1h candles strictly after entry; inclusive touches; **both barriers in one candle → SL**; fills at barrier price; hold window is wall-clock 240h — **weekends are skipped, never force-closed**; TIMEOUT at the last in-window close; data-end → CENSORED |
| Overlap | every trigger taken (independent positions); overlap share reported |
| Costs (frozen, per pair) | spread round-trip in pips: EUR/USD 1.0, GBP/USD 1.5, USD/JPY 1.2, AUD/USD 1.2 · swap: 1.0 pip per UTC-midnight crossed during the hold, charged flat both directions (conservative: real swaps are directional and sometimes positive; Wednesday-3× and 5pm-ET rollover conventions simplified away) · cost in R = cost_price / R · sensitivities: spread ×0.5 / ×2, swap ×1 / ×2 |
| Gate (frozen) | per variant: n ≥ 30 AND **net** expectancy (base cost) bootstrap/normal CI-LO > 0 |
| Inference | Wilson 95% on WR; normal-approx 95% + seeded bootstrap 95% (5,000 resamples, seed 20260908) on expectancy |

## 4. Funnel

| Stage | Count | Share |
|---|---|---|
| Evaluated 1h decisions (4 pairs, incl. warmup) | 6,688 | 100% |
| WARMUP_INSUFFICIENT (first 480 candles per pair) | 1,920 | 28.7% |
| Evaluable decisions (post-warmup) | **4,768** | 71.3% |
| NO_TRIGGER (candle entirely inside value area) | 2,430 | 51.0% of evaluable |
| PIERCE_NO_REJECT (pierced VAH/VAL, closed outside) | 2,168 | 45.5% of evaluable |
| BOTH_PIERCED (noise candle, frozen NO_TRADE) | 1 | 0.02% |
| **Trades** (PUT 134 / CALL 35) | **169** | 3.5% of evaluable |
| POC target degenerate (no profit barrier) | 1 | 0.6% of trades |
| ZERO_RANGE / trades | 0 / — | — |

Per pair: EUR/USD 37 · GBP/USD 61 · USD/JPY 39 · AUD/USD 32 trades — every per-pair
bucket clears the minimum-30 rule, barely (32–61). Overlap share 93.5% (240h holds
mean most triggers fire while another position is nominally open — positions are
independent by frozen design). 14 trades (8.3%) held across ≥2 midnights; per-variant
average hold: 0.35 nights (1.5R), 0.63 (3R), 0.63 (POC), max 10. The trigger mix is
heavily short-biased (PUT 134 vs CALL 35) — in this window, upside pierces of the
value area were rejected far more often than downside ones.

## 5. Results — all three TP variants, reported side by side

### Headline table (n = 167 / 166 / 164 decided trades; 2–5 censored)

| Metric | TP = 1.5R | TP = 3R | TP = POC |
|---|---|---|---|
| Win rate W/(W+L) | 37.7% | 23.0% | 17.7% |
| Wilson 95% CI | [30.7, 45.3] | [17.3, 30.0] | [12.6, 24.2] |
| Timeout rate | 0.0% (0) | 0.6% (1) | 0.0% (0) |
| Avg win R | +1.500 | +3.000 | +4.006 |
| **Expectancy gross** | **−0.057R** | **−0.065R** | **−0.115R** |
| 95% CI (normal) | [−0.241, +0.127] | [−0.323, +0.192] | [−0.545, +0.315] |
| 95% CI (bootstrap) | [−0.237, +0.138] | [−0.312, +0.194] | [−0.506, +0.347] |
| Net cost (base spread+swap) | −0.226R | −0.249R | −0.256R |
| **Expectancy net (base)** | **−0.283R** | **−0.315R** | **−0.371R** |
| 95% CI net (bootstrap) | [−0.469, −0.090] | [−0.559, −0.061] | [−0.761, +0.089] |
| GATE (n≥30 AND net CI-LO > 0) | **FAIL** | **FAIL** | **FAIL** |

Cost decomposition (base assumptions, per decided trade, averaged per-trade):
spread-only ≈ **0.199R** + swap ≈ 0.028–0.058R → total ≈ **0.23–0.26R**. The gap-fill
sensitivity count is 0 — no SL in this sample gapped through (the engine's conservative
touch-fill contract was never load-bearing here).

### Per pair (n / WR / gross expectancy / net-base expectancy — 1.5R · 3R · POC)

| Pair | TP 1.5R | TP 3R | TP POC |
|---|---|---|---|
| EUR/USD | 35 / 45.7% / +0.143 / −0.029 | 35 / 25.7% / +0.029 / −0.179 | 35 / 25.7% / −0.130 / −0.333 |
| GBP/USD | 61 / 29.5% / −0.262 / −0.513 | 60 / 13.6% / −0.414 / −0.698 | 60 / 8.3% / −0.755 / −1.042 |
| USD/JPY | 39 / 46.2% / +0.154 / −0.044 | 39 / 35.9% / +0.436 / +0.232 | 39 / 33.3% / +1.371 / +1.136 |
| AUD/USD | 32 / 34.4% / −0.141 / −0.415 | 32 / 21.9% / −0.125 / −0.410 | 30 / 6.7% / −0.748 / −1.032 |

**The USD/JPY outlier, handled honestly:** the only positive net cell in the whole
grid is USD/JPY (3R: +0.232R, POC: +1.136R). Its POC gross CI is **[−0.197, +2.939]**
(bootstrap lo −0.247) — the interval spans zero by a wide margin at n=39. It is one
positive pair out of four tested against the same window (a 4-way multiple-comparison
family): **not a finding**. If anything here is worth a pre-registered look on FRESH
data, it is exactly this cell — declared here so it cannot be rediscovered later as
if new. Direction split does not rescue the picture: PUT gross −0.041R, CALL −0.118R
(1.5R variant) — both negative.

### Weekly consistency (to the extent the short window allows)

All 10 weekly buckets hold **fewer than 30 trades each** and are therefore flagged,
not treated as rates (the minimum-bucket-30 rule doing its job on short data). The
1.5R weekly expectancy sequence: −0.11, +0.88, +0.73, −0.38, −0.17, +0.07, −0.35,
−0.53, −0.17, −0.04 — two positive weeks in early July, everything else flat-to-
negative. The POC variant's +5.96R week (Jul 6) is a single large POC reversion;
the three weeks at exactly −1.00R (Aug 10/17/24) are stretches where every POC trade
hit its stop. No variant shows anything resembling month-over-month stability.

## 6. What the hypothesis got right, and what it didn't

**Right — the cost mechanism.** The crypto test died because round-trip taker fees
(~0.2% of notional) were ~2.3× the median R. On FX 1h the per-trade cost is
~0.23R: retail spreads are quoted in pips (≈0.009–0.013% of price round-trip here)
and multi-day swap adds 0.03–0.06R. That is a ~10× cost-as-fraction-of-R improvement,
exactly the direction the hypothesis predicted. Also worth stating precisely: the 1h
fade's R (avg 12.7 pips; median 8.5; IQR 5.2–15.1) is **not** relatively wider than
the crypto 1m fade's R (median 0.088% of price there vs 0.091–0.123% here — the same
order). What changed is the cost structure, not the stop width.

**Didn't — there is no gross edge to trade on this window.** Every variant's gross
expectancy point estimate is negative with a CI spanning zero: the data is consistent
with the no-skill null (E[R] = 0 under any driftless process). The crypto window's
+0.05..+0.24R gross edge did not transfer to FX 1h on this sample. Whether that is a
market difference, a tick-count-proxy profile difference, a granularity difference
(1h triggers are 60× coarser than the crypto test's 1m), or simply short-sample noise
cannot be resolved from ~170 trades — and the test was scoped knowing that. With
n≈167, passing the frozen gate would have required a gross edge of roughly **≥0.42R**
(CI half-width ±0.19 plus the ~0.23R cost): even the crypto result would not have
cleared this bar. The honest conclusion is a two-parter: the gate says FAIL, and the
window says "underpowered by design — wide intervals reported as such."

## 7. Reproducibility

```
node backtest/fetch_fx1h_data.mjs        # histdata tick -> 1h (4 pairs, 2026-06..09)
node scripts/frvp_fx1h_tests.mjs         # 227/227: fixtures, no-lookahead, incremental==reference
node backtest/harness_frvp_fx1h.mjs      # single pass -> results/FRVP_FX1H_audit.jsonl.gz + _summary.json
node scripts/verify_frvp_fx1h_audit.mjs  # 55/55: full independent re-derivation from raw + audit
```

- Engine: `backtest/tripleBarrier.mjs` reused **unchanged** from `feature/frvp-rr`
  (timeframe-agnostic by design — `maxHoldMs`/`msPerBar` are call parameters).
  Profile/trigger: `src/strategy/frvpFadeFx1h.mjs` (standalone; mirrors the crypto
  module's structure; frozen FX constants).
- Fixtures: `scripts/frvp_fx1h_fixture_calc.py` (independent Python implementation)
  → 7 profile + 15 triple-barrier fixtures, including three FX-specific weekend
  fixtures (walk skips Sat/Sun, gap-through-SL on Monday open, exact-240h TIMEOUT
  landing after two weekends) and the exact-240h hold boundary.
- The verifier re-derives every trade's decision, profile, and all three barrier
  walks from the raw candle files with fresh code, plus funnel, Wilson rates,
  gross/net/bootstrap expectancy, per-pair/per-direction/weekly buckets and the
  gate — 55/55 checks green.
- Branch `feature/frvp-rr-fx1h` (from `feature/frvp-rr` @ 93a9787; neither `main`
  nor the crypto branch touched). Pre-registration commit `2af0ad2`; results commit
  follows this report. Audit: `results/FRVP_FX1H_audit.jsonl.gz` (6,857 rows: 6,688
  H1 decisions + 169 TRD trades), summary: `results/FRVP_FX1H_summary.json`.

## 8. Verdict and standing options

**Verdict: FAIL ×3 under the frozen gate.** Not tradeable as specified at the stated
retail costs; no rescue condition; no parameters changed after results; nothing
merged. Per the project's standing discipline, the options from here are the
pre-registered ones only: (1) accept the FAIL and park the higher-timeframe step;
(2) if the USD/JPY cell or the cost-mechanism finding is considered worth one more
look, it must be a **pre-registered confirmatory run on FRESH data** (histdata
history extends years back — but any window touched by a new test must be declared
before that test runs, and this window is now burnt for this concept); (3) adaptive
timeframe selection remains explicitly out of scope and is not unlocked by this
result.
