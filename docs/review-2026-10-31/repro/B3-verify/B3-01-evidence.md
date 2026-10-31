# B3-01 verification evidence (2026-10-31, read-only)

Sources: `docker exec rs-coordinator rsc vault logins --limit 300` and
`docker logs --since 24h rs-fleet-agent` on 10.10.10.73. Aggregated in the
terminal; device/datr ids never printed.

## Login ledger, 2026-10-30T20:15Z .. 2026-10-31T18:38Z
- 31 logins: 30 boot + 1 relogin.
- Boot outcomes: 9 restored, 11 locked, 9 challenge, 1 failed (21 walls).
- 29 distinct devices across the 31 logins. Only 2 devices logged in twice:
  restored -> failed 4 min later, and challenge -> challenge 2 h later.
  No device that ended `locked` logged in again inside the window.
  Over the 7-day ledger, 5 cases of a wall followed by a later login on the
  same device.
- By slot: homelab-5 6 logins on 5 devices; homelab-8 3 logins on 3 devices;
  worker-60-14-8 4 logins on 4 devices.

## Fleet agent, same 24 h (homelab host)
- desired.count changed 13 times: 8->10->9->10->6->8->9->6->4->6->8->7->8->9.
  hosts.ts:239 `workerCount` derives it from free/held fleet slots; no person
  set it.
- Actions: 72 `replace` for exit 75 (homelab-8 x56, homelab-5 x6, homelab-6 x3,
  homelab-7 x2), 10 `run` missing, 9 `remove` beyond count.
- homelab-8: 56 exit-75 replaces, only 3 ledger logins. A fenced or slotless
  restart exits 75 without a login. The "restarted a minute later against the
  same wall" mechanism does not drive the login count.
- The login clusters line up with count rises (02:54, 08:24, 15:00, 17:02,
  18:23) and with one count drop (10:25 10->6; logins at 10:27-10:30).
