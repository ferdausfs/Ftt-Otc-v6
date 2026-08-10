#!/usr/bin/env python3
"""
feature_validation.py — R1 train→holdout tables for the Phase F round 2 edge
features (hour-of-day, RSI×direction, volatility state, ATR percentile,
session-range, recent-form).

Discipline (R1 / holdout rules):
  TRAIN    = 08-01..06  (choose / derive)
  HOLDOUT  = 08-07..09  (validate, never peeked)
  Every feature is reported as a WR table: feature OFF (full pool) vs ON
  (tradable pool after the feature's gate), with Wilson 95% CI + coverage.
  A feature that does NOT improve holdout (or at least not hurt, CI overlap
  accepted) is reported as such — the PR decides ship/flag/drop from THIS
  output, not from opinion.

Data sources (re-runnable on fresh data, same discovery as
scripts/calibration_validation.py):
  - phase_f_forward/*/*.json  (drive snapshots; decided rows = WIN/LOSS)
  - signalIndicators rows on instrumented snapshots (>= 2026-08-09 deploy)
    carry { rsi, atrPct, adx, bbBandwidth } and, after THIS PR deploys,
    { atrPercentile, bbState, sessionRange, hourUtc, hourMult, totalMult }
  - features without signal-time data are reported PENDING (no fabricated
    values — see D9 of the PR).

Thresholds are read from src/config.js (single source of truth, R4). If node
is unavailable the script falls back to inline copies and prints a warning.

Usage:
  python3 scripts/feature_validation.py
  python3 scripts/feature_validation.py --data /path/to/phase_f_forward
  python3 scripts/feature_validation.py --data /path --out feature_validation.md
"""

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timezone

TRAIN_END = '2026-08-07'   # TRAIN = days < this; HOLDOUT = days >= this


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data', default=None, help='path to phase_f_forward root (contains date folders)')
    p.add_argument('--out', default=None, help='write markdown tables to this file')
    p.add_argument('--config', default=None, help='path to src/config.js (default: next to this script)')
    p.add_argument('--no-node', action='store_true', help='skip node extraction of config thresholds')
    return p.parse_args()


# ── config extraction (single source of truth: src/config.js, R4) ────────
def extract_config(config_path):
    """Read EDGE_FEATURES + SELF_CALIB from config.js via node (JSON print)."""
    try:
        script = (
            "import('./config.js').then(m => {"
            "const c = m.CONFIG;"
            "console.log(JSON.stringify({ EDGE_FEATURES: c.EDGE_FEATURES, SELF_CALIB: c.SELF_CALIB }));"
            "}).catch(e => { console.error(e.message); process.exit(1); });"
        )
        proc = subprocess.run(
            ['node', '--input-type=module', '-e', script],
            cwd=os.path.dirname(os.path.abspath(config_path)) or '.',
            capture_output=True, text=True, timeout=60,
        )
        if proc.returncode != 0:
            return None
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception:
        return None


FALLBACK_CONFIG = {
    'EDGE_FEATURES': {
        'HOUR_MULTIPLIERS': {
            0: 1.04, 1: 1.10, 2: 1.04, 3: 0.96, 4: 0.96, 5: 0.92,
            6: 1.00, 7: 1.05, 8: 1.04, 9: 1.10, 10: 0.85, 11: 1.00,
            12: 0.95, 13: 1.00, 14: 1.00, 15: 0.85, 16: 0.85, 17: 1.10,
            18: 1.05, 19: 0.85, 20: 0.89, 21: 1.10, 22: 1.08, 23: 0.87,
        },
        'SESSION_RANGE': {'extremeLow': 0.15, 'extremeHigh': 0.85, 'extremeMult': 1.05},
        'RSI_DIRECTION_GATE': {'buyMaxRsi': 55, 'sellMinRsi': 45, 'penaltyMult': 0.85},
        'VOL_STATE': {'deadSqueezeBlock': {'FOREX': 0.04, 'CRYPTO': 0.20},
                      'squeezeMax': {'FOREX': 0.08, 'CRYPTO': 0.80}, 'squeezeMult': 0.90},
        'ATR_PERCENTILE': {'window': 50, 'minSamples': 20, 'squeezePct': 30,
                           'expansionPct': 80, 'squeezeMult': 0.95, 'expansionMult': 1.05},
        'RECENT_FORM': {'minSample': 10, 'badWr': 0.35, 'badMult': 0.85},
    },
    'SELF_CALIB': {'MIN_HOUR_OBS': 20, 'HOUR_MULT_MIN': 0.85, 'HOUR_MULT_MAX': 1.10},
}


# ── data loading ─────────────────────────────────────────────────────────
def find_json_files(root_candidates):
    files = []
    for root in root_candidates:
        if not root or not os.path.isdir(root):
            continue
        for pat in (os.path.join(root, '*', '*.json'),
                    os.path.join(root, 'phase_f_forward', '*', '*.json'),
                    os.path.join(root, 'phase_f_forward', 'phase_f_forward', '*', '*.json')):
            files.extend(__import__('glob').glob(pat))
    files = sorted(set(files))
    skip = {'health.json', 'pairs.json', 'MANIFEST.txt', 'SHA256SUMS.txt', 'SHA256SUM.txt'}
    return [f for f in files if os.path.basename(f) not in skip]


def load_rows(files):
    rows = []
    for f in files:
        try:
            d = json.load(open(f))
        except Exception:
            continue
        rows += d.get('signals') or []
    seen = {}
    for s in rows:
        if s.get('id'):
            seen[s['id']] = s
    out = []
    for s in seen.values():
        if s.get('result') not in ('WIN', 'LOSS'):
            continue
        try:
            dt = datetime.fromisoformat(s['timestamp'].replace('Z', '+00:00')).astimezone(timezone.utc)
        except Exception:
            continue
        s['_dt'] = dt
        out.append(s)
    return out


# ── stats ────────────────────────────────────────────────────────────────
def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / d
    return p, max(0.0, c - h), min(1.0, c + h)


def table(pool):
    n = len(pool)
    k = sum(1 for r in pool if r['result'] == 'WIN')
    p, lo, hi = wilson(k, n)
    return {'n': n, 'wins': k, 'wr': p, 'ci_lo': lo, 'ci_hi': hi}


def fmt(t):
    return '%5.1f%% (n=%4d) CI[%4.1f-%4.1f]' % (t['wr'] * 100, t['n'], t['ci_lo'] * 100, t['ci_hi'] * 100)


def split_rows(rows):
    tr = [r for r in rows if r['_dt'].strftime('%Y-%m-%d') < TRAIN_END]
    va = [r for r in rows if r['_dt'].strftime('%Y-%m-%d') >= TRAIN_END]
    return tr, va


def hour_of(r):
    return r['_dt'].hour


def si(r):
    v = r.get('signalIndicators')
    return v if isinstance(v, dict) else None


def row_feature_tables(rows, select_on):
    """select_on(row) -> bool: True = row stays in the ON pool."""
    off = table(rows)
    on_rows = [r for r in rows if select_on(r)]
    on = table(on_rows)
    excluded = table([r for r in rows if not select_on(r)])
    return off, on, excluded


def print_pair(name, off, on, excluded):
    delta = (on['wr'] - off['wr']) * 100
    print('%-22s OFF %s' % (name, fmt(off)))
    print('%-22s ON  %s   (excluded %s, Δ %+0.1f pts)' % (name, fmt(on), fmt(excluded), delta))


# ── recent-form reconstruction (no lookahead) ────────────────────────────
def recent_form_survives(rows):
    """Row keeps the pair's prior-20 rolling WR (strictly-before signals only).
    Returns a dict row_id -> survived(bool)."""
    by_pair = defaultdict(list)
    for r in rows:
        by_pair[r['pair']].append(r)
    survived = {}
    for pair, sigs in by_pair.items():
        sigs.sort(key=lambda r: r['_dt'])
        prior = []
        for r in sigs:
            if len(prior) >= 10:
                win = sum(1 for x in prior[-20:] if x == 'WIN')
                wr = win / min(len(prior[-20:]), 20)
                survived[r['id']] = wr >= 0.35
            else:
                survived[r['id']] = True   # insufficient history -> no gate
            prior.append(r['result'])
    return survived


def main():
    args = parse_args()

    # config
    config_path = args.config or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'config.js')
    cfg = None
    if not args.no_node and os.path.exists(config_path):
        cfg = extract_config(config_path)
    if cfg is None:
        print('WARNING: using FALLBACK config copies (node extraction failed or --no-node)', file=sys.stderr)
        cfg = FALLBACK_CONFIG
    ef = cfg['EDGE_FEATURES']
    sc = cfg['SELF_CALIB']

    # data
    roots = [args.data, '/tmp/wd/data/extracted/phase_f_forward',
             os.path.expanduser('~/wd/data/extracted/phase_f_forward'),
             os.path.expanduser('~/phase_f_forward'),
             os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'phase_f_forward')]
    files = find_json_files(roots)
    if not files:
        print('FATAL: no phase_f_forward JSON found. Pass --data <phase_f_forward root>.', file=sys.stderr)
        sys.exit(2)
    rows = load_rows(files)
    tr, va = split_rows(rows)
    print('rows: TRAIN=%d HOLDOUT=%d (total %d)\n' % (len(tr), len(va), len(rows)))
    if len(tr) == 0 or len(va) == 0:
        print('FATAL: need both TRAIN and HOLDOUT rows', file=sys.stderr)
        sys.exit(2)

    out_lines = []

    def emit(s=''):
        print(s)
        out_lines.append(s)

    emit('## feature_validation — R1 train→holdout tables')
    emit('')
    emit('Data: TRAIN < %s · HOLDOUT >= %s · thresholds from src/config.js (R4)' % (TRAIN_END, TRAIN_END))
    emit('')
    emit('### Baseline')
    emit('')
    emit('| window | WR | n |')
    emit('|---|---|---|')
    emit('| TRAIN 08-01..06 | %s | %d |' % (fmt(table(tr)), table(tr)['n']))
    emit('| HOLDOUT 08-07..09 | %s | %d |' % (fmt(table(va)), table(va)['n']))
    emit('')

    # ── 1. HOUR OF DAY ──
    # JSON keys arrive as strings from node — normalise to int.
    hour_map = {int(h): float(m) for h, m in ef['HOUR_MULTIPLIERS'].items()}
    # Gate-bad hours = strong penalties (mult <= 0.90): these are the hours
    # whose signals the floor+multiplier interaction can actually block. The
    # mild band (0.92-0.96) is a confidence shave, not a gate.
    bad_hours = sorted(h for h, m in hour_map.items() if m <= 0.90)
    good_hours = sorted(h for h, m in hour_map.items() if m >= 1.05)
    emit('### A1 — hour-of-day gate (config bad hours %s, ×0.85)' % bad_hours)
    emit('')
    emit('| window | OFF (all) | ON (skip bad hours) | excluded | Δ pts |')
    emit('|---|---|---|---|---|')
    for name, pool in (('TRAIN', tr), ('HOLDOUT', va)):
        off, on, ex = row_feature_tables(pool, lambda r: hour_of(r) not in set(bad_hours))
        emit('| %s | %s | %s | %s | %+0.1f |' % (name, fmt(off), fmt(on), fmt(ex), (on['wr'] - off['wr']) * 100))
    emit('')
    emit('Hour multipliers (TRAIN-derived, clamped %.2f-%.2f): bad %s · good %s' %
         (float(sc['HOUR_MULT_MIN']), float(sc['HOUR_MULT_MAX']), bad_hours, good_hours))
    emit('')
    emit('Per-hour WR (TRAIN):')
    emit('')
    emit('| hour | WR | n | mult |')
    emit('|---|---|---|---|')
    byh = defaultdict(list)
    for r in tr:
        byh[hour_of(r)].append(r)
    base_tr = table(tr)['wr']
    for h in range(24):
        t = table(byh.get(h, []))
        m = hour_map.get(h, 1.0)
        emit('| %02d | %s | %d | x%.2f |' % (h, fmt(t), t['n'], m))
    emit('')
    # holdout per-hour (n>=10)
    emit('Per-hour WR (HOLDOUT, n>=10):')
    emit('')
    emit('| hour | WR | n |')
    emit('|---|---|---|')
    byh2 = defaultdict(list)
    for r in va:
        byh2[hour_of(r)].append(r)
    for h in range(24):
        if len(byh2.get(h, [])) >= 10:
            t = table(byh2[h])
            emit('| %02d | %s | %d |' % (h, fmt(t), t['n']))
    emit('')

    # ── 2. RECENT-FORM (reconstructed, no lookahead) ──
    emit('### C8 — recent-form gate (pair prior-20 rolling WR < %.2f, n>=%d)' %
         (ef['RECENT_FORM']['badWr'], ef['RECENT_FORM']['minSample']))
    emit('')
    emit('| window | OFF (all) | ON (recent WR >= threshold) | excluded | Δ pts |')
    emit('|---|---|---|---|---|')
    surv_tr = recent_form_survives(tr)
    surv_va = recent_form_survives(va)
    for name, pool, surv in (('TRAIN', tr, surv_tr), ('HOLDOUT', va, surv_va)):
        off, on, ex = row_feature_tables(pool, lambda r, s=surv: s.get(r['id'], True))
        emit('| %s | %s | %s | %s | %+0.1f |' % (name, fmt(off), fmt(on), fmt(ex), (on['wr'] - off['wr']) * 100))
    emit('')

    # ── 3. INSTRUMENTED FEATURES (RSI×dir, vol-state, ATR-pct) ──
    def with_ind(pool):
        return [r for r in pool if si(r) and si(r).get('rsi') is not None]

    itr, iva = with_ind(tr), with_ind(va)
    emit('### B4/B5/B6 — indicator-gated features (instrumented rows only)')
    emit('')
    emit('Instrumented coverage: TRAIN=%d HOLDOUT=%d (signalIndicators rows; '
         'drive snapshots before the 2026-08-09 deploy carry none)' % (len(itr), len(iva)))
    emit('')
    if len(itr) + len(iva) == 0:
        emit('**PENDING — no instrumented rows in the data.** The worker has been '
             'persisting signalIndicators since the 2026-08-09 deploy (~50-80 rows/day); '
             're-run this script on the next drive snapshot. The engine gates are '
             'shipped config-first with reviewer slice evidence (BUY+RSI>55 = 32.3%, '
             'BB 0.2-0.8 = 35-36%, n=66) and are re-evaluated by this script as data '
             'accumulates (self-calibration refreshes them weekly).')
        emit('')
    else:
        rsi_cfg = ef['RSI_DIRECTION_GATE']
        emit('#### B4 — RSI × direction (BUY rsi>%d / SELL rsi<%.0f)' %
             (rsi_cfg['buyMaxRsi'], rsi_cfg['sellMinRsi']))
        emit('')
        emit('| window | OFF (instrumented) | ON (skip chasing) | excluded | Δ pts |')
        emit('|---|---|---|---|---|')
        for name, pool in (('TRAIN', itr), ('HOLDOUT', iva)):
            def gate_ok(r):
                d = r.get('direction'); v = si(r).get('rsi')
                if d == 'BUY' and v > rsi_cfg['buyMaxRsi']:
                    return False
                if d == 'SELL' and v < rsi_cfg['sellMinRsi']:
                    return False
                return True
            off, on, ex = row_feature_tables(pool, gate_ok)
            emit('| %s | %s | %s | %s | %+0.1f |' % (name, fmt(off), fmt(on), fmt(ex), (on['wr'] - off['wr']) * 100))
        emit('')

        vs = ef['VOL_STATE']
        emit('#### B5 — volatility state (BB bandwidth %%: dead ≤ %.2f block, mid ≤ %.2f ×%.2f)' %
             (vs['deadSqueezeBlock']['CRYPTO'], vs['squeezeMax']['CRYPTO'], vs['squeezeMult']))
        emit('')
        emit('| window | OFF (instrumented) | ON (skip dead+mid) | excluded | Δ pts |')
        emit('|---|---|---|---|---|')
        for name, pool in (('TRAIN', itr), ('HOLDOUT', iva)):
            # ON = tradable pool after the gate: dead-squeeze blocked AND
            # mid-squeeze skipped (both are the feature's gate effects).
            def vol_ok(r):
                bb = si(r).get('bbBandwidth')
                if bb is None:
                    return True
                return bb > vs['squeezeMax']['CRYPTO']
            off, on, ex = row_feature_tables(pool, vol_ok)
            emit('| %s | %s | %s | %s | %+0.1f |' % (name, fmt(off), fmt(on), fmt(ex), (on['wr'] - off['wr']) * 100))
        emit('')
        emit('Slice detail (BB buckets, instrumented):')
        emit('')
        emit('| window | BB<=dead | dead<BB<=mid | BB>mid |')
        emit('|---|---|---|---|')
        for name, pool in (('TRAIN', itr), ('HOLDOUT', iva)):
            dead = table([r for r in pool if si(r).get('bbBandwidth') is not None and si(r)['bbBandwidth'] <= vs['deadSqueezeBlock']['CRYPTO']])
            mid = table([r for r in pool if si(r).get('bbBandwidth') is not None and vs['deadSqueezeBlock']['CRYPTO'] < si(r)['bbBandwidth'] <= vs['squeezeMax']['CRYPTO']])
            high = table([r for r in pool if si(r).get('bbBandwidth') is not None and si(r)['bbBandwidth'] > vs['squeezeMax']['CRYPTO']])
            emit('| %s | %s | %s | %s |' % (name, fmt(dead), fmt(mid), fmt(high)))
        emit('')

        ap = ef['ATR_PERCENTILE']
        emit('#### B6 — ATR percentile (rows with atrPercentile)')
        emit('')
        pools_ap = (([r for r in tr if si(r) and si(r).get('atrPercentile') is not None],
                     [r for r in va if si(r) and si(r).get('atrPercentile') is not None]))
        if sum(len(p) for p in pools_ap) == 0:
            emit('**PENDING — no atrPercentile rows yet.** atrPercentile ships with '
                 'this PR (additive signalIndicators field); re-run on the next snapshot.')
        else:
            emit('| window | OFF | ON (skip squeeze pct<%d) | excluded | Δ pts |' % ap['squeezePct'])
            emit('|---|---|---|---|---|')
            for name, pool in (('TRAIN', pools_ap[0]), ('HOLDOUT', pools_ap[1])):
                off, on, ex = row_feature_tables(pool, lambda r: si(r).get('atrPercentile', 100) >= ap['squeezePct'])
                emit('| %s | %s | %s | %s | %+0.1f |' % (name, fmt(off), fmt(on), fmt(ex), (on['wr'] - off['wr']) * 100))
        emit('')

    # ── 4. SESSION-RANGE — PENDING (no candle snapshots in drive data) ──
    emit('### A2 — session-range position')
    emit('')
    emit('**PENDING — needs signal-time candle snapshots (today high/low), which '
         'the drive does not archive.** The engine computes it per-request from '
         'candleData and exposes it via edgeFeatures.sessionRange + signalIndicators '
         '.sessionRange (shipped with this PR); snapshotting candles daily would '
         'unlock this table.')
    emit('')

    # ── 5. FUTURE DATA SOURCES (D9 — deliberately not added) ──
    emit('### D9 — future features (documented, NOT shipped)')
    emit('')
    emit('| feature | needed data source | status |')
    emit('|---|---|---|')
    emit('| VWAP distance | TwelveData has no VWAP series; needs tick/1min volume-weighted feed | future |')
    emit('| Cross-asset (DXY, BTC dominance) | new feed (e.g. FRED / CoinGecko) + per-request fetch | future |')
    emit('| Funding / open interest | exchange API per asset (Binance/Bybit futures) | future |')
    emit('| News-during-trade | event calendar feed + text pipeline | future |')
    emit('')

    if args.out:
        with open(args.out, 'w') as f:
            f.write('\n'.join(out_lines) + '\n')
        print('\nwrote ' + args.out)


if __name__ == '__main__':
    main()
