---
id: RS-475
title: Fleet account cell shows a brief on hover
type: story
status: done
priority: P2
created: 2026-10-31
reporter: jinhu
branch: JinhuW/darter
pr: "#1019"
version: 1.391.0
related: []
---


## Ask

> as we discuss before. When i hover the account, it should shows the berief info about the account.(When impotred, note.)
> [Image #1]
>
> Cuz i need this info to brief evaluate the performance about the account.

(Image #1: the Fleet tab's worker table with the Account cell of homelab-1,
"No. 47 / 615…067", outlined in red.)

## Context

The Fleet tab's worker table (`pages/desktop/fleet/FleetAccountsTab.tsx`)
shows each account as its number and masked uid only. Judging whether an
account earns its slot meant opening the Account pool for the import date and
note, and the worker page for its history. The pool summary the tab already
polls carries the import time, batch and note; the account's searches live in
`fleet_tasks` (by `account_no`, result jsonb) and its stints in
`fb_worker_accounts`.

## Acceptance criteria

- [x] Hovering (or focusing) the Account cell of a row with an account opens a card after a short delay; leaving closes it.
- [x] The card shows No. + masked uid, pool status, imported date with its age and batch, the note (or "No note"), and since when it has been on its current worker.
- [x] The card shows the last 7 days: searches done, cards seen, listings opened, alerts sent, minutes searched, last search; and lifetime stints with how many ended problem or retired.
- [x] Imported and note render at once from the pool summary; the performance block loads on first hover and is cached for a minute.
- [x] Rows with no account show no card.
- [x] The card stays inside the viewport.

## Out of scope

Touch/mobile, editing the note from the card, unmasking the uid, a per-account chart.
