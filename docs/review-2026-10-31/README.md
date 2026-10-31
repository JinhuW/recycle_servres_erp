# Full-estate review — 2026-10-31

This review covered `origin/dev` **62f53dec** (ERP **v1.395.0**, newest tag
v1.395.0) and the facebook tracker at **0.15.0** (tag facebook-tracker/v0.15.0).
`main` was fb4afda4 (v1.394.0), two commits behind dev. During the review, dev
moved on to 8ad4e918 (v1.395.1). The B lanes saw that version live on dev; the
code lanes did not review it.

Scope covered every code module (1,704 files, all read; see
[coverage.md](coverage.md)), every live resource (Railway, Cloudflare, the
homelab VM, the fleet and OCI hosts, Alertmanager, this Mac) and the project
docs. **Nothing was fixed.** The only commit is this folder and its ticket.

## Result

**312 findings: 6 P1 / 48 P2 / 258 P3.** Severities are after verification.

Every P1 and P2 went to an adversarial verifier. The verifier saw only the
claim, never the reviewer's reasoning. Its verdicts:

- **2 rejected and dropped:** A6-04 and A9-03.
- **About 30 downgraded.**
- **14 PLAUSIBLE:** these stay in and are labelled. Most are A6 frontend
  claims that need a DOM harness the repo doesn't have.
- **The rest reproduced:** by a failing test under [repro/](repro/), a query,
  or command output.

P3s were not verified. Eight cross-lane duplicates are each tracked once; see
`tools/dupes.json`.

| Area | Findings | P1 / P2 / P3 | Report |
| --- | ---: | --- | --- |
| Security and platform (A1) | 6 | 0 / 1 / 5 | [security-todo.md](security-todo.md) |
| PO/SO/inventory + backend test suite (A2, A2t) | 28 | 0 / 2 / 26 | [backend-domain-todo.md](backend-domain-todo.md) |
| Finance (A3) | 12 | 0 / 1 / 11 | [finance-todo.md](finance-todo.md) |
| Fleet and integrations (A4) | 6 | 0 / 3 / 3 | [fleet-integrations-todo.md](fleet-integrations-todo.md) |
| Schema and data (A5) | 5 | 0 / 1 / 4 | [schema-todo.md](schema-todo.md) |
| Frontend desktop, components, lib (A6, A6b–d) | 84 | 0 / 8 / 76 | [frontend-todo.md](frontend-todo.md) |
| Mobile and PWA (A7) | 5 | 0 / 1 / 4 | [mobile-pwa-todo.md](mobile-pwa-todo.md) |
| Shared package and contracts (A8) | 5 | 0 / 0 / 5 | [contracts-todo.md](contracts-todo.md) |
| Reddit tracker (A9, A9t) | 17 | 0 / 0 / 17 | [reddit-tracker-todo.md](reddit-tracker-todo.md) |
| Facebook tracker (A10) | 42 | 1 / 9 / 32 | [facebook-tracker-todo.md](facebook-tracker-todo.md) |
| Tooling, CI, deps (A11) | 8 | 2 / 1 / 5 | [tooling-deps-todo.md](tooling-deps-todo.md) |
| Live resources (B1–B5) | 40 | 3 / 13 / 24 | [live-resources.md](live-resources.md) |
| Documentation (C1–C3) | 54 | 0 / 8 / 46 | [docs-drift.md](docs-drift.md) |

The cross-lane themes are in [architecture-todo.md](architecture-todo.md).
Every 2026-10-13 ID and its status today is in
[carryover-2026-10-13.md](carryover-2026-10-13.md).

## Start here

| Order | Repair | IDs |
| --- | --- | --- |
| 1 | Stop the two legacy launchd jobs on the office Mac that replay a personal Facebook session from the house IP (`com.recycleservers.fbmonitor` + watchdog, `search-probe`). | [B5-01, B5-02](live-resources.md) |
| 2 | Restore prod monitoring: re-arm uptime-monitor, treat an edge 429 as unknown rather than down, and stop Cloudflare from 429ing Railway egress. Alert on failed cron exits; db-sync has been down since 10-28 because scrub NULLs a NOT NULL `*_enc` column. | [A11-01, B1-04](tooling-deps-todo.md), [A5-01](schema-todo.md) |
| 3 | Finish the post-breach rotation and protect backups. Add an R2 lock rule and split the backup writer from prune. Rotate the facebook-tracker Postgres password and drop its public proxy. Take the vault key and token secret out of rs-console. Put Access in front of fbc-api. | [A11-02](tooling-deps-todo.md), [B1-02, B2-01](live-resources.md), [A10-01](facebook-tracker-todo.md) |
| 4 | Cut uncontrolled Facebook logins. Investigate the 31 boot logins in 24 h. Make lease expiry and pool Assign safe. Confirm-gate the login-causing buttons. Bring the fleet agent up to date. | [B3-01, B4-01](live-resources.md), [A4-01, A4-03](fleet-integrations-todo.md), [A6-05, A6-06](frontend-todo.md), [A10-04](facebook-tracker-todo.md) |
| 5 | Gate prod deploys on CI (required checks, Railway "wait for CI") and align prod watchPatterns. | [A11-03](tooling-deps-todo.md), [B1-05](live-resources.md) |
| 6 | Data-integrity defects in supported flows: inventory PATCH escaping Sold, unbounded FX override, mobile autosave deleting a draft with a saved line, and the refresh rotation that survives a password change. | [A2-01](backend-domain-todo.md), [A3-01](finance-todo.md), [A7-01](mobile-pwa-todo.md), [A1-01](security-todo.md) |
| 7 | Fix the coordinator's 422 on every fleet city event, apply the R2 CORS fix that never shipped (INF-02), back up vaultwarden, and add 10.10.60.14 to Prometheus. | [B3-02, B2-02, B1-06, B4-04](live-resources.md) |
| 8 | Fix the docs that tell operators to restart workers or that point at retired topology: the facebook README, the root README quick start, and the AGENTS.md first rule, which leaves out the ERP fleet. | [C1-04–C1-08, C2-01, C2-02](docs-drift.md), [A10-02](facebook-tracker-todo.md) |

## Validation

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm typecheck` | All workspace packages passed |
| Frontend suite | **106 files, 1,248 tests passed** |
| Backend suite (ephemeral PG18) | 240 of 260 files passed: 2,824 tests passed, 44 failed. **All 44 were load artefacts.** The run shared the machine with ~20 review agents. Lane A2t reran the 20 failing files alone and together at 8 forks: 328/328 passed every time. The cascade itself is a real test-harness defect, [A2t-01](backend-domain-todo.md). |
| `pnpm build` | Passed |
| `pnpm audit --prod` | 6 moderate, 0 high/critical (`baseline/audit.json`; reachability in [tooling-deps-todo.md](tooling-deps-todo.md)) |
| Reddit tracker suite | **17 files, 281 tests passed** |
| Facebook tracker suites (per-package venvs) | coordinator 594 passed / 31 skipped, console 134, poster 96, worker 67, fleetd 61, messenger 37, router 8, scripts 37 + 3 shell gates: all green |
| Contract tests (tracker, coordinator, wechat-market + vnc/pool) | 136/136 on a dedicated PG18 |

Baseline logs are in [baseline/](baseline/).

## Limits

- **The frontend has no DOM test environment** (no jsdom or happy-dom), and
  `pnpm install` was off-limits. Rendered behaviour was judged from code, which
  is why A6 has 7 PLAUSIBLE verdicts.
- **Login-causing UI was not exercised in a browser, on purpose.** Neither were
  iOS PWA camera/share-target, the CLABEL printer, or the desk scanner (A7).
- **Some Cloudflare checks were blocked by missing credentials.** Terraform
  `plan` ran for the reddit tracker only (no changes); the ERP environments and
  the facebook tracker need a Cloudflare token and R2 state credentials. Access
  apps, DNS records and token ages are not readable with the local wrangler
  OAuth token.
- **Secret rotation was judged from indirect evidence.** No per-variable update
  ages are exposed by Railway MCP or its audit log, and no value was read.
  B1-02 is PLAUSIBLE for that reason.
- **Alertmanager config drift was not checked:** there is no homelab-monitoring
  clone on this Mac.
- **Prod-DB aggregate counts** (token-table sizes, fleet slot states, duplicate
  coordinator account mappings) were not run. The worktree has no Railway link
  or psql, and the VM route needs `docker exec`.

## Needs owner

These need an action the review was not allowed to take: a restart, a login,
a secret, or a write.

1. **Unload `com.recycleservers.fbmonitor`, its watchdog and `search-probe`**
   on the office Mac (B5-01/02). Say whether `configs/sessions/personal.json`
   is also a fleet or pool account. Then retire `keyword-eval` (B5-03).
2. **Re-arm uptime-monitor** (redeploy) and find the Cloudflare rule that 429s
   Railway egress 152.55.181.187 (A11-01, B1-04).
3. **Confirm rotation since 2026-10-21** of the R2 keys (backup writer
   included), Telegram bot tokens and the facebook-tracker Postgres password.
   Rotate the ones that weren't. Planning the FB Postgres rotation means
   recreating containers, which counts as logins (A11-02, B1-02, B2).
4. **Split `secrets.env` so rs-console stops holding `RS_VAULT_KEY` and
   `RS_WORKER_TOKEN_SECRET`.** This recreates the console container (A10-01).
   Then decide on a Cloudflare Access app for fbc-api (B2-01).
5. **Fix db-sync's scrub.** Decide how dev should hold `fleet_proxies`, and
   remember the first good run drops dev's schema. Remove the orphan 0216
   ledger row before ever setting `SYNC_KEEP_FLEET=1` again (A5-01/02).
6. **Explain who changed the homelab desired count 9→6→6→4→9 on 10-31.**
   Decide whether locked or challenged accounts are held rather than re-booted
   (B3-01).
7. **Swap rs-fleet-agent on 10.10.60.14 and the homelab** to an image at
   v1.390.1 or newer, after confirming one was pushed. Decide on the dead
   `rs-fleet-worker-60-14-2`. Check worker -5's account, which accounts for
   276 of the 284 empty searches (B4-01/02/07).
8. **Turn on required status checks and Railway "wait for CI"** (A11-03).
9. **Make two policy calls on login-causing controls.** Should every fleet
   control that starts a worker container require a confirm (A6-05/06)? Which
   ERP-fleet actions count as a login, for the AGENTS.md first-rule wording
   (C2-01)?
10. **Clean up stray secrets and stale checkouts.**
    - Delete `trackers/reddit/scripts/secrets.env.bak-*` in the main checkout
      (B4-05) and the `secrets.env.bak-*` files on the VM.
    - `railway unlink` the stale `recycle_servres_erp-handfish` clone, which is
      linked to production, and archive the other stale checkouts (B5-04).
    - Commit or back up memtrade (B5-05).
11. **Back up vaultwarden** and confirm `SIGNUPS_ALLOWED` (B1-06).
12. **Answer the intent questions.** Is a manual Sold→Done in the inventory
    editor a supported correction (A2-01)? Should archived Done POs keep their
    projected commission (A3-02)?
13. **Give the nightly routine a token.** Add a read-only `RAILWAY_API_TOKEN`
    to the cloud routine's environment, and `git fetch origin dev` to its
    prompt (B4-03).

Every lane's full needs-owner list is in its JSON under [lanes/](lanes/).

## How this was run

Twenty-four Orca review workers ran in parallel, each with the shared
[BRIEF.md](BRIEF.md). There were 20 planned lanes plus 4 coverage-gap lanes
(A6c, A6d, A2t, A9t), dispatched after the ledger showed unread files. Each
lane's P1/P2 claims then went to a fresh verifier. Lane outputs (`*.json`),
claims and verdicts (`*.verify.json`) are in [lanes/](lanes/). Repro tests are
in [repro/](repro/), and the merge script is
[tools/aggregate.py](tools/aggregate.py).
