# FTT Signal Worker — FTT3 engine

Binary-options signal worker (Cloudflare Worker + Telegram push). **FTT3** is a
complete rewrite: three conditions, three timeframes, standard-default
indicators, and an ATR-percentile expiry ladder. There are no other filters —
no grading, no confidence scores, no AI validation, no session filter, no
hidden veto. The entire decision logic is `src/strategy/engine.mjs` and is
readable in one sitting.

> **Verdict up front:** the walk-forward backtest (out-of-sample touched once,
> split date committed before the run) returned **FAIL** — OOS win rate 50.5%
> (Wilson 95% CI [46.6%, 54.3%]) vs the 55.6% breakeven at a 0.80 payout.
> See `results/FTT3_BACKTEST_REPORT.md`. The engine is deployed as an audited
> data collector, not as a proven-profitable signal source.

## The three conditions

Evaluated strictly in order C1 → C2 → C3. The first failing condition stops
the chain and is logged with its raw indicator values. Nothing else can block.

| # | Timeframe | Check | Pass means |
|---|---|---|---|
| C1 | 15m | EMA(20) vs EMA(50) on the last **closed** candle | EMA20 > EMA50 → only **CALL** allowed; EMA20 < EMA50 → only **PUT**; equal/undefined → NO_TRADE |
| C2 | 5m | MACD(12,26,9) line crosses its signal line on the last **closed** candle | Bullish cross required for CALL, bearish for PUT; no cross or wrong direction → NO_TRADE |
| C3 | 1m | ATR(14, Wilder) at/above its own trailing **median over the last 100 closed candles** | Below the median (market too quiet) → NO_TRADE |

A signal can only fire when the entry 1m candle closes exactly on a 5m
boundary (that is when C2's "last closed 5m candle" exists). The worker scans
every 5 minutes for exactly this reason.

## Dynamic expiry (fixed before any backtest — never tuned after results)

Chosen at entry time from the percentile rank of the current 1m ATR(14) within
its trailing 100 closed candles:

| ATR percentile | Expiry |
|---|---|
| ≥ 75th | 5 minutes |
| 25th – 75th | 7 minutes |
| < 25th | 10 minutes |

Every signal logs the chosen expiry and the percentile value.

## No-lookahead

A signal for 1m index `i` may only use candles fully closed before `i`'s close
time. The engine enforces this itself (it slices its own inputs) and
`scripts/strategy_tests.mjs` proves it by mutating future candles and asserting
the decision, audit and expiry are unchanged — on both the reference path and
the precomputed fast path.

## Scope

- **Pairs:** exactly the 8 pairs the backtest covered — BTC/USD, ETH/USD,
  XRP/USD, SOL/USD (Bybit spot as the /USD proxy) and EUR/USD, GBP/USD,
  USD/JPY, AUD/USD (Yahoo). Real markets only.
- **No OTC pairs** — there is no legitimate historical data source for broker
  synthetic feeds, so they are out of scope entirely.

## Layout

```
src/strategy/indicators.mjs   EMA / MACD / Wilder ATR / median / percentile
src/strategy/engine.mjs       THE strategy: C1→C2→C3 + expiry tiers
src/handlers/scan.js          */5 scanner + on-demand /api/signal
src/history/store.js          history save (30-min dedup) + expiry result checker
src/handlers/push.js          Telegram subscriber push (plain text, push-lock)
src/fetch/candles.js          TwelveData fetch + KV cache + key rotation
backtest/fetch_data.mjs       real-historical-data fetcher (fails loudly on gaps)
backtest/harness.mjs          walk-forward harness (split committed pre-run)
results/FTT3_BACKTEST_REPORT.md   verdict + full tables
results/audit_signals.jsonl       every OOS decision with raw indicator values
```

## Tests

```bash
node scripts/strategy_tests.mjs   # 42 assertions + no-lookahead mutation proof
node scripts/engine_smoke.mjs     # live path end-to-end on stubbed feeds (33)
node scripts/verify_audit.mjs     # re-derives every report number from the audit (72)
```

## Reproduce the backtest

```bash
node backtest/fetch_data.mjs      # real candles -> backtest/data/ (gitignored)
node backtest/harness.mjs         # single pass -> results/ + audit JSONLs
```

The split date lives in `backtest/harness.mjs` (`SPLIT_DATE`) and was committed
before the first run. Per the honesty rule: if OOS fails, report FAIL and do
not add filters to rescue the number — that is what this repo's history taught.

## API

`/health` · `/api/signal?pair=BTC/USD` · `/api/signals/latest` ·
`/api/batch?pairs=...` · `/api/pairs` · `/api/history?pair=...` ·
`/api/stats` · `/api/report?id=...&result=WIN|LOSS|TIE|UNKNOWN`

Crons: `*/5` signal scanner (aligned to 5m closes), `*/2` result checker
(resolves expiries against the 1m feed; ties are stored as TIE, missing candles
as EXPIRY_GAP — both excluded from win/loss stats).

---

# FTT3-R — regime-adaptive engine (branch `feature/regime-adaptive` — NOT deployed)

Status: **branch-only**. `main` keeps running the audited FTT3 engine; nothing on
this branch is merged or deployed. The branch exists so the merge decision can be
made after the fresh-window backtest actually runs.

Idea: a market-CONDITION detector applied uniformly to every pair. The strategy
that fires depends on what the market is doing, never on which symbol it is —
there are no pair-specific parameters anywhere.

- Regime: ADX(14) on the last closed 15m candle. >= 25 TRENDING -> Strategy A
  (FTT3's C1->C2->C3, reused byte-for-byte); < 20 RANGING -> Strategy B
  (mean-reversion D1->D3: BB(20,2σ) 5m extension, RSI(14) exhaustion + snap-back
  inside, same 1m ATR gate as C3); 20-25 TRANSITION -> NO_TRADE (deliberate).
- Expiry: the same ATR-percentile ladder (5/7/10 min) for both strategies.
- Audit rows now carry `regime` (raw ADX + classification) and `strategy`
  (TREND / MEANREV / null) on every row.

Every threshold and the fresh-window split date (**2026-09-05T00:00:00Z** — the
FTT3 OOS window is burned and is never re-sliced) are frozen in
**PRE_REGISTRATION.md** and in the pre-registration commit. The 25/20 ADX cutoffs
are the standard textbook values, not tuned on any FTT dataset.

Tests: `node scripts/regime_tests.mjs` — 89 checks including hand-computed
ADX/RSI/BB fixtures, both-value-path equivalence, no-lookahead mutation proofs
for the new code, and the pair-agnostic proof. Fresh-window harness (deferred
until enough post-2026-09-05 data exists): `node backtest/harness_regime.mjs`.
