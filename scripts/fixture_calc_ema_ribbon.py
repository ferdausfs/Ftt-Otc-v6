#!/usr/bin/env python3
"""
Independent fixture calculator for scripts/ema_ribbon_tests.mjs.

Replicates ONLY the textbook EMA (SMA-seeded) arithmetic in pure Python,
completely separate from the JS indicator code, then freezes the expected
values/classifications for crafted synthetic fixtures. The JS test suite
asserts the strategy module reproduces these numbers (rel eps 1e-9).

EMA convention (identical to src/strategy/indicators.mjs):
  seed  = SMA of the first `period` values, placed at index period-1
  step  = v[k] * (2/(period+1)) + prev * (1 - 2/(period+1))

Output: a JS block (frozen fixtures) to paste into the test file.

Run: python3 scripts/fixture_calc_ema_ribbon.py
"""

def ema(vals, period):
    out = [None] * len(vals)
    if len(vals) < period:
        return out
    prev = sum(vals[:period]) / period
    out[period - 1] = prev
    k = 2.0 / (period + 1)
    for i in range(period, len(vals)):
        prev = vals[i] * k + prev * (1 - k)
        out[i] = prev
    return out

def order(f, m, s):
    if f > m and m > s:
        return 'BULL'
    if f < m and m < s:
        return 'BEAR'
    return 'TANGLED'

def find_flip(vals, want, fast, mid, slow):
    """First index where order(fast,mid,slow) == want and prior index's order != want."""
    ef, em, es = ema(vals, fast), ema(vals, mid), ema(vals, slow)
    for i in range(1, len(vals)):
        if ef[i] is None or em[i] is None or es[i] is None:
            continue
        if ef[i-1] is None or em[i-1] is None or es[i-1] is None:
            continue
        cur, prev = order(ef[i], em[i], es[i]), order(ef[i-1], em[i-1], es[i-1])
        if cur == want and prev != want:
            return i, ef, em, es
    return None, ef, em, es

def j(x):
    return repr(float(x))

print('// ── frozen by scripts/fixture_calc_ema_ribbon.py (independent Python) ──')

# ── F1..F4: 15m bias ribbon fixtures ─────────────────────────────────────────
ramp_up = [100 + k for k in range(120)]
ramp_dn = [200 - k for k in range(120)]
flat    = [100] * 120
osc     = [100 + (k % 2) for k in range(120)]

for name, series in [('F1_RAMP_UP', ramp_up), ('F2_RAMP_DOWN', ramp_dn),
                     ('F3_FLAT', flat), ('F4_OSC', osc)]:
    e5, e13, e55 = ema(series, 5), ema(series, 13), ema(series, 55)
    i = len(series) - 1
    print(f'export const {name} = {{ ema5: {j(e5[i])}, ema13: {j(e13[i])}, '
          f'ema55: {j(e55[i])}, order: "{order(e5[i], e13[i], e55[i])}" }};')

# ── F5: 1m V-series -> first BULLISH flip (trough at k=150, series of 260) ───
V = [300 - k for k in range(151)] + [150 + (k - 150) for k in range(151, 260)]
fi, e5, e7, e13 = find_flip(V, 'BULL', 5, 7, 13)
assert fi is not None and fi > 113, f'V-series flip at {fi}, need > 113 for full ATR window'
print(f'export const F5_V_FLIP = {{ idx: {fi},')
print(f'  cur: {{ ema5: {j(e5[fi])}, ema7: {j(e7[fi])}, ema13: {j(e13[fi])}, order: "{order(e5[fi], e7[fi], e13[fi])}" }},')
print(f'  prev: {{ ema5: {j(e5[fi-1])}, ema7: {j(e7[fi-1])}, ema13: {j(e13[fi-1])}, order: "{order(e5[fi-1], e7[fi-1], e13[fi-1])}" }},')
print(f'  next: {{ ema5: {j(e5[fi+1])}, ema7: {j(e7[fi+1])}, ema13: {j(e13[fi+1])}, order: "{order(e5[fi+1], e7[fi+1], e13[fi+1])}" }} }};')

# ── F6: Lambda-series -> first BEARISH flip ──────────────────────────────────
L = [150 + k for k in range(151)] + [300 - (k - 150) for k in range(151, 260)]
gi, e5, e7, e13 = find_flip(L, 'BEAR', 5, 7, 13)
assert gi is not None and gi > 113, f'Lambda flip at {gi}'
print(f'export const F6_LAMBDA_FLIP = {{ idx: {gi},')
print(f'  cur: {{ ema5: {j(e5[gi])}, ema7: {j(e7[gi])}, ema13: {j(e13[gi])}, order: "{order(e5[gi], e7[gi], e13[gi])}" }},')
print(f'  prev: {{ ema5: {j(e5[gi-1])}, ema7: {j(e7[gi-1])}, ema13: {j(e13[gi-1])}, order: "{order(e5[gi-1], e7[gi-1], e13[gi-1])}" }} }};')

# ── F7: EXPIRY_INSUFFICIENT craft — 15m bias pre-loaded, young 1m V-series ───
# c15 (100 candles) all close before the 1m window opens -> C1 (bias BULL)
# is defined from the very first 1m boundary. c1 = shallow 110-candle V
# (decline 100->76 over 25 bars, then rise) -> the first aligned BULLISH flip
# lands while the trailing ATR window still has < 100 values.
V_SHORT = [100 - k for k in range(25)] + [76 + (k - 25) for k in range(25, 110)]
ei, e5, e7, e13 = find_flip(V_SHORT, 'BULL', 5, 7, 13)
assert ei is not None and ei < 100, f'shallow-V flip at {ei}, need < 100'
print(f'export const F7_YOUNG = {{ flipIdx: {ei}, len: {len(V_SHORT)},')
print(f'  cur: {{ ema5: {j(e5[ei])}, ema7: {j(e7[ei])}, ema13: {j(e13[ei])}, order: "{order(e5[ei], e7[ei], e13[ei])}" }},')
print(f'  prev: {{ ema5: {j(e5[ei-1])}, ema7: {j(e7[ei-1])}, ema13: {j(e13[ei-1])}, order: "{order(e5[ei-1], e7[ei-1], e13[ei-1])}" }} }};'
      f' // expect EXPIRY_INSUFFICIENT at this boundary (ATR window < 100)')
