---
id: RS-134
title: "Code-review fixes batch 2: every remaining Minor finding"
type: bug
status: done
priority: P2
created: 2026-10-01
reporter: jinhu
branch: fix/review-minors
pr: "#451"
version: 1.193.0
related: [RS-130]
---

## Ask

> pls fix all the remaing minior issue as well.

Answers to the scoping questions:

> Archived Shipped / Awaiting-payment sell orders — which rule? — Refuse archiving them

> Backups — how far? — Repo-side only (Recommended)

## Context

The 2026-10-01 full code review left 46 Minor findings after RS-130 (v1.191.0)
fixed the Criticals and four Majors. Eight were already resolved by RS-130 (the
vendor-portal items, the PATCH catch-all regex, the dead attachments route, the
backup CSV, the empty `.gitkeep`); the other 38 are this ticket. They cluster as:

- **Auth and boundaries** — a string `active` skipped the member guards; access
  tokens outlived a password change; OAuth refresh rotated before checking the
  client; unauthenticated parse failures 500'd into the error log; weak-secret
  and proxy-secret checks; unbounded MCP metric labels and upload file names.
- **Purchase orders** — the closed-book freeze ignored `payment`; a changed or
  cleared PayPal id left the old bank row linked; proof could be deleted and
  evidence uploaded without a re-check under the lock; a stage-jump to the
  current stage re-notified; three write gates used the preview role.
- **Sell side and inventory** — failed creates burned SO ids; unsorted row
  locks; receive promoted Reviewing lines to Done; Closed orders were editable;
  silent result caps; unread count capped at 50; unescaped LIKE input.
- **Payments and integrations** — sync single-flight ignored the provider set;
  disputes re-fetched every sync; card sync failures invisible; a stuck pending
  row widened every fetch (prod's oldest is 2026-06-01); out-of-order Shippo
  pushes; proxy response handling; spend counted archived POs.
- **Ops** — no lock timeout or checksum in migrations, no DB statement timeout,
  a test harness that reuses half-built templates and bypasses the migration
  runner, CI on Postgres 16 against a prod on 18, unpinned deploy tooling, and
  backup-script mismatches.
- **Frontend** — hidden-tab polling that stacked error dialogs, a load-more
  race, raw English strings.

## Acceptance criteria

- [x] Every item in the approved plan (`~/.claude/plans/optimized-watching-map.md`)
      is fixed or explicitly recorded as decided-against with a reason.
- [x] Archiving a Shipped or Awaiting-payment sell order is refused.
- [x] A password change or reset makes older access tokens 401; the caller of a
      self change stays signed in through one refresh.
- [x] Changing or clearing a PO's PayPal id unlinks the bank row linked through
      the old id, unless a manager made that link.
- [x] Full backend and frontend suites pass; CI runs on Postgres 18.

## Out of scope

- The ~30 remaining Major findings — later themed batches.
- Backup infrastructure changes in Cloudflare / Railway (bucket import,
  write-only token, object lock, R2 attachments backup) — written up as a
  runbook for separate approval.
- Batching PO PATCH's per-line UPDATE: each line carries its own field
  sentinels and the table is ~1k rows.
- Paginating the packages list: the client needs every row for its counts, and
  there are 23.

## Notes

Plan reviewed by one Plan agent (two blockers, eight should-fix, all applied —
notably the password-change cookie re-issue would have clobbered `rt`, and a
blanket "purchasers can't delete proof after Draft" reversed a deliberate
design, so it was narrowed to the last required proof file).
