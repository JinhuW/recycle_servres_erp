#!/bin/sh
# Re-runnable doc checks for C2 claims (run from repo root).
echo "C2-01: fleet mentions in root/area AGENTS.md (expect none):"
grep -n "fleet-agent\|/api/fleet\|apps/fleet" AGENTS.md apps/backend/AGENTS.md trackers/facebook/AGENTS.md
ls apps/fleet-agent/AGENTS.md apps/fleet-agent/CLAUDE.md 2>&1
echo "C2-02: console session routes called by facebookPool.ts vs documented:"
grep -n "/session\`\|restore-session\|/relogin" apps/backend/src/routes/facebookPool.ts
grep -n "facebookPool\|restore-session\|/session" AGENTS.md trackers/facebook/AGENTS.md
echo "C2-03: service names in backup docs:"
grep -n "db-sync\|pg-r2-backup" backup/README.md backup/railway.toml deploy/railway-sync/railway.toml
