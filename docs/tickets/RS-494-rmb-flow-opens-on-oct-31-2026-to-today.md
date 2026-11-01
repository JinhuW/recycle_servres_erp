---
id: RS-494
title: RMB Flow opens on Oct 31, 2026 to today
type: story
status: done
priority: P2
created: 2026-11-01
reporter: jinhu
branch: JinhuW/brill
pr: 1046
version: 1.400.0
related: []
---

## Ask

> also pls help me preset the start point from the Oct 31, 2026. for the rmb flow.

Clarified: the default period starts Oct 31 (chosen over "the book starts
Oct 31" and "add an Oct 31 preset").

## Context

The RMB Flow page (`#/accounting`, `pages/desktop/DesktopAccounting.tsx`)
opened on *This month*, which on Nov 1 shows a single day. The owner wants it
to open on Oct 31, 2026 → today. Entries before Oct 31 still count toward the
Opening balance; only the default window changes.

## Acceptance criteria

- [x] A fresh load of RMB Flow shows the period Oct 31 – today.
- [x] Opening still includes everything before Oct 31; other periods can still be picked.
- [x] A period the user picked is still remembered across navigation (RS-493).

## Out of scope

Ignoring entries before Oct 31, or a set opening balance; a new preset in the
date chip.
