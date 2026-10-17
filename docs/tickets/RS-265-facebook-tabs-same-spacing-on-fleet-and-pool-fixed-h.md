---
id: RS-265
title: Facebook tabs: same spacing on Fleet and Pool, fixed-height flow detail
type: bug
status: done
priority: P3
created: 2026-10-17
reporter: jinhu
branch: fix/facebook-tab-spacing
pr: "#677"
version: 1.266.1
related: [RS-264]
---

## Ask

> 我有点强迫症 你看看感觉这两个页面虽然结构一样，但是一些子间距不一致。我想我切换的时候只有表格内容变化了。

> 这边也设置一个最大高度 而不是随着卡片的切换而变化

## Context

Monitors ▸ Facebook has two tabs, Fleet and Account pool, that share a page
head, tab bar, status legend and table + aside split. Switching between them
moved the legend and the chrome around it, and the "From a search to an
alert" card resized every time a different stage was picked.

## Acceptance criteria

- [x] Switching between Fleet and Account pool leaves the title, tabs and
      legend where they were; only the content below changes.
- [x] The Recent activity aside header has the same layout on both tabs.
- [x] Picking a stage on the flow card does not change the card's height; a
      long stage scrolls inside the detail panel.

## Out of scope

The Edit form on a flow stage still grows to fit, because textareas don't belong in a
scroll box. Below 1190px the detail panel stacks and keeps its natural
height.

## Notes

Fleet wrapped the head and tabs in a `<div>` inside `.fp-pool`. The tabs'
18px bottom margin collapsed out of that div and stacked on the column's 18px
gap, which put 36px above the legend where the Pool tab had 18px. The head's
22px margin also replaced the page's 18px gap, so the tabs sat 4px lower.
