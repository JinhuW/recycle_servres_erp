---
id: RS-500
title: Web submissions nav shows a count of new submissions
type: story
status: done
priority: P2
created: 2026-11-01
reporter: jinhu
branch: JinhuW/dorado
pr: 1049
version: 1.405.0
related: []
---

## Ask

> when new submission coming.
> [Image #1]
>
> it should show a number

(Image #1: the sidebar's "Web submissions" item, with no count beside it.)

## Context

The desktop sidebar's Web submissions leaf (`lib/desktopNav.ts`, manager only)
gave no sign that a public-form submission had arrived; a manager had to open
the page to find out. Accounting and Reddit leads already draw a live
`badge due` count in `components/Sidebar.tsx`. A submission in status `new`
(`routes/webSubmissions.ts`) is one nobody has triaged yet. Submissions arrive
from outside the app, so this count, unlike the other two, also has to refresh
on a timer.

## Acceptance criteria

- [x] The Web submissions leaf shows a `badge due` with the number of submissions in status `new`, hidden at 0.
- [x] A submission that arrives while the app is open reaches the badge within about a minute, and at once when the tab regains focus.
- [x] Triaging on the thread page (status change, Create Draft PO) updates the badge without a reload.
- [x] A folded parent row carries the count like the other badges; the hover title explains it in English and Chinese.
- [x] `GET /api/web-submissions/count` returns `{ n }`, manager only, covered by a backend test.

## Out of scope

Push or websocket delivery, browser notifications, the mobile nav, and a
per-user "seen" state: the count is the shared untriaged queue.
