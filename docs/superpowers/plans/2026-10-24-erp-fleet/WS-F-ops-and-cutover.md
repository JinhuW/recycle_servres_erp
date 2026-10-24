# WS-F · Ops: images, Railway env, host prep, integration, cutover

**Depends on:** CI and host prep now; integration after A+B+C; cutover after
D+E. **Owns:** `.github/workflows/fleet-images.yml`, Railway env for
`backend` (dev then prod), `HOSTS.md`, the cutover runbook below, the
follow-up ticket that retires the coordinator's queue.

Every step on a live host or on prod needs the owner's explicit yes, one step
at a time. Each worker container start is a Facebook login (root `AGENTS.md`,
first rule).

## Now (parallel with A–E)

1. **GHCR workflow** `fleet-images.yml`: on a `facebook-tracker/v*` tag build
   and push `ghcr.io/jinhuw/aimm-recycle:<ver>` from
   `trackers/facebook/deploy/Dockerfile.worker` (the vendored monitor is
   gitignored: the workflow clones `recycle-patches` from a private mirror
   the owner creates, pinned to `VENDOR.md`; until that mirror exists, build
   the image on the Mac and push by hand); on a root `v*` tag build
   `ghcr.io/jinhuw/fleet-agent:<ver>` from `apps/fleet-agent/Dockerfile`.
   Make both packages private; add a read token to the hosts' docker login.
2. **Railway env (dev first):** `FLEET_WORKER_TOKEN_KEY`, `FLEET_IMAGE_WORKER`,
   `FLEET_IMAGE_AGENT`, `FLEET_COORDINATOR_URL` on the `backend` service.
   Prod gets the same at cutover.
3. **Host prep `worker-60-14`** per `HOSTS.md` checklist, read-only until the
   owner says go. The host is not reachable from the Mac mini; run from the
   owner's machine.
4. **Export files for WS-B's slot seed** (one-time, by hand on the VM, never
   committed): home cities per account from `rs_console` `/v1/fleet`, device
   profiles from the coordinator's `device_profiles` (`rsc` + vault key), the
   proxy login from `configs/secrets.env`. Hand them to the WS-B seed script
   on dev with throwaway values first.

## Integration (after A, B, C merge to dev)

- [ ] `pnpm dev` ERP on the Mac with the fleet migration; `fleet-import.mjs`
      against `master.toml`; `fleet-seed-slots.mjs` with one **throwaway**
      pool account (never a live fleet account).
- [ ] Register host `mac-dev`; run WS-D's agent locally (or `docker run` the
      worker by hand with the three env vars); capacity 1.
- [ ] The worker claims, logs in once (ledger: one `boot`), receives a manual
      task within 2 s, searches it, the listing reaches the coordinator
      (`rsc` on the VM shows the sighting), `done` closes the task and the
      scheduler writes tomorrow's.
- [ ] Add a city in the ERP → `verify-slug` task → the worker reports the
      label → city enabled; remove → cancelled.
- [ ] Claim the same account from a second container → the first gets 409 on
      its next call and exits 75; the agent restarts it after 60 s and it
      claims again (second login — expected, note it).
- [ ] Record timings and any surprise in this file.

## Cutover runbook (prod)

0. Owner's yes to start. dev → main release carrying A–E (ERP) and the
   tracker release with the new worker image. Prod env vars set. Imports and
   slot seed run against prod (`memory: fb-pool-prod-import` for creds).
1. Register `worker-60-14` and `homelab` as hosts in prod; start both agents
   `authoritative=false`; confirm reports.
2. **Pilot (4 logins).** In the coordinator: `rsc queue unenroll homelab-1
   nyc-1 phl-1 va-2`. Stop those four compose containers on the VM (`docker
   stop`, not deploy.sh; everything else held). Set `worker-60-14`
   `authoritative=true, capacity=4`. The agent starts 4 workers 3 min apart;
   each claims one of the four accounts (set the other slots' `note`/park so
   only these four are claimable). The old fleet still searches the same
   cities: double coverage for the pilot days, accepted.
3. Watch two days: Queue tab (tasks/day ≈ 2 × cities the four cover),
   Slots minutes vs 360, `rsc vault logins` (only the 4 boots), walls,
   Telegram alerts still arriving. Stop criteria: any checkpoint on a pilot
   account → pause and report.
4. **Everyone (≤ 11 more logins).** Owner's yes. Stop the remaining old
   healthy compose workers a few minutes apart; raise capacity (split between
   `worker-60-14` and `homelab` as the owner decides). Parked accounts stay
   parked until a human re-logs them from the ERP.
5. Coordinator stays for alerts. File the follow-up ticket: retire
   `city_queue`, roster push, `rs_console` fleet routes, the per-worker
   compose files and the ERP's old Fleet tab; update README/FEATURES.
6. `HOSTS.md` and the README status table updated; RS-394 closed with PR and
   versions.

## Exit

- [ ] Every healthy account runs under the ERP fleet; `docker ps` on the VM
      shows only the coordinator, console, agent and fleet workers; no
      per-worker compose, config, secret or session file remains.
