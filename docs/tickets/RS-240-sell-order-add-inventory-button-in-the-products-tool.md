---
id: RS-240
title: Sell order Add inventory button in the products toolbar
type: story
status: done
priority: P2
created: 2026-10-12
reporter: jinhu
branch: feat/so-add-inventory-toolbar
pr: 625
version: 1.250.0
related: [RS-235]
---

## Ask

> also help me bring the add invetory buttom to the top of the section. But create a better UI UX for the buttom and give it a better location

## Context

In edit mode the sell order page rendered Add inventory as a small `btn sm`
after the last product group — at the foot of a long order. v1.248.0 put a
search box at the top of the Products section (RS-235).

## Acceptance criteria

- [x] In edit mode, Add inventory is an accent button on the same row as the
      products' search box, at the top of the Products section.
- [x] The old button under the lines is gone.
- [x] Adding clears the search box.
- [x] After adding, the page scrolls to the first new (or revived) line and
      each one flashes briefly.

## Out of scope

- A keyboard shortcut for Add inventory.
- The Add inventory picker dialog itself.
