#!/usr/bin/env python3
"""Reproducible train/holdout edge-feature report.
Usage: python3 scripts/feature_validation.py --input /path/to/resolved_history.json
Input may be a list of records or a {pair:[records]} object. Records require
result (WIN/LOSS), timestamp/checkedAt, direction, and signalIndicators fields.
The script never chooses thresholds: it evaluates the config values already
shipped, splitting fixed TRAIN 2026-08-01..06 / HOLDOUT 2026-08-07..09.
"""
import argparse, json, math
from datetime import datetime, timezone

def flatten(x): return x if isinstance(x,list) else [r for v in x.values() if isinstance(v,list) for r in v]
def day(r):
 s=r.get('checkedAt') or r.get('timestamp') or ''
 try: return datetime.fromisoformat(s.replace('Z','+00:00')).date().isoformat()
 except ValueError: return ''
def wilson(w,n):
 if not n:return '—'
 z=1.96;p=w/n;d=1+z*z/n;c=(p+z*z/(2*n))/d;m=z*math.sqrt((p*(1-p)+z*z/(4*n))/n)/d
 return f'{(c-m)*100:.1f}–{(c+m)*100:.1f}%'
def stat(rows):
 rows=[r for r in rows if r.get('result') in ('WIN','LOSS')];n=len(rows);w=sum(r['result']=='WIN' for r in rows)
 return f'{(100*w/n):.1f}% ({w}/{n}; CI {wilson(w,n)})' if n else '—'
def on(feature,r):
 i=r.get('signalIndicators') or {}; d=r.get('direction')
 if feature=='hour': return i.get('hourUTC') not in (0,1,2,3,10,15)
 if feature=='rsi_direction': return not ((d=='BUY' and (i.get('rsi') or -999)>55) or (d=='SELL' and (i.get('rsi') or 999)<45))
 if feature=='volatility': return i.get('volatilityState')!='DEAD_SQUEEZE'
 if feature=='atr': return i.get('atrState')!='LOW_SQUEEZE'
 if feature=='recent_form': return (r.get('edgeFeatures') or {}).get('recentFormMultiplier',1)>=1
 return True
p=argparse.ArgumentParser();p.add_argument('--input',required=True);a=p.parse_args()
rows=flatten(json.load(open(a.input))); windows={'TRAIN':('2026-08-01','2026-08-06'),'HOLDOUT':('2026-08-07','2026-08-09')}
print('| Feature | Split | OFF (coverage, WR Wilson CI) | ON (coverage, WR Wilson CI) |')
print('|---|---|---|---|')
for f in ['hour','rsi_direction','volatility','atr','recent_form']:
 for label,(lo,hi) in windows.items():
  x=[r for r in rows if lo<=day(r)<=hi and r.get('result') in ('WIN','LOSS')]; y=[r for r in x if on(f,r)]
  print(f'| {f} | {label} | {len(x)-len(y)}/{len(x)} · {stat([r for r in x if not on(f,r)])} | {len(y)}/{len(x)} · {stat(y)} |')
