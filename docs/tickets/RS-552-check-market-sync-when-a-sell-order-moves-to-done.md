---
id: RS-552
title: Check Market sync when a sell order moves to Done
type: story
status: done
priority: P2
created: 2026-11-05
reporter: jinhu
branch: JinhuW/sablefish
pr:
version: 1.428.0
related: [RS-516, RS-517]
---

## Ask

> If manager move a sell order to done, It should confirm if the price has been synced.

(The request came with a screenshot of the Sync to Market button and its hint.)

Asked which behaviour they wanted, the owner chose, for Done on a synced part, to
keep the synced price, and for the check, to warn about unsynced parts while still
letting the manager continue.

## Context

Sync to Market (RS-516, `POST /api/sell-orders/:id/market-sync`) is a separate
action from moving an order along, so an order could reach Done with nothing
said about it. Done also wrote the full `sale:<order>` price over any synced
reading, which RS-516 chose at the time, so a reminder alone would have asked
about a price Done was about to replace.

## Acceptance criteria

- [x] `GET /api/sell-orders/:id` returns `marketSyncedParts`: the canonical part numbers holding a `bid:<order>` reading.
- [x] Moving an order into Done shows the check in the Done dialog. Reopening that dialog on an order already saved as Done doesn't.
- [x] With unsynced priced parts, the dialog names them, says they will get the full sale price, and offers Sync to Market.
- [x] With every priced part synced, the dialog shows one short "all synced" line. An order with no priced parts shows nothing.
- [x] The manager can always continue to Done. The check never blocks.
- [x] Syncing from the Done dialog updates the check in place and keeps the typed note and attachments.
- [x] With unsaved edits other than the status, the dialog's sync is disabled with the existing "save first" reason.
- [x] Done keeps a synced part's reading: `last_price` and `last_price_source: bid:<order>` are unchanged, and no `sale:<order>` event is written for it.
- [x] Done still records the full `sale:<order>` price for parts never synced.
- [x] Reopening a Done sale withdraws only `sale:` readings. Closing the order still withdraws its `bid:` readings.
- [x] A part the order stops pricing is still withdrawn at Done (RS-517).
- [x] Nothing on the Market side mentions the percent.

## Out of scope

- Spotting a sync that went stale because the price was edited afterwards. The
  percent isn't stored, so the old reading can't be compared.
- Blocking Done, changing past readings, and syncing after Done (still 409).

## Notes

Reverses RS-516's "reaching Done moves the Market price up to the full sale
price", for synced parts only.

Known limitation: a part synced and then repriced still counts as synced, and
Done keeps the older synced price. Syncing again before Done fixes it.

The dialog's sync lists only the unsynced parts, so it can't silently re-record
a part that was synced earlier at another percent.
