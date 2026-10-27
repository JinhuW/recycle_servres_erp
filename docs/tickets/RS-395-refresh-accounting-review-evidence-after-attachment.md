---
id: RS-395
title: Refresh accounting review evidence after attachment edits
type: bug
status: done
priority: P2
created: 2026-10-24
reporter: jinhu
branch: fix/accounting-attachment-refresh
pr: "894, 895"
version: "1.344.1 (dev), 1.333.2 (prod)"
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
- [x] The accounting-only release is deployed and both production hostnames
      report healthy v1.333.2 APIs and v1.333.2 frontend versions.

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

- Production release PR #895 contains RS-390 plus this fix, branched from
  the historical dev commit that introduced RS-390. The fleet overhaul and
  the other queued dev changes are excluded.
- The production release passed workspace typechecks, its frontend build,
  all 2,561 backend tests and all 1,067 frontend tests. The first CI run had
  one timeout in the existing cache-header test's live exchange-rate lookup;
  the retry passed without code changes.
- The backend was deployed before merging the production release so the
  attachment API and migration 0205 were ready before the frontend update.
- This back-merge preserves production release ancestry in dev while keeping
  dev's v1.344.1 code and version. Only release documentation changes.

- Verified production at both inventory.recycleservers.com and
  inventory-prod.recycleservers.com: /api/health returns status ok and
  version 1.333.2; /version.json reports frontend version 1.333.2.
  Cloudflare deployment run 40160931948 passed its verify and deploy jobs,
  including both hostname smoke checks. Worker version:
  e9ea616b-8773-4499-9b03-fe8e9b688273.
- The successful backend deployment is 6ef7f9d3-a6ce-4fd2-ade2-9be79bc7fac3,
  uploaded from clean release commit d29c776e. Railway skipped the follow-up
  main deployment because its source matched the already-running build.
  GitHub tracking remains main.
