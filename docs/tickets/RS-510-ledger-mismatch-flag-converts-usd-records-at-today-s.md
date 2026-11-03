---
id: RS-510
title: Ledger mismatch flag converts USD records at today's rate, not the booked one
type: bug
status: backlog
priority: P2
created: 2026-11-02
reporter: jinhu
branch: JinhuW/walrus
pr:
version:
related: [RS-508]
---


## Ask

> /code-review all dev changes and merge to main, then release to prod.
>
> pls. create an fix plan , then start the implementation

## Context

Split out of RS-508. The accounting ledger (`GET /entries`,
`apps/backend/src/routes/accounting.ts`) flags a row as mismatched through
`recordMismatch(record, recordedCny, fx.rate)` with `fx = latestCnyPerUsd`.
A USD PO paid in full in RMB at 7.10 shows a red ! on all its rows once
today's rate drifts past the tolerance, and the entry form raises the same
false "Save anyway". The check should compare at the rates the entries were
booked at.

## Acceptance criteria

- [ ] A USD record settled in RMB at its booked rates shows no mismatch whatever today's rate is.
- [ ] A record that is short in USD terms at its booked rates still shows the flag.
- [ ] The entry form's "Save anyway" prompt uses the same rule.

## Out of scope

—
