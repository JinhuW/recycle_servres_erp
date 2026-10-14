---
id: RS-252
title: Fix the 2026-10-13 full code-review findings
type: bug
status: in-review
priority: P1
created: 2026-10-14
reporter: jinhu
branch: fix/review-2026-10-13-a
pr: 641
version:
related: [RS-224]
---

## Ask

> @docs/review-2026-10-13/README.md
>
> Here is the codex found bug. pls create an fix plan

> continue

## Context

`docs/review-2026-10-13/` is a whole-codebase review of `55b5a15a` (v1.247.2):
66 findings — 8 P1, 45 P2, 13 P3 — across security, backend domains, the
supporting backend, frontend, components, infrastructure and dependencies,
each with a probe or reproduction that asserts the *current* broken
behaviour.  Every P1 and the key P2s were re-checked against source before
this plan; all were present.  Two repeat the still-open 2026-08-24 backlog
(`docs/code-review-2026-08-24.md` #4 and #7).

By the time work started `dev` was at v1.258.1, eleven releases past the
reviewed commit, so the review's line numbers are re-located per batch.

The 62 P1/P2/cheap-P3 findings ship as seven area PRs under this ticket, in
risk order; each PR strikes its items in the review's TODO files:

| Batch | Findings | Theme |
|---|---|---|
| A | DEP-01, DEP-02, SEC-03, SEC-11–14 | dependencies and small hardening |
| B | SEC-01, SEC-02, SEC-04, SEC-10 | session and credential validity |
| C | BD-01–03, BD-05, BD-06, BD-09, SUP-01, INT-01 | one domain lock protocol |
| D | BD-04, BD-07, BD-08, BD-10, SUP-02, SUP-03, FE-09, FE-13, FE-15, UI-03 | financial facts and complete lists |
| E | FE-01–03, FE-06, FE-14, UI-06 | frontend session and mobile capture |
| F | FE-04, FE-05, FE-07, FE-08, FE-10–12, FE-16, UI-01, UI-02, UI-04, UI-05 | frontend workflow and accessibility |
| G | SEC-05–09, SEC-15, INF-01–05, INT-02, INT-03, SUP-04, SUP-05, DEP-03 | external side effects and ops |

## Acceptance criteria

Batch A
- [x] `pnpm audit --prod` reports no high advisory without a written disposition; sharp ≥ 0.35.5, hono ≥ 4.13.13.
- [x] A TIFF or WebP renamed `.png` is refused by the anonymous upload path; real PNG/JPEG/WebP still pass.
- [x] An access or bearer token minted in the same second as a password change is refused; the replacement token works without waiting for the clock.
- [x] `constructor`, `toString`, `hasOwnProperty` and `__proto__` preference keys are a 400 and persist nothing.
- [x] Two preference patches landing together keep both keys; an unrelated patch does not touch `language`.
- [x] Three error-log rotations in one second keep three archives.
- [x] An oversized or malformed login email is a 400 with no `login_attempts` row and no bcrypt call.

Batch B
- [x] An authorization code redeemed after a password reset, deactivation or demotion is `invalid_grant` or carries only the role's scopes.
- [x] A saved `at` cookie is 401 after logout and after refresh-reuse revocation; an open VNC viewer closes.
- [x] Two concurrent self-demotions of the last two managers leave one manager and one 400.
- [x] A burst of password-change guesses stops at the five-attempt budget.

Batch C
- [x] Pairing A+B against A+C, link against ignore, and reassign against PATCH each yield one winner and one 409/403; sync never overwrites a manager's committed verdict.
- [x] Transfer reopen under a racing Shipped sale is 409 and the lot stays received.
- [x] Archive against sell-order Done never raises 40P01.
- [x] Parallel item-type renames leave every line on the final name.

Batch D
- [x] Dashboard revenue and counts include manual (inventory-free) sell lines and match the sell-orders screen; lines without a cost are counted and labelled.
- [x] CRM `?follow=soon` finds clients beyond the first 200; counts cover the whole owner-scoped book.
- [x] A 26-page PO walk reaches page 26; the phone inventory reaches lot 51+.
- [x] The phone profit sparkline keeps negative periods on canvas; Market shows no simulated cost or broker series.
- [x] Duplicate-lot edits appear once in sell-order history; POST and PATCH validate categories and customers alike; non-Latin seller names never cross-attach a package.

Batch E
- [x] A login under a different identity renders none of the previous user's PO or capture data.
- [x] Save-then-Submit on a slow line PATCH makes one PO with one line; a failed edit stays visible as unsaved and submits once on retry.
- [x] The newest preference edit wins over an older reply; a cancelled scan never lands in a later capture.

Batch F
- [x] Each PWA shortcut lands on its screen in both shells; a shared image reaches the scanner once.
- [x] Inventory edits prompt before discard; Tab stays inside an open dialog; the phone zooms; `/clients/:id` opens that client; an internal-transaction note survives adding a payment.
- [x] Proof upload and item-type pick work by keyboard; capture controls and hardware fields have names; Chinese UI has no English timeline titles.

Batch G
- [ ] Production without R2 refuses uploads with 503 and `/api/health` says so; public-form quota admits exactly its budget under concurrency; DCR at the last slot yields one 201.
- [ ] A reopened submission is never purged; a failed receipt insert leaves no public object; Shippo registers a number once.
- [ ] Frontend deploy waits on checks; sync refuses an aliased prod URL; uptime alerts are valid JSON; AI replies that are arrays or scalars retry and unknown keys don't raise confidence; a seed failure leaves triggers enabled; XLSX tab names are unique; the audit workflow runs with dispositions.

## Out of scope

- INF-06 (isolated restore drill), INF-07 (Worker typecheck/observability) and BD-11 (packing helpers out of the route module) — each a follow-up ticket.
- The `architecture-todo.md` consolidations beyond what the batches already do.
- The review's "Follow-up questions excluded" and "Unverified concerns" sections: not findings.
- FE-07 is resolved by removing the dead *Internal notes* field; a persisted inventory note is a story if wanted.
- FE-05's share-target hand-off is routed and consumed in code with unit coverage; a real installed-phone smoke test (share an image while signed in and while signed out) is still owed.
- FE-01, FE-10 and the mobile write queue have no rendered tests: the frontend suite has no DOM environment or testing library, and adding one is its own change.

## Notes

- Plan: `~/.claude/plans/docs-review-2026-10-13-readme-md-here-i-transient-meteor.md` (this session).
- The review's reproduction files (`backend-domain-reproductions.ts`, `supporting-domain-repro.test.ts`, the `*-probes.mjs`) assert the defects; each batch converts the relevant case into a regression test and never adds the originals to the suite.
