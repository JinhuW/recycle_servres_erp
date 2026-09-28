---
id: RS-123
title: Web form submissions inbox (ram4cash + recycleservers)
type: story
status: in-review
priority: P2
created: 2026-09-28
reporter: jinhu
branch: feat/web-submissions
pr:
version: 1.187.0
related: [RS-095]
---

## Ask

> So for the form in the ram4cash or recycleservers.com
> I hope you can build an api endpoint that can connect to our system. (maybe you already build it on half way)
>
> The ERP system will have a dedicated page for all submissions.

## Context

The ram4cash.com sell form already posted to `POST /api/public/intake`, but that
endpoint only existed on the unmerged RS-095 branch (PR #391), which turned every
anonymous lot straight into a Draft PO. The recycleservers.com quote form posted
only to Formspree. Neither reached the ERP.

Decisions (2026-09-28): a ram4cash lot is stored as a submission and becomes a
Draft PO only when a manager clicks **Create Draft PO**; recycleservers.com posts
to the ERP and keeps Formspree as a backup email.

## Acceptance criteria

- [x] `POST /api/public/intake` stores a ram4cash lot (lines, label photos,
      PayPal-vs-pickup hand-off) as `WS-nnnn` and creates no PO.
- [x] `POST /api/public/quote` stores a recycleservers.com quote request.
- [x] Both are rate-limited per IP (429 + `Retry-After`) and drop a filled
      honeypot silently; the limiter does not touch the rest of `/api/public/*`.
- [x] Managers get a notification per submission.
- [x] A manager-only **Web submissions** page lists every submission with
      status tabs + counts, site filter, search and paging, and opens one with
      its photos, a status/staff-note triage panel and a mailto reply.
- [x] **Create Draft PO** on a sell lot files a Draft PO (lines at cost 0,
      photos copied, house-account supplier with source `web`; PayPal for a
      shipped lot, cash + pickup for a pickup lot) exactly once.
- [x] Purchasers get 403 from the API and no nav entry.

## Out of scope

Mobile screen (manager oversight pages are desktop-only); emailing the sender
from the ERP; auto-pricing a lot.

## Notes

Supersedes RS-095 / PR #391: its validation, photo handling and PO-creation
code were ported onto current dev. Plan:
`~/.claude/plans/radiant-strolling-abelson.md`.
