#!/usr/bin/env python3
"""
FRVP + triple-barrier — INDEPENDENT fixture calculator (Python).

Re-implements the frozen spec from its text, separately from the JS modules,
and writes scripts/frvp_fixtures.json. The JS test suite (frvp_tests.mjs)
consumes these fixtures: any disagreement between the two implementations is
a bug in one of them. Nothing here imports or reads the JS code.

Frozen rules encoded (identical to src/strategy/frvpFade.mjs header):
  - bins over [24h min low, 24h max high]; uniform-spread volume bucketing
  - POC argmax, ties -> lowest-priced bin; POC price = bin midpoint
  - VA: greedy outward expansion, richer neighbor first, exact tie -> UP,
    until cumulative >= 70% of window volume; VAH/VAL = edges of the range
  - triple barrier: walk candles closing <= entry_time + max_hold; touch is
    inclusive; both barriers in one candle -> SL (conservative); fills at
    barrier price; TIMEOUT at the last in-window close; CENSORED if data ends
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'frvp_fixtures.json')


# ── profile (independent implementation) ────────────────────────────────────
def alloc(c, lo, width, bins):
    l, h, v = c['l'], c['h'], c['v']
    if v <= 0 or width <= 0:
        return []
    if h == l:
        k = int((l - lo) / width)
        k = max(0, min(bins - 1, k))
        return [(k, v)]
    f_lo = max(0.0, (l - lo) / width)
    f_hi = min(float(bins), (h - lo) / width)
    span = f_hi - f_lo
    if span <= 0:
        return []
    out = []
    k = max(0, min(bins - 1, int(f_lo)))
    k_end = max(0, min(bins - 1, int(max(f_hi - 1e-12, f_lo))))
    while k <= k_end:
        o_lo = max(f_lo, float(k))
        o_hi = min(f_hi, float(k + 1))
        ln = o_hi - o_lo
        if ln > 0:
            out.append((k, v * ln / span))
        k += 1
    if not out:
        out.append((max(0, min(bins - 1, int(f_lo))), v))
    return out


def build_profile(candles, bins, va_pct):
    lo = min(c['l'] for c in candles)
    hi = max(c['h'] for c in candles)
    tv = sum(c['v'] for c in candles)
    if not (hi > lo) or not (tv > 0):
        return {'degenerate': True, 'lo': lo, 'hi': hi, 'totalVol': tv}
    width = (hi - lo) / bins
    bv = [0.0] * bins
    for c in candles:
        for k, vol in alloc(c, lo, width, bins):
            bv[k] += vol
    poc = 0
    for k in range(1, bins):
        if bv[k] > bv[poc]:
            poc = k
    poc_price = lo + (poc + 0.5) * width
    va_lo = va_hi = poc
    cum = bv[poc]
    target = va_pct * tv
    k_lo, k_hi = poc - 1, poc + 1
    while cum < target and (k_lo >= 0 or k_hi <= bins - 1):
        if k_lo < 0:
            k = k_hi
            k_hi += 1
        elif k_hi > bins - 1:
            k = k_lo
            k_lo -= 1
        elif bv[k_hi] >= bv[k_lo]:
            k = k_hi
            k_hi += 1
        else:
            k = k_lo
            k_lo -= 1
        cum += bv[k]
        va_lo = min(va_lo, k)
        va_hi = max(va_hi, k)
    return {
        'degenerate': False, 'lo': lo, 'hi': hi, 'width': width,
        'bins': bv, 'totalVol': tv, 'pocIdx': poc, 'pocPrice': poc_price,
        'vaLoIdx': va_lo, 'vaHiIdx': va_hi,
        'vah': lo + (va_hi + 1) * width, 'val': lo + va_lo * width,
    }


# ── triple barrier (independent implementation) ─────────────────────────────
def resolve_tb(candles_after, direction, entry, sl, tp, entry_close_t,
               max_hold_min=120, ms_bar=60000):
    hold_end = entry_close_t + max_hold_min * ms_bar
    last = None
    for c in candles_after:
        close_t = c['t'] + ms_bar
        if close_t > hold_end:
            break
        last = c
        sl_touch = (c['l'] <= sl) if direction == 'LONG' else (c['h'] >= sl)
        tp_touch = (tp is not None) and ((c['h'] >= tp) if direction == 'LONG' else (c['l'] <= tp))
        if sl_touch or tp_touch:
            typ = 'SL' if sl_touch else 'TP'
            px = sl if sl_touch else tp
            gap = sl_touch and ((c['o'] <= sl) if direction == 'LONG' else (c['o'] >= sl))
            return {'type': typ, 'exitT': close_t, 'exitPrice': px, 'openPrice': c['o'],
                    'slGapFill': bool(gap), 'bothTouched': bool(sl_touch and tp_touch)}
    if last is None:
        return {'type': 'CENSORED', 'exitT': None, 'exitPrice': None, 'openPrice': None,
                'slGapFill': False, 'bothTouched': False}
    exact = (last['t'] + ms_bar) == hold_end
    return {'type': 'TIMEOUT' if exact else 'CENSORED', 'exitT': last['t'] + ms_bar,
            'exitPrice': last['c'], 'openPrice': last['o'],
            'slGapFill': False, 'bothTouched': False}


def r_of(direction, entry, r_abs, px):
    if px is None:
        return None
    return round(((px - entry) if direction == 'LONG' else (entry - px)) / r_abs, 8)


# ── fixtures ────────────────────────────────────────────────────────────────
T0 = 1_700_000_000_000
M = 60_000


def candle(k, l, h, v, o=None, c=None):
    return {'t': T0 + k * M, 'o': o if o is not None else (l + h) / 2,
            'h': h, 'l': l, 'c': c if c is not None else (l + h) / 2, 'v': v}


def p_money(x):
    return None if x is None else round(x, 10)


fixtures = {'_meta': {
    'generator': 'scripts/frvp_fixture_calc.py (independent Python implementation)',
    'note': 'frozen expected values for scripts/frvp_tests.mjs',
}}

# ── 1. profile fixtures (bins=4, va 70%) ────────────────────────────────────
def pf(name, candles, expect_note):
    p = build_profile(candles, 4, 0.70)
    fixtures.setdefault('profile', []).append({
        'name': name, 'note': expect_note, 'binsCount': 4, 'vaPct': 0.70,
        'window': candles,
        'expected': {
            'degenerate': p.get('degenerate', False),
            'lo': p_money(p.get('lo')), 'hi': p_money(p.get('hi')),
            'width': p_money(p.get('width')), 'totalVol': p_money(p.get('totalVol')),
            'pocIdx': p.get('pocIdx'), 'pocPrice': p_money(p.get('pocPrice')),
            'vaLoIdx': p.get('vaLoIdx'), 'vaHiIdx': p.get('vaHiIdx'),
            'vah': p_money(p.get('vah')), 'val': p_money(p.get('val')),
        },
    })

# basic: POC bin2; VA expands to the richer neighbor (down), then up
# bins: [10, 25, 30, 15]; total 80; target 56; cum 30 -> down bin1 (55)
# -> then up bin3 (70); VA bins 1..3
pf('basic_poc_bin2_va_richer_neighbor', [
    candle(0, 110, 110, 10), candle(1, 130, 130, 20), candle(2, 160, 160, 30),
    candle(3, 185, 185, 15), candle(4, 140, 140, 5),
], 'POC=bin2(30 of 80); richer neighbor bin1(25)>bin3(15) DOWN first, cum=55<56; then bin0(10)<bin3(15) UP, cum=70>=56; VA bins1..3 -> VAH=185 VAL=128.75 (lo=110 hi=185 w=18.75)')

# VA expansion TIE -> UP first. bins [25, 20, 30, 20]; total 95; target 66.5.
# UP-tie path: bin3 (cum 50) -> richer of bin1(20)/bin0(25)?? no: after UP,
# k_hi is out of range -> forced DOWN bin1, cum 70 >= 66.5 -> VA [1,3].
# DOWN-tie path (wrong rule): bin1 (cum 50) -> richer bin0(25) vs bin3(20)
# -> bin0, cum 75 -> VA [0,3] (VAL=110). The two rules DISAGREE -> fixture
# discriminates the tie direction; frozen rule (UP first) gives VA [1,3].
pf('va_tie_expands_up', [
    candle(0, 110, 110, 25), candle(1, 130, 130, 20), candle(2, 160, 160, 30),
    candle(3, 185, 185, 20),
], 'POC=bin2(30); nbrs bin1=20 vs bin3=20 TIE -> UP bin3 (cum50<66.5); k_hi out of range -> forced DOWN bin1 (cum70>=66.5); VA bins1..3 VAL=128.75. A DOWN-first tie rule would add bin0 (VA [0,3], VAL=110) — discriminator')

# POC TIE -> lowest-priced bin. bins [30, 30, 5, 2]; total 67; target 46.9.
pf('poc_tie_lowest_bin', [
    candle(0, 110, 110, 30), candle(1, 130, 130, 30), candle(2, 160, 160, 5),
    candle(3, 185, 185, 2),
], 'bin0==bin1==30 -> POC=bin0 (lowest-priced wins); forced UP expansion to bin1 (cum60>=46.9); VA bins0..1: VAH=147.5 VAL=110; POC price=119.375 (bin1 would be 138.125 — discriminator)')

# POC bin alone >= 70% -> VA == POC bin. bins [5,5,90,5]; total 105; target 73.5
pf('va_is_poc_bin_alone', [
    candle(0, 110, 110, 5), candle(1, 130, 130, 5), candle(2, 160, 160, 90),
    candle(3, 185, 185, 5),
], 'POC=bin2(90 of 105 = 85.7% >= 70%) -> VA=bin2 only: VAH=166.25 VAL=147.5')

# uniform spread candle spans all bins (tests alloc proportions); then the
# first expansion step is a TIE (bin1=10 vs bin3=10 -> UP), forced DOWN next.
pf('uniform_spread_candle', [
    candle(0, 100, 200, 40), candle(1, 110, 110, 10), candle(2, 160, 160, 20),
], 'spread 40 over 4 bins (width 25) = 10 each; bins=[20,10,30,10]; total 70 target 49; POC=bin2; nbrs bin1(10) vs bin3(10) TIE -> UP bin3 (cum40); forced DOWN bin1 (cum50>=49); VA bins1..3: VAH=200 VAL=125')

# degenerate: flat window
pf('flat_window_degenerate', [
    candle(0, 150, 150, 10), candle(1, 150, 150, 10),
], 'hi==lo -> degenerate (FLAT_WINDOW)')

# ── 2. triple-barrier fixtures ──────────────────────────────────────────────
def tb(name, direction, entry, sl, tp, entry_idx, candles, max_hold_min,
       note, r_abs=None):
    """entry_idx = index of the ENTRY candle (walk starts at entry_idx+1);
    entry close time is DERIVED from that candle (t + M) — no hand-set times."""
    if r_abs is None:
        r_abs = abs(entry - sl)
    entry_close_t = candles[entry_idx]['t'] + M
    res = resolve_tb(candles[entry_idx + 1:], direction, entry, sl, tp,
                     entry_close_t, max_hold_min)
    fixtures.setdefault('tripleBarrier', []).append({
        'name': name, 'note': note, 'direction': direction, 'entry': entry,
        'sl': sl, 'tp': tp, 'rAbs': r_abs, 'entryCloseT': entry_close_t,
        'maxHoldMin': max_hold_min, 'candlesAfterEntryIdx': entry_idx + 1,
        'candles': candles,
        'expected': {
            'type': res['type'], 'exitT': res['exitT'],
            'exitPrice': p_money(res['exitPrice']),
            'openPrice': p_money(res['openPrice']),
            'slGapFill': res['slGapFill'], 'bothTouched': res['bothTouched'],
            'r': r_of(direction, entry, r_abs, res['exitPrice']),
            'rOpen': (r_of(direction, entry, r_abs, res['openPrice'])
                      if res['type'] == 'SL' and res['slGapFill'] else None),
            'minutesHeld': (None if res['exitT'] is None
                            else int(round((res['exitT'] - entry_close_t) / M))),
        },
    })

# (1) LONG TP-first: candles 0,1 quiet; entry candle = idx1; walk starts idx2
tb('long_tp_first', 'LONG', 100.0, 98.0, 104.0, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 100.2, 101.0, 5, o=100.2, c=100.8),
    candle(3, 101.0, 104.2, 5, o=101.0, c=103.9),                        # TP touched
    candle(4, 103, 105, 5),
], 120, '2nd walked candle reaches high 104.2 >= TP 104 -> TP at 104, r=+2.0, minutesHeld=2')

# (2) LONG SL-first
tb('long_sl_first', 'LONG', 100.0, 98.0, 104.0, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 99.8, 100.9, 5, o=99.9, c=100.2),
    candle(3, 97.5, 100.0, 5, o=99.5, c=98.1),                           # low 97.5 <= SL 98
    candle(4, 97, 99, 5),
], 120, 'walked candle low 97.5 <= SL 98 -> SL at 98, r=-1.0, minutesHeld=2')

# (3) LONG both-in-one-candle -> SL (conservative)
tb('long_both_in_one_resolves_sl', 'LONG', 100.0, 98.0, 104.0, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 97.0, 105.0, 5, o=100.0, c=103.0),                         # huge range touches both
], 120, 'one candle spans SL and TP -> SL wins (worst case), r=-1.0, bothTouched=true, minutesHeld=1')

# (4) SHORT both-in-one-candle -> SL
tb('short_both_in_one_resolves_sl', 'SHORT', 100.0, 102.0, 96.0, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 95.0, 102.5, 5, o=100.0, c=97.0),                          # touches both
], 120, 'short: high 102.5 >= SL 102 AND low 95 <= TP 96 -> SL at 102, r=-1.0')

# (5) SHORT TP-first
tb('short_tp_first', 'SHORT', 100.0, 102.0, 96.0, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 99.0, 100.6, 5, o=100.2, c=99.5),
    candle(3, 95.5, 99.0, 5, o=99.0, c=96.2),                            # low <= 96
], 120, 'short TP: low 95.5 <= 96 -> TP at 96, r=+2.0, minutesHeld=2')

# (6) TIMEOUT: nothing touched, exit at close of the 120th-minute candle
_path = [candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5)]
for k in range(2, 122):
    _path.append(candle(k, 99.2, 100.8, 5, o=100.0, c=100.5))
tb('long_timeout_exact_120', 'LONG', 100.0, 98.0, 104.0, 1, _path,
   120, 'no touch in 120 min -> TIMEOUT at close of candle ending exactly entry+120m; minutesHeld=120, r=+0.25')

# (7) CENSORED: data ends before hold expires
tb('long_censored_data_end', 'LONG', 100.0, 98.0, 104.0, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 100, 100.9, 5, o=100.1, c=100.5),
    candle(3, 100, 100.7, 5, o=100.4, c=100.6),
], 120, 'only 2 walked candles then data ends -> CENSORED at last close 100.6, r=+0.3')

# (8) boundary touch: high EXACTLY == TP counts (inclusive)
tb('long_tp_boundary_exact_touch', 'LONG', 100.0, 98.0, 104.0, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 101, 104.0, 5, o=101.5, c=103.0),                          # high == TP exactly
], 120, 'high exactly equals TP 104 -> TP touch (inclusive), r=+2.0, minutesHeld=1')

# (9) gap through SL: candle opens BELOW SL -> fill still at SL price,
#     slGapFill=true, rOpen=(97-100)/2=-1.5 (worse realistic fill at open 97)
tb('long_gap_through_sl', 'LONG', 100.0, 98.0, 104.0, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 96.0, 96.8, 5, o=97.0, c=96.2),                            # opens 97 < SL 98
], 120, 'candle opens beyond SL: exit price stays SL 98 (touch-fill contract), slGapFill=1, rOpen=-1.5')

# (10) no TP barrier (degenerate POC case): only SL / timeout resolve
tb('long_no_tp_barrier', 'LONG', 100.0, 98.0, None, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 99, 100.5, 5, o=100, c=100.2),
    candle(3, 97.9, 99.5, 5, o=99.5, c=98.2),                            # SL touched
], 120, 'tp=null (degenerate POC): SL still resolves at 98; TP ignored, minutesHeld=2')

# (11) entry candle itself is NEVER walked: TP/SL-touching range inside the
#      ENTRY candle must not resolve; quiet afterwards -> TIMEOUT at 120m
_path = [candle(0, 99, 101, 5), candle(1, 97.0, 105.0, 5, o=100.0, c=100.4)]
for k in range(2, 122):
    _path.append(candle(k, 99.2, 100.8, 5, o=100.0, c=100.5))
tb('entry_candle_not_walked', 'LONG', 100.0, 98.0, 104.0, 1, _path,
   120, 'entry candle spans SL and TP but resolves nothing (entry at its close); quiet after -> TIMEOUT, minutesHeld=120')

# (12) SHORT timeout with max hold boundary: candles closing AFTER
#      entry+120m must NOT be walked; 120th candle close is the exit
_path = [candle(0, 99, 101, 5)]
for k in range(1, 122):
    _path.append(candle(k, 99.2, 100.8, 5, o=100.0, c=100.5))
_path.append(candle(122, 105, 106, 5, o=105, c=105.5))  # outside hold window (would be an SL hit)
tb('short_timeout_hold_boundary', 'SHORT', 100.0, 102.0, 96.0, 0, _path,
   120, 'candle closing at entry+121m and the later SL spike are outside the hold window -> TIMEOUT at exactly 120m, r=-0.25')

with open(OUT, 'w') as f:
    json.dump(fixtures, f, indent=1)
print(f'wrote {OUT}: {len(fixtures.get("profile", []))} profile fixtures, '
      f'{len(fixtures.get("tripleBarrier", []))} triple-barrier fixtures')
