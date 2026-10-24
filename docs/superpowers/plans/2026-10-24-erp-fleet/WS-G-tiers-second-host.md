# WS-G · Tiers and the second host (after cutover)

**Depends on:** WS-F cutover done and a stable week. **Owns:**
`apps/backend/src/fleet/tiers.ts`, tier UI in the Cities tab, `HOSTS.md`.

## Tasks

1. **Tiers.** Port `trackers/facebook/rs_coordinator/rs_coordinator/city_tiers.py`
   `rank()` to `tiers.ts`: score each city by alert hits over a window (the
   coordinator's `/v1/stats/alert-hits` stays the source until alerts move;
   fetch it server-side with the coordinator token), top 20% → 3/day, next
   20% → 2/day, rest 1/day; `fleet_cities.pinned` fixes a city's tier. The
   scheduler uses the tier when `fleet_cities.per_day` is null and
   `fleet_settings.tiers.enabled` is true. Cities tab shows tier and lets a
   manager pin. Budget stays 360 min; the scheduler never writes a task that
   would push an account past it in the hour it is due — it just waits.
2. **Second host.** Add `homelab` as an authoritative host with capacity N;
   move slots by lowering `worker-60-14`'s capacity and letting leases
   expire; verify a moved slot kept its proxy and device (ledger shows
   `restored`, not a fresh fingerprint).
3. Tests for `rank()` parity with the Python version on a fixture; scheduler
   with tiers; UI helpers.

## Exit

- [ ] Busy cities are searched 2–3× a day within budget; a pin holds.
- [ ] Two hosts share the fleet; a slot moved once and logged in with its
      saved session.
