# WS-D — Deploy and release gates

Plan for the deploy- and release-gate findings of `docs/review-2026-10-31/`.
Written 2026-10-31 against `origin/dev` f0c1d856. Planning only: nothing here
has been changed or run against a live resource.

## 1. Goal and scope

Nothing should reach production unless CI has passed on that exact commit, and
each environment should build what the repo says it builds. Today a `main`
merge deploys the prod backend and runs its migrations before CI finishes.
Prod watches fewer paths than dev. The Worker test gates nothing until after
the merge. Two fast dev pushes can tag a version on the wrong commit. The
backend image fails open when `NODE_ENV` is missing. The Facebook `deploy.sh`
still drives a topology that no longer exists and "verifies" zero workers. On
top of that, dependency advisories in the trackers reach nobody.

Findings covered (9): **A11-03, B1-05** (dupe A11-05), **A10-02** (P2);
**A10-03, A11-06, A11-07, A11-08, A11-09, A11-10** (P3).

The input has no separate finding on the fleet-agent image release path
(`push-fleet-images.sh`, `fleet-images.yml`, `POST /api/fleet/releases`). D4
names that path as the only way workers get released, and plans nothing else
for it.

Verified on f0c1d856 while planning:

- `backend-tests.yml` never runs `deploy/cloudflare/worker.test.mjs`, although
  its path filter includes `deploy/cloudflare/**`. Only
  `deploy-frontend.yml:63` runs it, and that workflow has no `pull_request`
  trigger. (A11-06: confirmed.)
- `version-check.yml` has no `concurrency:` block. Its tag step pushes
  `v$VERSION` from whichever run gets there first. (A11-08: confirmed.)
- `apps/backend/Dockerfile:41-49` bakes in `NODE_ENV=development`, a published
  `JWT_SECRET`, `ENABLE_DEMO_ACCOUNTS=true` and `ADMIN_PASSWORD=admin`. Every
  refusal in `env.ts`, and the demo-account gate in `routes/auth.ts:114`, keys
  on `NODE_ENV === 'production'`. (A11-09: confirmed.)
- `backup/backup.sh:85-94` configures rclone from the environment with no
  config file, which is where the NOTICE comes from. (A11-10, rclone part:
  confirmed.)
- `deploy.sh` has no `check-vendor.sh` call. `fleet_mode()` and
  `homelab_workers()` find nothing on the current VM, and `verify()` passes on
  an empty loop. Repro: `repro/A10-verify/a10-02-homelab-workers.sh`.
  (A10-02, A10-03: confirmed.)

## 2. Tickets

Ticket numbers (RS-nnn) are assigned with `scripts/ticket.sh new` when each
ticket starts. Concurrent sessions collide on these numbers, so none are
reserved here. Every ticket is one PR to `dev`.

| # | Title | Findings | Sev | Versions under | Restarts workers? | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | CI must pass before a merge, and before Railway deploys | A11-03, A11-06, A11-08 | P2 | none (CI/docs-exempt) | No | M |
| D2 | Backend Railway config as code; prod watches what dev watches | B1-05 (+A11-05) | P2 | ERP root bump (patch) | No | S |
| D3 | Facebook `deploy.sh` for today's VM: coordinator + console only, vendor pin gate | A10-02, A10-03 | P2 | `trackers/facebook` VERSION, `release.sh patch` | **No** (by design; see D3) | L |
| D4 | Dependency audit covers the trackers; ERP moderates refreshed or dispositioned | A11-07 | P3 | ERP root bump (patch); reddit SHA | No | M |
| D5 | Backend image fails closed; backup log noise | A11-09, A11-10 | P3 | ERP root bump (patch) | No | S |

---

### D1 — CI must pass before a merge, and before Railway deploys (P2)

**Closes:** A11-03 (P2), A11-06 (P3), A11-08 (P3). All three are GitHub
workflow edits plus the two repository and Railway settings that make the
workflows binding, so they ship together.

**Versioning:** the diff touches only `.github/` and `AGENTS.md`, so
version-check treats it as CI/docs-exempt: no bump and no CHANGELOG section.
Record the change in the ticket alone. No worker restart and no Facebook
impact.

**Change:**

1. **Make `backend-tests` report on every PR, so it can be a required check.**
   A required check that a path filter never triggers stays "Expected" forever
   and blocks docs-only PRs. `.github/workflows/backend-tests.yml`:
   - Remove `paths:` from the `pull_request` trigger. Keep the `push`
     trigger's filter, so a docs push to `main` still does not run the suite.
   - Add a `changes` job that computes `code=true|false` with the same path
     list (including the `!**/*.md` exclusion). Use `dorny/paths-filter`
     pinned to a commit SHA, as every action in this repo is pinned, or a
     `git diff --name-only` step against `github.event.pull_request.base.sha`
     to avoid a new third-party action. The repo's preference is the latter.
   - Gate `test` with `needs: changes` and
     `if: github.event_name == 'push' || needs.changes.outputs.code == 'true'`.
     GitHub counts a job skipped by `if:` as passing for a required check.
   - Rewrite the header comment at lines 11-17. It claims branch protection
     keys on this check name, which is untrue today. Say what does key on it
     after this ticket.
2. **Run the Worker behaviour test on PRs (A11-06).** In the `test` job, after
   the frontend test step, add
   `- run: apps/backend/node_modules/.bin/tsx --test deploy/cloudflare/worker.test.mjs`
   (the same line as `deploy-frontend.yml:63`). Keep that step in
   `deploy-frontend`'s `verify` job too, because it is the post-merge gate for
   the Worker deploy.
3. **Serialize version-check per ref (A11-08).**
   `.github/workflows/version-check.yml`, top level:
   ```yaml
   concurrency:
     group: version-check-${{ github.ref }}
     cancel-in-progress: false
   ```
   PRs run under `refs/pull/N/merge`, so they never queue behind dev pushes.
   Known limit: GitHub keeps at most one *pending* run per group, so with three
   quick pushes the middle one's run is cancelled. That push gets no tag, and
   the next one is judged against the tag before it. That is safe (no
   mis-tag), and it should be noted in the header comment.
4. **Document the new merge flow.** Root `AGENTS.md` → *Git workflow* →
   *Merging*: a feature PR merges only after its checks are green
   (`gh pr checks <n> --watch`, then `gh pr merge --squash`, or
   `gh pr merge --squash --auto`). A refused merge means a red or pending
   check. It never calls for `--admin`.
   `.claude/skills/ticket-workflow` and the memory note on polling
   `headRefOid` stay valid. Check the skill's merge step and adjust it if it
   merges straight after `gh pr create`.

**Tests:**

- Workflow lint: run `actionlint` on the two changed workflows locally, and in
  CI if it is ever added. Not a repo dependency.
- The behaviour test is the throwaway-PR check under *Rollout*. It ports the
  A11-03 reviewer's regression. No repro under `docs/review-2026-10-31/repro/`
  covers this. The A11 evidence is `gh api` and Railway reads in the lane
  JSON.

**Owner gates:**

1. Yes/no: set branch protection on **`main`** with required checks `test`
   (backend-tests), `version-tag-check` (version-check) and `audit`
   (dependency-audit, if D4 makes it always-on; otherwise leave it out), and
   with "require branches to be up to date" **on**. Exact action:
   `gh api -X PUT repos/JinhuW/<repo>/branches/main/protection` with
   `required_status_checks.contexts` set to those names and `strict: true`.
   The existing protection fields are kept: read them first with
   `gh api .../branches/main/protection` and resend them unchanged.
2. Yes/no: the same required checks on **`dev`**, but with `strict: false`.
   Concurrent agent sessions squash-merge into `dev` many times an hour, and
   `strict` would force a rebase and re-run for each. Version collisions are
   already caught by `version-check` on the push.
3. Yes/no: turn on Railway **"Wait for CI"** (`checkSuites: true`) for the
   `backend` service in `production` and in `dev` (project
   `recycle-erp-experiment`). An agent can do it through the Railway MCP
   `update-service` once approved. Side effect: a cancelled `backend-tests`
   run (`cancel-in-progress: true` on a superseded `main` push) leaves that
   commit undeployed. The next commit deploys, which is the behaviour we want.

**Rollout and verification:**

1. Merge D1 to `dev`. Then apply gates 1–3 in this order: dev protection, main
   protection, Railway. Protection before Railway, so no merge is ever both
   unprotected and waiting on CI.
2. Read-only checks:
   - `gh api .../branches/{main,dev}/protection --jq .required_status_checks`
     shows the contexts.
   - Railway MCP `get-service-config` shows `checkSuites: true` for both
     environments.
3. Behaviour check, which needs a yes because it opens a PR:
   - Open a scratch PR to `dev` that breaks one assertion in
     `deploy/cloudflare/worker.js`, for example dropping the `X-Client-IP`
     clear.
   - Expect `backend-tests / test` to go red and the merge button to be
     blocked.
   - Close the PR without merging and delete the branch.
4. On the next real release, Railway's deployment list should show the prod
   backend deployment as `WAITING` until `backend-tests` on the merge commit
   is green. Read it with Railway MCP `list-deployments`.
5. Rollback: delete the required-check contexts with
   `gh api -X DELETE .../protection/required_status_checks`, set Railway
   `checkSuites` back to false, and revert the PR.

**Effort:** M.

---

### D2 — Backend Railway config as code; prod watches what dev watches (P2)

**Closes:** B1-05 (P2), and its dupe A11-05.

**Versioning:** a root patch bump, because `apps/backend/**` changes. No
worker impact.

**Change:**

1. Add **`apps/backend/railway.json`**. JSON, not TOML, so a test can parse it
   with no new dependency. Before writing it, mirror the live build settings
   with a read-only Railway MCP `get-service-config` on both environments:
   builder, `dockerfilePath`, and any start, healthcheck or restart fields set
   today. Config as code overrides the dashboard for every field it names.
   Leave out fields that are set through the API and should stay per
   environment, such as `drainingSeconds: 30` (see `docs/agents/erp-ops.md`).
   Its `build.watchPatterns` is the union of dev's patterns and the
   root-manifest list in `backend-tests.yml`:
   `apps/backend/**`, `packages/shared/**`, `package.json`,
   `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.npmrc`,
   `.nvmrc`. Do not add `!**/*.md`: a doc-only backend change then rebuilds
   prod, which is harmless.
2. Add `apps/backend/tests/railway-config.test.ts` (vitest; see *Tests*).
3. `docs/agents/erp-ops.md`, Railway section: one line saying the backend's
   build settings live in `apps/backend/railway.json`, and dashboard edits to
   those fields are overwritten on the next deploy.

**Tests:** `apps/backend/tests/railway-config.test.ts` checks two things:

- It parses `railway.json` and asserts that `build.watchPatterns` contains
  every root manifest listed in `backend-tests.yml`'s `push.paths`. Read the
  YAML as text and match the quoted root-file entries, so there is no YAML
  dependency.
- It asserts that `version-check.yml`'s path list names the same root files.

This replaces the reviewer's "compare both environments" script: with one
config file, the environments cannot drift on these fields. No repro to port.
The B1-05 evidence is `repro/B1-verify/README.md` (live reads).

**Owner gates:**

1. Yes/no: set the backend service's **config file path** to
   `apps/backend/railway.json` in `production` and `dev`. Railway service
   settings, "Config-as-code"; or an agent through Railway MCP
   `update-service` once approved. Until this is set, Railway ignores the
   file.

**Rollout and verification:**

1. Merge to `dev`. Apply the gate on `dev` first. Railway MCP
   `get-service-config` (read-only) for dev should show the merged
   watchPatterns, and dev's next build should succeed.
2. Apply the gate on `production`. The next `dev`→`main` release carries
   `apps/backend/railway.json`, which is a watched path, so prod builds. Prod
   `/api/health` should then report the release's root version. Today it lags
   because releases that only bump the version were SKIPPED: `4fdc04e7`,
   `55b5a15a` and others in `B1-verify/README.md`.
3. Next check: the first release that changes only the lockfile (D4's
   nodemailer refresh is one) should show a new prod backend deployment for
   that commit, not SKIPPED.
4. Rollback: clear the config file path in the Railway settings. The
   dashboard values come back into force. Then revert the PR.

**Effort:** S.

---

### D3 — Facebook `deploy.sh` for today's VM: coordinator + console only, vendor pin gate (P2)

**Closes:** A10-02 (P2), A10-03 (P3). Both edit the same script: its gate,
what it ships, and what it verifies.

**Versioning:** a `trackers/facebook` change. Write the entry under
`CHANGELOG.md [Unreleased]`, then `scripts/release.sh patch`, then tag
`facebook-tracker/vX.Y.Z`. Release with a merge commit so the tag stays
reachable from `dev` (see the release-from-worktree memory). No ERP bump: a
`trackers/`-only push is exempt from version-check.

**Worker restarts: none, by design.** Today's workers are the
`rs-fleet-homelab-*` containers. The TS `apps/fleet-agent` runs them, and
images are released through `scripts/push-fleet-images.sh` plus the ERP's
`POST /api/fleet/releases` (`apps/backend/src/fleet/hosts.ts:369`). The
rewritten script never touches a worker. Recreating `rs-coordinator` and
`rs-console` holds no Facebook session, so it is not a login under root
`AGENTS.md`. Still, the first run on the VM is an owner gate, below.

**Change** (`trackers/facebook/scripts/deploy.sh`):

1. **Gate.**
   - Add a `gate` mode, `scripts/deploy.sh gate`. It runs the version gate
     only, with no ssh, so it can be tested.
   - The version gate runs `sh scripts/check-release-tag.sh` and then
     **`sh scripts/check-vendor.sh`** (A10-03), both before any rsync.
     `release.sh:104` and `push-fleet-images.sh:69-72` already apply the same
     pin.
   - Every mode except `check` runs the gate first.
2. **Remove the retired topology.**
   - Delete `fleet_mode()`, `homelab_workers()`, `held()`/`RS_DEPLOY_HOLD`,
     `verify_worker()` and `verify_fleet()`.
   - Delete the "rebuild `$IMAGE`" step that builds `aimm-recycle:latest`, the
     `$REGISTRY` push, the "rebuild rs-fleetd" step and
     `rsc fleet release`, and the compose-worker restart loop.
   - Remove `rs_fleetd` from the rsync source list. Coordinate with WS-G
     A10-43, which retires `rs_fleetd` itself.
   - Keep the `configs/homelab.toml` render-through-console step:
     `docker-compose.console.yml:50` still mounts that file. Narrow its glob to
     `configs/homelab.toml`, and drop the `rs_console.settings publish` call
     that was fleet-mode only.
3. **Verify what it ships.** Replace `verify()` with `verify_services()`:
   - Read `rs-coordinator`'s and `rs-console`'s versions from their health
     endpoints. `coordinator_version()` already does this for the coordinator;
     add the console's equivalent, after confirming the console's health path
     in `rs_console/`.
   - Compare each version with `VERSION`. Fail on any mismatch **or on an
     unreachable service.** No service read counts as a failure.
   - Print a final line naming exactly what it verified:
     `verified: rs-coordinator and rs-console run <VERSION>`.
   - **Workers:** print one informational line saying that workers are
     released from the ERP Fleet tab and not by this script. Never print a
     worker count.
4. **Telegram notice.** Rewrite the notice to "Deployed facebook_tracker
   v… to the coordinator and the console - verified." Remove `WORKER_COUNT`
   and `HELD_NOTE`.
5. **Stamp.** Keep writing `.rs-deployed` after the verify passes. Writing
   `VERSION` and the pyprojects on the VM is WS-A B3-06's fix; that ticket
   decides it, and this script must not contradict it.
6. **Docs.**
   - `trackers/facebook/AGENTS.md`, *Versioning, releases, deploys*, the
     "Deploy with `scripts/deploy.sh`" bullet: rewrite it to coordinator +
     console only, with workers released through `push-fleet-images.sh` and
     the ERP Fleet tab. Remove `rsc fleet release` and the rs-fleetd sentence.
   - `trackers/facebook/README.md`, *Deploying to the homelab worker*
     (lines ~255-300): update the usage block, and delete `RS_DEPLOY_HOLD` and
     the worker-restart wording.
   - `deploy/README.md` §*rs-fleetd* (lines ~301-415): mark it retired, and
     point to `apps/fleet-agent` and `docs/superpowers/plans/2026-10-24-erp-fleet/`.
   - WS-I C1-06 rewrites the README's broader fleet narrative. Land D3 first,
     or in the same PR if WS-I is ready, so the two don't conflict.

**Tests** (`trackers/facebook/scripts/tests/`, plain `sh`, in the style of
`test-version-gate.sh`):

- `test-deploy-gate.sh` (A10-03): build a fixture monorepo the way
  `test-version-gate.sh`'s `mkmono` does, with a tagged
  `trackers/facebook/`, a `VENDOR.md` row and a git-initialised
  `ai-marketplace-monitor/`, and copy `deploy.sh`, `check-release-tag.sh` and
  `check-vendor.sh` into its `scripts/`. Then run `sh scripts/deploy.sh gate`
  in four cases:
  - The clone sits at the pinned commit: allowed.
  - The clone is one commit past the pin: refused.
  - The clone has an uncommitted edit: refused.
  - The clone is missing: refused.
  Put a stub `ssh` that exits 99 first on `PATH`, so any ssh call fails the
  test.
- `test-deploy-verify.sh` (A10-02): put a stub `ssh` on `PATH` and source
  `verify_services` in a way that does not run the script body. The simplest
  route is a `DEPLOY_LIB_ONLY=1` guard, or moving the functions to
  `scripts/deploy-lib.sh`. Cases:
  - The stub reports both versions equal to `VERSION`: exit 0.
  - One version differs: non-zero.
  - The stub returns nothing (service missing or unreachable): non-zero.
  This ports `repro/A10-verify/a10-02-homelab-workers.sh`, whose "verify loop
  iterations=0, passes" outcome must become a failure.
- Add both scripts to `scripts/release.sh` beside lines 95-101, so every
  release runs them.

**Owner gates:**

1. Yes/no: the first run of the new `scripts/deploy.sh` against
   `10.10.10.73`. It recreates `rs-coordinator` and `rs-console` only, with no
   worker and no login. Schedule it after WS-A B3-06 has reconciled the VM
   tree: the VM is a mix of 0.13.18/0.14.x/0.15.0 files with a hand edit in
   `configs/fleet.toml`, and a whole-tree rsync with `--delete` would revert
   that edit. Until then, keep using the console-only path (memory
   `console-only-deploy`).
2. Before that run, confirm that no other session is mid-change on the VM:
   container uptimes and open PRs touching `trackers/facebook/`.

**Rollout and verification:**

1. Merge and release (tag). No live action is needed to land the code.
2. After gate 1, run `scripts/deploy.sh check`, which is read-only. It should
   report both services and end non-zero if either is off-version. It should
   never report a worker count.
3. The Releases Telegram topic should show the new wording.
4. Rollback: run the previous tag's `deploy.sh` (`git show <prev-tag>:…`). It
   is equivalent for the coordinator and console, and it is the old script
   that is dangerous, so prefer a fix-forward.

**Effort:** L (script rewrite, two shell tests, three docs).

---

### D4 — Dependency audit covers the trackers; ERP moderates refreshed or dispositioned (P3)

**Closes:** A11-07.

**Versioning:** a root patch bump for the `pnpm-lock.yaml` refresh. The
`trackers/reddit` lockfile refresh ships under the reddit SHA, which needs no
version. **No Facebook image rebuild** in this ticket (see the deferred
item).

**Change:**

1. **ERP:** `pnpm update nodemailer` (within `^10`, to ≥ 10.1.4) to refresh
   the lockfile only. The `apps/backend/package.json` range stays as it is
   unless pnpm rewrites it. Run `pnpm audit --prod` afterwards. Record a
   one-line reachability disposition for each remaining moderate in
   `pnpm-workspace.yaml` next to `auditConfig`: `@hono/node-server`
   (serveStatic unused), `ip-address` (SOCKS only) and `minimatch` (no user
   globs). These are comments, not `ignoreGhsas`, because the gate level stays
   `high`.
2. **Reddit:** `cd trackers/reddit && pnpm update hono` within `^4`, to the
   first version that fixes the six moderates, if one exists inside `^4`.
   Otherwise record the dispositions in its `pnpm-workspace.yaml` the same
   way. Run `pnpm test` there before pushing, because root CI does not.
3. **`.github/workflows/dependency-audit.yml`:**
   - Rename the existing job to `erp`. If D1 lists it as a required check,
     update the context name there.
   - Add a job `reddit`:
     `working-directory: trackers/reddit`, then
     `pnpm install --frozen-lockfile`, then
     `pnpm audit --prod --audit-level high`.
   - Add a job `facebook`: `actions/setup-python` (pinned SHA, Python 3.12),
     then
     `pipx run pip-audit==2.9.0 -r trackers/facebook/deploy/worker-constraints.txt --no-deps --disable-pip`.
     Add an `--ignore-vuln` per accepted advisory, with the reason on the line
     above: diskcache PYSEC-2026-2447 (needs write access to the cache
     directory in a single-user container), and the filelock GHSAs (local
     attacker or Windows).
   - Add `trackers/reddit/pnpm-lock.yaml`,
     `trackers/reddit/pnpm-workspace.yaml` and
     `trackers/facebook/deploy/worker-constraints.txt` to the `push` and
     `pull_request` path lists.
4. Header comment: say which three trees are audited and where each one's
   dispositions live.

**Tests:** none in code. The regression check is a manual
`workflow_dispatch` run of `dependency-audit` that shows three green jobs:
`erp`, `reddit` and `facebook`.

**Owner gates:**

1. Yes/no: accept the listed dispositions (the ERP moderates as comments, and
   the two Facebook `--ignore-vuln`s) instead of fixing them now.

**Rollout and verification:** merge after D2, so the prod backend rebuilds on
this lockfile-only change. That doubles as D2's live verification. Read-only
checks:

- On the release, Railway `list-deployments` shows a prod backend build for
  the commit.
- `pnpm why nodemailer` on `main` shows ≥ 10.1.4.

Reddit: the Railway `reddits-tracker` services redeploy on their own watch
paths, so check that `api` and `worker` came up healthy. No Facebook impact.
Rollback: revert the PR.

**Effort:** M.

---

### D5 — Backend image fails closed; backup log noise (P3)

**Closes:** A11-09 and A11-10, the rclone part. A11-10's other two parts are
the same defects as findings planned elsewhere:

- The uptime-monitor deploys from `dev`: this is **WS-B B1-08**.
- The backup docs name the service `db-sync`: this is **WS-I C2-03**.

Neither is re-planned here. A11-10 counts as closed when D5, B1-08 and C2-03
have all landed.

**Versioning:** a root patch bump (`apps/` and `backup/`). No worker impact.

**Change:**

1. `apps/backend/Dockerfile:36-49`:
   - Set `ENV NODE_ENV=production` and keep `APP_VERSION`/`GIT_SHA`.
   - Delete the `JWT_SECRET`, `ENABLE_DEMO_ACCOUNTS` and `ADMIN_*` defaults.
   - Rewrite the comment: the image defaults to production, and dev defaults
     live in compose.
2. `docker-compose.yml`, backend `environment:`:
   - Add `NODE_ENV: ${NODE_ENV:-development}`,
     `JWT_SECRET: ${JWT_SECRET:-dev-jwt-secret-change-me-in-prod}`,
     `ENABLE_DEMO_ACCOUNTS: ${ENABLE_DEMO_ACCOUNTS:-true}`, and
     `ADMIN_EMAIL`/`ADMIN_PASSWORD`/`ADMIN_NAME`/`ADMIN_ROLE` with the same
     `${VAR:-default}` form.
   - Compose interpolates these from the repo-root `.env`, so `.env` still
     wins, and a fresh clone with no `.env` still boots.
   - Fix the comment at lines 92-97.
3. `apps/backend/src/env.ts`, `buildEnv`: add
   `if (src.RAILWAY_ENVIRONMENT && !src.NODE_ENV) throw new Error('NODE_ENV must be set on Railway')`.
   With the image default this is defence in depth, for a start command that
   bypasses the image ENV.
4. `backup/backup.sh` near line 85: silence rclone's "Config file … not found"
   NOTICE with `export RCLONE_CONFIG=/dev/null` or `--config /dev/null`.
   Choose the form by running the backup image locally against a fake
   endpoint: `docker build backup/`, then `rclone lsf` with dummy `R2_*`, and
   watch for the NOTICE. Coordinate with WS-C A11-02, which also edits
   `backup/` (credentials split). Whichever lands second rebases.

**Tests:**

- `apps/backend/tests/env.test.ts`, three new cases:
  - `RAILWAY_ENVIRONMENT` set and `NODE_ENV` unset: throws.
  - `NODE_ENV='production'` with the published `JWT_SECRET`: still throws.
    This one exists already; keep it.
  - A string read of `apps/backend/Dockerfile` asserting it contains no
    `JWT_SECRET=` and no `ENABLE_DEMO_ACCOUNTS=`, and contains
    `NODE_ENV=production`.
- Local: `docker compose up backend` on a clone without `.env` boots, and demo
  login works. Run the `verify` skill.
- No repro to port (A11-09 is from code reading).

**Owner gates:**

1. Yes/no: accept that a Railway backend whose `NODE_ENV` is deleted boots
   production-strict, and refuses to start if a prod secret is missing, rather
   than booting in development mode. Before merging, check NODE_ENV's
   *value* on Railway `dev`, which is not a secret, with a read-only
   `list-variables`. If dev relies on `development`, it must stay set
   explicitly, and it is today.

**Rollout and verification:**

1. Merge to `dev`. Dev Railway rebuilds the backend. `/api/health` 200 shows
   the image change is inert while `NODE_ENV` is set.
2. After the release, prod `/api/health` returns 200 with the new version.
3. The next nightly `pg-r2-backup` run logs no rclone NOTICE. Check with
   Railway MCP `get-logs`.
4. Rollback: revert. The image defaults return.

**Effort:** S.

## 3. Order

1. **D1**: it makes every later ticket's CI binding. Announce the new merge
   flow in `AGENTS.md` in the same PR, because every agent session's
   `gh pr merge` behaviour changes once gates 1–2 apply.
2. **D2**: before any lockfile-only change, so prod rebuilds on it.
3. **D4**: after D2, since its nodemailer refresh is D2's live proof. If D1
   names `audit` as a required check, its rename (`audit` → `erp`) lands with
   or before D1's gate 1.
4. **D5**: independent; any time after D1.
5. **D3**: in parallel with the ERP tickets, since it touches only
   `trackers/facebook/`. Its code can merge any time. Its first live run waits
   for **WS-A B3-06** (VM tree reconciliation and the stamp).

Cross-workstream dependencies:

| Other WS | Finding | Relation |
| --- | --- | --- |
| WS-A | B3-06 | D3's first live `deploy.sh` run waits for the VM tree to be reconciled. B3-06 owns stamping `VERSION`/pyprojects on the VM. |
| WS-B | B1-08 | Owns the uptime-monitor branch part of A11-10. |
| WS-C | A11-02 | Edits `backup/` too; D5's rclone line rebases on it, or the other way round. |
| WS-G | A10-43, A10-39 | A10-43 retires `rs_fleetd`, which D3 drops from the rsync list. A10-39 pins the messenger base image: D3 stops building `aimm-recycle:latest`, so `Dockerfile.messenger`'s `FROM aimm-recycle:latest` goes stale until A10-39 lands. That is harmless (no rebuild is triggered), but ship A10-39 before the next messenger rebuild. |
| WS-I | C1-06, C2-03 | C1-06 rewrites the Facebook README fleet narrative after or with D3's README edits. C2-03 owns A11-10's backup service-name doc fix. |

## 4. Dropped / deferred

None of the 9 findings is dropped. Every one is in a ticket above. Items
deliberately left out of those tickets:

- **Locks for the five Python services that pin only floors** (A11-07's
  second half). Adding locks changes what every Facebook image builds, and
  poster and messenger hold Facebook sessions, so a rebuild means a restart,
  which is a login. Deferred until the next Facebook release that rebuilds
  those images anyway, in **WS-G**. Once the locks exist, D4's `facebook`
  audit job extends to cover them.
- **Bumping diskcache/filelock in `worker-constraints.txt`.** Both are low
  reachability. They are dispositioned in D4, and the bump rides the next
  worker image release (`push-fleet-images.sh` → ERP Fleet tab). It never
  gets a dedicated release, because a worker roll is a login for every worker.
- **"Fleet-agent image release path"**: named in the scope, but the input has
  no finding on it. Nothing is planned beyond D3's docs pointing to it.
