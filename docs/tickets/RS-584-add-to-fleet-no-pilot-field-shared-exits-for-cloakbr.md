---
id: RS-584
title: Add to fleet: no pilot field, shared exits for CloakBrowser, limit per exit IP
type: story
status: done
priority: P2
created: 2026-11-12
reporter: jinhu
branch: session/20261112-234354
pr: 1196
version: 1.457.0
related: []
---

## Ask

> debug the issue that.
> It shows this proxy only be used by 1/2 account. But it shows it occupied once i assign it to a new account.

> Can i simplify that poilt? i meant remove it cuz i hope all my browser use the Cloakbrowser.
>
> Anywork proxy should work

Both came with a screenshot of Add to fleet for #164: first with "Decodo :10015
(Palo Alto), 1 of 2 accounts" picked and the toast "isp.decodo.com:10015 exits
from 23.230.217.40, already used by #163", then with the random proxy option and
"isp.decodo.com:10014 exits from 188.221.13.235, already used by #141".

## Context

Two rules disagreed. The dropdown and `proxy_full` counted non-parked slots per
port against `max_accounts_per_proxy` (2). A CloakBrowser add, the dialog's
default since v1.431.0 (RS-555), also went through `measuredExit` in
`apps/backend/src/fleet/workers.ts`, which refused any exit IP another slot,
enrollment or homelab worker used, across ports (`exit_shared`). So a proxy
shown with room was refused, and the random draw, which only skipped ports
carrying a slot, could land on an empty port that shared an IP.

The owner wants every account on CloakBrowser with no pilot step. Asked how the
limit should count, the owner chose per exit IP; asked about the Browser
choice, to keep it; asked how far to remove pilots, the dialog and the rules
only.

## Acceptance criteria

- [x] Add to fleet has no Pilot field and no arm picker; Proxy and Browser remain.
- [x] A CloakBrowser account can be added to, or moved onto, a proxy whose exit
      IP another account uses, while that IP is under the limit.
- [x] `max_accounts_per_proxy` counts non-parked ERP accounts plus homelab
      workers on the proxy's last known exit IP, over every port that exits
      there. A proxy with no known exit is counted per port, as before.
- [x] The Add to fleet and Change proxy dropdowns show that same count
      (`exit_load` on `GET /api/fleet/proxies`).
- [x] The random draw picks any open proxy, for either browser.
- [x] A never-logged-in pilot account is no longer held because another slot
      shares its exit (still held when its exit IP or zone moved).

## Out of scope

- Removing `fleet_pilot_enrollments`, the Cohort report's pilot view, or the
  `pilot`/`arm` fields of `POST /api/fleet/slots`. The API keeps accepting them.
- The freshness rule: a CloakBrowser add still needs a good measurement under
  15 minutes old, since the profile's clock comes from it.
- The limit's value, and the Proxies tab's crowding thresholds.

## Notes

- Two CloakBrowser accounts on one IP is what the removed rule prevented. The
  limit is the only guard now; the owner was told.
- The error code `exit_shared` is gone. Nothing outside the ERP read it.
- Add and Change proxy both hold the engine advisory lock, so two adds on
  different ports of one IP can't both take the last place.
