---
id: RS-395
title: Refresh accounting review evidence after attachment edits
type: bug
status: in-review
priority: P2
created: 2026-10-24
reporter: jinhu
branch: fix/accounting-attachment-refresh
pr: 894
version: 1.344.1
related: [RS-390]
---

## Ask

> give me an recommand update for this problem.

> go ahead fix it and deploy to prod.

## Context

The review of RS-390 found that adding or removing payment screenshots in
Review's entry drawer reloads only the drawer. The parent queue keeps its
old attachments. Its read-only AcctAttachments component also seeds local
state once, so refreshed queue props alone would still leave stale proof.

## Acceptance criteria

- [x] Successful attachment uploads and deletions in the drawer refresh both
      the drawer and the parent Review queue.
- [x] The read-only evidence pane renders refreshed props, including a change
      from no screenshots to one and from one screenshot to none.
- [x] Editable attachment lists keep their local upload/delete updates.
- [x] Frontend checks pass (1,150 tests, shared typecheck, frontend production build).
- [ ] The approved release is deployed and both production hostnames respond.

## Out of scope

Changing attachment storage, OCR, sign-off rules, or the fleet runtime.

## Notes

- Implements the targeted fix recommended in the preceding review response
  and approved by the requester's go-ahead.
- An isolated browser smoke run mounted the actual EntryDrawer beside the
  read-only AcctAttachments pane with mocked APIs. Two uploads and two
  deletions refreshed the parent four times and updated the pane from empty
  to one, two, one, and zero attachments without remounting or browser errors.
- Production was v1.332.2; dev also contained the unreleased fleet overhaul.
  Release scope was asked separately before promoting production.
