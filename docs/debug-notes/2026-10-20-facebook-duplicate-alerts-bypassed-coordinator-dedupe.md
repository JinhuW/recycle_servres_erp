# Facebook alerts repeated because no worker used the coordinator's dedupe

**Fixed** in facebook-tracker 0.13.6 (RS-329). Each worker now claims a
listing from the coordinator (`POST /v1/alerts/claim`) before sending, and
only the first claim sends.

**Seen:** 2026-10-20. The fleet had grown from six regional workers to ten,
and the Telegram chat was showing the same listing several times.

## Symptom

From 10-12 to 10-20 there were 122 alerts for 72 listings. The rate jumped
from about 5 a day to 40 on 10-18, the day va-2, nyc-1, phl-1 and west-1
joined. One listing was alerted ten times.

## Why it was not obvious

The README, the coordinator's docstrings and the ERP's pipeline card all said
"the coordinator dedupes across workers by Facebook item id". It does, but
only on `POST /api/v1/listings`, the sharded workers' "coordinator" notify
channel. Every homelab worker notifies `[user.recycle]`, a Telegram user, and
so never reaches that code. Prod's `listings` table had **0 rows**.
`routers/alerts.py` even said why: direct sends were chosen when there was
one worker. Each worker's "already notified" record is its own diskcache
volume, so worker B never knew worker A had sent a listing.

A second, smaller cause hid among the first: `Listing.hash` includes `name`
(the item config). One worker that finds a listing under both `server_ram`
and `enterprise_ssd` sees the hash flip every sweep. `User.notification_status`
reads that as LISTING_CHANGED and alerts again.

## How to tell which kind of duplicate you have

`alert_messages.worker_id` is useless for this: `alert_report_worker_id` is
hardcoded to `homelab-monitor` in every config. Use OpenSearch, where every
`listing_alert` event names its real worker, item and search city:

```bash
ssh jinhu@10.10.10.73 'curl -s -H "Content-Type: application/json" \
  "127.0.0.1:9200/fb-tracker-*/_search" -d "{\"size\":1000,
  \"query\":{\"bool\":{\"must\":[{\"term\":{\"kind.keyword\":\"listing_alert\"}},
  {\"range\":{\"@timestamp\":{\"gte\":\"now-7d\"}}}]}},
  \"sort\":[{\"@timestamp\":\"asc\"}]}"'
```

Group the hits by `listing_id`:

- **Different `worker` values** → cross-worker overlap.
- **Same worker, alternating `item`** → the hash flip.
- **Same worker and item, a lower `price`** → a real price drop.

After 0.13.6, a refused claim shows up as `listing_skip` with reason
`fleet_duplicate` or `fleet_pending`, and its `claimed_by` field names the
holder. `listing_alert.fleet_claim` is `null` when an alert went out without a
claim (the coordinator didn't answer).

## Coordinator queries

The coordinator runs on Railway Postgres; reach it through the container:

```bash
ssh jinhu@10.10.10.73 'docker exec rs-coordinator python3 -c "
from rs_coordinator import deps
print(deps.db.get_alert_claim(\"facebook\", \"<listing id>\"))"'
```
