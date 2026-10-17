---
id: RS-266
title: Fleet page: load the frame first, then each card's data
type: story
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/fleet-lazy-frame
pr:
version: 1.267.0
related: []
---


## Ask

> for this page. pls load the frame frist and the inside data later. use a lazy loading
>
> [Image #1]
>
> Keep in mind for all of this system, you cna use lazy loading.

(Image #1: a screenshot of Monitors ▸ Facebook ▸ Fleet with the legend, the workers table, Recent activity and the "From a search to an alert" funnel.)

## Context

`/fleet` (`apps/frontend/src/pages/desktop/DesktopCoordinator.tsx` → `FleetPage`)
fires five fetches through the `/api/coordinator` proxy: fleet, open challenges,
alert hits, review stats and filter prompt. The fleet document comes over the
rs-console tunnel and can take seconds. The head and card shells already drew
first, but until the data arrived the legend showed real-looking `0`s. The
workers table had an empty body with `…` in its summary and footer, Recent
activity was blank, and the funnel tiles read `—` "not counted", which looks
the same as having no data. The page looked broken or empty while it was
still loading.

## Acceptance criteria

- [x] On a cold load, the head, tabs, legend, workers card, activity aside and funnel card all appear before any coordinator call resolves.
- [x] Until the fleet document arrives, the legend counts show skeleton pills instead of `0`.
- [x] Until the fleet document arrives, the workers table shows 8 skeleton rows in the real columns, and its summary and footer show skeletons instead of `…`.
- [x] Until the fleet document arrives, Recent activity shows skeleton entries.
- [x] While review stats are in flight, each funnel tile's number and unit are skeletons. `—` / "not counted" appear only after stats resolve or fail.
- [x] While the prompt is in flight, the AI-rating detail shows a skeleton instead of "prompt unavailable".
- [x] Each card fills on its own when its own fetch resolves. A failed fetch still ends in that card's existing unavailable or empty state, never an endless skeleton.
- [x] The 30-second refresh does not bring the skeletons back, because data that is already loaded stays on screen.

## Out of scope

- The Account pool tab. It already keeps the head and tabs and skeletons only its body.
- Other ERP pages. "All of this system" is the standing rule: each page follows it when it is next touched.
- Backend and proxy latency.
