---
id: RS-467
title: Fleet alert stopgaps: string unit counts, price drops, logged literals, follower re-emits
type: bug
status: done
priority: P2
created: 2026-10-30
reporter: jinhu
branch: JinhuW/bluegill
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1009
version: n/a — trackers/facebook scripts only, no ERP release
related: [RS-453, RS-455, RS-466]
---

## Ask

> Fix these as well:

> - [P1] Normalize unit counts before comparing routing thresholds — /Users/jinhu/orca/workspaces/recycle_servres_erp/bluegill/trackers/facebook/scripts/fleet-alert-sender.py:104-106
>   When a model returns "unit_count": "12", the monitor accepts and normalizes it, but the bridge stores the string unchanged. Calling priority('12') raises TypeError, aborting the entire oldest-first sender pass. Every subsequent pass encounters the same unprocessed alert, blocking newer leads too. Normalize counts consistently with the monitor before comparing thresholds.
> - [P2] Recover extra workers after failed release replacements — /Users/jinhu/orca/workspaces/recycle_servres_erp/bluegill/apps/fleet-agent/src/plan.ts:333-335
>   When a release replaces a running worker above desired.count, a failed ticket request or Docker run after removal leaves that worker permanently missing. Subsequent planning only visits IDs within the count, while settlePending changes its pending replacement to restart: false. A FakeDocker reproduction removes lab-3 with count 1 and never recreates it on later ticks. Preserve and recover pending replacements above the count without restarting unrelated extras.
> - [P2] Persist successful Telegram sends before acknowledging delivery — /Users/jinhu/orca/workspaces/recycle_servres_erp/bluegill/trackers/facebook/scripts/fleet-alert-sender.py:184-186
>   If Telegram succeeds but /claim/delivered fails before recording delivery, execution exits before saving the successful send. The coordinator still grants the same worker its undelivered claim, so the next pass sends another Telegram message. Two mocked passes reproduced two messages for one listing with no state file. Persist the successful send before coordinator calls and retry reconciliation separately.
> - [P2] Retry pending alert claims instead of saving them as final — /Users/jinhu/orca/workspaces/recycle_servres_erp/bluegill/trackers/facebook/scripts/fleet-alert-sender.py:179-182
>   When another worker holds an unfinished claim, the coordinator returns send: false with verdict pending. Saving that response permanently makes every later pass skip the listing, even after the holder dies and its 15-minute lease expires. The sender therefore cannot recover the abandoned alert. Only terminal duplicate responses should be marked processed; pending claims need another attempt.
> - [P2] Recheck processed listings when their price drops — /Users/jinhu/orca/workspaces/recycle_servres_erp/bluegill/trackers/facebook/scripts/fleet-alert-sender.py:165-167
>   After a listing is sent or recorded as duplicate, this listing-ID-only check suppresses every subsequent event, including a lower asking price. That bypasses the coordinator's explicit discounted claim behavior, so workers with alerts disabled lose price-drop notifications through this replacement sender. Track the processed price or event and allow later discounts to reach the claim endpoint.
> - [P2] Decode the response's Python string literal before parsing JSON — /Users/jinhu/orca/workspaces/recycle_servres_erp/bluegill/trackers/facebook/scripts/ai-verdict-bridge.py:157-162
>   The monitor logs responses using pretty_repr, so the captured content contains Python string escapes rather than raw JSON. For example, a summary containing Seller's RAM is logged with an escaped apostrophe; passing that directly to json.loads fails and silently discards a valid unit count. A reproduced 50-unit verdict consequently routes to General instead of High. Decode the Python string literal before parsing the model's JSON.
> - [P2] Search beyond the first 5,000 withheld sightings — /Users/jinhu/orca/workspaces/recycle_servres_erp/bluegill/trackers/facebook/scripts/fleet-alert-sender.py:86-88
>   When the selected window contains more than 5,000 withheld sightings, the oldest-first limit excludes newer listings before deduplication occurs. Already-processed sightings remain in those first 5,000 results on every pass, so unseen leads cannot be sent until older records age out. Paginate the results or group by listing before applying the result limit.
> - [P2] Emit only newly completed verdicts from the follower — /Users/jinhu/orca/workspaces/recycle_servres_erp/bluegill/trackers/facebook/scripts/fleet-log-follow.py:62-67
>   As the 600-line buffer advances, an already-shipped verdict can remain after its response block has scrolled out. Reparsing then classifies that same conclusion as cached and generates a different document ID, which bypasses shipped and indexes a second verdict. This was reproduced by parsing a full response and then its remaining conclusion. Track source-event progress rather than emitting every historical verdict reconstructed from the buffer.
> - [P2] Keep document placement stable across UTC midnight — /Users/jinhu/orca/workspaces/recycle_servres_erp/bluegill/trackers/facebook/scripts/ai-verdict-bridge.py:235-236
>   Around midnight, the follower can timestamp a withheld line using its current-time fallback while the cron bridge timestamps the identical line using a fresh verdict from the previous day. Their document IDs match, but these lines place them in different daily indices, where IDs are independently unique. The event is therefore counted twice despite the claimed idempotency. Use stable placement for an existing event across both ingestion paths.

## Context

A second review of the same release range. Five of its nine findings had
already shipped in RS-466 (v1.387.1): agent extras after a failed
replacement, persist-before-ack, pending claims, the 5,000 cap, and midnight
placement. This ticket covers the other four.

## Acceptance criteria

- [x] The sender routes a count indexed as `"12"`, `0` or a word as the
  monitor would, and no such count aborts a pass.
- [x] The bridge decodes the logged Python literal (escaped quotes, a
  trailing `\n`, prose around the JSON) and coerces the count as the monitor
  does. On the homelab logs it recovers 12 counts of 655 that it used to drop.
- [x] A listing withheld again after it was sent or recorded as a duplicate
  goes back to the coordinator's claim, so a price drop comes back as
  `discounted` and is sent.
- [x] The follower emits only the verdicts whose line it has just read, never
  an older one rebuilt as cached from its buffer.
- [x] `scripts/tests/test_ai_verdict_bridge.py` and
  `test_fleet_alert_sender.py` cover each of these.

## Out of scope

The fleet-agent and the five findings already fixed in RS-466.
