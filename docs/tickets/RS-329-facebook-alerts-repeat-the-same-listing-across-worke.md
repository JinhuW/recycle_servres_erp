---
id: RS-329
title: Facebook alerts repeat the same listing across workers
type: bug
status: in-progress
priority: P1
created: 2026-10-20
reporter: jinhu
branch: fix/facebook-fleet-alert-claim
pr:
version:
related: []
---

## Ask

> The current facebook filter include lots of duplicated alerts.
> Ultrathink the root casue and fix it. You can check the alerts to see what i am talking about.

## Context

Measured on 2026-10-20 from production. The coordinator's `alert_messages`
table records every delivered alert; OpenSearch's `listing_alert` events say
which worker sent each one. From 10-12 to 10-20 there were 122 Telegram alerts
for 72 listings, so 50 were repeats. The rate went from about 5 a day to 40 a
day on 10-18, when va-2, nyc-1, phl-1 and west-1 joined the fleet.

| Cause | Repeats | Example |
| --- | ---: | --- |
| Two workers sent the same listing | 38 | 2171928597075513: va-2 (dc), homelab-1 (dc) 79 s later, ne-1, nyc-1 |
| One worker repeated itself when the search changed | 7 | 2635206676952894: homelab-1 sent it 8 times as server_ram and enterprise_ssd took turns |
| Real price drop | 4 | 3762566503900687: $25 → $20 |
| Same worker, same price, two days apart | 1 | 1027347030377300, sc-1 |

**Why.** Every homelab worker sends its alerts straight to Telegram
(`[user.recycle]` in `configs/master.toml`). Its only record of what it has
already sent is the diskcache in its own Docker volume, keyed by
`User.notified_key` (listing id, user). The coordinator does have a fleet-wide
dedupe (`routers/listings.py` → `dedupe.py`), but it lives on the "coordinator"
notify channel, which no homelab worker uses: prod's `listings` table had
0 rows. `routers/alerts.py` records the original reasoning: "routing them
through the coordinator's outbox buys nothing for a single worker". The fleet
is now ten direct-send workers. Some cities are searched twice:

- dc by homelab-1 and va-2
- nyc by ne-1 and nyc-1
- philly by ne-1 and phl-1
- wc-1 and west-1 have the same list

Neighbouring cities return the same listings anyway.

The second defect is in the worker. `Listing.hash` in the vendored monitor
includes `name`, the item config. A listing that both `server_ram` and
`enterprise_ssd` find therefore changes hash each time the other search sees it.
`User.notification_status` reads that as LISTING_CHANGED and alerts again.

## Acceptance criteria

- [ ] Two workers seeing the same listing produce one Telegram alert. The
      second worker logs `fleet_duplicate` and caches the listing as notified.
- [ ] A listing found by two searches on one worker alerts once.
- [ ] A price drop below the last alerted price alerts once fleet-wide. An edit
      at the same or a higher price does not alert.
- [ ] A claimer whose send fails retries on its next sweep. If it dies, another
      worker takes over after 15 minutes.
- [ ] If the coordinator is unreachable, or too old to know the claim, the
      worker sends as before.
- [ ] A listing alerted before the deploy is not alerted again by a different
      worker after it (the claim table is seeded from `alert_messages`).

## Out of scope

- De-overlapping the city lists (dc, nyc and philly searched twice, wc-1 the
  same as west-1). That is an operator decision on the ERP's worker page. The
  claim makes the overlap harmless for alerts.
- `alert_report_worker_id = "homelab-monitor"`, hardcoded in every worker's
  config. Every row in `alert_messages` (and so in the ERP's alert-hit stats)
  names the same worker. That is a follow-up.
- Changing `Listing.hash` to drop `name`. The AI and prescreen caches key on
  that hash, so changing it would re-bill every listing still visible.

## Notes

- Only a new listing or a price drop alerts now. An edited listing used to
  re-alert on the worker that had sent it (LISTING_CHANGED). The claim refuses
  that case, because the same hash change is what the item-name flip produced.
- The claim fails open: no answer means send, as before. A missed lead costs
  more than an occasional duplicate during a coordinator outage.
