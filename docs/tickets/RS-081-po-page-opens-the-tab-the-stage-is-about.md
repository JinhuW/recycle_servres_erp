---
id: RS-081
title: PO page opens the tab the stage is about
type: task
status: done
priority: P2
created: 2026-09-20
reporter: jinhu
branch: feat/rs-081-stage-tab
pr: 374
version: 1.161.1
related: [RS-080]
---

## Ask

> 1. when the status is in "ready to pay", it should also switch to Commission.
> [screenshot: a staged Ready to Pay with the Commission tab circled]
> 2. Same as "in transit"
> It should switch to delivery.
>
> But it is not hard set, user still can switch to other tab.

> this tab should not scrollable.
> [screenshot: the tab strip with a scrollbar track beneath it]

## Context

RS-080 (v1.160.0) put the desktop PO page's editable facts under five tabs
and kept the open tab in the route query, defaulting to Delivery. The stage a
person is looking at usually says which tab they need — the box while In
Transit, the commission once the review closes — but the page made them click
for it. Separately, `.oe-tabs` was an `overflow-x: auto` box and the tabs'
`-1px` underline overlap made it overflow by a pixel, so a scrollbar track
appeared under the strip on macOS with scrollbars always shown.

## Acceptance criteria

- [x] Staging or landing on In Transit opens the Delivery tab; Ready to Pay
      opens Commission. Draft, Reviewing and Done leave the tab alone.
- [x] A tab the user picks afterwards stays until the stage changes again; a
      `?tab=` deep link wins on load.
- [x] The tab strip never shows a scrollbar; it wraps when it must.

## Out of scope

- The phone (folded cards, not tabs) — a fold could open by stage the same
  way; not asked.

## Notes

- `STAGE_TAB` in `pages/desktop/DesktopEditOrder.tsx`; the suggestion runs
  in the same effect that closes the look-back on a stage change, skipping
  the first render so the deep link is honoured.
