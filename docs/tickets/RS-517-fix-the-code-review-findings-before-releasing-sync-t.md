---
id: RS-517
title: Fix the code review findings before releasing Sync to Market and Add to fleet
type: bug
status: done
priority: P2
created: 2026-11-03
reporter: jinhu
branch: JinhuW/drum-dev-review
pr: 1073
version: 1.414.1
related: []
---

## Ask

> /code-review all dev change, then merge to the main, release the change once fix all identified issues.

## Context

The review of `origin/main...origin/dev` at `9fa1b3e8` (RS-514, RS-515, RS-516)
returned ten candidates, nine in Sync to Market and Add to fleet and one in the
ticket index. Each was checked against the code before fixing.

## Acceptance criteria

- [x] `POST /sell-orders/:id/market-sync` takes `linesVersion` and answers 409 `lines_changed`, writing nothing, when the lines moved after the dialog read them.
- [x] A lot priced at 0 is left out of the qty-weighted Market price, in the backend and the dialog.
- [x] A part the order stops pricing has its `bid:` reading withdrawn on the next line save, sync or Done.
- [x] A sync whose price rounds to 0 still takes back the part's earlier reading.
- [x] A new URL on a proxy starts unchecked; checks of the old exit no longer judge it, in the guard or the Proxies tab.
- [x] Add to fleet's guard and dialog read one definition of proxy state, which ignores checks older than the Proxies tab's 24 hours.
- [x] A `proxy_down` refusal marks that proxy down in the open dialog, so a retry can't draw it again.
- [x] Add to fleet reads `GET /proxies/health/states`, not the full health view.
- [x] Sync to Market's dialog can't be dismissed while its request is in flight.
- [x] The dialog's Market price column shows the USD the Market page will show.
- [x] `docs/tickets/INDEX.md` shows RS-516 as shipped.

## Out of scope

- Probing a proxy the moment its URL changes. It is unchecked until the next
  round, at most five minutes, exactly like a proxy just added (RS-514 allows
  never-checked).
- A round already in flight when the URL changes can still attach one check of
  the old exit. The next round overrides it.
- Listing withdrawn readings in the order's history on a save or Done. Only
  Closed names them today.
- RS-515's look on a real iPhone, which still needs a person on inventory-dev.

## Notes

- Withdrawing on a line save is the one place a save touches the Market page.
  RS-516's rule is that a save never *publishes* a price; taking back a quote
  for a part no longer priced isn't publishing, and without it the manager has
  no way to withdraw it, since the dialog no longer lists the part.
- Verified with the full backend and frontend suites, and locally in the real
  dialog on a CNY order with a $0 lot: qty 10, ¥720, $97.12, Cancel disabled
  while the request is held, `$97.12` recorded with a null note. Add to fleet
  was covered by tests and the API, not clicked through.
