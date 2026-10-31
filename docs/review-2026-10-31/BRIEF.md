# Full-estate review 2026-10-31 — reviewer brief

Read-only review of the Recycle Servers estate at `origin/dev` **62f53dec**
(ERP v1.395.0, newest tag v1.395.0; facebook tracker VERSION 0.15.0, tag
facebook-tracker/v0.15.0; `main` = fb4afda4, 2 commits behind dev; dev is 15
merge commits "behind" main only through release merges).

Worktree: `/Users/jinhu/orca/workspaces/recycle_servres_erp/brant` (shared by
all reviewers; never `git checkout`, `reset`, `stash`, commit or push).

## Ground rules (non-negotiable)

1. **No Facebook logins.** Never `docker restart`/`up`/`compose
   --force-recreate` a worker, never run `trackers/facebook/scripts/deploy.sh`
   or `rsc fleet release`, never call `/v1/workers/{id}/relogin`, never touch
   `trackers/facebook/configs/sessions/`. On VMs use only `docker ps`,
   `docker inspect`, `docker logs --since`, `df`, `cat`, and `rsync -n`/`diff`
   against the repo.
2. **Read-only everywhere live.** Railway MCP: only `list-*`, `get-*`,
   `describe-*`, `environment-status`, `domain-status`, `http-*`. No
   `redeploy`, `restart-service`, `set-variables`, `update-*`, `accept-deploy`,
   `create-*`, `delete-*`, `railway-agent`. Cloudflare: read commands only
   (`wrangler deployments list`, `r2 object list`, `secret list`). Terraform:
   `plan -lock=false` only. No deploys, webhook tests, Telegram sends.
3. **Secrets never leave the terminal.** Record names, presence and age only.
   Never paste tokens, cookies, `.env` lines or connection strings anywhere.
4. **Prod data is read-only and aggregate**: only inside `BEGIN READ ONLY`,
   only schema, counts, `schema_migrations`. No PII in findings.
5. **No production code changes.** Write only inside
   `docs/review-2026-10-31/` (your lane JSON, and repro tests under
   `docs/review-2026-10-31/repro/<lane>/`). Never `pkill`; kill only PIDs you
   started.
6. If a check needs a forbidden action (restart, login, secret value), stop
   that check and list it under `needs_owner`. Don't work around it.

## Shared resources

- **Baseline suites** (install, typecheck, frontend tests, backend tests,
  build, `pnpm audit`, reddit tests) are running now; results land in
  `docs/review-2026-10-31/baseline/summary.txt` and `*.log`; `DONE` is the
  last line when finished. **Do not run `pnpm install` or the full root
  suites yourself.** Targeted runs are fine once `DONE` appears, e.g.
  `cd apps/backend && TEST_DATABASE_URL=postgres://postgres:review@127.0.0.1:<port>/postgres npx vitest run <file>`
  against your **own** disposable container
  (`docker run -d --name review1031-<lane> -e POSTGRES_PASSWORD=review -p 127.0.0.1:<port>:5432 postgres:18`,
  port = 556xx with xx unique to your lane, e.g. A3 → 55603; remove it when done).
- Your file list: `docs/review-2026-10-31/lanes/<lane>.files.txt`. Read every
  file in it (skim generated/vendored ones, but list them).
- Prior review: `docs/review-2026-10-13/` (same severity scheme). Re-check any
  old ID in your area that is still open; also say if any previously
  checked-off fix in your area regressed.
- Project rules: `AGENTS.md`, area `AGENTS.md`, `docs/FEATURES.md`,
  `docs/DATABASE.md`.

## Severity

- **P1** security or data integrity, or prod down / at risk.
- **P2** a real defect in a supported flow, or drift that will bite.
- **P3** narrow, cosmetic or maintainability.

Only report things you can point at (file:line or resource id) with concrete
evidence and a failure scenario. No style nits dressed up as defects.

## Output (required)

Write `docs/review-2026-10-31/lanes/<lane>.json`:

```json
{"lane":"A1","files_read":["path", "..."],
 "findings":[{"id":"A1-01","severity":"P1|P2|P3","title":"",
   "location":"file:line or resource id","evidence":"","failure_scenario":"",
   "proposed_fix":"","regression_test":"","confidence":"high|medium|low"}],
 "carryover":[{"old_id":"","status":"fixed|still open|obsolete","evidence":""}],
 "needs_owner":["..."],
 "notes":"limits of this lane, anything not checked"}
```

`files_read` must list every path from your files list you actually read
(live-resource and docs lanes list docs/configs/resources instead). Validate
the JSON with `python3 -m json.tool` before reporting done.
