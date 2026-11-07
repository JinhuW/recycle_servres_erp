---
id: RS-563
title: Move web submissions under Leads as Website
type: story
status: done
priority: P2
created: 2026-11-07
reporter: jinhu
branch: JinhuW/moray
pr: 1139
version: 1.436.0
related: []
---

## Ask

> move the web submission to the leads. and have a better name for it web submission.

> let we call it simplier.

## Context

Web submissions was a top-level manager item at the bottom of the sidebar's
Workspace group (`lib/desktopNav.ts`), at `/web-submissions`. It holds people
offering hardware through ram4cash.com and recycleservers.com, which makes it a
second source of leads beside Leads ▸ Reddit, until now that parent's only
child.

## Acceptance criteria

- [x] A manager sees Leads ▸ Reddit and Leads ▸ Website, and no top-level Web
      submissions item.
- [x] A purchaser still sees only Leads ▸ Reddit and is still sent Home from the
      Website URLs.
- [x] The page lives at `/leads/website` and one lead at
      `/leads/website/WS-nnnn`.
- [x] Old `/web-submissions` and `/web-submissions/WS-nnnn` links still open the
      same pages.
- [x] The sidebar and page title say Website (网站); the Home queue row and badge
      hint say "website leads" (网站线索).
- [x] A closed Leads row's badge adds both counts for a manager, and its tooltip
      stays true when both sources have items.

## Out of scope

Renaming the database tables, `/api/web-submissions`, the `WS-` ids, the
`websubmissions` view id (perf rollups key on it), or the note on Draft POs
already created. Merging both sources into one list. The public forms and their
customer-facing text.

## Notes

The first proposed name was "Website leads"; the owner asked for simpler, so the
sidebar and page title are just "Website". Text that stands alone without the
Leads parent around it, the Home queue row and the badge hint, still says
"website leads".
