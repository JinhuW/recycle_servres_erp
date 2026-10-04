---
id: RS-169
title: Second-level sidebar nav; the trackers move under Monitors
type: story
status: done
priority: P2
created: 2026-10-04
reporter: jinhu
branch: feat/sidebar-second-level-nav
pr: 495
version: 1.207.0
related: [RS-164, RS-166]
---

## Ask

> enable the second level nav for this erp system.
>
> migrate the facebook worker to the second level nav.

## Context

The desktop sidebar (`components/Sidebar.tsx`) was flat: two groups,
Workspace and Oversight, each a list of leaf links. The only second level was
in-page tabs (Inventory ▸ Analysis, Payments ▸ Internal transactions), kept lit
by two hard-coded clauses in the sidebar's active check.

"The facebook worker" is the Facebook tracker at `/fleet` (view
`coordinator`; the fleet of Facebook worker accounts, with the live worker
viewer at `/fleet/watch/<worker>` since v1.204.0). Asked how the second level
should look, the requester picked:

- **Group the trackers** — a new Oversight parent, **Monitors**, holds
  **Facebook** (`/fleet`) and **Reddit** (`/tracker`). Both pages and their
  URLs stay as they are.
- **Open while inside** — the children show only while you are on one of
  them; the parent is a link to its first child.

## Acceptance criteria

- [x] The sidebar supports a parent entry with child entries
      (`DESKTOP_NAV` in `lib/desktopNav.ts`).
- [x] Oversight shows Monitors with Facebook (`/fleet`) and Reddit
      (`/tracker`).
- [x] The children show only while on one of them; elsewhere Monitors is one
      row with a › caret.
- [x] Monitors is a real link to Facebook, so ⌘-click opens a tab.
- [x] The active child is lit, including on `/fleet/watch/<worker>`.
- [x] In the icon rail the caret hides and the children show as icons.
- [x] Purchasers see no Monitors entry.
- [x] Inventory and Payments stay lit on their Analysis and Internal tabs.

## Out of scope

- Splitting the Facebook tracker page into sub-pages under its own parent —
  offered, not picked.
- A manual expand/collapse toggle or a remembered open state.
- Moving the Inventory ▸ Analysis and Payments ▸ Internal tabs into the
  sidebar.
- Any URL change.

## Notes

Plan: `~/.claude/plans/parallel-tumbling-plum.md`.

The model lives in a pure module so the rules are unit-tested; the frontend
test suite is node-only. `inventory` and `payments` carry
`alsoActiveOn` instead of the two `||` clauses the sidebar used to hard-code.

No rail-specific CSS: the caret is a `<span>`, which the rail's
`.sidebar .nav-item > span:not(.badge)` already hides, and the child indent is
a `padding-left` that the rail's later `.sidebar .nav-item { padding: 10px 0 }`
overrides. That keeps the change clear of RS-166, which moves the rail rules
into an `@container` query. The new rules must stay **before** the rail block,
or the indent wins and leaks into the rail.

`tests/i18nCoverage.test.ts` only sees literal `t('…')` calls, and the sidebar
calls `t(n.tKey)`, so `desktopNav.test.ts` checks every nav key against
`I18N.en` itself.
