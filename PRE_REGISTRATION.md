# FTT3-R Pre-Registration — Regime-Adaptive Strategy

**Frozen:** 2026-09-05 (branch `feature/regime-adaptive`, the commit that adds this file).
**Status:** NOT merged to `main`, NOT deployed. `main` keeps running FTT3 exactly as
audited — it is the live collector whose post-2026-09-05 output this idea will be
tested on.

Nothing in this file may change after the freezing commit. If any parameter is ever
edited, this document and the git history must show it, and any verdict produced
afterwards is invalid as a pre-registered result.

## Motivation (context, not a parameter)

FTT3's OOS verdict was FAIL (50.5% WR; BTC/USD 41.8% vs USD/JPY 64.8%). The spread
across pairs is consistent with trend-following only suiting trending conditions.
The response is a market-CONDITION detector applied uniformly to every pair — the
fired strategy depends on what the market is doing, never on which symbol it is.
This is explicitly NOT "give USD/JPY a special strategy": no pair-specific parameter
exists anywhere in the regime detector or either strategy (proven by
`scripts/regime_tests.mjs`).

## Frozen parameters

### Regime detector (`src/strategy/regime.mjs`)
| Parameter | Value | Provenance |
|---|---|---|
| Indicator | ADX(14), Wilder, on the **15m** timeframe (same timeframe as C1's bias) | standard default |
| Evaluated on | last CLOSED 15m candle before the entry candle's close | no-lookahead contract |
| TRENDING | ADX >= **25** | textbook ADX strong-trend cutoff (Wilder; platform defaults) |
| RANGING | ADX < **20** | textbook ADX weak-trend cutoff |
| TRANSITION | 20 <= ADX < 25 -> **NO_TRADE** (deliberate; no strategy fires; prevents flip-flopping on small ADX wobbles) | — |

The 25/20 cutoffs are the standard textbook ADX trend-strength thresholds. They were
NOT tuned on any FTT dataset — the FTT3 OOS window was not touched when choosing
them (it was only used to reach the FTT3 FAIL verdict). The freezing commit message
states the same, so threshold provenance is auditable from git history alone.

### Strategy A — trend-following (fires only when TRENDING)
Reused **exactly as-is** from FTT3 (`src/strategy/engine.mjs` `evaluateSignal`,
byte-for-byte unchanged on this branch; already audited by the FTT3 OOS run):
- C1 bias (15m): EMA(20) vs EMA(50) on the last closed 15m candle.
- C2 confirmation (5m): MACD(12,26,9) line crosses signal on the last closed 5m
  candle, in the C1 direction.
- C3 entry gate (1m): ATR(14) >= its trailing median over the last 100 closed 1m
  candles.

### Strategy B — mean-reversion (fires only when RANGING, `src/strategy/meanReversion.mjs`)
| Condition | Definition | Frozen value |
|---|---|---|
| D1 extension (5m) | Bollinger Bands on 5m closes; the "outside" candle X (the closed 5m candle before the trigger) closes **strictly** beyond a band (edges count as inside) | BB(**20**, **2**σ, population std) |
| D2 reversal trigger | RSI(14) on 5m at X confirms exhaustion on that same candle (>70 fade-down, <30 fade-up), AND the next closed 5m candle closes back inside the bands — that close is the entry trigger. "Back inside" is judged against the bands computed AT the trigger candle; X and the trigger must be adjacent (exact 5-minute spacing) | Wilder RSI(**14**), **70**/**30** |
| D3 entry gate (1m) | **Identical** to FTT3's C3 — same math, same constants, same semantics in both strategies | ATR(14) >= trailing-100 median |
| Direction | CALL = fade-up (X below lower band, RSI<30, snaps back inside); PUT = fade-down (mirror) | — |

Evaluation order is strictly D1 -> D2 -> D3; first failure stops the chain and is
logged with its raw indicator values (same audit discipline as C1-C3).

### Expiry (both strategies, unchanged)
ATR-percentile ladder computed at entry from the 1m ATR series, identical to FTT3:
percentile >= 75 -> 5 min; 25-74.x -> 7 min; < 25 -> 10 min. Expiry is about
volatility, not which strategy fired.

## Frozen test protocol

| Item | Value |
|---|---|
| Fresh OOS window | data from **2026-09-05T00:00:00Z** forward (`REGIME_SPLIT_DATE` in `backtest/harness_regime.mjs`) |
| Old window | the FTT3 window (through 2026-09-05) is **burned** — never evaluated by the regime harness, not even for diagnostics |
| Minimum bucket | **30** decided signals per reported rate; smaller = INSUFFICIENT, never a rate |
| Win rate | Wilson 95% CI; TIE excluded from headline W/(W+L), conservative W/(W+L+T) also reported |
| Payout assumption | **0.80** -> breakeven **55.5556%**. Confirm the live broker's actual payout before finalizing any verdict |
| PASS gate | Wilson lower bound > breakeven on the overall fresh bucket (and enough n) |
| No-skill baseline | up-rate over the same 5/7/10-minute windows across the same fresh boundary candidates |
| Audit | `results/audit_regime_fresh.jsonl` — every fresh decision (signal and NO_TRADE) with regime, ADX, strategy path, full condition values, expiry, entry/exit, result |
| Deferral rule | If the fresh window has fewer than 30 decided signals, the verdict is **DEFERRED** — wait for the live collector to accumulate data. Do NOT re-slice the old window |
| Deliberate exclusions | no third strategy to "cover" TRANSITION; no pair-specific parameters; no re-touching the old OOS audit data; no adding conditions after seeing fresh-window results |

## Prohibited after unblinding

Adding filters, changing thresholds, re-splitting, or reporting a re-run as the
verdict after seeing fresh-window results would invalidate the pre-registration. A
FAIL is reported as a FAIL.
