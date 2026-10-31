---
id: RS-479
title: Leads Pool loads the next 50 sellers on scroll
type: story
status: done
priority: P2
created: 2026-10-31
reporter: jinhu
branch: JinhuW/oystercatcher
pr: 1025
version: 1.393.0
related: []
---

## Ask

> Show 50 more. it should auto refresh when scroll down to the bottom.

(Sent with a screenshot of the Leads ▸ Reddit Pool footer: "2,170 unclaimed
sellers · showing 50" and a **Show 50 more** button.)

## Context

The Pool tab (`apps/frontend/src/pages/desktop/LeadsReddit.tsx`, `PoolTab`,
v1.392.0) gets the whole unclaimed pool in one response and renders it 50 rows
at a time. With 2,170 sellers, walking the list meant clicking **Show 50 more**
over forty times. The data is already in memory, so loading more is only a
render.

## Acceptance criteria

- [x] Scrolling to the foot of the Pool table reveals the next 50 sellers
      without a click, starting a screenful early.
- [x] It keeps going page by page and stops when every seller is shown.
- [x] **Show 50 more** stays as a manual fallback.
- [x] A new search still resets the list to the first 50.

## Out of scope

- Server-side paging of the pool. The endpoint returns the whole pool and is
  fast enough at today's size.
- My leads, Buyer network and Team tabs: they don't page.

## Notes

Uses the existing `useSentinel` hook (the Market and Activity pages' infinite
scroll), with the viewport as root, since the pool scrolls with the page.
Verified locally with 180 seeded sellers: 50 → 100 → 150 → 180 on scroll.
