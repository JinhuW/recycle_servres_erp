---
id: RS-139
title: Pre-release review fixes for v1.193–v1.194
type: bug
status: in-progress
priority: P2
created: 2026-10-02
reporter: jinhu
branch: fix/prerelease-review-rs139
pr:
version:
related: [RS-134, RS-138]
---

## Ask

> clean up all local or dev change and merge all required or target change to the main.
>
>
> make sure you code review them.

## Context

`dev` carried two releases prod had not seen: v1.193.0 (RS-134, the second
minor-finding batch) and v1.194.0 (RS-138, the sell-order full page). A
`/code-review high origin/main...origin/dev` before the release reported ten
findings. Each was checked against `origin/dev`, and against prod data where
that decides whether it can happen:

| # | Finding | Verdict |
|---|---|---|
| 2 | Correcting a box's tracking number (or carrier) in place left `tracking_status_at` — new in 0145 — at the wrong box's last event, so `applyPackageTracking` dropped every earlier-dated event for the real one. A poll for the old number landing after the fix re-stamped it too. | Confirmed, regression new in 1.193.0 |
| 3 | The keyed sync single-flight let a full sync run beside a narrower PayPal-only pull: two `syncOne` transactions on one source at once, which the old single promise prevented. | Plausible |
| 5 | Sell-order edit: a lot that left Reviewing/Done (or is fully held elsewhere) now reports `maxQty 0`; the qty input snapped to 1 and read "/ 0". Save already refuses such a line. | Confirmed, UX |
| 7 | The shared sellable search cap rose to 201 for the REST picker; the MCP tool passes `limit` straight through and advertises a maximum of 100. | Confirmed |
| 8 | `webSubmissions.ts` re-declared `publicForms.ts`'s channel list — a channel added to one would mint duplicate house suppliers. | Confirmed, latent |
| 9 | The notifications unread count was a second serial query on a polled endpoint. | Confirmed, nit |
| 10 | The new sell-order page shipped raw English strings (header chip and buttons, status card, customer label, history, footer). | Confirmed |
| 1 | `unlinkPaypalTxnFromOrder` never frees a link a *manager* made by typing the id. | Confirmed — but prod frees no typed link at all today, so not a regression |
| 4 | `/stats` reports `MIN(last_synced_at)`; an account a provider stops listing would freeze it. | Not reachable today — all four prod accounts sync together |
| 6 | Receiving a legacy Pending transfer restores lines as Reviewing. | Dismissed — prod's two transfers are both Received |

## Acceptance criteria

- [ ] A corrected tracking number or carrier clears `tracking_status_at`, so the real box's earlier-dated events apply; adopting a standalone box on a different carrier does too.
- [ ] `applyPackageTracking` ignores an update computed for a number the row no longer carries.
- [ ] A sync that can't join an in-flight run waits for any run sharing one of its sources before fetching.
- [ ] A sell-order line whose lot has nothing left to offer shows a disabled qty and "No longer available — remove the line" instead of "/ 0".
- [ ] `search_sellable_inventory` over MCP returns at most 100 rows whatever `limit` says.
- [ ] One web-channel list, exported from `publicForms.ts`.
- [ ] `GET /api/notifications` is one statement; an empty inbox reports `unreadCount: 0`.
- [ ] No raw English left in `DesktopSellOrders.tsx`'s JSX; both locales carry the keys.

## Out of scope

- #1 — telling a typed-id link from a manager's `/link` needs a link-source column
  and a migration; prod has the same behaviour today.
- #4 — not reachable with the current accounts; revisit if Mercury drops one.
- The `NULL_BODY_STATUSES` copy in `coordinator.ts`/`tracker.ts` — two three-line
  proxies; cosmetic.

## Notes

Plan: `~/.claude/plans/memoized-leaping-firefly.md`. The review found three raw
strings in the sell-order page and the plan reviewer four more. The zh pass on the
running page found the rest: an `<Icon/> Label` pattern that line greps miss
(Customer, Edit order, Reopen, New from inventory), the step tooltips, and the
status-change note. Status names are left verbatim, as on every other page. The
new tests were each run against the unfixed code and failed there first: the
sync-overlap case and the MCP cap (161 rows). Release checks done before the
merge: prod `JWT_SECRET` is 64 bytes and `PROXY_SECRET` is set (the new `env.ts`
boot guards), migrations 0144–0146 only add nullable columns.
