# FTT Engine v2 — Simplified Rebuild

**Status: backtest FAILED the out-of-sample gate — NOT live, NO win-rate claim.**
See `results/FTT_V2_BACKTEST_REPORT.md` for the full walk-forward verdict.

FTT Signal Engine v2 is a deliberate rebuild of `Ftt-Otc-v6`: a small, auditable
4-condition strategy with a walk-forward validation harness. No confluence
scoring, no A+/A/B/C grades, no AI layer, no hidden filters.

## The 4 conditions (ALL must align — binary, no partial match)

| # | Condition | Definition (exact, nothing implicit) |
|---|---|---|
| C1 | HTF trend | EMA(50) vs EMA(200) on **1h** candles: `ema50 > ema200` → CALL only; `<` → PUT only; equal → NO_TRADE |
| C2 | Pullback zone | RSI(14) on **5m**: CALL needs 25 ≤ RSI ≤ 45; PUT needs 55 ≤ RSI ≤ 75 |
| C3 | Rejection candle | The just-closed 5m candle: rejection wick ≥ **1.5×** body AND ≥ **40%** of range AND close in the far **40%** of the range (lower wick for CALL, upper for PUT) |
| C4 | Session / news | Trading only in HIGH+ quality sessions (London/New York, 07–21 UTC); forex market must be open; forex blocks inside the 4 static high-impact news windows; crypto exempt from news windows (same as v6) |

**Execution semantics:** entry = close of the signal candle; result decided at
the close of the **next** 5m candle (= the production 5-min expiry). WIN if
price moved in the direction, LOSS if against, TIE (excluded from WR) if flat.

**Every threshold** lives in one exported object: `src/strategy.mjs → PARAMS`.

## File map

```
src/indicators.mjs   EMA + RSI only (ported verbatim from v6 math.js)
src/session.mjs      session quality, forex open/closed, news windows
src/strategy.mjs     THE core — PARAMS + computeIndicators + evaluateSignal
backtest/fetch_data.mjs   real candle fetcher (Bybit crypto / Yahoo forex)
backtest/harness.mjs      walk-forward engine, buckets, audit JSONL
tests/strategy.test.mjs   18 tests incl. the no-lookahead property proof
results/                  audit_signals.jsonl, harness_summary.json, report
```

## Run

```bash
node backtest/fetch_data.mjs   # real candles -> data/*.json (cached)
node backtest/harness.mjs      # walk-forward run -> results/
node --test tests/strategy.test.mjs
```

## What is deliberately NOT in v2

No 11-category scoring, no grade ladder, no dual-AI validation, no
HOUR_MULTIPLIERS, no pseudo-confluence votes, no conditions added after seeing
a losing trade. The core decision function is ~190 lines with comments.

## Walk-forward discipline (non-negotiable)

1. Split X = 2026-08-15T00:00Z was committed **before** the first run.
2. In-sample = diagnostics only; the headline is the untouched OOS window.
3. A bad result means **simplify or rethink the core** — never re-split, never
   re-test the same OOS window, never bolt on a new gate.
4. Buckets with < 30 decided signals are reported as INSUFFICIENT, not as a
   win rate.
5. OTC and real-market pairs are never pooled; OTC stays deferred until real
   broker-feed history exists.

## Data provenance & caveats

- Crypto: Bybit spot klines (USDT quote ≈ USD, basis-level proxy)
- Forex: Yahoo Finance chart API (mid-quotes, pip-quantized → higher TIE rate)
- OTC: no public historical source — never simulated
- Math cross-verified: JS EMA/RSI reproduced exactly by an independent Python
  implementation over the audit rows.
