---
id: RS-470
title: Fleet table links each account to its pool record
type: story
status: done
priority: P2
created: 2026-10-30
reporter: jinhu
branch: JinhuW/lionfish
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1012
version: 1.388.0
related: []
---

## Ask

> addd a link to trace back to the account info.
> or you can show some info about the account when user hover.

## Context

On Monitors ▸ Facebook ▸ Fleet (`/fleet`) the Account column
(`apps/frontend/src/pages/desktop/fleet/FleetAccountsTab.tsx`) shows "No. 55"
and a masked uid ("615…798") as plain text, the uid's tooltip saying the pool
page shows it. Getting from a worker to its account meant switching to the
Account pool tab and searching by hand.

## Acceptance criteria

- [x] "No. N" in the Fleet table's Account column links to `/fleet/pool?account=N`
- [x] Following it opens the Account pool tab with account N's editor open; the
      param is consumed, so a reload or closing the editor does not reopen it
- [x] Hovering the Account cell shows the account's pool status, holder and
      note when the pool knows them
- [x] A row without an account number (`—`) has no link

## Out of scope

A custom popover component (a native `title` is enough); the full uid or any
secret on hover; the mobile shell (the fleet is desktop-only).

## Notes

Plan: `~/.claude/plans/goofy-churning-floyd.md`. The one-shot param uses the
existing `takeHashParam` (`lib/route.ts`).
