#!/usr/bin/env python3
"""
Market Structure (BOS/CHoCH) — INDEPENDENT fixture calculator.

A second, from-scratch implementation of the pivot/confirmation-lag state
machine in Python (the strategy module under test is JS). It freezes
hand-verified expectations for scripts/market_structure_tests.mjs:

  1. a 78-bar hand-built fixture whose exact event sequence is
     CHoCH_BEAR (first break out of UNKNOWN) -> BOS_BEAR (continuation)
     -> CHoCH_BULL (flip up) -> BOS_BULL (continuation) -> CHoCH_BEAR (flip down);
  2. a 23-bar "lag discriminator" fixture: a new swing high whose value must
     NOT suppress a break of the OLD swing high before the new pivot's
     confirmation bar (the observable form of the L-bar confirmation lag);
  3. a Wilder ATR(14) fixture on a small hand-written OHLC set;
  4. percentile-rank boundary checks.

Run: python3 scripts/ms_fixture_calc.py
"""

L = 5

# ── independent state machine (fresh code, no shared source with the JS) ────
def is_swing_high(H, i):
    if i - L < 0 or i + L >= len(H):
        return False
    return all(H[k] <= H[i] for k in range(i - L, i + L + 1) if k != i)

def is_swing_low(Lo, i):
    if i - L < 0 or i + L >= len(Lo):
        return False
    return all(Lo[k] >= Lo[i] for k in range(i - L, i + L + 1) if k != i)

def run_machine(bars):
    trend = "UNKNOWN"
    sh = None   # [value, broken]
    sl = None
    out = []
    for t in range(len(bars)):
        o, h, l, c = bars[t]
        i = t - L
        if i >= L:
            if is_swing_high([b[1] for b in bars], i):
                sh = [bars[i][1], False]
            if is_swing_low([b[2] for b in bars], i):
                sl = [bars[i][2], False]
        ev = "NONE"
        bull = sh is not None and not sh[1] and c > sh[0]
        bear = sl is not None and not sl[1] and c < sl[0]
        if bull and bear:
            sh[1] = True; trend = "UP"
            sl[1] = True; trend = "DOWN"
            ev = "BOTH"
        elif bull:
            sh[1] = True
            ev = "BOS_BULL" if trend == "UP" else "CHoCH_BULL"
            trend = "UP"
        elif bear:
            sl[1] = True
            ev = "BOS_BEAR" if trend == "DOWN" else "CHoCH_BEAR"
            trend = "DOWN"
        out.append((t, ev, trend))
    return out

def build_bars(closes, dh, dl):
    """o = previous close; h = max(o,c)+dh[t]; l = min(o,c)-dl[t]."""
    bars, prev = [], closes[0]
    for k, c in enumerate(closes):
        o = prev
        h = max(o, c) + dh.get(k, 0.3)
        l = min(o, c) - dl.get(k, 0.2)
        assert h >= max(o, c) and l <= min(o, c) and h >= l, f"bar {k} invalid"
        bars.append((o, h, l, c))
        prev = c
    return bars

# ── fixture 1: the five-event path ──────────────────────────────────────────
# wick overrides (index -> dh / dl); everything else uses +0.3 / -0.2
DH = {6: 0.1, 14: 0.1, 37: 0.3, 44: 0.3, 45: 0.1, 49: 0.1, 56: 1.0, 62: 0.3,
      64: 0.5, 70: 0.2}
DL = {9: 0.3, 27: 0.3, 37: 0.1, 44: 0.1, 54: 0.1, 62: 0.1, 64: 0.8, 73: 0.1}
CLOSES = [
    # 0..9 decline 105 -> 98 (swing low #1 forms at bar 9)
    105, 104, 103, 102, 101, 100, 99.5, 99, 98.5, 98,
    # 10..13 bounce to 101 (swing high #1 at bar 13)
    99, 100, 100.5, 101,
    # 14..18 pullback 100.5 -> 98.5 (stays above the 97.7 swing low)
    100.5, 100, 99.5, 99, 98.5,
    # 19 break: close 97 < 97.7  -> CHoCH_BEAR (UNKNOWN -> DOWN)
    97,
    # 20..27 drift down to swing low #2 at bar 27 (95.2)
    97.5, 98, 97.6, 97.2, 97, 96.5, 96, 95.5,
    # 28..35 bounce and fade; close stays above 95.2
    96.2, 96.6, 96.8, 97, 96.8, 96.4, 96, 95.5,
    # 36 break: close 95 < 95.2 -> BOS_BEAR (DOWN stays DOWN)
    95,
    # 37..44 rally to swing high #2 at bar 44 (98.5)
    95.4, 95.8, 96.2, 96.6, 97, 97.4, 97.8, 98.2,
    # 45..49 pullback, stay under 98.5
    97.9, 97.6, 97.8, 98.1, 98.3,
    # 50 break: close 98.7 > 98.5 -> CHoCH_BULL (DOWN -> UP)
    98.7,
    # 51..55 shallow pause
    99, 98.8, 98.5, 98.7, 99,
    # 56..61 push to swing high #3 at bar 56 (101.0, big wick), hold
    100.0, 100.4, 100.2, 100.3, 100.4, 100.5,
    # 62 break: close 101.2 > 101.0 -> BOS_BULL (UP stays UP)
    101.2,
    # 63..69 pullback to swing low #3 at bar 64 (99.7), holds
    100.8, 100.5, 100.4, 100.6, 100.4, 100.5, 100.3,
    # 70..71 last push that stays under structure
    100.6, 100.2,
    # 72 break: close 99.5 < 99.7 -> CHoCH_BEAR (UP -> DOWN)
    99.5,
    # 73..77 tail (decline; no further confirmed-and-broken structure)
    99.5, 99.3, 99, 98.8, 98.6,
]
BARS = build_bars(CLOSES, DH, DL)
print(f"== fixture 1: {len(BARS)} bars ==")
for t, ev, tr in run_machine(BARS):
    if ev != "NONE":
        print(f"  t={t:3d} close={BARS[t][3]:7.2f}  event={ev:11s} trend_after={tr}")
H = [b[1] for b in BARS]
Lo = [b[2] for b in BARS]
print("swing highs (i, h, confirmed_at):",
      [(i, H[i], i + L) for i in range(len(H)) if is_swing_high(H, i)])
print("swing lows  (i, l, confirmed_at):",
      [(i, Lo[i], i + L) for i in range(len(Lo)) if is_swing_low(Lo, i)])

# ── fixture 2: confirmation-lag discriminator ────────────────────────────────
# Old swing high 95.2 at i=5 (confirmed at t=10). New swing high 96.0 at
# i=12 (confirmed at t=17) — its bar sits OUTSIDE the old pivot's window, so
# both stay valid. Closes at t=13..16 sit BETWEEN 95.2 and 96.0.
# Correct lag  : the t=13 close (95.4) breaks the OLD 95.2 -> CHoCH_BULL at 13.
# Leaked pivot : if 96.0 were in play before t=17, 95.4 < 96 -> NO event ever.
LAG_CLOSES = [
    93.5, 93.8, 94.1, 94.4, 94.7, 94.9,          # 0..5 rise to A=95.2
    94.5, 94.2, 94.0, 93.8, 93.6, 93.4,          # 6..11 fade (A confirms at 10)
    94.0,                                        # 12 B bar: h = 96.0 (2.0 wick)
    95.4, 95.2, 95.0, 94.8, 94.6,                # 13..17 break zone (B confirms at 17)
    94.4, 94.2, 94.0, 93.8, 93.6,                # 18..22 tail
]
LAG_DH = {6: 0.1, 12: 2.0}
LAG_DL = {11: 0.3}
LAG = build_bars(LAG_CLOSES, LAG_DH, LAG_DL)
print(f"\n== fixture 2 (lag discriminator, {len(LAG)} bars) ==")
for t, ev, tr in run_machine(LAG):
    if ev != "NONE":
        print(f"  t={t:3d} close={LAG[t][3]:6.2f} event={ev} trend_after={tr}")
lag_H = [b[1] for b in LAG]
print("swing highs:", [(i, lag_H[i], i + L) for i in range(len(lag_H)) if is_swing_high(lag_H, i)])

# ── Wilder ATR(14) fixture ───────────────────────────────────────────────────
print("\n== Wilder ATR(14) fixture ==")
ATR_BARS = [
    (100, 101.0, 99.0, 100.5), (100.5, 102.0, 100.0, 101.5),
    (101.5, 102.5, 100.5, 101.0), (101.0, 103.0, 100.5, 102.5),
    (102.5, 104.0, 102.0, 103.5), (103.5, 104.5, 103.0, 104.0),
    (104.0, 105.0, 103.5, 104.5), (104.5, 105.5, 104.0, 105.0),
    (105.0, 106.0, 104.5, 105.5), (105.5, 106.5, 105.0, 106.0),
    (106.0, 107.0, 105.5, 106.5), (106.5, 107.5, 106.0, 107.0),
    (107.0, 108.0, 106.5, 107.5), (107.5, 108.5, 107.0, 108.0),
    (108.0, 109.0, 107.5, 108.5), (108.5, 109.5, 108.0, 109.0),
    (109.0, 110.0, 108.5, 109.5), (109.5, 110.5, 109.0, 110.0),
    (110.0, 111.0, 109.5, 110.5), (110.5, 111.5, 110.0, 111.0),
]
trs = []
for k, (o, h, l, c) in enumerate(ATR_BARS):
    trs.append(h - l if k == 0 else max(h - l, abs(h - ATR_BARS[k - 1][3]), abs(l - ATR_BARS[k - 1][3])))
atr = None
atr_series = []
for k in range(len(ATR_BARS)):
    if k == 13:
        atr = sum(trs[:14]) / 14
    elif k > 13:
        atr = (atr * 13 + trs[k]) / 14
    atr_series.append(atr)
print("trs  :", [round(x, 10) for x in trs])
print("atr14:", [(k, round(v, 10)) for k, v in enumerate(atr_series) if v is not None])

# ── percentile boundaries ────────────────────────────────────────────────────
print("\n== percentileRank boundaries (window [1..10]) ==")
def pct_rank(w, v):
    return 100 * sum(1 for x in w if x <= v) / len(w)
win = list(range(1, 11))
for v in [0.5, 1, 5, 10, 11]:
    print(f"  pct_rank(win, {v}) = {pct_rank(win, v)}")
