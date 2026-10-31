# WS-I — Documentation drift: fix plan

Input: `inputs/WS-I-docs.json` (53 findings: C1-01..C1-32, C2-02..C2-08,
C3-01..C3-14). Evidence: `docs/review-2026-10-31/lanes/C1.json`, `C2.json`,
`C3.json` and `docs-drift.md`. Planned against `origin/dev` f0c1d856.

## 1. Goal and scope

Make the documents agents and operators act on tell the truth again, most
urgently where a stale instruction causes a Facebook login (Facebook README:
C1-04, C1-05, C1-06), breaks onboarding (root README: C1-07, C1-08), takes
prod's Telegram updates (Reddit README: C1-10) or hides an ERP→console caller
that triggers restores and re-logins (contract docs: C2-02). After that it
covers the long tail: FEATURES.md accuracy (C1-01..C1-03, C1-11, C1-13..C1-24),
README reference sections (C1-25..C1-32), agent/ops docs (C2-03, C2-04, C2-07,
C2-08, C3-14), DATABASE.md (C2-05, C2-06) and ticket/CHANGELOG/plan hygiene
(C3-01..C3-05, C3-07..C3-13). C1-12 is deferred to WS-F and C3-06 is dropped
(already fixed).

**Line numbers in the findings have drifted.** Entries added since the review
moved them (examples: the stray `## [Unreleased]` is now at `CHANGELOG.md:1631`,
not 1589. `[1.333.2]` is at :1980 under `[1.333.1]` at :1956. FEATURES "per UTC
day" is at :3664, not :3657. INDEX.md:8 is now RS-487). Every edit below is
anchored on the quoted text. Find it with `grep -n`, not the cited line.

**Unverified P3s.** Most C1 P3s and every C2/C3 P3 went unverified in the
review. Before each edit, the implementer checks the claim against the code
named in the lane JSON's `evidence`. A claim that does not hold is left alone
and named in the PR body as "not a drift". The plan does not re-verify each one
up front, which would duplicate the review.

**Versioning.** `version-check.yml` excludes `*.md` everywhere
(`':(exclude)*.md'`), so ERP Markdown edits, `apps/**/AGENTS.md` included, need
no bump. Only non-Markdown files cost a bump: `backup/railway.toml` (I-3) and
the test/script guards (I-8). Facebook README/AGENTS/CHANGELOG edits are docs
inside `trackers/facebook/`. They need no `VERSION` bump or release, and they
deploy nothing (`deploy.sh` ships modules, not README). Reddit README edits
have no release process. **No ticket in this workstream restarts a worker or
causes a login.**

Each ticket = one RS ticket (`scripts/ticket.sh new`, drafted in plan mode per
`ticket-workflow`), one PR to `dev`, squash-merged under the standing
authorization. Pick ticket numbers just before merging, because concurrent
sessions collide on them.

## 2. Tickets

### I-1 — Facebook README: stop steering operators into logins (P2)

- **Closes:** C1-04, C1-05, C1-06 · **Severity:** P2 · **Versions under:**
  nothing (docs in `trackers/facebook/`; add a `### Docs` line under
  `trackers/facebook/CHANGELOG.md` `[Unreleased]` so the next release carries
  it) · **Worker restart:** none.
- **Change** (`trackers/facebook/README.md`):
  - C1-04, parked-worker section (grep `Only \`docker stop\` ends it`, ~:482-498):
    timeouts are retried twice more in the same page, 10 s and 30 s apart,
    before `ConnectFailedError` (0.15.0). A `connect_failed` park ends with
    **Mark healthy** on the ERP Fleet page: a one-shot `resume` heartbeat
    directive, same browser, no login. `login_failed`, `browser_failed` and
    `crashed` ignore it. `docker stop` means a new container, which is a login.
    At ~:465-468, the directive list becomes "`relogin` or, for
    `connect_failed`, `resume`". Check the ~:1324 mention too. Source of truth:
    `apps/backend/src/fleet/workers.ts:52-67` (resume_id),
    `apps/backend/src/fleet/claim.ts:494-533`, CHANGELOG `[0.15.0]`.
  - C1-05 (grep `regenerate worker configs with \`rsc gen-configs\` and restart`,
    ~:1208): replace with the claim/Fleet Rules wording from the finding. A
    change reaches each worker at its next task. Never restart to pick one up,
    because a restart is a login (link AGENTS.md first rule).
  - C1-06: a "Where workers run today" paragraph after the region intro
    (~:59): since 0.14.14 no compose worker remains, `apps/fleet-agent` runs
    `rs-fleet-*` workers that claim from `/api/fleet`, images ship through
    `scripts/push-fleet-images.sh` and releases through the ERP Fleet tab, and
    the region table is the `fleet.toml` coverage template. Banner at the top of
    the rs_fleetd / rolling-release section (~:339-382): superseded for ERP
    fleet workers, and every recreated worker is a login. Rewrite the deploy
    step list (~:251-300) to the post-WS-D-A10-02 `deploy.sh`, which rebuilds
    coordinator + console and touches no worker. Reframe ~:384-386 "The ERP is
    growing a task queue" to present tense, and name `apps/fleet-agent/README.md`.
- **Dependencies:** WS-D **A10-02** changes `deploy.sh` topology. Write the
  deploy steps against the merged `deploy.sh`: rebase on it, or describe today's
  behaviour and let A10-02's PR adjust its sentence. WS-A **A10-18** edits the
  same README (`check --save-refreshed`), so whichever merges second rebases.
  WS-A **C2-01** owns the root AGENTS.md first-rule text, which I-1 links to and
  does not edit.
- **Tests:** none (docs). Guard: I-8's optional grep for `restart the workers`
  / `Only \`docker stop\``.
- **Owner gates:** (1) "Is any host still running `rs_fleetd` / `rs-fleetd`
  (not fleet-agent)? yes/no". The answer decides whether the rs_fleetd section
  becomes "legacy, retired" or "applies only on host X".
- **Rollout / verification:** merge to `dev`. Then
  `grep -n 'restart the\s*workers\|Only .docker stop' trackers/facebook/README.md`
  returns nothing, and a reader following "parked: Page didn't load" reaches
  Mark healthy. Rollback: revert the PR.
- **Effort:** M.

### I-2 — Root and Reddit READMEs: onboarding that works and stays off prod (P2)

- **Closes:** C1-07, C1-08, C1-09, C1-10, C1-25, C1-26, C1-27, C1-28 ·
  **Severity:** P2 (C1-07/08/10), rest P3 · **Versions under:** nothing (root
  `README.md`, `trackers/reddit/README.md`) · **Worker restart:** none.
- **Change:**
  - `README.md` quick start (grep `any password`): the image boots with the
    `init-admin.mjs` admin (`ADMIN_EMAIL` / `ADMIN_PASSWORD`, defaults in
    `apps/backend/Dockerfile` ENV). Demo users come from
    `docker compose exec backend node ./scripts/seed.mjs`, with password
    `demo` (`seed.mjs:414`). `ENABLE_DEMO_ACCOUNTS` only lists them
    (`routes/auth.ts:105-115`). (C1-07)
  - `README.md` layout line for `docker-compose.override.yml`: "not committed,
    create locally". Before the host-side `pnpm db:migrate` loop (~:94), give
    the three-line override body (`services.postgres.ports:
    ["127.0.0.1:5432:5432"]`). Don't commit an example file: prefer editing
    existing files, and `.gitignore:56` stays. (C1-08)
  - `README.md` Stack/Edge (~:37-69) and deploy section (~:252): production is
    Railway `recycle-erp-experiment` → `backend` plus Workers
    `recycle-erp-prod`/`-dev`. Retitle the Compose+Caddy section "Self-hosted
    Compose deploy" and point to `docs/agents/erp-ops.md`. (C1-09)
  - `README.md` C1-25: 60-minute access JWT and 14-day rotating refresh, read
    from `apps/backend/src/auth*`. Test count becomes "250+ files" or drop the
    number. Metrics: 9090 is published on 127.0.0.1 only, and
    `/metrics/postgres` needs `--profile metrics` + `POSTGRES_METRICS_PASSWORD`
    (check `docker-compose.yml`). Replace the shell list with a link to
    FEATURES § The two shells. C1-26: add `FB_POOL_KEY` and
    `FLEET_WORKER_TOKEN_KEY` as required in production (names only; confirm
    against `apps/backend/src/env.ts`). Add `trackers/reddit/`,
    `trackers/facebook/`, `deploy/`, `backup/` to the layout. The backend
    mounts `/api/*`, `/oauth/*`, `/.well-known/*`.
  - `trackers/reddit/README.md`: the local api command becomes
    `ALERT_TRANSPORT=console ROLE=api API_TOKEN=devtoken pnpm dev`, with a
    one-line why (C1-10, `src/config.ts:70-71`, `src/index.ts:94-106`). C1-27:
    after "…or its hold is two minutes stale." add the "a renew that matches no
    row disconnects at once" sentence (v1.391.1). C1-28: refresh the `loops/`
    layout from `ls trackers/reddit/src/loops`, drop the test count (~:205) and
    list every registered loop at ~:322.
- **Dependencies:** WS-H may change the Reddit `ALERT_TRANSPORT` default, as
  suggested under gate (1). If it does, the README line still holds, because an
  explicit console setting is harmless.
- **Tests:** none (docs). Reproduce C1-07 by hand before merging with the
  review's replay (`docs/review-2026-10-31/repro/C1-verify/C1-07-image-boot.txt`):
  the documented admin login must succeed on a fresh `docker compose up` on a
  disposable stack. C1-10 has the offline config repro
  `repro/C1-verify/C1-10-reddit-api-transport.txt`.
- **Owner gates:** (1) "Should the Reddit tracker also default `ALERT_TRANSPORT`
  to `console` when `NODE_ENV` isn't production (a WS-H code change), on top of
  the README fix? yes/no".
- **Rollout / verification:** merge to `dev`. A fresh clone that follows the
  quick start signs in (local only). Rollback: revert.
- **Effort:** M.

### I-3 — Contract and agent/ops docs (P2)

- **Closes:** C2-02, C2-03, C2-04, C2-07, C2-08, C3-14 · **Severity:** P2
  (C2-02), rest P3 · **Versions under:** nothing for Markdown. The
  `backup/railway.toml` comment (C2-03) is non-Markdown under `backup/` and
  costs an ERP patch bump. It rides WS-D **A11-10**, which already edits
  `backup/README.md:3-4` / `backup/railway.toml`. If A11-10 drops the toml, this
  PR bumps patch and adds the `## [X.Y.Z]` CHANGELOG section · **Worker
  restart:** none.
- **Change:**
  - C2-02, `AGENTS.md` Contracts row 2 (~:72): add "the account pool's Assign /
    credentials / ledger calls in `routes/facebookPool.ts`" to the ERP cell,
    and `apps/backend/tests/facebook-pool.test.ts` to the Test cell (check which
    pool test covers Assign; `facebook-pool-summary.test.ts` covers the
    ledger). `trackers/facebook/AGENTS.md` "Forwarded today" (~:45-77): add
    `PUT /v1/workers/{id}/session` (`{cookie, reason}`, seals a pool cookie as
    the worker's restorable session), `POST /v1/workers/{id}/restore-session`
    (the gentle Re-login: **a login**) and `POST /v1/vnc/{id}/ticket` (VNC
    websocket ticket, `src/vncBridge.ts:120`). Also name `facebookPool.ts` as a
    caller of the existing `/v1/fleet`, `/v1/accounts/{id}`, `/v1/logins` and
    `/v1/workers/{id}/relogin` lines (`facebookPool.ts:538,656,680,689,694,836`)
    and add it to the ERP-side sentence at :39.
  - C2-03, `backup/README.md:3`: the service is `pg-r2-backup`, not `db-sync`
    (`db-sync` is the prod→dev copy in `deploy/railway-sync/`). Same fix in the
    `backup/railway.toml:1` comment (see versioning above).
  - C2-04, `apps/backend/AGENTS.md:192-193`: tests need `TEST_DATABASE_URL`,
    normally the `recycle-erp-testdb` container on `127.0.0.1:55432`. Give the
    `docker run` line with `POSTGRES_PASSWORD=…` as a placeholder, never a
    value. `global-setup.ts` becomes `tests/helpers/global-setup.ts` (:196,
    :200). Same in `docs/agents/erp-ops.md` (~:54-56).
  - C2-07: `trackers/facebook/AGENTS.md:11` README size "around 1,450 lines"
    (it has 1,450 now; better: drop the number). `:34`
    `rs_coordinator/rs_coordinator/db.py`. `:59`
    `rs_console/rs_console/settings.py`. `apps/backend/AGENTS.md:59-63` adds
    `aiReview`. `AGENTS.md:50` Facebook row's component list adds "fleet agent
    (rs_fleetd)", **merged into WS-A C2-01's rewrite of the same row** (see
    Dependencies).
  - C2-08: `docs/deployment-railway-dev-prod.md`: the `main` push auto-deploys
    (`.github/workflows/deploy-frontend.yml`), and the sync cron is
    `0 4 * * *`, after the 03:30 backup (check `deploy/railway-sync/railway.toml`).
    `docs/deployment-railway-cloudflare.md:1-6` gets a "Historical (2026-05)"
    banner pointing at the dev-prod doc and erp-ops. Drop its stale :329 line.
    `docs/agents/erp-ops.md:7-8` points at the current doc first.
  - C3-14, `AGENTS.md` Pointers (~:227-228): Reddit debug notes live under
    `trackers/reddit/docs/debug-notes/`, Facebook's under the root
    `docs/debug-notes/`.
- **Dependencies:** WS-A **C2-01** rewrites the AGENTS.md first rule and Map
  (row :50 included). WS-C **B2-01** changes the "Bearer + Cloudflare Access"
  claim in the same Contracts row :72. Land I-3 **after** both, or fold the
  :50/:72 cell edits into whichever of them is open, so three PRs don't fight
  over one table row.
- **Tests:** the contract grep in I-8 (every `callFacade(` path in
  `apps/backend/src` appears in `trackers/facebook/AGENTS.md`).
- **Owner gates:** none. The `pg-r2-backup` name is confirmed by a read-only
  `railway service list` in the implementing session.
- **Rollout / verification:** merge to `dev`.
  `grep -rn "callFacade(" apps/backend/src | grep -o "/v1/[a-z-]*"` must equal
  the set in "Forwarded today". Rollback: revert.
- **Effort:** M.

### I-4a — FEATURES.md accuracy: ERP core sections (P3)

- **Closes:** C1-01, C1-13, C1-16, C1-17, C1-18, C1-19, C1-20, C1-21, C1-22 ·
  **Versions under:** nothing (`docs/FEATURES.md`) · **Worker restart:** none.
- **Change** (`docs/FEATURES.md`, anchor on text; each claim is checked against
  the cited code first):
  - C1-01 "reassign a PO's purchaser until it is Done" (:108): ownership freezes
    at Ready to Pay. Check the PO route's reassign guard in
    `apps/backend/src/routes/` before writing.
  - C1-13 OCR (~:4172): production refuses to boot without
    `OPENROUTER_API_KEY` (`apps/backend/src/env.ts:52-53`, confirmed).
  - C1-16 purchaser role list (~:42-43): verify against the sidebar config in
    `apps/frontend/src/` (nav items by role).
  - C1-17 CSRF exemptions (~:104-107): list the bearer-only and OAuth surfaces
    from the CSRF middleware. Make the same edit in `README.md` (~:110-113) in
    this PR, not I-2, so the two lists can't diverge.
  - C1-18 purchaser Analysis (~:2810): Ready to Pay or Done.
  - C1-19 label drift (:70, :904, :984, :1899): copy the exact strings from
    `apps/frontend/src/lib/i18n.tsx`.
  - C1-20 PO list KPI tiles / Payment chips (~:818, :1177-1178).
  - C1-21 small drifts (Shipping tab, Buyer network cap, Activity range, task
    list cap 5000, client-errors stream, health providers; the Proxies Down
    rule at ~:3705 goes in I-4b).
  - C1-22 auth (~:93-95): `users.credential_version` (migration 0177), with `cv`
    in the token.
- **Tests:** none (docs).
- **Owner gates:** none.
- **Rollout / verification:** merge to `dev`. Each changed sentence cites the
  version it describes. Rollback: revert.
- **Effort:** M. Conflicts: WS-E/WS-F PRs that edit FEATURES rebase on it.
  Keep the PR small and merge it fast.

### I-4b — FEATURES.md accuracy: Monitors / fleet sections (P3)

- **Closes:** C1-02, C1-03, C1-11, C1-14, C1-15, C1-23, C1-24 · **Versions
  under:** nothing · **Worker restart:** none.
- **Change** (`docs/FEATURES.md`):
  - C1-02 coordinator Fleet tab (~:3083-3125): since v1.344.0 (RS-394) it has
    host cards over one worker table (Worker, Host, Account, State, Now, Today,
    Lease, Version), with an All / Healthy / Free / Parked legend. Keep the old
    column text dated "From v1.263.0 until v1.344.0".
  - C1-03 round board (~:3301-3368): date it "From v1.328.0 until v1.344.0".
    Since then the round board and bulk move are not rendered (confirmed: no
    `<RoundCard` in `apps/frontend/src`). The ERP fleet's Start the round now
    is on the Tasks tab. The dead `RoundCard`/`FleetLegend`/`WorkersCard` code
    belongs to WS-F, not here.
  - C1-11 Analysis (grep `per UTC day`, :3664): Eastern day (FLEET_TZ) since
    v1.390.0. Also add the Proxies **Down** rule from C1-21 (~:3705) here,
    because it sits in the same section.
  - C1-14 Reddit page (~:2896): alert rules were under Evaluate until v1.386.0.
  - C1-15 (~:3083): fleet tabs are managers only. Purchasers see only the
    Account pool tab.
  - C1-23 OAuth scopes (~:3973): `fleet:read` is service-only like
    `wechat:write`.
  - C1-24: v1.393.1 pool cookie limit (Account pool editor, ~:3795) and the
    v1.353.0 coordinator 15 s response cache with `X-Cache`/`Age`. Read both
    from CHANGELOG and `routes/coordinator.ts`.
- **Dependencies:** WS-F **A6-39** changes the Tasks tab "Today" range. Leave
  that sentence (~:3607-3611) to the A6-39 PR (see C1-12 below).
- **Tests / gates:** none.
- **Rollout / verification:** merge to `dev`. Rollback: revert.
- **Effort:** M.

### I-5 — Facebook README and AGENTS: reference sections (P3)

- **Closes:** C1-29, C1-30, C1-31, C1-32 · **Versions under:** nothing
  (trackers/facebook docs; `[Unreleased]` docs line) · **Worker restart:** none.
- **Change:**
  - C1-29 (~:859): `rsc vault set-account --account-id` (check the flag in the
    `rsc` CLI source under `trackers/facebook/rs_*`).
  - C1-30 console Watch / `RS_WORKER_CONFIGS` / rs-monitor scripts (~:553,
    :641-707, :840-898, :1214): mark them "Legacy (retired 0.14.8-0.14.14)".
    Add how to watch an ERP fleet worker (ERP Fleet page, relay
    `/api/fleet/vnc/:workerId/ws`) and where its logs are (`docker logs --since`
    on the fleet-agent host, OpenSearch `fb-tracker-*`).
  - C1-31 fleet-mode env (~:397-406): `RS_FLEET_CLAIM_TICKET` (single-use, 401
    → exit 75) or `RS_FLEET_HOST_TOKEN` (older agents). Drop "home cities"
    (RS-439). After ~:452 add a "Withheld alerts (stopgap, RS-453/455)"
    paragraph naming the cron scripts and where they run, with no secrets.
  - C1-32 Setup/Tests/Release (~:231-233, :1369, :1394-1413): two venvs
    (`.venv-coordinator`, `.venv-aimm`), the real suite list, what `release.sh`
    runs and how many `pyproject.toml` it bumps. Read `scripts/release.sh`, and
    don't trust the finding's "six" / "five" without counting. The AGENTS.md
    size note is fixed in I-3 (C2-07); don't edit it twice.
- **Dependencies:** after I-1 (same file). WS-G changes to `release.sh` or the
  suites change these counts, so write them last.
- **Tests / gates:** none.
- **Rollout / verification:** merge to `dev`. Rollback: revert.
- **Effort:** M.

### I-6 — DATABASE.md catch-up (P3)

- **Closes:** C2-05, C2-06 · **Versions under:** nothing · **Worker restart:**
  none.
- **Change** (`docs/DATABASE.md`): add the missing columns from 0209, 0215,
  0219 and 0220 (`after_sales_cases.currency_code`, `fleet_hosts.agent_instance`
  / `agent_daemon` / `agent_seen_at`, the `fleet_proxy_checks`, `reddit_leads`
  and `reddit_lead_buyers` columns the lane lists), the unique
  `fleet_slots_claim_idx (host_id, claim_id) WHERE claim_id IS NOT NULL`, and
  the three functions in the functions table. Update the "As of" line (ERP
  migration, Reddit migration, Facebook `0.15.0`), the Overview counts and the
  "N numbers, M files" gap line. Take the counts from the migrations
  directories at merge time, not the lane's numbers.
- **Dependencies:** **land last in WS-I**, after the WS-E (and WS-C/WS-H)
  migration PRs merge, or the As-of line goes stale again. Those PRs follow
  the file's own "Keeping this file current" rule for their own tables.
- **Tests:** the schema-doc diff in I-8.
- **Owner gates:** none.
- **Rollout / verification:** run the I-8 diff script locally against
  `recycle-erp-testdb` before merging. It reports zero missing columns.
  Rollback: revert.
- **Effort:** M.

### I-7 — Project-memory hygiene: tickets, changelogs, debug notes, plans (P3)

- **Closes:** C3-01, C3-02, C3-03, C3-04, C3-05, C3-07, C3-08, C3-09, C3-10,
  C3-11, C3-12, C3-13 · **Versions under:** nothing (Markdown only; root
  `CHANGELOG.md` edits don't touch the current version's header) · **Worker
  restart:** none.
- **Change:**
  - Tickets (front matter via `scripts/ticket.sh status`, then hand-fill
    `pr:`/`version:`, then `scripts/ticket.sh index`):
    - C3-01: RS-290 (`backlog`) → done, pr 722, `facebook-tracker 0.10.4`.
      RS-291 (`backlog`) → done, pr 723, 725, `facebook-tracker 0.10.5, 0.10.6`.
      Confirm the PR numbers with `gh pr view` (read-only).
    - C3-02: RS-003, -004, -007, -029, -117, -280, -293, -296, -297, -300,
      -305, -312 → done. Set RS-117 `pr: 418` and RS-280 `pr: 708`. Add the
      "verified by CHANGELOG [x]" note on RS-007/RS-117. RS-293/RS-305 get a
      line saying their unticked live check is the owner's (gate 3).
    - C3-03: RS-394 `backlog` → `in-progress`. Tick WS-A..WS-D and the docs
      item with PRs/versions, and fix `0205_fleet.sql` → `0206_fleet.sql`.
    - C3-04: RS-014 → `wont-do` (superseded by RS-105, v1.177.0) or `done` +
      `version: 1.177.0` (gate 1).
    - C3-05: RS-321 (split its merged pr/version line), RS-294 `pr: 768`, RS-429
      `pr: 958`, RS-456 `pr: 996`, RS-404 `version: n/a …`, RS-258
      `version: facebook-tracker 0.6.0`.
  - Changelogs: C3-07 delete the empty `## [Unreleased]` at `CHANGELOG.md:1631`
    (check that `scripts/changelog.sh` doesn't need one first; :13133 says
    the permanent heading was dropped). C3-08 move the `[1.333.2]` block above
    `[1.333.1]`. C3-09 add a `## [0.13.3] - 2026-10-19` stub ("same tree as
    0.13.4, re-cut for the wrong ticket id") before `[0.13.4]` in
    `trackers/facebook/CHANGELOG.md:911`. Check that `release.sh` / `deploy.sh`
    parse only the top section; the grep at `deploy.sh:265` suggests they do.
  - Debug notes: C3-10 status lines in
    `docs/debug-notes/2026-07-29-transfer-order-reopen-test-flake.md` and
    `2026-08-03-transfer-orders-draft-so-test-flake.md` (fixed in v1.191.0 /
    RS-130). C3-11 in `2026-10-17-new-worker-without-session-file-searches-logged-out.md:50-52`.
  - Plans: C3-12 `docs/superpowers/plans/2026-10-24-erp-fleet/README.md`: one
    WS-F row, plus a dated Status line pointing to RS-454+. C3-13: apply the
    convention gate 2 picks to the ~33 May–July top-level plans (`git mv` into
    `finished/` with a first-line status, or a first-line status in place),
    and name it in `AGENTS.md` Pointers (~:223).
- **Tests:** none in this PR. I-8 adds the `ticket.sh index` warning.
- **Owner gates:** (1) "RS-014: `wont-do` (superseded by RS-105), not `done`?
  yes/no". (2) "Plans convention: move shipped plans to `finished/` (yes) or
  drop `finished/` and require a status line (no)?" (3) "Close RS-293 and
  RS-305 as done, with their remaining live check noted as the owner's? yes/no".
- **Rollout / verification:** merge to `dev`.
  `scripts/ticket.sh list --status in-review` and `--status backlog` no longer
  list a shipped ticket. `grep -c '^## \[Unreleased\]' CHANGELOG.md` is 0.
  The `## [` headers in both changelogs sort newest-first (check with a short
  `sort -V -r` diff). Rollback: revert.
- **Effort:** M. Plan moves (C3-13) can be a second commit in the same PR.

### I-8 — Drift guards (P3, optional; regression tests for I-3, I-6, I-7)

- **Closes:** nothing. These are the regression tests the findings closed in
  I-3, I-6 and I-7 propose · **Versions under:** ERP root
  `package.json` patch bump + `## [X.Y.Z]` CHANGELOG section (non-Markdown
  under `apps/` and `scripts/`) · **Worker restart:** none.
- **Change:**
  - `apps/backend/tests/docs-contract.test.ts`: read `apps/backend/src/**` for
    `callFacade(env|c.env, '<METHOD>', \`/v1/...\`` and `vncBridge.ts`'s `/v1/vnc`.
    Normalise the `${…}` segments to `{id}` and assert each path appears in
    `trackers/facebook/AGENTS.md` under "Forwarded today". A pure file read, so
    no DB is needed.
  - `apps/backend/tests/database-doc.test.ts`: after `global-setup` migrates the
    test DB, compare `information_schema.columns` (public schema) with
    DATABASE.md's `#### \`table\`` + `| \`col\` |` rows. Assert that the "As of"
    ERP migration equals the highest file in `apps/backend/migrations/`. Port the
    lane C2 parser (`docs/review-2026-10-31/tools/`, if the script was kept;
    otherwise the ~30-line parser the finding describes).
  - `scripts/ticket.sh index`: print a warning, like its duplicate-id warning,
    for a `done` ticket with an empty `pr:` or `version:`. Don't fail the
    command.
  - Optional grep check (C1 "optional grep check in CI"): skip it. Banned-phrase
    lists rot faster than the docs.
- **Tests:** these are the tests. They must fail on f0c1d856 (before I-3/I-6),
  pass after, and run in `backend-tests.yml` with no new workflow.
- **Owner gates:** (1) "Add the two doc-drift tests to the backend suite (they
  fail a PR whose migration skips DATABASE.md)? yes/no".
- **Rollout / verification:** merge to `dev` after I-3 and I-6.
  `backend-tests` stays green. Rollback: revert (the bump stays).
- **Effort:** M.

## 3. Order

| # | Ticket | Sev | Waits on |
| --- | --- | --- | --- |
| 1 | I-1 Facebook README login-safety | P2 | WS-D A10-02 for the deploy-step wording (else adjust after); coordinate with WS-A A10-18 (same file) |
| 2 | I-2 Root + Reddit READMEs | P2 | — |
| 3 | I-3 Contract and agent/ops docs | P2 | WS-A C2-01 and WS-C B2-01 (same AGENTS.md rows); WS-D A11-10 for `backup/railway.toml` |
| 4 | I-7 Project-memory hygiene | P3 | owner gates 1-3 |
| 5 | I-4a FEATURES core | P3 | — (merge fast; others rebase) |
| 6 | I-4b FEATURES Monitors/fleet | P3 | after I-4a (same file) |
| 7 | I-5 Facebook README reference | P3 | after I-1; after WS-G release/suite changes |
| 8 | I-6 DATABASE.md | P3 | after the WS-E/WS-C/WS-H migration PRs |
| 9 | I-8 Drift guards | P3 | after I-3 and I-6; owner gate |

I-1, I-2 and I-3 touch different files and can run in parallel sessions. The
one shared file is root `README.md`: I-2 owns it, except the CSRF list (C1-17),
which goes with I-4a. Merge I-2 before I-4a.

## 4. Dropped / deferred

| ID | Decision | Reason |
| --- | --- | --- |
| C1-12 | Deferred to **WS-F A6-39** | The same bug seen from the code side: the Tasks tab "Today (ET)" range starts at UTC midnight (`FleetTasksTab.tsx:43-44`). The fix is code, and FEATURES (~:3607-3611) should change in that PR, per the ticket workflow's "FEATURES with the behaviour change". A docs-only interim edit would be rewritten days later. The A6-39 PR must make FEATURES say "today (Eastern)" and add the `sinceFor('today', …)` unit test from the finding. |
| C3-06 | Dropped (already fixed) | `docs/tickets/INDEX.md:12` on f0c1d856 shows RS-483 with `1.395.0` in Shipped. The index was regenerated after the review snapshot. |

Every input ID appears exactly once: I-1 (3), I-2 (8), I-3 (6), I-4a (9),
I-4b (7), I-5 (4), I-6 (2), I-7 (12), dropped/deferred (2) = 53.

**Owner gates: 6** (I-1 ×1, I-2 ×1, I-7 ×3, I-8 ×1). None is a live write.
Each is a decision, or a read-only fact only the owner can confirm.
