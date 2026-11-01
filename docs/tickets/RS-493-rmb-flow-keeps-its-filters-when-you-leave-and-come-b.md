---
id: RS-493
title: RMB Flow keeps its filters when you leave and come back
type: story
status: done
priority: P2
created: 2026-11-01
reporter: jinhu
branch: JinhuW/brill
pr: 1044
version: 1.399.0
related: []
---

## Ask

> I did some selection from this RMB flow page. When user jump to another page and go back. It should keep the selection.

## Context

Every filter on the RMB Flow page (`#/accounting`,
`pages/desktop/DesktopAccounting.tsx`) was plain `useState`. Opening Log,
Review mode, a PO, or any other page unmounts it, so coming back reset the
range, manager, direction, kind, method, review state, search and Show voided.
Orders, Inventory, Payments and Clients already keep theirs with
`usePersisted` (`lib/listMemory.ts`): in memory for the page load, so a full
reload starts fresh.

## Acceptance criteria

- [x] Range, manager, All/Received/Paid, kind, method, review state, search text and Show voided survive navigating away and back.
- [x] A full page reload still starts from the defaults (this month, all managers, no filters).

## Out of scope

Persisting across reloads or devices (localStorage or URL); scroll position;
the mobile pages.
