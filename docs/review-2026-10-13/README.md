# Code review and repair backlog — 2026-10-13

Reviewed commit **`55b5a15a`**, application version **1.247.2**. The review found **66 prioritized items: 8 P1, 45 P2, 13 P3**, plus linked structural follow-ups. Each finding gives current source locations, failure conditions, evidence, a proposed repair and useful regression coverage. All checkboxes remain open: this task changed review documents and reproduction artifacts only.

P1 means urgent security or data-integrity work; P2 means a supported workflow, correctness, security or reliability defect; P3 means a narrower usability/helper defect or maintainability improvement. These are review priorities, not CVSS scores. Items explicitly distinguish runtime reproductions, source-confirmed interleavings, config mismatches and structural recommendations. Dependency advisory entries are separate from application findings.

## Start here

| Order | Repair | Finding IDs |
| --- | --- | --- |
| 1 | Patch Sharp and constrain detected image formats on anonymous uploads. | [DEP-01](dependency-audit.md) |
| 2 | Make OAuth code redemption honor credential changes and live roles; serialize the last-manager invariant. | [SEC-01, SEC-04](security-todo.md) |
| 3 | Clear retained records on user changes; serialize mobile draft/line writes and preserve failed edits before finalization. | [FE-01–03](frontend-todo.md) |
| 4 | Lock/revalidate both payment-pair legs and read sell commitments after inventory locking. | [BD-01–02](backend-domain-todo.md) |
| 5 | Extend those boundaries to logout revocation, reassignment authorization, manual/automatic reconciliation and PO/SO lock ordering. | [SEC-02–03](security-todo.md), [BD-03, BD-05–06](backend-domain-todo.md), [SUP-01](schema-and-supporting-domain-todo.md), [INT-01](infrastructure-integrations-todo.md) |
| 6 | Restore accurate financial reporting and complete pagination; remove misleading simulated figures. | [BD-04](backend-domain-todo.md), [SUP-03](schema-and-supporting-domain-todo.md), [FE-09, FE-13, FE-15](frontend-todo.md), [UI-03](components-todo.md) |

## TODO files

| Area | Findings | P1 / P2 / P3 | Report |
| --- | ---: | --- | --- |
| Authentication, authorization, public inputs, storage, VNC | 15 | 2 / 10 / 3 | [Security TODOs](security-todo.md) |
| Purchase/sell orders, inventory, payments, financial queries | 11 | 2 / 8 / 1 | [Backend domain TODOs](backend-domain-todo.md) |
| CRM, package conversion, schema/seed, XLSX helpers | 5 | 0 / 4 / 1 | [Supporting backend TODOs](schema-and-supporting-domain-todo.md) |
| Shell/session state, mobile writes, routes/PWA, editors | 16 | 3 / 12 / 1 | [Frontend TODOs](frontend-todo.md) |
| Accessibility, charts, language, scanner lifecycle | 6 | 0 / 3 / 3 | [Component TODOs](components-todo.md) |
| Deployment, recovery, provider integrations, Worker | 10 | 0 / 6 / 4 | [Infrastructure/integration TODOs](infrastructure-integrations-todo.md) |
| Production dependencies and audit automation | 3 | 1 / 2 / 0 | [Dependency TODOs and advisory inventory](dependency-audit.md) |

[Architecture follow-ups](architecture-todo.md) consolidate repair boundaries and dependency direction; they cross-reference the findings instead of counting the same defects again.

## Validation

| Check | Result |
| --- | --- |
| Frozen dependency install | Passed; 617 packages, lockfile unchanged |
| `pnpm typecheck` | All workspace packages passed |
| Frontend suite | **74 files, 775 tests passed** |
| Production build | Passed; 367 transformed modules, 99 precache entries, approximately 2.24 MiB |
| Full backend suite | **222 files passed, 1 failed; 2,330 tests passed, 1 failed**; 480.95 s |
| Backend failure investigation | Seed-sensitive partial-sale assertion in `tier1-data-integrity.test.ts:44`; targeted rerun passed. Recorded as **BD-10**, not a demonstrated production stock bug. |
| Domain defect reproductions | 9 cases passed on an isolated migrated/seeded database |
| Supporting-domain defect reproductions | 7 cases passed on an isolated migrated/seeded database |
| Security defect reproductions | 8 cases passed; temporary source removed after verification; evidence recorded in the report |
| Preserved frontend probes | 10 scenarios demonstrate current defective behavior |
| Preserved component probes | 3 cases demonstrate current defective behavior |
| Preserved integration probes | 4 cases demonstrate current defective behavior; providers mocked |
| `pnpm audit --prod --json` | 27 advisory entries: 12 high, 13 moderate, 2 low, 0 critical; duplicate GHSAs/reachability triaged separately |

The defect probes intentionally assert the current failures; a passing probe does **not** mean a defect was fixed. Existing test-suite success also does not invalidate the concurrency/UI failures reproduced outside its coverage.

Validation used synthetic accounts/keys/files and disposable local PostgreSQL 18, never the project's live database or credentials. The local runtime was Node 26.5.1/pnpm 11.0.9; project configuration targets Node 24 or newer. PostgreSQL 18 also differs from the local Compose PostgreSQL 16 target. Production/platform compatibility was not certified by these local results. No deployment, cloud configuration change, real provider subscription, email or webhook delivery was performed.

## Coverage and limits

The reviewed production source inventory is **150 backend + 257 frontend + 24 shared = 431 TypeScript modules**, plus the plain-JavaScript Cloudflare Worker, **172 SQL migrations**, backend bootstrap scripts, deployment/backup/sync/uptime scripts, Terraform, workspace/build configuration and git tooling. Three delegated reviewers covered security, backend domains and frontend/shared flows; the primary reviewer completed remaining modules, integration/configuration review and report reconciliation.

- [Backend production coverage with fingerprints](backend-coverage.md)
- [Backend domain read ledger](backend-domain-coverage.md)
- [Frontend/shared coverage with fingerprints and depth](frontend-coverage.md)
- [Infrastructure/configuration manifest](infrastructure-coverage.md)
- [Full migration/supporting-script manifest](schema-and-supporting-domain-todo.md#explicit-coverage)

Coverage depth is explicit: full component/shared/backend passes coexist with focused frontend flow reads and an AST-assisted executable/render-expression pass. Static JSX/style literals were not all manually reviewed line by line. CSS and static assets received pattern/inventory screening; translation keys/placeholders passed parity tests, but linguistic and manufacturer-data accuracy were not independently certified. Existing tests were executed and selectively inspected, rather than all read line by line. Historical review/design documents were context, not evidence that older findings still apply.

Real device cameras/scanner bridge, installed-app Web Share, browser rendering/assistive technology, live bucket CORS, GitHub branch protections, cloud state and actual backup restore were not exercised. The relevant follow-ups identify where those checks are needed. Source coverage and local tests establish the recorded evidence; they cannot guarantee an absence of additional defects.

## Replay artifacts

The probe and reproduction files this review shipped (`frontend-probes.mjs`, `component-probes.mjs`, `integration-probes.mjs`, `backend-domain-reproductions.ts`, `supporting-domain-repro.test.ts`) were removed in v1.259.1. They asserted the defects; RS-252 (v1.258.2–v1.258.8) fixed the findings it took on and turned each case it covered into a regression test of the corrected behavior. Those tests run in the normal suites: backend cases under `apps/backend/tests/` (the lock-protocol races in `review-lock-protocol.test.ts`, the rest in the test file of the route or module they cover), frontend cases next to their helpers in `apps/frontend/src/lib/` (for example `orderSubmit.test.ts`, `prefSaver.test.ts`, `keysetPages.test.ts`, `route.test.ts`). The TODO files still cite the originals as evidence; read them at `v1.259.0`, for example `git show v1.259.0:docs/review-2026-10-13/frontend-probes.mjs`.
