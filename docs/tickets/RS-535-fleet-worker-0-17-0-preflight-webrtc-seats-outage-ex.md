---
id: RS-535
title: Fleet worker 0.17.0: preflight, WebRTC, seats, outage exit
type: story
status: done
priority: P2
created: 2026-11-05
reporter: jinhu
branch: JinhuW/turban
pr: 1091
version: facebook-tracker unreleased (next minor, 0.17.0)
related: []
---

## Ask

> Deep review the all feature of these https://cloakbrowser.dev/ and see how we can integrate with my current automation system and see how it can integrate with my proxy service.
>
> Long term goal, It will auto simulate the browser profile for each account.
>
> Create an detailed launch plan for it.

## Context

This implements workstream E of `docs/superpowers/plans/2026-11-04-cloakbrowser-launch-plan.md`. The ERP has no way yet to tell a bad cloak profile from a bad account, so a worker has to prove its profile before it spends a login. A license outage used to park a worker for good. A killed browser held its seat, so the replacement exited 76 and parked.

Everything here applies to the cloak engine only. No stock path or stock fingerprint changes, and no cloak slot exists on prod today. Nothing is released: no tag, no image, no fleet release, and no worker was touched.

## Acceptance criteria

- [x] Stopping closes a cloak browser after its session is saved; stock doesn't change
- [x] The binary's exit 78, before or after `launch` returns, makes the worker exit 74; 76, 77 and 79 stay parked `license_denied`
- [x] `entry.py` doesn't turn 74 into 78, even with a parked file behind it
- [x] `--fingerprint-webrtc-ip` comes from the claim's `webrtc_ip`, and `--license-route=direct` is on every cloak launch
- [x] Absent or null `expected_exit_ip` / `webrtc_ip` skips that flag and check, and says so
- [x] A failed preflight parks `profile_preflight` with no Facebook request and no login
- [x] A refused session upload is reported in the log and in each heartbeat until one succeeds
- [x] A license setup or guard error parks `browser_failed` instead of crash-looping
- [x] `fingerprint-probe.py --compare` covers the new flags and the forced failures (not run against any real host)
- [x] `fake_fleet.py` serves the new claim fields and `entry.py` carries them to the launch args

## Out of scope

Windows fonts (waiting on the owner's decision), `geoip`, `humanize`, the agent's handling of 74 (workstream D), the ERP's claim fields (workstream B), and any release. The S1 to S5 spikes need a real key and a real host, so none has run.

## Notes

**VERSION stays 0.16.0.** `scripts/release.sh` is the only thing that bumps it, and it tags in the same run. A hand bump would make `check-release-tag.sh` look for a tag that doesn't exist, and `release.sh minor` would then compute 0.18.0. The change sits under `[Unreleased]` in the tracker's `CHANGELOG.md`, and the pin moved to `8128525`.

**How a replacement re-claims after exit 74** (`apps/backend/src/fleet/claim.ts`, read, not run):

- The replacement must be a new container: a claim ticket is single-use, and `docker start` would get 401, then exit 75.
- While the old lease is live, the claim answers `409 no_slot`, so the worker exits 75 before any browser opens. This costs no login and it can't take another account.
- The wait is up to `lease_minutes` (default 30) from the last heartbeat. The worker's `DEAD` heartbeat renews the lease, so expect close to the full 30 minutes, even when no Facebook page was opened. There is no release call. Retries backing off from 5 minutes will mostly see 75 until the lease lapses.
- After it lapses, the same worker id sorts its own slot first and gets the same account, with the session the ERP holds. That isn't guaranteed: any other idle worker that claims first can take the slot, and cloak-capable workers prefer cloak slots. Only a worker with no free slot of its own would do that.
- If the account has left the fleet, the worker takes the next free slot, which is a first login for that account.

**The boot login record.** The replacement's login is written as trigger `boot`, because `_restoring` is only set by the coordinator's restore directive, which a fleet worker never runs. That ledger row needs a coordinator, though, so a worker without one writes no row. The ERP's own record exists either way: a claim clears the worker's state, so its first heartbeat (`DEGRADED`, reason `booting`) lands in `fleet_worker_state_events`. The outage heartbeat's `facebook_opened` tells a free retry from one that costs a login, but `fleet_worker_state_events` keeps only the reason; `facebook_opened` survives only in `fleet_workers.detail` until the next claim clears it.

**Checks that need a spike.**

- WebRTC requires `webrtc_ip` among the candidates and no other address. If the binary offers only an mDNS name when STUN is blocked, this parks every cloak worker. S1 must confirm it first. A false park costs no login.
- The preflight's JavaScript ran once in stock local Chromium against a loopback echo, with no proxy. It has never run in the CloakBrowser binary.
- Exit-74 detection after `launch` relies on the binary writing its denial file on an outage. That comes from the wrapper's code, and S5 must confirm it.

**Session upload reporting is cloak-only, per the brief.** A stock worker's 413 is still silent.
