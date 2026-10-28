---
id: RS-444
title: Link imported fleet slots to ERP proxies so proxy use and the limit count them
type: bug
status: done
priority: P1
created: 2026-10-28
reporter: jinhu
branch: JinhuW/grayling
pr: 978
version: 1.376.1
related: []
---

## Ask

> why it shows noboday is using. but i can not add new account to the fleet due to the lack of proxt

> 2

## Context

On prod (2026-10-28) the fleet's Proxies tab read "Nobody" on 16 homelab
ports (`isp.decodo.com:10001`–`10020`), while Add to fleet found no free proxy.

- Add to fleet offers only `fleet_proxies`: four rows (10011, 10012, 10013,
  10018), each at `max_accounts_per_proxy` = 2.
- The 20 slots `scripts/fleet-seed-slots.mjs` wrote at cutover carry a sealed
  `proxy_url` but no `proxy_id`. `listProxies` (`src/fleet/proxies.ts`) and the
  limit in `POST /api/fleet/slots` (`src/fleet/workers.ts`) count `proxy_id`
  only, so these slots counted nowhere. A homelab row's "Used by" is
  rs_console's worker list, empty since those accounts moved to the ERP fleet.
- Unsealed, the real use: 10014 unused; 10008 only retired #4; 10015 only
  problem #52; 10011, 10013 and 10018 each a third slot (in problem) the limit
  did not see; every other port 1 or 2 running accounts.

The owner picked registering the homelab ports as ERP proxies and linking the
slots to them, so the tab and the limit read the same truth.

## Acceptance criteria

- [x] `scripts/fleet-link-proxies.mjs` links every slot with no `proxy_id` to
      the `fleet_proxies` row of its unsealed host:port, creating the row (the
      slot's sealed URL, its device's timezone) when none exists.
- [x] It registers each port of the last coordinator round on a host whose
      login it holds, which brings in the unused 10014.
- [x] `--dry-run` rolls back; a remote database needs `FLEET_LINK_REMOTE=true`;
      no URL or login is printed; a second run changes nothing.
- [x] Run on prod: no slot is left without a `proxy_id`, the Proxies tab names
      the accounts on the homelab ports, and Add to fleet offers 10014.

## Out of scope

- Changing `max_accounts_per_proxy`. 10011, 10013 and 10018 now read 3 of 2,
  which is the truth.
- Removing the dead slots of #4 (retired) and #52 (problem); the owner's call.
- How the tab merges coordinator rows into ERP rows.
- Any worker restart: a claim reads `fleet_slots.proxy_url`, which the link
  leaves alone.

## Notes

- Run on prod 2026-10-28: 20 slots linked, 16 proxies listed (ids 21–36; the
  dry run consumed 5–20 of the identity), 3 reused; a re-run changes nothing.
- The listed timezones are the slots' device zones, inherited from the
  coordinator: `UTC` on several New York ports, `America/Los_Angeles` on the
  Parsippany pair. Left alone, because editing a proxy's timezone rewrites the
  device of every account on it. 10014 (Palo Alto, no slots) was set to
  `America/Los_Angeles` by hand.
- After the link 10011, 10013 and 10018 read 3 of 2 (a problem account each),
  and 10010 and 10016 are full; 10014 is the one empty port, and 10008 (#4
  retired) and 10015 (#52 problem) have one place each.
