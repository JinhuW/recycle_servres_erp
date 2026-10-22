---
id: RS-351
title: WeChat and Reddit pages follow the Facebook fleet pattern
type: story
status: in-review
priority: P2
created: 2026-10-22
reporter: jinhu
branch: feat/monitors-fleet-pattern
pr:
version: 1.316.0
related: [RS-297, RS-344]
---

## Ask

> update the wechat and reddit page to the same pattern as the facebook subpage design.

(with a screenshot of the Monitors / Facebook fleet head: tabs, status pills,
search + summary toolbar, Recent activity aside)

## Context

Monitors ▸ Facebook (`/fleet`, `DesktopCoordinator.tsx` + `FleetWorkers.tsx`)
is the reference: breadcrumb, title, an icon tab row, status pills that
filter, a table card with search on the left and a one-line summary on the
right, and an aside. Reddit (`/tracker`) took the legend, table and aside in
RS-297 (v1.283.0) but has no tabs and no search. WeChat (`/wechat`, RS-344,
v1.312.0) is a KPI grid, an overview row and a full-width board.

## Acceptance criteria

- [x] Reddit: tabs Fleet (`/tracker`) and Prompts (`/tracker/prompts`), and the
      title follows the tab; the prompt comparison lives on Prompts.
- [x] Reddit: the workers toolbar has a search box (worker id, role) that finds
      workers past the loaded page, a clear button, and a summary
      "N workers · posts in 24 h · alerts · subreddits · rules on".
- [x] WeChat: tabs Price board and Groups; Groups shows the group table open.
- [x] WeChat: pills Short / Tight / Balanced / Loose / Glut show the board's
      line count per signal; clicking one filters the board, clicking it again
      clears it.
- [x] WeChat: the board toolbar has search first and a summary of buyers,
      sellers, posts and groups on the right, with the day-over-day trend in
      its tooltip; the shown/total line count moves to the foot; the KPI cards
      are gone.
- [x] Signal and status counts ignore the search box, as Facebook's do.
- [x] WeChat: market notes and Most wanted / Most offered sit in an aside
      beside the board, above it below 1190px.
- [x] No backend, proxy or tracker change.

## Out of scope

- Server-side worker search (a tracker contract change); the browser filters a
  ≤500-row load instead (the tracker's `MAX_LIMIT`).
- Route-based WeChat tabs: the URL already carries the report day.
- The mobile app.

## Notes

Choices made with the requester: Fleet / Prompts tabs, load-all search, the
full pattern for WeChat. Plan reviewed by a subagent before approval; it caught
that the old `loadingRef` guard would drop the search reload, so worker loads
are now latest-wins.

Found in the browser check (1440×900, tracker and wechat-market APIs stubbed
in Playwright since the local stack has neither): beside the 286px aside the
WeChat board overflowed by 130px and its toolbar wrapped. The board took the
Fleet table's 8px cells, a 104px bid/ask bar and a wrapping spec line, and the
line-family control and *Priced lines only* moved to a second toolbar row so
the first stays Facebook's search + summary. The Groups tab's chip counts all
groups read (the rows that tab lists), as the Pool tab's counts accounts.
