#!/usr/bin/env python3
"""
FRVP-FX1H + triple-barrier — INDEPENDENT fixture calculator (Python).

Re-implements the frozen spec from its text, separately from the JS modules,
and writes scripts/frvp_fx1h_fixtures.json. The JS test suite
(frvp_fx1h_tests.mjs) consumes these fixtures: any disagreement between the
two implementations is a bug in one of them. Nothing here imports or reads
the JS code.

Adapted for the FX 1h test (mirrors scripts/frvp_fixture_calc.py of the
crypto branch, which this test family reuses conceptually):
  - 1h bars (ms_bar = 3,600,000), max hold = 240 HOURS (10 days)
  - NEW weekend fixtures: FX feeds contain no weekend candles; the hold
    window is wall-clock time, so the walk must skip the gap and either
    resolve on the first post-weekend candles or TIMEOUT exactly at the
    240h boundary. Frozen contract: weekends are skipped, never force-closed.

Frozen rules encoded (identical to src/strategy/frvpFadeFx1h.mjs header):
  - bins over [min low, max high]; uniform-spread (tick-)volume bucketing
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
OUT = os.path.join(HERE, 'frvp_fx1h_fixtures.json')


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
               max_hold_hours=240, ms_bar=3_600_000):
    hold_end = entry_close_t + max_hold_hours * ms_bar
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
T0 = 1_750_000_000_000
H = 3_600_000  # 1 hour in ms


def candle(k, l, h, v, o=None, c=None):
    return {'t': T0 + k * H, 'o': o if o is not None else (l + h) / 2,
            'h': h, 'l': l, 'c': c if c is not None else (l + h) / 2, 'v': v}


def at(y, mo, d, h):
    """hour-open timestamp for a specific UTC wall-clock time"""
    import calendar
    return calendar.timegm((y, mo, d, h, 0, 0)) * 1000


def wcandle(t, l, h, v, o=None, c=None):
    return {'t': t, 'o': o if o is not None else (l + h) / 2,
            'h': h, 'l': l, 'c': c if c is not None else (l + h) / 2, 'v': v}


def p_money(x):
    return None if x is None else round(x, 10)


fixtures = {'_meta': {
    'generator': 'scripts/frvp_fx1h_fixture_calc.py (independent Python implementation)',
    'note': 'frozen expected values for scripts/frvp_fx1h_tests.mjs; 1h bars, max hold 240h',
}}

# ── 1. profile fixtures (bins=4, va 70%; scale-free — same discriminators
#      as the crypto suite, retimestamped to 1h bars) ───────────────────────
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

pf('basic_poc_bin2_va_richer_neighbor', [
    candle(0, 110, 110, 10), candle(1, 130, 130, 20), candle(2, 160, 160, 30),
    candle(3, 185, 185, 15), candle(4, 140, 140, 5),
], 'POC=bin2(30 of 80); richer neighbor bin1(25)>bin3(15) DOWN first, cum=55<56; then bin0(10)<bin3(15) UP, cum=70>=56; VA bins1..3 -> VAH=185 VAL=128.75 (lo=110 hi=185 w=18.75)')

pf('va_tie_expands_up', [
    candle(0, 110, 110, 25), candle(1, 130, 130, 20), candle(2, 160, 160, 30),
    candle(3, 185, 185, 20),
], 'POC=bin2(30); nbrs bin1=20 vs bin3=20 TIE -> UP bin3 (cum50<66.5); k_hi out of range -> forced DOWN bin1 (cum70>=66.5); VA bins1..3 VAL=128.75. A DOWN-first tie rule would add bin0 (VA [0,3], VAL=110) — discriminator')

pf('poc_tie_lowest_bin', [
    candle(0, 110, 110, 30), candle(1, 130, 130, 30), candle(2, 160, 160, 5),
    candle(3, 185, 185, 2),
], 'bin0==bin1==30 -> POC=bin0 (lowest-priced wins); forced UP expansion to bin1 (cum60>=46.9); VA bins0..1: VAH=147.5 VAL=110; POC price=119.375 (bin1 would be 138.125 — discriminator)')

pf('va_is_poc_bin_alone', [
    candle(0, 110, 110, 5), candle(1, 130, 130, 5), candle(2, 160, 160, 90),
    candle(3, 185, 185, 5),
], 'POC=bin2(90 of 105 = 85.7% >= 70%) -> VA=bin2 only: VAH=166.25 VAL=147.5')

pf('uniform_spread_candle', [
    candle(0, 100, 200, 40), candle(1, 110, 110, 10), candle(2, 160, 160, 20),
], 'spread 40 over 4 bins (width 25) = 10 each; bins=[20,10,30,10]; total 70 target 49; POC=bin2; nbrs bin1(10) vs bin3(10) TIE -> UP bin3 (cum40); forced DOWN bin1 (cum50>=49); VA bins1..3: VAH=200 VAL=125')

# FX-specific: a one-price (zero-range) 1h candle — quiet hour with a single
# tick — must allocate its whole (tick) volume to its containing bin.
pf('zero_range_candle_single_tick', [
    candle(0, 110, 110, 12), candle(1, 130, 130, 20), candle(2, 160, 160, 30),
    candle(3, 185, 185, 15), candle(4, 147.1875, 147.1875, 3),
], 'same as basic but candle4 is a zero-range 1h candle (one tick) at 147.1875 = exactly the midpoint of bin1 [128.75,165.625): all 3 units go to bin1; totals identical to basic: POC=bin2, VA bins1..3')

pf('flat_window_degenerate', [
    candle(0, 150, 150, 10), candle(1, 150, 150, 10),
], 'hi==lo -> degenerate (FLAT_WINDOW)')

# ── 2. triple-barrier fixtures (1h bars, 240h hold) ────────────────────────
def tb(name, direction, entry, sl, tp, entry_idx, candles, max_hold_hours,
       note, r_abs=None):
    """entry_idx = index of the ENTRY candle (walk starts at entry_idx+1);
    entry close time is DERIVED from that candle (t + H) — no hand-set times."""
    if r_abs is None:
        r_abs = abs(entry - sl)
    entry_close_t = candles[entry_idx]['t'] + H
    res = resolve_tb(candles[entry_idx + 1:], direction, entry, sl, tp,
                     entry_close_t, max_hold_hours)
    fixtures.setdefault('tripleBarrier', []).append({
        'name': name, 'note': note, 'direction': direction, 'entry': entry,
        'sl': sl, 'tp': tp, 'rAbs': r_abs, 'entryCloseT': entry_close_t,
        'maxHoldHours': max_hold_hours, 'candlesAfterEntryIdx': entry_idx + 1,
        'candles': candles,
        'expected': {
            'type': res['type'], 'exitT': res['exitT'],
            'exitPrice': p_money(res['exitPrice']),
            'openPrice': p_money(res['openPrice']),
            'slGapFill': res['slGapFill'], 'bothTouched': res['bothTouched'],
            'r': r_of(direction, entry, r_abs, res['exitPrice']),
            'rOpen': (r_of(direction, entry, r_abs, res['openPrice'])
                      if res['type'] == 'SL' and res['slGapFill'] else None),
            'hoursHeld': (None if res['exitT'] is None
                          else int(round((res['exitT'] - entry_close_t) / H))),
        },
    })

# (1) LONG TP-first: candles 0,1 quiet; entry candle = idx1; walk starts idx2
tb('long_tp_first', 'LONG', 100.0, 98.0, 104.0, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 100.2, 101.0, 5, o=100.2, c=100.8),
    candle(3, 101.0, 104.2, 5, o=101.0, c=103.9),                        # TP touched
    candle(4, 103, 105, 5),
], 240, '2nd walked candle reaches high 104.2 >= TP 104 -> TP at 104, r=+2.0, hoursHeld=2')

# (2) LONG SL-first
tb('long_sl_first', 'LONG', 100.0, 98.0, 104.0, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 99.8, 100.9, 5, o=99.9, c=100.2),
    candle(3, 97.5, 100.0, 5, o=99.5, c=98.1),                           # low 97.5 <= SL 98
    candle(4, 97, 99, 5),
], 240, 'walked candle low 97.5 <= SL 98 -> SL at 98, r=-1.0, hoursHeld=2')

# (3) LONG both-in-one-candle -> SL (conservative)
tb('long_both_in_one_resolves_sl', 'LONG', 100.0, 98.0, 104.0, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 97.0, 105.0, 5, o=100.0, c=103.0),                         # huge range touches both
], 240, 'one candle spans SL and TP -> SL wins (worst case), r=-1.0, bothTouched=true, hoursHeld=1')

# (4) SHORT both-in-one-candle -> SL
tb('short_both_in_one_resolves_sl', 'SHORT', 100.0, 102.0, 96.0, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 95.0, 102.5, 5, o=100.0, c=97.0),                          # touches both
], 240, 'short: high 102.5 >= SL 102 AND low 95 <= TP 96 -> SL at 102, r=-1.0')

# (5) SHORT TP-first
tb('short_tp_first', 'SHORT', 100.0, 102.0, 96.0, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 99.0, 100.6, 5, o=100.2, c=99.5),
    candle(3, 95.5, 99.0, 5, o=99.0, c=96.2),                            # low <= 96
], 240, 'short TP: low 95.5 <= 96 -> TP at 96, r=+2.0, hoursHeld=2')

# (6) TIMEOUT: nothing touched, exit at close of the 240th-hour candle
_path = [candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5)]
for k in range(2, 242):
    _path.append(candle(k, 99.2, 100.8, 5, o=100.0, c=100.5))
tb('long_timeout_exact_240h', 'LONG', 100.0, 98.0, 104.0, 1, _path,
   240, 'no touch in 240h -> TIMEOUT at close of candle ending exactly entry+240h; hoursHeld=240, r=+0.25')

# (7) CENSORED: data ends before hold expires
tb('long_censored_data_end', 'LONG', 100.0, 98.0, 104.0, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 100, 100.9, 5, o=100.1, c=100.5),
    candle(3, 100, 100.7, 5, o=100.4, c=100.6),
], 240, 'only 2 walked candles then data ends -> CENSORED at last close 100.6, r=+0.3')

# (8) boundary touch: high EXACTLY == TP counts (inclusive)
tb('long_tp_boundary_exact_touch', 'LONG', 100.0, 98.0, 104.0, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 101, 104.0, 5, o=101.5, c=103.0),                          # high == TP exactly
], 240, 'high exactly equals TP 104 -> TP touch (inclusive), r=+2.0, hoursHeld=1')

# (9) gap through SL: candle opens BELOW SL -> fill still at SL price,
#     slGapFill=true, rOpen=(97-100)/2=-1.5 (worse realistic fill at open 97)
tb('long_gap_through_sl', 'LONG', 100.0, 98.0, 104.0, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 96.0, 96.8, 5, o=97.0, c=96.2),                            # opens 97 < SL 98
], 240, 'candle opens beyond SL: exit price stays SL 98 (touch-fill contract), slGapFill=1, rOpen=-1.5')

# (10) no TP barrier (degenerate POC case): only SL / timeout resolve
tb('long_no_tp_barrier', 'LONG', 100.0, 98.0, None, 1, [
    candle(0, 99, 101, 5), candle(1, 99.5, 100.5, 5),
    candle(2, 99, 100.5, 5, o=100, c=100.2),
    candle(3, 97.9, 99.5, 5, o=99.5, c=98.2),                            # SL touched
], 240, 'tp=null (degenerate POC): SL still resolves at 98; TP ignored, hoursHeld=2')

# (11) entry candle itself is NEVER walked: TP/SL-touching range inside the
#      ENTRY candle must not resolve; quiet afterwards -> TIMEOUT at 240h
_path = [candle(0, 99, 101, 5), candle(1, 97.0, 105.0, 5, o=100.0, c=100.4)]
for k in range(2, 242):
    _path.append(candle(k, 99.2, 100.8, 5, o=100.0, c=100.5))
tb('entry_candle_not_walked', 'LONG', 100.0, 98.0, 104.0, 1, _path,
   240, 'entry candle spans SL and TP but resolves nothing (entry at its close); quiet after -> TIMEOUT, hoursHeld=240')

# (12) SHORT timeout with hold boundary: candles closing AFTER entry+240h
#      must NOT be walked; 240th candle close is the exit
_path = [candle(0, 99, 101, 5)]
for k in range(1, 242):
    _path.append(candle(k, 99.2, 100.8, 5, o=100.0, c=100.5))
_path.append(candle(242, 105, 106, 5, o=105, c=105.5))  # outside hold window (would be an SL hit)
tb('short_timeout_hold_boundary', 'SHORT', 100.0, 102.0, 96.0, 0, _path,
   240, 'candle closing at entry+241h and the later SL spike are outside the hold window -> TIMEOUT at exactly 240h, r=-0.25')

# ── 3. WEEKEND fixtures (FX-specific: no candles Sat/Sun; the hold window
#      is wall-clock, so the walk skips the gap) ────────────────────────────
# Friday 2026-06-26; Monday 2026-06-29. Entry candle = Fri 18:00 UTC
# (closes 19:00). holdEnd = Fri 19:00 + 240h = Mon 2026-07-06 19:00.
FRI_18 = at(2026, 6, 26, 18)
assert (FRI_18 + H + 240 * H) == at(2026, 7, 6, 19)   # holdEnd from the CLOSE of the entry candle

fri = [
    wcandle(at(2026, 6, 26, 15), 99.0, 101.0, 5),
    wcandle(at(2026, 6, 26, 16), 99.0, 101.0, 5),
    wcandle(at(2026, 6, 26, 17), 99.2, 100.8, 5, o=100.0, c=100.3),
    wcandle(at(2026, 6, 26, 18), 99.5, 100.5, 5, o=99.8, c=100.0),       # ENTRY candle
]
mon = lambda h, l, hi, o, c, v=5: wcandle(at(2026, 6, 29, h), l, hi, v, o=o, c=c)

# (13) weekend skipped, then TP on Monday: entry Fri 18:00 close 100.0,
#      TP 104 -> Monday 09:00 candle high 104.3 -> TP at 104; wall-clock
#      held = Fri 19:00 -> Mon 10:00 = 63h
tb('weekend_skipped_tp_on_monday', 'LONG', 100.0, 98.0, 104.0, 3,
   fri + [
       mon(0, 99.0, 101.0, 99.5, 100.4),
       mon(1, 99.0, 101.0, 100.0, 100.6),
       mon(9, 100.5, 104.3, 100.8, 103.9),                               # TP touched Monday
       mon(10, 103.0, 105.0, 104.0, 104.5),
   ], 240,
   'weekend (Fri 19:00 -> Mon 00:00) contains no candles and resolves nothing; '
   'first post-weekend touch wins -> TP at 104, hoursHeld=63 (wall-clock)')

# (14) weekend gap-through-SL: market reopens Monday BELOW the SL -> fill
#      still at SL (touch-fill contract), slGapFill=true, rOpen at Monday open
tb('weekend_gap_through_sl', 'LONG', 100.0, 98.0, 104.0, 3,
   fri + [
       wcandle(at(2026, 6, 29, 0), 96.5, 97.4, 5, o=96.8, c=97.0),       # opens 96.8 < SL 98
   ], 240,
   'market reopens Monday below SL: exit price stays SL 98 (contract), '
   'slGapFill=1, rOpen=(96.8-100)/2=-1.6, hoursHeld=54 (Fri 19:00 -> Mon 01:00)')

# (15) weekend skipped, nothing touches for the whole window -> TIMEOUT at
#      exactly the 240h boundary, which lands on a LIVE candle (Mon Jul 6
#      18:00 candle closes 19:00 == holdEnd)
_path = fri + []
# quiet candles Mon Jun 29 .. Mon Jul 6 (hourly, skipping the next weekend)
import datetime as _dt
t = at(2026, 6, 29, 0)
end = at(2026, 7, 6, 18)   # last candle whose CLOSE == holdEnd
while t <= end:
    _h = (_dt.datetime.fromtimestamp(t / 1000, _dt.UTC))
    if not (_h.weekday() == 5 or (_h.weekday() == 6)):    # no Sat/Sun candles
        _path.append(wcandle(t, 99.2, 100.8, 5, o=100.0, c=100.5))
    t += H
tb('weekend_timeout_exact_240h', 'LONG', 100.0, 98.0, 104.0, 3, _path,
   240,
   'no touch across two weekends; the last walked candle closes exactly at '
   'entry+240h -> TIMEOUT, hoursHeld=240 (a candle closing 1h later is outside)')

with open(OUT, 'w') as f:
    json.dump(fixtures, f, indent=1)
print(f'wrote {OUT}: {len(fixtures.get("profile", []))} profile fixtures, '
      f'{len(fixtures.get("tripleBarrier", []))} triple-barrier fixtures')
