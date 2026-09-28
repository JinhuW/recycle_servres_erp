---
id: RS-122
title: Part number → chip # map auto-fills a RAM line's chip #
type: story
status: done
priority: P2
created: 2026-09-27
reporter: Jinhu
branch: feat/part-chip-map
pr: "#422"
version: 1.186.0
related: []
---

## Ask

> help me build an map for part number to chips and it will help to reduce the type the chips again and again.

## Context

A RAM line's chip # (required for Micron / Other brands) is typed by hand on
every line, although the same part number always carries the same chip
marking and earlier PO lines already record it. Decided with the requester:
learn the map from past lines (no new table), and fill the chip # only when it
is empty.

## Acceptance criteria

- [ ] `POST /api/market/chips { partNumbers }` answers, per asked spelling, the
      chip # recorded on the most POs for that canonical part number (tie →
      most recent); archived POs and blank chips don't vote; workspace-wide.
- [ ] Typing or scanning a known part # on a RAM line (desktop drawer, desk
      scanner, phone form) fills a blank chip #; a user-entered chip is never
      overwritten; clearing the filled chip keeps it clear.
- [ ] Opening an existing line never fills, so an untouched PO does not turn
      dirty; read-only drawers never fill.
- [ ] RAM sheet scan fills known chips before its auto-save.

## Out of scope

Lines created server-side (packages → create-PO); a curated/editable map.

## Notes

Plan: `~/.claude/plans/serene-hatching-eagle.md`.
