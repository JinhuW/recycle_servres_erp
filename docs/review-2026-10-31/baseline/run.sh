#!/bin/zsh
# Baseline suites for the 2026-10-31 review. Disposable PG18 on 55531.
cd "$(dirname $0)/../../.."
B=docs/review-2026-10-31/baseline
docker rm -f review1031-pg >/dev/null 2>&1
docker run -d --name review1031-pg -e POSTGRES_PASSWORD=review -p 127.0.0.1:55531:5432 postgres:18 >/dev/null
sleep 6
step(){ local n=$1; shift; local t0=$(date +%s); "$@" > $B/$n.log 2>&1; local rc=$?; echo "$n rc=$rc secs=$(( $(date +%s)-t0 ))" >> $B/summary.txt; }
: > $B/summary.txt
step install pnpm install --frozen-lockfile
step typecheck pnpm typecheck
step frontend-test pnpm --filter recycle-erp-frontend test
TEST_DATABASE_URL=postgres://postgres:review@127.0.0.1:55531/postgres step backend-test pnpm --filter recycle-erp-backend test
step build pnpm build
step audit sh -c 'pnpm audit --prod --json > docs/review-2026-10-31/baseline/audit.json'
(cd trackers/reddit && pnpm install --frozen-lockfile >/dev/null 2>&1; pnpm test) > $B/reddit-test.log 2>&1; echo "reddit-test rc=$?" >> $B/summary.txt
docker rm -f review1031-pg >/dev/null 2>&1
echo DONE >> $B/summary.txt
