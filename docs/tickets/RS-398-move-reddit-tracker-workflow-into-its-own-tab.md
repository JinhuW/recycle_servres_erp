---
id: RS-398
title: Move Reddit tracker workflow into its own tab
type: story
status: done
priority: P2
created: 2026-10-25
reporter: jinhu
branch: feat/reddit-workflow-tab
pr: "#899"
version: 1.346.0
related: []
---

## Ask

> move this reddit tracker workflow to a new tab in teh reddit tracker page

## Context

The screenshot identifies the “From a post to an alert” card in
`apps/frontend/src/pages/desktop/DesktopTracker.tsx`. Since v1.316.0, the
Reddit page has Fleet and Prompts tabs; the workflow sits below the workers
and recent matches on Fleet. Give the workflow its own destination.

## Acceptance criteria

- [x] Fleet, Workflow and Prompts appear as separate tabs, with matching titles.
- [x] The workflow card appears only under Workflow at `/tracker/workflow`.
- [x] Poll, Evaluate and Notify retain their counts, settings and editing controls.
- [x] Direct navigation and browser history recognize the Workflow route.

## Out of scope

Tracker services, API contracts and workflow behavior changes.

## Notes

The requester approved the plan and ticket draft in chat before implementation.

Validation: frontend production build (including TypeScript), 36 route/tracker/
translation tests, and server-rendered checks of all three tabs' titles,
selected links and exclusive content passed. The existing workflow component
and callbacks are reused. Browser visual verification was unavailable because
the Browser plugin runtime could not import `node:process`.

Delivered to dev through PR #899 as v1.346.0.
