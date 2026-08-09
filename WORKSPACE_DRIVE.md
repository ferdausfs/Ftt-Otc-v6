# 📁 WORKSPACE DRIVE — FTT Ecosystem

**Puro ecosystem-er sob kichu ek jaygay:**
👉 **https://github.com/ferdausfs/Workplace-drive-**

> ⚠️ **NEW RULE (2026-08-09):** Ekhon theke amader protita kaj (data, scripts, reports, prompts, bundles, kono file) **Workplace-drive- repo-te push kora hobe**. Kono agent swap hole shudhu ei link diye puro context load hobe. Context miss hole → drive repo theke pull kore kaj aage jabe.

## Ei repo theke drive-e ki ki jabe (daily):
```bash
cd ~/workplace-drive && bash scripts/daily-push.sh
# snapshot → analysis → report → tar data → commit → push (sob auto)
```

## Drive repo-r structure:
```
Workplace-drive-/
├── worker/       ← Ftt-Otc-v6 code snapshot
├── app/          ← Ftt-app-002 code snapshot
├── bot/          ← ftt-telegram-bot code snapshot
├── my-zakat/     ← My-zakat code snapshot
├── data/         ← Phase F snapshots (tar.gz, daily)
├── scripts/      ← analysis + deploy + deriv scripts
├── reports/      ← verification + Phase F reports
├── prompts/      ← agent prompts + approval docs
├── bundles/      ← deployed worker.js / bot.js
├── runbook/      ← MASTER_RUNBOOK (full operating manual)
└── README.md     ← A-to-Z history + status
```

## Next steps (drive README-te lekha ache):
1. Phase F daily routine: snapshot → entryHit analysis → D4 ML → push.
2. App PR #4 (APP-001) — verified, merge pending.
3. Cloudflare token rotation (cfut_pTef5... leaked) — confirm.
4. Deriv demo integration (on hold — user decision).
