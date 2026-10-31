# Review fixes — implementation plan (2026-10-31)

This plan fixes every finding of the
[2026-10-31 full-estate review](../../../review-2026-10-31/README.md)
(312 findings: 6 P1 / 48 P2 / 258 P3). Nine workstreams cover it in **90
tickets**:

- 5 tickets are P1, 32 are P2 and 53 are P3.
- Each ticket is one PR to `dev` and follows the usual ticket, version-bump and
  CHANGELOG workflow.
- Every finding is placed exactly once, either in a ticket or under its
  workstream's *Dropped / deferred*.
- The plans were written against `origin/dev` f0c1d856. Each planner re-read
  the cited code, so several reviewer fixes were corrected. One example:
  WS-A found that the homelab count churn comes from `workerCount`'s slot math,
  not from a person.

Effort is about **400 engineer-hours**: S = 2 h, M = 4 h, L = 12 h. Owner time
for live actions comes on top.

| Workstream | Scope | Tickets | Plan |
| --- | --- | ---: | --- |
| WS-A | Facebook-login safety | 14 | [WS-A-login-safety.md](WS-A-login-safety.md) |
| WS-B | Scheduled jobs, monitoring, alerting | 7 | [WS-B-ops-alerting.md](WS-B-ops-alerting.md) |
| WS-C | Secrets, backups, edge, office Mac | 6 | [WS-C-secrets-backups-edge.md](WS-C-secrets-backups-edge.md) |
| WS-D | Deploy and release gates, dependencies | 5 | [WS-D-deploy-gates.md](WS-D-deploy-gates.md) |
| WS-E | ERP backend correctness | 14 | [WS-E-backend-integrity.md](WS-E-backend-integrity.md) |
| WS-F | ERP frontend and mobile/PWA | 17 | [WS-F-frontend-mobile.md](WS-F-frontend-mobile.md) |
| WS-G | Facebook tracker code | 12 | [WS-G-facebook-tracker.md](WS-G-facebook-tracker.md) |
| WS-H | Reddit tracker | 6 | [WS-H-reddit-tracker.md](WS-H-reddit-tracker.md) |
| WS-I | Documentation | 9 | [WS-I-docs.md](WS-I-docs.md) |

The input each planner received (finding IDs, verdicts, evidence pointers) is
in [inputs/](inputs/). The planning brief is
[PLANNER-BRIEF.md](PLANNER-BRIEF.md).

## Phase 0 — owner actions, today (no code)

These stop live risk without a PR. Each needs the owner's yes.

| # | Action | Closes | Plan |
| --- | --- | --- | --- |
| 0.1 | `launchctl bootout` `com.recycleservers.fbmonitor`, its watchdog, `search-probe` and `keyword-eval` on the office Mac. Confirm which account `personal.json` is. | B5-01, B5-02, B5-03 (P1) | WS-A-1, WS-B T6 |
| 0.2 | Re-arm uptime-monitor: fresh deploy of the cron, no code. | A11-01 (P1, until T1 lands) | WS-B T1 gate G1-0 |
| 0.3 | Confirm which post-breach secrets were rotated (R2 keys, Telegram, facebook-tracker Postgres). List the rest for C2. | input to C2/C3 | WS-C C2 |
| 0.4 | Delete `trackers/reddit/scripts/secrets.env.bak-*` in the main checkout. Then `railway unlink` the stale `handfish` clone and back up memtrade. | B4-05, B5-04, B5-05 | WS-C C6 |
| 0.5 | Swap `rs-fleet-agent` on 10.10.60.14 and the homelab to an image ≥ v1.390.1. This is not a login, but it replaces a live container. | B4-01 (agent half) | WS-A-6 gate G6 |
| 0.6 | Enable a vaultwarden volume backup and check `SIGNUPS_ALLOWED`. | B1-06 | WS-C |

## Phase 1 — week 1: P1 code and the gates everything else relies on

Run these in parallel sessions; the lanes are independent.

| Lane | Tickets, in order | Why first |
| --- | --- | --- |
| Ops | WS-B **T2** (db-sync scrub + failure alert), then **T1** (uptime probe, 429 = unknown, dead-man's switch in `railway-alerts`) | Dev has been frozen since 10-27, and prod is unmonitored. |
| CI | WS-D **D1** (required checks, Railway "wait for CI", Worker tests on PRs), then **D2** (backend `railway.json` watchPatterns) | Makes every later migration ticket safe to merge. |
| Backend harness | WS-E **E4** (serialise `resetDb`) | Every backend ticket's test run depends on it. |
| Login safety | WS-A **WS-A-3** (hold walled accounts), then **WS-A-2** (lapsed live lease stays held) | These cause most of the 20 walled logins in 24 h, plus the outage cascade. Both edit `claim.ts`/`hosts.ts`, so merge one after the other. |
| Secrets | WS-C **C1** (split `secrets.env`, vault rekey, scanner), then **C2** (rotation runbook). **C3** (backup bucket under Terraform: lock, lifecycle, new key, no pruning) runs in parallel. | P1s. C1 and C2 ship in maintenance window **W2** (below). |

## Phase 2 — weeks 2–3: the remaining P2s

- **WS-A:**
  - WS-A-4: a server-side `confirmLogin` plus dialogs on every login-causing
    control. It also covers the login-control part of F-04.
  - WS-A-5: pool Assign claims first; the editor keeps a resealed session.
  - WS-A-7: coordinator invariants.
  - WS-A-8: AGENTS.md first rule (docs).
- **WS-E:** E1 (credential version under one lock order), E2 (inventory
  PATCH obeys the cascade), E3 (FX bounds). Each ships its backend first and
  stays compatible with the old UI.
- **WS-F:**
  - F-00 (DOM test harness + pinned TZ; owner gate for the devDependencies).
  - F-03 (session reset registry).
  - F-01 (mobile capture), then F-02 (desktop submit + sign-out). These run in
    sequence because they share `MobileApp.tsx`, `DesktopSubmit.tsx` and
    `auth.tsx`.
  - F-04 (confirm/busy guards), F-05 (commission preview = backend).
- **WS-G:** G1 (city-event `via` 422), G2 (Telegram escaping/dead letter), G3
  (atomic incident votes, listing + alert), G4/G5 (console settings save,
  event loop). They ship in windows W1/W2.
- **WS-C:** C4 (Access on fbc-api + attachments CORS), C6 rest.
- **WS-B:** T4 (Prometheus scrapes 10.10.60.14, UPS alerts live).
- **WS-D:** D3 (facebook `deploy.sh` for today's VM: coordinator + console
  only, vendor-pin gate).
- **WS-I:** I-1, I-2, I-3 (READMEs and contract docs), after WS-A-8 and C4
  settle the shared AGENTS.md rows.

## Phase 3 — weeks 3–6: P3 batches

Pick up the P3 tickets in each workstream's own order (its section 3), as
capacity allows:

- WS-E E5–E14
- WS-F F-06–F-16
- WS-G G6–G12
- WS-H H1–H6, shipped as one reddit rollout
- WS-A-9–14
- WS-B T3, T5, T6, T7
- WS-C C5
- WS-D D4, D5
- WS-I I-4a–I-8

## Facebook deploys: batched, and none restarts a worker

Only one ticket here changes worker images, which means logins: **WS-A-9**
(search radius). It waits for the next fleet release the owner plans anyway.
Everything else on the Facebook side recreates only `rs-coordinator` and/or
`rs-console` on 10.10.10.73. Those are not logins. Each window is one owner
yes; never use `deploy.sh` before D3 lands.

| Window | Recreates | Carries | facebook-tracker release |
| --- | --- | --- | --- |
| **W1** | rs-coordinator | G1, G2, G3, G8, WS-A-7 | patch release R1 (G1 may go alone first) |
| **W2** | rs-console + rs-coordinator | C1 secret split, C2 rotation, G4, G5, WS-A-12 | minor release R2 |
| **W3** | rs-coordinator + rs-console | G6, G7, G11 | patch release R3 |
| — | fleet-agent containers only | WS-A-6 code half (version floor, log caps), WS-B T5 | ERP release (agent image) |
| — | worker image (**logins**) | WS-A-9 | the next owner-planned fleet release |

The reddit tracker gets one batched rollout (Railway api, Railway worker, OCI
fleet) after H1–H5 land. See WS-H gate G1.

## Cross-workstream dependencies

| Edge | Reason |
| --- | --- |
| WS-D D1 → migration tickets E1, E3, E7, E12 | Prod should wait for CI before migrations ship. |
| WS-E E4 → all WS-E | A reliable test harness. |
| WS-F F-00 → F-01, F-02, F-04, F-06–F-10, F-14 | DOM tests. |
| WS-A-4 ↔ WS-F F-04 | One shared confirm helper. |
| WS-A-4 / WS-A-5 ↔ WS-G G7 | The relogin cooldown agrees with Assign and the confirm gate. |
| WS-C C1 ↔ WS-D D3 ↔ WS-G | C1 ships by console recreate in W2, not via `deploy.sh`. |
| WS-C C3 ↔ WS-D D5 ↔ WS-I I-3 | Same `backup/` files. Merge in that order. |
| WS-C C4 ↔ WS-B T1 | Same `deploy/railway-uptime/check.sh`. |
| WS-A-8, WS-C C4, WS-E E13 ↔ WS-I I-3 | Same AGENTS.md *Contracts* and first-rule rows. I-3 merges last. |
| WS-E migrations ↔ WS-I I-6 | Each migration PR updates its own DATABASE.md rows. I-6 rebases over them. |
| WS-A-6 → WS-B T5 | Same agent rollout. |
| WS-H H4 closes WS-B B4-09 | Same defect as A9-09. |

## Owner gates

About 90 gates in total, listed per ticket in each plan. The ones that block
the most work:

1. Phase 0 actions 0.1–0.6.
2. **WS-D D1:** turn on required status checks and Railway "wait for CI". This
   changes every agent session's `gh pr merge` flow.
3. **WS-A:**
   - G3: keep or retire pool Assign, which shrinks WS-A-5 and C2-02 if retired.
   - G4: which slot states hold a lease.
   - G5: enforce the login confirm server-side.
4. **WS-C:**
   - C2: the rotation window for the facebook-tracker DB password.
   - C3: the backup bucket live steps, strictly ordered.
   - C4: create the fbc-api Access app.
5. **Windows W1–W3:** one yes each.
6. **WS-F F-00:** add the frontend devDependencies (jsdom + Testing Library).
7. **Intent questions:**
   - E2 / A2-01: is a manual Sold→Done a supported correction?
   - E9 / A3-02: archived POs and commission.
   - F-05: the commission basis.
   - F-09: currency-switch behaviour.

## Ticket index

Effort: S < 2 h, M ≈ half day, L = 1–2 days. Severity is the highest finding
the ticket closes.

| Ticket | Plan | Sev | Effort | Title |
| --- | --- | --- | --- | --- |
| WS-A-1 | [WS-A](WS-A-login-safety.md) | P1 | S | Retire the legacy Mac Facebook jobs |
| WS-A-2 | [WS-A](WS-A-login-safety.md) | P2 | M | A lapsed lease whose worker is alive stays held |
| WS-A-3 | [WS-A](WS-A-login-safety.md) | P2 | M | Hold walled accounts instead of re-booting them |
| WS-A-4 | [WS-A](WS-A-login-safety.md) | P2 | M | One server-side login confirm, and dialogs on every login control |
| WS-A-5 | [WS-A](WS-A-login-safety.md) | P2 | L | Pool Assign claims first; the editor keeps a resealed session |
| WS-A-6 | [WS-A](WS-A-login-safety.md) | P2 | M | The fleet agent is current on every host, with a version floor and log caps |
| WS-A-7 | [WS-A](WS-A-login-safety.md) | P2 | M | Coordinator: one account per worker, own-account lock, guarded backups |
| WS-A-8 | [WS-A](WS-A-login-safety.md) | P2 | S | AGENTS.md's first rule names the ERP fleet |
| WS-A-9 | [WS-A](WS-A-login-safety.md) | P2 | M | Fleet search radius and card parser |
| WS-A-10 | [WS-A](WS-A-login-safety.md) | P3 | S | Proxy delete leaves no sealed URL for an unpark |
| WS-A-11 | [WS-A](WS-A-login-safety.md) | P3 | M | Session tooling: logged-in guard, device and lock, proxy clear |
| WS-A-12 | [WS-A](WS-A-login-safety.md) | P3 | S | Homelab VM tidy-up: console poll, tree stamp, fleet.toml, dead worker |
| WS-A-13 | [WS-A](WS-A-login-safety.md) | P3 | S | Homelab ops: OpenSearch exposure and retention, log-sync token |
| WS-A-14 | [WS-A](WS-A-login-safety.md) | P3 | M | ERP proxy path params validated; Shippo push treated as a hint |
| T1 | [WS-B](WS-B-ops-alerting.md) | P1 | M | Uptime probe: restore it, stop the 429 false alarm, add a dead-man's switch |
| T2 | [WS-B](WS-B-ops-alerting.md) | P2 | S | db-sync: scrub NOT NULL sealed columns by deleting the row; alert on a failed run |
| T3 | [WS-B](WS-B-ops-alerting.md) | P3 | S–M | Backend: release held next-task polls on SIGTERM |
| T4 | [WS-B](WS-B-ops-alerting.md) | P2 | S | Homelab Prometheus coverage: scrape the fleet host, make UPS alerts live, drop the dead bridge cron |
| T5 | [WS-B](WS-B-ops-alerting.md) | P3 | S–M | Fleet agent prunes superseded images after a release |
| T6 | [WS-B](WS-B-ops-alerting.md) | P3 | S | Scheduled-job hygiene: nightly Railway routine and the dead keyword-eval |
| T7 | [WS-B](WS-B-ops-alerting.md) | P3 | S | Railway config hygiene: reddit deploy provenance, dormant projects, env drift |
| C1 | [WS-C](WS-C-secrets-backups-edge.md) | P1 | L | Facebook control-plane secret split, vault re-key tool, secret scanner |
| C2 | [WS-C](WS-C-secrets-backups-edge.md) | P1 | M | Post-breach rotation of the facebook-tracker DB password and control-plane keys |
| C3 | [WS-C](WS-C-secrets-backups-edge.md) | P1 | L | Backup bucket under Terraform, with lock, lifecycle, a new key and no pruning |
| C4 | [WS-C](WS-C-secrets-backups-edge.md) | P2 | M | Access in front of fbc-api; apply the attachments CORS |
| C5 | [WS-C](WS-C-secrets-backups-edge.md) | P3 | S | ERP Worker hygiene |
| C6 | [WS-C](WS-C-secrets-backups-edge.md) | P2 | M | Office Mac hygiene |
| D1 | [WS-D](WS-D-deploy-gates.md) | P2 | M | CI must pass before a merge, and before Railway deploys |
| D2 | [WS-D](WS-D-deploy-gates.md) | P2 | S | Backend Railway config as code; prod watches what dev watches |
| D3 | [WS-D](WS-D-deploy-gates.md) | P2 | L | Facebook `deploy.sh` for today's VM: coordinator + console only, vendor pin gate |
| D4 | [WS-D](WS-D-deploy-gates.md) | P3 | M | Dependency audit covers the trackers; ERP moderates refreshed or dispositioned |
| D5 | [WS-D](WS-D-deploy-gates.md) | P3 | S | Backend image fails closed; backup log noise |
| E1 | [WS-E](WS-E-backend-integrity.md) | P2 | L | One credential-version check under one lock order for refresh rotation |
| E2 | [WS-E](WS-E-backend-integrity.md) | P2 | M | Inventory editor obeys the PO cascade's status rules |
| E3 | [WS-E](WS-E-backend-integrity.md) | P2 | M | FX override bounds and one "latest rate" rule |
| E4 | [WS-E](WS-E-backend-integrity.md) | P2 | S | Serialise `resetDb` |
| E5 | [WS-E](WS-E-backend-integrity.md) | P3 | M | Transfer integrity: delete, reopen, discard, lock order |
| E6 | [WS-E](WS-E-backend-integrity.md) | P3 | L | PO lifecycle races and money rounding |
| E7 | [WS-E](WS-E-backend-integrity.md) | P3 | M | Sell-order price bounds, CNY precision, duplicate-lot diff |
| E8 | [WS-E](WS-E-backend-integrity.md) | P3 | M | Boundary validation: MCP, workspace, master data, market |
| E9 | [WS-E](WS-E-backend-integrity.md) | P3 | M | Reporting excludes archived POs; dashboard fan-out; bank match |
| E10 | [WS-E](WS-E-backend-integrity.md) | P3 | M | Bank/internal-tx writes from locked reads |
| E11 | [WS-E](WS-E-backend-integrity.md) | P3 | M | Retention sweep and graceful loop shutdown |
| E12 | [WS-E](WS-E-backend-integrity.md) | P3 | M | Migration ledger, seed re-run, validate 0178 |
| E13 | [WS-E](WS-E-backend-integrity.md) | P3 | M | Proxy allowlist and shared contract types |
| E14 | [WS-E](WS-E-backend-integrity.md) | P3 | L | Backend test assertions that can actually fail, plus packing out of routes |
| F-00 | [WS-F](WS-F-frontend-mobile.md) | P3 | M | Frontend DOM test harness and pinned TZ |
| F-01 | [WS-F](WS-F-frontend-mobile.md) | P2 | L | Mobile capture: no lost drafts, no double lines |
| F-02 | [WS-F](WS-F-frontend-mobile.md) | P2 | L | Desktop Submit and sign-out keep pending work |
| F-03 | [WS-F](WS-F-frontend-mobile.md) | P2 | M | Session reset registry on logout |
| F-04 | [WS-F](WS-F-frontend-mobile.md) | P2 | M | Confirm and busy guards on destructive clicks |
| F-05 | [WS-F](WS-F-frontend-mobile.md) | P2 | M | Commission preview matches the backend |
| F-06 | [WS-F](WS-F-frontend-mobile.md) | P3 | M | Unsaved-edit guards on desktop editors |
| F-07 | [WS-F](WS-F-frontend-mobile.md) | P3 | M | Failed loads show an error and Retry, not a skeleton forever |
| F-08 | [WS-F](WS-F-frontend-mobile.md) | P3 | M | Paged lists keep depth and drop stale responses |
| F-09 | [WS-F](WS-F-frontend-mobile.md) | P3 | L | Money and number inputs never save a wrong value |
| F-10 | [WS-F](WS-F-frontend-mobile.md) | P3 | S | Calendar dates and time zones |
| F-11 | [WS-F](WS-F-frontend-mobile.md) | P3 | S | Fleet pages |
| F-12 | [WS-F](WS-F-frontend-mobile.md) | P3 | M | Reddit leads |
| F-13 | [WS-F](WS-F-frontend-mobile.md) | P3 | M | Customer pickers |
| F-14 | [WS-F](WS-F-frontend-mobile.md) | P3 | L | Accessibility and i18n |
| F-15 | [WS-F](WS-F-frontend-mobile.md) | P3 | M | PWA platform: offline scanner, camera, CSP, telemetry |
| F-16 | [WS-F](WS-F-frontend-mobile.md) | P3 | S | Shared lib helpers |
| G1 | [WS-G](WS-G-facebook-tracker.md) | P2 | S | City-event `via` accepts the fleet's values |
| G2 | [WS-G](WS-G-facebook-tracker.md) | P2 | M | Telegram delivery |
| G3 | [WS-G](WS-G-facebook-tracker.md) | P2 | M | Atomic incident votes and listing + alert writes |
| G4 | [WS-G](WS-G-facebook-tracker.md) | P2 | M | Console settings save |
| G5 | [WS-G](WS-G-facebook-tracker.md) | P2 | M | Console event loop and VNC |
| G6 | [WS-G](WS-G-facebook-tracker.md) | P3 | M | Auth and input edges |
| G7 | [WS-G](WS-G-facebook-tracker.md) | P3 | M | Re-login records who asked and has a cooldown |
| G8 | [WS-G](WS-G-facebook-tracker.md) | P3 | M | Messenger outbound claim/lease, owned ack, atomic auto-reply |
| G9 | [WS-G](WS-G-facebook-tracker.md) | P3 | M | Dormant bridge clients |
| G10 | [WS-G](WS-G-facebook-tracker.md) | P3 | M | Build, release and deploy tooling |
| G11 | [WS-G](WS-G-facebook-tracker.md) | P3 | S | Vault unreadable flag and email-code skew |
| G12 | [WS-G](WS-G-facebook-tracker.md) | P3 | S | Terraform state for the coordinator Postgres |
| H1 | [WS-H](WS-H-reddit-tracker.md) | P3 | M | Shutdown that doesn't wait out the pacer, plus loop-runner tests |
| H2 | [WS-H](WS-H-reddit-tracker.md) | P3 | M | Buyer-alert exactly-once guards |
| H3 | [WS-H](WS-H-reddit-tracker.md) | P3 | M | Telegram failures that page and self-explain |
| H4 | [WS-H](WS-H-reddit-tracker.md) | P3 | M | Security hardening: SSH ingress, worker DB role, token handling |
| H5 | [WS-H](WS-H-reddit-tracker.md) | P3 | M | Pipeline test gaps and link-post bodies |
| H6 | [WS-H](WS-H-reddit-tracker.md) | P3 | S | Close out the prompt-evaluation log |
| I-1 | [WS-I](WS-I-docs.md) | P2 | M | Facebook README: stop steering operators into logins |
| I-2 | [WS-I](WS-I-docs.md) | P2 | M | Root and Reddit READMEs: onboarding that works and stays off prod |
| I-3 | [WS-I](WS-I-docs.md) | P2 | M | Contract and agent/ops docs |
| I-4a | [WS-I](WS-I-docs.md) | P3 | M | FEATURES.md accuracy: ERP core sections |
| I-4b | [WS-I](WS-I-docs.md) | P3 | M | FEATURES.md accuracy: Monitors / fleet sections |
| I-5 | [WS-I](WS-I-docs.md) | P3 | M | Facebook README and AGENTS: reference sections |
| I-6 | [WS-I](WS-I-docs.md) | P3 | M | DATABASE.md catch-up |
| I-7 | [WS-I](WS-I-docs.md) | P3 | M | Project-memory hygiene: tickets, changelogs, debug notes, plans |
| I-8 | [WS-I](WS-I-docs.md) | P3 | M | Drift guards |

## How to execute

Each ticket section in a workstream plan is written to be handed to one
session:

1. `scripts/new-session.sh`.
2. `scripts/ticket.sh new` with the ticket's title, quoting the review
   finding IDs in *Ask*.
3. Implement the **Change** and **Tests** blocks.
4. PR to `dev`, with the version bump and CHANGELOG entry.
5. Stop at any **Owner gates** item.

Concurrent sessions collide on ticket and version numbers, so pick both just
before merging. Phase 1 lanes can run as parallel Orca workers; Phase 2 and 3
tickets follow each plan's section 3 order.
