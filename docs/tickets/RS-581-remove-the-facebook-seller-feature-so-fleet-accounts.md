---
id: RS-581
title: Remove the Facebook seller feature so fleet accounts only search
type: chore
status: done
priority: P2
created: 2026-11-12
reporter: jinhu
branch: session/20261112-114555
pr: 1191
version: 1.454.0
related: [RS-565, RS-571, RS-578]
---

## Ask

> [Image #1]
>
> I am not sure why it shows this. But i don't want to the seller feature impact any monitoringt facebook account here.
>
> pls create an plan clean them up.

> yes.
> 2. archive data
> 3. delete photos.

The image was the Fleet worker page's "Facebook seller" card: "A seller
account stops searching and posts our ads and answers sellers instead.
Changing this restarts nothing and causes no login." with a Searches / Sells
toggle.

The three answers are to: remove the whole seller feature (yes), archive the
seller data and drop its tables, and delete the seller photos in R2.

## Context

RS-565 (v1.437.0 to v1.445.2) made a seller a role on a fleet slot. The
role sat in the monitoring path:

- the Fleet worker page drew the seller card for every slot;
- `fleet_slots.role` was read on every claim and every next-task
  (`fleet/claim.ts`);
- release, lease expiry (`fleet/scheduler.ts`), the daily minutes budget
  (`fleet/sql.ts`, migration 0234) and the pool-owner fence (0233) all had
  seller branches;
- a 30-second seller loop and the agent loop ran on every backend.

Marketplace chats now go through the chat bridge (RS-578, `fb_chat_*`), which
uses no fleet account. No seller account was ever turned on.

## Acceptance criteria

- [x] Prod and dev are checked read-only before the change: no seller slot, no
      seller task and no seller photo on either. Prod's seller tables held only
      their three seed rows.
- [x] Prod's seller tables are archived to R2 at
      `recycle-db-backup/archive/fb-seller-archive-prod-20261112.sql.gz`,
      outside the backup job's pruned prefix.
- [x] No seller photo exists in R2 to delete (`fb_photos` is empty on prod and
      dev).
- [x] Migration 0239 drops the seller tables, `fleet_slots.role`, `agent_on`,
      `agent_profile_id`, `fleet_tasks.payload` and the seller check and index.
      It also restores the 0207 fence trigger, the 0218 `fleet_minutes` view, the five
      task states and `NOT NULL` on `city` and `item`.
- [x] Claim, next-task, release, lease expiry and the minutes budget are back
      to their pre-seller code; seller task kinds and `/worker/seller` are gone.
- [x] The seller card, Leads ▸ Facebook, `/api/fb-seller`, `/api/fb-agent`, the
      seller and agent loops, `FB_SELLER_TELEGRAM_BOT_TOKEN` and their tests
      are removed.
- [x] The chat hub keeps `alignWindow`, moved into `services/fbChat.ts` with
      its tests; `fb_chat_*` is untouched.
- [x] An ERP deploy restarts no worker, so the change causes no Facebook login.

## Out of scope

- The worker image. facebook-tracker 0.18.0 keeps `seller_tasks.py`, but a
  worker only runs it on a seller task, which the ERP no longer has. Removing
  it needs a tracker release and new containers, so it waits for the next
  tracker release that ships for another reason.
- Railway's `FB_SELLER_TELEGRAM_BOT_TOKEN` variable, if set: nothing reads it
  now; unset it by hand.

## Notes

- RS-565 and RS-571 (the seller operator plan built on RS-565) are closed as
  won't do.
- The archive holds schema and data for the 13 seller tables. Restore with
  `gunzip -c … | psql` into a scratch database, not into the ERP.
