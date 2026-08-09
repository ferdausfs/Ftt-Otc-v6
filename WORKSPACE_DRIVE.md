# 📜 RULES — FTT WORKSPACE DRIVE (operating manual)

**Effective:** 2026-08-09 · Owner: ferdausfs + Arena main agent (independent reviewer)

---

## RULE 1 — Drive repo = source of truth
`Workplace-drive-` (https://github.com/ferdausfs/Workplace-drive-) holds **sob kichu**: 4 project code snapshots, Phase F data, scripts, reports, prompts, bundles, runbook. Kono file/knowledge shudhu local-e thakbe na.

## RULE 2 — Proti ta kaj drive-te push hobe
Jekono kaj (snapshot, analysis, report, script, prompt, bundle, kono file) → `Workplace-drive-` repo-te push. Daily: `bash scripts/daily-push.sh` (snapshot → analysis → report → push auto).

## RULE 3 — Context check proti turn
Arena main agent **proti turn-e drive repo check korbe** (`git pull` / API list):
- Kono notun push/update thakle → tar sathe kaj miliye nibe.
- **Context miss** thakle (kono file/data ami dekhini) → **oita drive-te push kore** tarpor kaj aage nibe.
- Miss kichhu thakle user-ke honest report: "ei jinis miss chilo, ekhon push korlam".

## RULE 4 — Code change = PR-first (project repos)
`worker/`, `app/`, `bot/`, `my-zakat/` repos-e kono code change **PR-first** (branch → PR → reviewer verify → user merge). Drive repo-te **docs/data direct push** allowed (PR lagbe na).

## RULE 5 — Verification (kono blind trust nai)
Agent report = raw material. GitHub HEAD + code + tests + live API — sob nije check. Test suite expected counts:
- worker: `fix_tests` 158/158 · `phase10_integration` 19/19 · `r71_tests` 117P/0F · baki sob green
- bot: `round2-bugfix-test` 60/60 · `menu-test` 74/74
- app: `tsc --noEmit` clean · `vite build` clean

## RULE 6 — Phase F discipline
Breakeven 55.6% (80% payout). Gate: ≥50 obs, ≥30/regime cell, 7–14 days, CI vs 55.6%. **No inversion, no pair block, no real-money recs until gate.**

## RULE 7 — Security
- **Token/secret repo-te NAI** (drive public!). Oi gulo shudhu Termux env-e.
- Chat-e token paste korle → revoke bolo.
- Leaked: 2 GitHub PAT (revoked ✓), Cloudflare `cfut_pTef5...` (rotation check).

## RULE 8 — Honesty
Hype nai, fake confidence nai. Bhul hoile admit ("amar fixture-i vul chilo"). Agent mittha bolle → bolo user-ke ("agent bad").

---

## NEXT STEPS (ekhon ki korte hobe — drive README-te-o ache)
1. **Phase F daily**: snapshot → corrected entryHit → D4 ML → push drive.
2. **App PR #4** (APP-001 grade chip + SignalHero) — verified, **merge pending** (user).
3. **Cloudflare token rotation** — `cfut_pTef5...` revoke/recreate (user).
4. **Deriv demo integration** — on hold, user decision (digital options vs CFD).
5. **Custom Alerts (F09)** — worker-side PR (future, flag chaile).
6. **r71 baseline** — done (F3-20); re-baseline after next engine change.
