---
id: RS-538
title: Fleet: track each proxy's measured exit
type: story
status: done
priority: P2
created: 2026-11-05
reporter: jinhu
branch: JinhuW/jawfish
pr: 1093
version: 1.422.0
related: []
---

## Ask

> Deep review the all feature of these https://cloakbrowser.dev/ and see how we can integrate with my current automation system and see how it can integrate with my proxy service.
>
> Long term goal, It will auto simulate the browser profile for each account.
>
> Create an detailed launch plan for it.

## Context

This implements workstream A (exit identity) of the CloakBrowser launch plan,
`docs/superpowers/plans/2026-11-04-cloakbrowser-launch-plan.md`.

A port is not an identity. On 2026-11-04 between 10:47 and 10:51 UTC, 14 of 20
ports changed exit IP, 7 of them under live slots, and proxy 24 changed geo with
its IP unchanged. The ERP probed every port every five minutes
(`fleet/proxyProbe.ts`, `fleet_proxy_checks`, since 0215) but dropped the exit's
zone and kept no record of a move past the 14 days of checks. The Proxies tab
only said "was <ip>" for the last 24 hours. Plan rules 2, 3 and 5 need the
measured exit, and the cohort report (workstream C) needs to know which accounts
a move touched.

## Acceptance criteria

- [x] `fleet_proxy_checks.timezone` holds the zone from the lookup, nullable.
- [x] An IP change, or a geo change on the same IP, adds a row to
  `fleet_proxy_exit_changes` with old and new IP and geo, the time, and the
  slots and homelab workers on the port then.
- [x] A failed probe is not a change, and recovering on the same exit isn't one.
- [x] A change under a bound slot or homelab worker alerts managers through
  `notifyManagers`. A remap sends one alert, however many ports it covers.
- [x] The Proxies tab flags a zone mismatch, a stale or failing measurement and
  a recent exit change. Report only.
- [x] `latestProxyExit(tx, proxyId)` is exported for enrollment.
- [x] No device, slot or timezone is rewritten.

## Out of scope

- Blocking first logins on a changed exit (plan rule 5) and refusing a stale
  measurement at assignment (rule 4). Those belong to enrollment, workstream B,
  which can read `latestProxyExit`.
- Homelab zones. rs_console's `/v1/proxies/health` doesn't send the lookup's
  zone, so coordinator rows keep `timezone` NULL. Adding it means a console
  deploy, and homelab ports have no ERP slot to mismatch.
- A page listing the change history. The table is there for the cohort report.
- Backfill. The first round after the migration compares against the checks
  already stored, so tracking starts at once.

## Notes

- **Zone field confirmed:** a direct call to `https://ipinfo.io/8.8.8.8/json` on
  2026-11-05 answered with `"timezone": "America/Los_Angeles"`. It was not tried
  through a Decodo port, because no proxy login was available, so the column
  stays nullable and a missing zone is never read as a change.
- **Alert channel:** the fleet had none, so this uses the ERP's manager
  notifications.
- **Grouping:** one alert per detection, then at most one every 30 minutes.
  Moves in between wait and arrive together, so a remap spread over two rounds
  or a flapping port can't send one per round. Ports nobody uses are recorded
  and counted in the alert's title but never alert alone.
- **Zones compare by name,** so America/Detroit against America/New_York flags.
  The hover names both for a manager to judge.
- **Slots seeded without a `proxy_id`** aren't seen as bound; `fleet-link-proxies.mjs`
  is what links them.
