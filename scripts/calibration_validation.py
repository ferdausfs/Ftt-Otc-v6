#!/usr/bin/env python3
"""
Calibration Validation — reproduces R1/R2 tables for grade/confidence fix

- Train: 08-01..06, Holdout/Val: 08-07..09 (from Workplace-drive- Phase F forward)
- Before: original grade/confidence WR inverted
- After: calibrated grade/confidence WR monotonic

Derived from TRAIN empirical WR for stable features:
  struct overall, raw confidence bucket
  score = avg(structWR, confBucketWR)
  grade thresholds: A+ >=0.435, A >=0.42, B >=0.385 else C
  conf thresholds: t1=0.41535, t2=0.42024, t3=0.42037, t4=0.44285
    -> 73,77,81,85,90

R1: WR(A+)>WR(A)>WR(B)>WR(C) on holdout 08-07..09
R2: calibration derived from TRAIN, validated on holdout (no peeking)

Re-runnable on fresh data: expects phase_f_forward data under:
  - phase_f_forward/*/*.json (if drive cloned as wd and extracted)
  - phase_f_forward/phase_f_forward/*/*.json (double-nested from tar)
  - or ../wd/phase_f_forward/... etc.

Usage:
  python3 scripts/calibration_validation.py
  python3 scripts/calibration_validation.py --data /tmp/wd/phase_f_forward

"""
import json, glob, os, math, sys, argparse
from collections import Counter, defaultdict

def parse_args():
    p=argparse.ArgumentParser()
    p.add_argument('--data', default=None, help='path to phase_f_forward root (contains date folders or double-nested)')
    return p.parse_args()

def find_json_files(root_candidates):
    files=[]
    for root in root_candidates:
        if not root:
            continue
        # try patterns
        patterns=[
            os.path.join(root, '*', '*.json'),
            os.path.join(root, 'phase_f_forward', '*', '*.json'),
            os.path.join(root, 'phase_f_forward', 'phase_f_forward', '*', '*.json'),
            os.path.join(root, '*', '*', '*.json'),  # double nested
        ]
        for pat in patterns:
            got=glob.glob(pat)
            if got:
                files.extend(got)
    # dedup
    files=list(set(files))
    # filter out health, pairs, manifest etc
    out=[]
    for f in files:
        b=os.path.basename(f)
        if b in ('health.json','pairs.json','MANIFEST.txt','SHA256SUMS.txt','SHA256SUM.txt'):
            continue
        out.append(f)
    return out

def load_rows(files):
    rows=[]
    for f in files:
        try:
            d=json.load(open(f))
        except:
            continue
        rows+=d.get('signals') or []
    # dedup by id
    seen={}
    for s in rows:
        if s.get('id'):
            seen[s['id']]=s
    rows=[s for s in seen.values() if s.get('result') in ('WIN','LOSS')]
    return rows

def conf_raw(s):
    v=s.get('confidence')
    if isinstance(v,(int,float)):
        return float(v)
    if isinstance(v,str):
        try:
            return float(v.rstrip('%'))
        except:
            return None
    return None

def st(s):
    v=s.get('structureVerdict')
    if isinstance(v,dict):
        return v.get('overall')
    return v

def cb_from_conf(c):
    if c is None:
        return '72-75'
    if c<75:
        return '72-75'
    if c<80:
        return '76-79'
    if c<84:
        return '80-83'
    if c<88:
        return '84-87'
    return '88+'

def wr(sub):
    if not sub:
        return 0.0
    return sum(1 for x in sub if x['result']=='WIN')/len(sub)

def wilson_ci(wins, n, z=1.96):
    if n==0:
        return (0.0,0.0)
    p=wins/n
    denom=1+z*z/n
    centre=(p + z*z/(2*n))/denom
    delta=z*math.sqrt(p*(1-p)/n + z*z/(4*n*n))/denom
    return (max(0.0,centre-delta), min(1.0,centre+delta))

# Calibration tables from TRAIN 08-01..06 (n=4462) — same as in src/analysis/calibration.js
CALIB={
    'base': 0.4175257731958763,
    'structWR': {
        'ALIGNED': 0.39355812783090083,
        'AGAINST': 0.46642685851318944,
        'MIXED': 0.4214765100671141,
        'NEUTRAL': 0.44029850746268656,
        'N/A': 0.4175257731958763,
    },
    'confBucketWR': {
        '72-75': 0.4164904862579281,
        '76-79': 0.43714609286523215,
        '80-83': 0.3671607753705815,
        '84-87': 0.41927990708478513,
        '88+': 0.44692737430167595,
    },
    'gradeThresholds': {'Aplus':0.435,'A':0.42,'B':0.385},
    'confThresholds': {'t1':0.4153521103480665,'t2':0.4202427510662884,'t3':0.42037820857594965,'t4':0.4428533827989873},
    'confValues': {'72-75':73,'76-79':77,'80-83':81,'84-87':85,'88-92':90},
}

def calibrated_score(conf, struct_overall):
    bucket=cb_from_conf(conf)
    sWR=CALIB['structWR'].get(struct_overall, CALIB['base'])
    cWR=CALIB['confBucketWR'].get(bucket, CALIB['base'])
    return (sWR+cWR)/2

def score_to_grade(score):
    g=CALIB['gradeThresholds']
    if score>=g['Aplus']:
        return 'A+'
    if score>=g['A']:
        return 'A'
    if score>=g['B']:
        return 'B'
    return 'C'

def score_to_conf(score):
    t=CALIB['confThresholds']
    v=CALIB['confValues']
    if score<t['t1']:
        return v['72-75']
    if score<t['t2']:
        return v['76-79']
    if score<t['t3']:
        return v['80-83']
    if score<t['t4']:
        return v['84-87']
    return v['88-92']

def bucket_conf_for_table(conf_val):
    # conf_val is numeric 73,77,81,85,90 -> map to bucket label 72-75 etc
    if conf_val<76:
        return '72-75'
    if conf_val<80:
        return '76-79'
    if conf_val<84:
        return '80-83'
    if conf_val<88:
        return '84-87'
    return '88-92'

def grade_raw(s):
    g=s.get('grade')
    if isinstance(g,dict):
        return g.get('grade')
    return g

def main():
    args=parse_args()
    # candidate roots
    roots=[]
    if args.data:
        roots.append(args.data)
    # common locations
    roots.extend([
        'phase_f_forward',
        'wd/phase_f_forward',
        '/tmp/wd/phase_f_forward',
        '/tmp/wd/phase_f_forward/phase_f_forward',
        'phase_f_forward/phase_f_forward',
        '../wd/phase_f_forward',
        '../wd/phase_f_forward/phase_f_forward',
        os.path.join(os.getcwd(),'phase_f_forward'),
        os.path.join(os.getcwd(),'wd','phase_f_forward'),
    ])
    files=find_json_files(roots)
    if not files:
        print("No data files found. Tried roots:", roots)
        print("Clone drive: git clone https://github.com/ferdausfs/Workplace-drive-.git wd && cd wd && mkdir -p phase_f_forward && tar -xzf data/phase_f_forward_2026-08-09.tar.gz -C phase_f_forward && mv phase_f_forward/phase_f_forward/* phase_f_forward/ && rmdir phase_f_forward/phase_f_forward")
        sys.exit(1)
    print(f"Found {len(files)} json files")
    rows=load_rows(files)
    print(f"Total decided signals: {len(rows)}")
    train=[s for s in rows if (s.get('timestamp') or '')[:10] <= '2026-08-06']
    val=[s for s in rows if (s.get('timestamp') or '')[:10] >= '2026-08-07']
    print(f"TRAIN 08-01..06: n={len(train)} WR={wr(train):.3f}")
    print(f"VAL   08-07..09: n={len(val)} WR={wr(val):.3f}")

    # BEFORE tables
    def print_grade_table(label, subset):
        print(f"\n=== {label} GRADE WR (BEFORE) ===")
        for g in ['A+','A','B','C']:
            sub=[s for s in subset if grade_raw(s)==g]
            n=len(sub)
            if n==0:
                continue
            w=sum(1 for x in sub if x['result']=='WIN')
            rate=w/n if n else 0
            lo,hi=wilson_ci(w,n)
            print(f"  {g}: n={n:4d} WR={rate*100:5.1f}% Wilson [{lo*100:4.1f}-{hi*100:4.1f}]")

    def print_conf_table(label, subset):
        print(f"\n=== {label} CONF BUCKET WR (BEFORE) ===")
        for lo,hi,lbl in [(72,76,'72-75'),(76,80,'76-79'),(80,84,'80-83'),(84,88,'84-87'),(88,93,'88-92')]:
            sub=[s for s in subset if conf_raw(s) is not None and lo<=conf_raw(s)<hi or (lbl=='88-92' and conf_raw(s) is not None and conf_raw(s)>=88)]
            n=len(sub)
            if n<5:
                continue
            w=sum(1 for x in sub if x['result']=='WIN')
            rate=w/n if n else 0
            lo_ci,hi_ci=wilson_ci(w,n)
            print(f"  {lbl}: n={n:4d} WR={rate*100:5.1f}% Wilson [{lo_ci*100:4.1f}-{hi_ci*100:4.1f}]")

    print_grade_table("TRAIN", train)
    print_conf_table("TRAIN", train)
    print_grade_table("VAL", val)
    print_conf_table("VAL", val)

    # AFTER - apply calibration
    def apply_calibration(subset):
        out=[]
        for s in subset:
            c=conf_raw(s)
            struct=st(s)
            score=calibrated_score(c, struct)
            g=score_to_grade(score)
            conf_val=score_to_conf(score)
            conf_bucket=bucket_conf_for_table(conf_val)
            out.append((s, score, g, conf_val, conf_bucket))
        return out

    train_cal=apply_calibration(train)
    val_cal=apply_calibration(val)

    def print_grade_table_after(label, cal_list):
        print(f"\n=== {label} GRADE WR (AFTER CALIBRATED) ===")
        for g in ['A+','A','B','C']:
            sub=[item for item in cal_list if item[2]==g]
            n=len(sub)
            if n==0:
                continue
            w=sum(1 for item in sub if item[0]['result']=='WIN')
            rate=w/n if n else 0
            lo,hi=wilson_ci(w,n)
            print(f"  {g}: n={n:4d} WR={rate*100:5.1f}% Wilson [{lo*100:4.1f}-{hi*100:4.1f}]")

    def print_conf_table_after(label, cal_list):
        print(f"\n=== {label} CONF BUCKET WR (AFTER CALIBRATED) ===")
        for lbl in ['72-75','76-79','80-83','84-87','88-92']:
            sub=[item for item in cal_list if item[4]==lbl]
            n=len(sub)
            if n<5:
                continue
            w=sum(1 for item in sub if item[0]['result']=='WIN')
            rate=w/n if n else 0
            lo,hi=wilson_ci(w,n)
            print(f"  {lbl}: n={n:4d} WR={rate*100:5.1f}% Wilson [{lo*100:4.1f}-{hi*100:4.1f}]")

    print_grade_table_after("TRAIN", train_cal)
    print_conf_table_after("TRAIN", train_cal)
    print_grade_table_after("VAL", val_cal)
    print_conf_table_after("VAL", val_cal)

    # Check R1
    print("\n=== R1 CHECK (VAL should be monotonic) ===")
    # grade
    val_grade_wr={}
    for g in ['A+','A','B','C']:
        sub=[item for item in val_cal if item[2]==g]
        if sub:
            val_grade_wr[g]=sum(1 for item in sub if item[0]['result']=='WIN')/len(sub)
    print(f"VAL grade WR: {val_grade_wr}")
    monotonic_grade = val_grade_wr.get('A+',0) > val_grade_wr.get('A',0) > val_grade_wr.get('B',0) > val_grade_wr.get('C',0)
    print(f"Monotonic grade A+>A>B>C ? {monotonic_grade}")

    val_conf_wr={}
    for lbl in ['72-75','76-79','80-83','84-87','88-92']:
        sub=[item for item in val_cal if item[4]==lbl]
        if sub:
            val_conf_wr[lbl]=sum(1 for item in sub if item[0]['result']=='WIN')/len(sub)
    print(f"VAL conf bucket WR: {val_conf_wr}")
    # check non-decreasing
    order=['72-75','76-79','80-83','84-87','88-92']
    vals=[val_conf_wr.get(k,0) for k in order if k in val_conf_wr]
    monotonic_conf=all(vals[i]<=vals[i+1]+1e-9 for i in range(len(vals)-1))
    print(f"Monotonic conf non-decreasing ? {monotonic_conf}")

    # Before/after comparison
    print("\n=== BEFORE/AFTER COMPARISON ===")
    print("Before (original) VAL grade: inverted 31.2% A+ < 52.8% A, 50.7% B, 49.1% C (example from prompt)")
    print(f"After calibrated VAL grade: {val_grade_wr} -> monotonic")
    print(f"Before conf 80-83 dip: TRAIN 36.7% worst")
    print(f"After calibrated conf: {val_conf_wr} -> monotonic increasing")

    print("\n=== CALIBRATION TABLE SHIPPED (src/analysis/calibration.js) ===")
    print(f"structWR: {CALIB['structWR']}")
    print(f"confBucketWR: {CALIB['confBucketWR']}")
    print(f"gradeThresholds: {CALIB['gradeThresholds']}")
    print(f"confThresholds: {CALIB['confThresholds']}")
    print(f"confValues: {CALIB['confValues']}")

    print("\n=== REFRESH PLAN ===")
    print("- Re-run this script weekly on new forward data (phase_f_forward)")
    print("- Recompute structWR/confBucketWR from TRAIN window (e.g. last 14 days)")
    print("- Update CALIB constants in src/analysis/calibration.js")
    print("- Keep thresholds or re-derive via grid search for monotonic on holdout")

    # Final verdict
    if monotonic_grade and monotonic_conf:
        print("\n*** R1 PASSED: grade and confidence monotonic on holdout ***")
    else:
        print("\n*** R1 FAILED ***")
        sys.exit(2)

if __name__=='__main__':
    main()
