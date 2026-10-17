---
id: RS-268
title: Link pool accounts to fleet workers
type: story
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/account-holder-worker
pr: 683
version: 1.269.0
related: []
---

## Ask

> The holder should link to the woker and the status should based on the woker instead of selecting manually.
>
> when i click the password it will show the password.

## Context

On the Account pool tab (`/fleet/pool`, `FacebookAccountPool.tsx`) a fleet
account's holder was free text ("Purchaser name, or a worker ID such as
denver-1") and its status a manual select, so nothing tied the row to the
worker actually using the login, and "Fleet" said nothing about whether that
worker was healthy. The table's password cells were a fixed mask; the only way
to read one was to open the editor.

Asked follow-ups: the worker is picked from a dropdown and the status follows
from it; a fleet row's Status column shows the worker's own health chip, the
same one as the Fleet tab.

## Acceptance criteria

- [x] The editor has a "Fleet worker" select listing the fleet's workers.
      Choosing one sets status to Fleet and the holder to the worker id, and
      the status select gives way to the worker's health chip. Choosing "None"
      brings the status select back (without Fleet) at Available.
- [x] A stored fleet holder that matches no current worker stays selectable as
      "not in the fleet", so saving doesn't silently drop it.
- [x] A fleet row's Holder is a link to the worker's page and its Status is the
      worker's Live / Stale / Attention / Offline chip. With the fleet document
      unavailable or the worker unknown, the row reads as before.
- [x] Clicking the masked Password or Email password in the table shows it
      (without opening the editor) and records a `revealed` audit event.

## Out of scope

- A new DB column: `holder_name` already carries the worker id for fleet rows.
- The pool API checking the worker exists — it doesn't talk to the coordinator.
- The purchaser view, which has no coordinator access.

