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
src/handlers/scan.js          */15 scanner + on-demand /api/signal
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

`/health` · `/watchdog` · `/api/signal?pair=BTC/USD` · `/api/signals/latest` ·
`/api/batch?pairs=...` · `/api/pairs` · `/api/history?pair=...` ·
`/api/stats` · `/api/report?id=...&result=WIN|LOSS|TIE|UNKNOWN`

Crons: `*/15` signal scanner only (aligned to 15m closes; events are emitted
on candle close, results are never messaged in CFD mode).

## Reliability — cron resilience (v1.8.0)

The platform Cron Trigger has gone silent before (2026-09-20, ~5h) and a
reactive watchdog is only as good as its triggers, so the scan watchdog
(`src/handlers/scan.js`) is invoked by THREE independent paths:

1. any HTTP request (unchanged);
2. an external heartbeat — GitHub Actions `heartbeat.yml` pings
   `GET /watchdog` every 5 min (a free cron-job.org/UptimeRobot monitor on the
   same endpoint is a recommended 1-min-cadence extra);
3. a Durable Object alarm re-arming itself every 5 min
   (`src/handlers/heartbeatDO.js`) — fires with zero traffic, survives deploys.

When the newest cursor of the ENABLED pairs exceeds `WD_STALE_MS` (21 min),
the watchdog: verifies + auto-repairs the cron trigger via the CF API
(`src/handlers/cronHeal.js` — deploys replace the whole trigger set, which has
silently dropped schedules here before), Telegram-alerts the owner chat in
real time (1h cooldown per incident), then runs the catch-up scan. Probes
follow the live config (disabled pairs' frozen cursors can never fake
staleness) and all-forex probe sets idle safely while the market is closed.
Simulate the whole chain on demand:
`/watchdog?drill=1&key=<WATCHDOG_DRILL_KEY>`. Full investigation + runbook:
`AGENT_LOG.md` (2026-09-22 entry).

---

# UT Bot Alerts — live engine (UT-BOT-v1.0.0)

The live signal path is now an **exact port of the TradingView "UT Bot Alerts"
indicator** (Pine v4, defaults `a=1` Key Value, `c=10` ATR period), replacing
FTT3 for signal generation. FTT3 remains in the repo for the audit record
(`src/strategy/engine.mjs`, `results/FTT3_BACKTEST_REPORT.md`); it is no
longer imported by the live path.

This is **not** a win-rate-seeking engine. The success criterion is exact
behavioral match to TradingView's own indicator output, verified bar-by-bar:

- `scripts/utbot_tests.mjs` — hand-derived fixtures for every porting pitfall
  (crossover `<=` semantics, `nz()` first-bar seeding, Pine `ta.atr` Wilder/SMA
  seeding — reused from `indicators.mjs`, the nested `iff` reset branches),
  plus no-lookahead proofs (truncation invariance, future-mutation
  invariance, leakage canary).
- `scripts/utbot_reference.py` + `scripts/utbot_crosscheck.mjs` — an
  independent Python derivation of the Pine source; the two implementations
  must agree on every bar (they do: 2000 bars, 0 mismatches, events exact).
- `scripts/utbot_tv_diff.mjs` — the mandatory verification harness: run a
  TradingView "Export chart data" CSV (with the indicator applied, defaults,
  Heikin Ashi **off**) through `--csv` and it diffs `xATRTrailingStop`
  bar-by-bar plus every Buy/Sell marker. Export a window with >=300 bars of
  lead-in and diff from there (`--from 300` or `--auto-lead`) because the
  Wilder recursion is path-dependent and the export only carries its own
  window.

**Known limitation (out of scope):** the indicator's Heikin Ashi input
(`h=true`) is NOT implemented — the port computes the `h=false` raw-close path
only, which is the indicator's default. Enable per pair via
`/api/utbot/config` (GET read / POST merge-write; per-pair `enabled`,
`timeframe` 1min/5min/15min, `a`, `c`, and per-indicator toggles under
`indicators` — e.g. `indicators.mkr.{enabled,kernel,bandwidth}` for the
Multi Kernel Regression [ChartPrime] port). CFD mode: there is NO expiry and
NO win/loss tracking — a setup stands until the indicator flips to the
opposite event, and each indicator speaks only its own output (UT Bot says
BUY/SELL; MKR says UP/DOWN; simultaneous events share one combined Telegram
message). Signals correspond to TradingView **bar-close confirmation**
(the marker as it stands once the candle closes; intrabar flicker of the live
bar is deliberately not reproduced). Events on a 1min-timeframe pair surface
on the next 15-minute scan tick.

---

# Repainting vs causal indicators — the emission rule (standing, 2026-09-21)

Every indicator added to `src/strategy/registry.mjs` falls into exactly one
of two categories, classified in its own file header BEFORE porting:

1. **Causal / non-repainting** — its value at bar N depends only on bars
   <= N and never changes once that bar closes (UT Bot Alerts; MKR `nrp`).
   Emit exactly at the flip/cross bar's own close. No emit-window question
   ever arises.
2. **Repainting** — its value at bar N can still change after bar N+1,
   N+2, ... close (any two-sided/centered/adaptive smoother — MKR `tv`).
   Normal operation emits ONLY the newest knowable detection (offset 1,
   knowable at the very next candle close). A backfill window (hard cap
   `MKR_TV_EMIT_WINDOW = 4` candles) opens exclusively for PROVEN scanner
   downtime — the stored `lastScanT` cursor vs `now` showing genuinely
   missed scan ticks — never on a routine tick.

**Priority, fixed project decision:** "match the TradingView chart
pixel-for-pixel" never overrides "the alert must correspond to something
that just happened". For a repainting indicator these conflict by
definition; timeliness wins, full stop. A signal delivered 18 hours after
its stated candle is not tradeable regardless of how faithfully it matches
the chart's redraw (the 120-candle emit window did exactly that — an
"fresh" alert whose extremum bar was 75 candles old).

Per repainting indicator, two deliverables are mandatory: the file-header
classification above, and a regression test proving an extremum that first
becomes true at offset > 1 during normal operation is NOT emitted (see
`scripts/mkr_tv_tests.mjs` T5/T6 for the pattern).
