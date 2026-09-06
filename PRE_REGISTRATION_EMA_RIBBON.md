# PRE-REGISTRATION — EMA Ribbon Strategy (5/13/55 bias + 5/7/13 trigger)

Committed to `feature/ema-ribbon` BEFORE the harness ever touches the target
data. Parameters below are frozen; there is no tuning step anywhere in this
test. This is a NEW, UNRELATED hypothesis — a well-known retail EMA ribbon
setup — built as a standalone module (`src/strategy/emaRibbon.mjs`), not a
patch on `engine.mjs` or `meanReversion.mjs`, and carrying over no threshold
or finding from FTT3 or FTT3-R. Both prior families failed their clean OOS
tests (FTT3 50.5% n=746; FTT3-R crypto ext 48.0% n=4,992, below breakeven and
below no-skill); those failures motivate testing a different hypothesis with
the same discipline, not layering filters on the old engines.

## Frozen parameters (textbook values, not tuned on any FTT dataset)

- C1 bias, 15m: EMA(5), EMA(13), EMA(55) on the last CLOSED 15m candle.
  Full bullish order (EMA5 > EMA13 > EMA55) -> bias UP; full bearish order
  (EMA5 < EMA13 < EMA55) -> bias DOWN; any other order (tangled, including
  any equality) -> NO_TRADE.
- C2 trigger, 1m: EMA(5), EMA(7), EMA(13) on 1m candles. Trigger = the first
  CLOSED 1m candle in full fast-ribbon alignment matching C1's bias whose
  immediately prior 1m candle was NOT in that alignment (the flip candle).
  CALL = bullish bias + bullish flip; PUT = bearish bias + bearish flip;
  no flip or direction disagreement -> NO_TRADE.
- Expiry: the FTT3 ATR-percentile ladder REUSED verbatim (ATR(14) on 1m,
  percentile vs trailing 100 closed 1m candles; >=75th -> 5m, 25th..75th ->
  7m, <25th -> 10m). Expiry selects trade duration; it is NOT an entry gate.
  No volatility condition exists in this strategy.
- Entry at the close of the trigger candle; exit compares the close n minutes
  later (same fixed-time convention as every prior engine here). TIE excluded
  from headline W/(W+L), conservative W/(W+L+T) also reported; missing exit
  candle -> EXPIRY_GAP, excluded.

## Frozen data window (genuinely unused)

- Evaluation: 2024-07-05T00:00:00Z -> 2025-07-05T00:00:00Z (~12 months).
  Every crypto candle previously fetched by this project covers
  2025-07-05T00:00Z onwards (FTT3's window plus FTT3-R's 12-month extension),
  so nothing inside this window has been seen, evaluated, or tuned on.
- Warmup: 7 days before the window feeds indicators only (EMA55(15m)
  convergence + full trailing-100 ATR window at the first evaluable
  boundary); NO decision is evaluated before 2024-07-05T00:00:00Z itself.
  A 15-minute tail past the end resolves final expiries.
- Pairs: BTC/USD, ETH/USD, XRP/USD, SOL/USD (Bybit spot USDT quote — the same
  honest basis-level proxy used by backtest/fetch_data.mjs). Timeframes:
  1m and 15m only. Forex is out of scope (no deep 1m history available).
- No split: the whole 12-month block is ONE pre-registered result, run once
  and reported once. No sample may be moved between "diagnostic" and
  "headline" — there is no diagnostic slice.

## Discipline

- Minimum bucket: 30 decided signals per reported rate; smaller buckets are
  flagged INSUFFICIENT and are never quoted as a rate.
- Payout assumption 0.80 -> breakeven 55.5556% WR, identical to every prior
  test in this project. The actual broker payout must be confirmed before
  finalizing any live decision (sensitivity in the report).
- PASS gate: Wilson 95% CI lower bound on the OVERALL decided W/(W+L) rate
  strictly above breakeven, with n >= 30. Anything else is FAIL (or
  INSUFFICIENT if n < 30). A FAIL is a valid, useful finding and will be
  reported plainly.
- Prohibited after seeing results: changing any parameter, adding conditions
  or filters, re-slicing or extending the window, pair-specific thresholds,
  merging to main, or deploying — a good result is a finding to DISCUSS, not
  a merge/deploy license; a bad result is not a tuning invitation.

## Deliverables

1. `src/strategy/emaRibbon.mjs` — C1/C2 exactly as above, standalone.
2. `backtest/fetch_data_ext2.mjs` — the 2024 window fetcher (fail loudly on
   zero candles/missing warmup; no fabricated or interpolated data).
3. `backtest/harness_ema_ribbon.mjs` — single-block harness.
4. `results/EMA_RIBBON_audit.jsonl.gz` — every evaluated boundary with full
   condition values, blocking reason, entry/exit, result, and per-row
   no-skill direction markers dir5/dir7/dir10.
5. `results/EMA_RIBBON_REPORT.md` — every number re-derivable from the audit
   by `scripts/verify_ema_ribbon_audit.mjs`.
6. `scripts/ema_ribbon_tests.mjs` — fixtures frozen by the independent
   Python calculator (`scripts/fixture_calc_ema_ribbon.py`), chain-ordering,
   boundary semantics, reference==fast equivalence, no-lookahead mutation
   proofs and leakage canaries.
