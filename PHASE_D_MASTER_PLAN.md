# Phase D — Engine Accuracy Overhaul · Master Plan

**Goal:** raise production WR from ~40% to a realistic **~60-65%** (NOT 75% —
that is not achievable in binary options by any method). Payout 80% → break-even
56% → 65% = profitable.

**Why now:** R7.1 + Phase C verified the current engine cannot be tuned past ~46%.
WR is declining day-by-day. The core signal logic + expiry must change.

**Repo:** `github.com/ferdausfs/Ftt-Otc-v6` · base: `d1212e4` (R7.1 live)
**No WR guarantee. Every phase validated before deploy. No overfit.**

---

## Phase order (do one at a time, validate, then next)

### D1 — Longer expiry (15–30 min) · 1 day · LOW RISK
**Change:** `DURATION_CONFIG` multipliers raised so recommended expiry = 15–30 min
(not 1–5 min). Win/loss resolution cron checks at the new expiry.
**Why:** 1–5 min expiry = noise-dominated (~50% random). 15–30 min = trends
develop, indicators work, noise averages out.
**Expected lift:** +8–12pp (pooled ~40% → ~48–52%).
**Validation:** deploy → 48h live → compare new-window WR vs old.

### D2 — Negative quality filters · 1 day · LOW RISK
**Change:** block signals in verified-bad slices:
- `marketRegime === 'TRENDING'` → NO_TRADE (29.5% WR, n=356, strong)
- `pair ∈ {USD/JPY, AUD/USD, DOT/USD}` → NO_TRADE (12–19% WR, stable)
- `sessionQuality === 'HIGHEST'` → NO_TRADE (6.1% WR, n=66)
**Why:** these lose consistently. Removing them raises pooled WR.
**Expected lift:** +5–8pp (pooled ~48% → ~53–56%). Signal frequency drops ~40%.
**Validation:** same as D1. These are observational findings (not overfit) —
stable across 1460+ signals.

### D3 — Price-action signal module · 1–2 weeks · MEDIUM RISK
**Change:** new entry logic alongside (not replacing) indicators:
- Key S/R level bounce (price touches S/R → rejection candle → entry)
- Session-open momentum burst (London/NY open first 15 min → strong direction)
- Candle rejection pattern (long-wick rejection at key level)
- Only when ALL of: clear level + rejection candle + aligned session
**Why:** standard indicators (EMA/RSI/MACD) are used by everyone → no edge.
Price-action at levels is a real edge (institutional levels work).
**Expected lift:** +8–12pp (if done well; needs rigorous backtest).
**Validation:** backtest on 1000+ historical candles per pair → walk-forward →
shadow mode (R7.1 pattern: compute but don't deploy) → 1 week comparison → deploy.

### D4 — ML scoring model (XGBoost) · 2–3 weeks · HIGH RISK (overfit)
**Change:** train an XGBoost model on R7.1+B5 historical data:
- Features: all indicators, regime, session, TF, structure, confidence, price-action signals
- Target: WIN/LOSS outcome
- Output: a 0–100 score per signal → replaces/augments current confidence
- Deploy as scoring layer (not replacing the engine, scoring ON TOP)
**Why:** finds non-obvious statistical patterns ("which combo actually wins").
LLM "AI validation" has zero predictive power — ML does (if edge exists).
**Expected lift:** +3–8pp verified out-of-sample (if edge exists; may be zero).
**Validation:** STRICT walk-forward (train past, test future, repeat). NO deploy
without out-of-sample test showing lift. Shadow mode first.

### D5 — Quality gate (ML threshold) · 1 day · LOW RISK (on top of D4)
**Change:** only trade signals with ML score ≥ threshold (e.g., top 20%).
**Why:** select only the highest-conviction signals from D4's model.
**Expected lift:** +3–5pp on taken signals. Frequency drops to ~5–15/day.
**Validation:** live shadow comparison.

---

## Combined realistic outcome (all 5 phases)
- Base engine (D1+D3): ~55–60%
- ML scoring (D4): ~58–63%
- Quality gate (D5): ~60–65% on 5–15 signals/day
- **NOT 75%.** 60–65% is excellent and profitable.

## Hard rules
- One phase at a time. Validate. Then next.
- No deploy without out-of-sample validation (D3, D4 especially).
- No WR guarantee. "Optimization target" only.
- D1+D2 are safe (observational, verified). D3+D4 are research (may not pan out).
- Keep R7.1 running (data collection continues through all phases).
