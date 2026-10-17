---
id: RS-266
title: Skeleton loading on the Fleet tab
type: story
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/fleet-skeleton-loading
pr: 679
version: 1.267.0
related: []
---

## Ask

> pls use the Skeleton Loading for all components. Apply it here first

(Sent with a screenshot of the Fleet tab's workers table and Recent activity aside.)

## Context

The Fleet tab (`pages/desktop/DesktopCoordinator.tsx` `FleetPage`) already paints its
frame at once, but until `/v1/fleet` lands through the tunnel proxy (often seconds) its
cards show nothing useful. `WorkersCard` (`FleetWorkers.tsx`) has an empty table body and
`…` in the summary and footer. `ActivityAside` is an empty list, `FleetLegend` reads `0` for every
status, and `FlowCard` (`FleetFlow.tsx`) shows `—` for every stage count. Zeros and dashes
look like real data. The shared `components/Skeleton.tsx` primitive and the `.skeleton`
shimmer in `styles/tokens.css` already exist.

## Acceptance criteria

- [x] Before the fleet doc arrives, the workers table shows skeleton rows shaped like real
      rows: chevron, two-line worker, status pill + note, day bar + label, ring + count,
      session, two-line posts, eye.
- [x] The Recent activity aside shows skeleton entries (dot + two lines) until the fleet doc arrives.
- [x] The legend counts, the toolbar summary and the "Fleet as of" footer show skeleton bars, not `0` / `…`.
- [x] The flow-stage counts show a skeleton bar while review stats load; `—` still means "not counted".
- [x] When the fleet is unavailable, the skeletons give way to the existing unavailable note.
- [x] The 30 s background refresh never brings the skeletons back.

## Out of scope

- The other ERP pages. "Here first": each page gets its own follow-up.
- The Pool tab and the worker page, which are still gated by `FormSkeleton`.
