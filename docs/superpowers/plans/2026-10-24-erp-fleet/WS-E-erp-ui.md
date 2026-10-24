# WS-E · ERP UI: Cities, Queue, Hosts, Slots

**Depends on:** `CONTRACTS.md` §7 and §9; build against MSW/mock fixtures
until WS-A/B merge. **Owns:** `apps/frontend/src/lib/fleet.ts`,
`apps/frontend/src/pages/desktop/fleet/*`, their tests, i18n keys
(`i18n.tsx`, `i18n.zh.ts`, prefix `fleet*`), styles in
`apps/frontend/src/styles/fleet.css`. Read `apps/frontend/AGENTS.md` and the
existing `pages/desktop/Fleet*.tsx` for the house style; reuse their
components (tables, chips, rings) rather than new ones.

## Tasks

1. `lib/fleet.ts`: typed fetchers for §7 (same shape as `lib/coordinator.ts`),
   SWR-style polling every 10 s on open tabs.
2. Monitors ▸ Facebook gets four new tabs (keep the existing ones until WS-F
   trims them):
   - **Cities**: table (name, slug, region, enabled/verifying, per-day, pin,
     last done per item, next due, holder); *Add city* dialog (slug, name,
     radius) → shows "verifying…" until `verified_at`, with the label Facebook
     returned and an *Enable anyway* for managers; row actions: pin, per-day,
     *Search now* (manual task), *Remove* (confirm).
   - **Queue**: per item a board of city cells (ready-due, ready-later,
     leased, done today, cancelled) like today's round card; counts sentence;
     *Start the round now* (confirm with the §7 answer preview); a task table
     with filters; click a city → city log (tasks + events).
   - **Hosts**: hosts table (id, authoritative, capacity, agent version,
     last seen, running/desired), *Add host* (shows the token once, copy
     button), capacity stepper, authoritative toggle, *Release* dialog
     (image, version) with roll progress.
   - **Slots**: accounts table (no, uid masked, pool status, host, worker,
     epoch, lease, minutes today / budget ring, quarantine), actions: release
     quarantine, park; link to the pool page.
3. Worker page: when a worker is a fleet worker, show its current task and
   the VNC view through the new relay (`/api/fleet/worker/vnc` path via the
   existing noVNC component).
4. Mobile: none (desktop-only pages, say so in FEATURES).
5. Tests: `fleetView`-style pure helpers (board cells, counts sentence, due
   formatting) with vitest; component smoke tests with mocked fetchers.
6. `docs/FEATURES.md`: a *Fleet (ERP-owned)* bullet per tab, citing the
   version. Root version minor bump + changelog.

## Exit

- [x] The four tabs render from fixtures with every action wired to the typed
      fetcher (v1.337.0: vitest helpers + smoke tests, Playwright pass against
      a mock API; see the PR).
- [x] Against WS-A/B: add a city → appears "verifying", becomes
      enabled after the fake worker reports; *Search now* creates a task the
      fake worker receives; *Remove* cancels it; Hosts shows the fake host;
      Slots shows the claimed account with its epoch. (v1.341.0: done
      **locally**, not on Railway dev: a private database on the test
      container, migrated, seeded and loaded from `master.toml`, one made-up
      pool account, `fleet-fake-worker.mjs` with the token from the Hosts
      tab, headless Playwright as a seed manager. Also checked: park/unpark,
      409 `unverified` → Enable anyway, round start answer, release banner,
      the worker page's current task. See the PR.)

## Notes for the agent

- Times are shown in US Eastern as the existing Fleet pages do
  (`utcToEastern` in `lib/fleetView.ts`).
- Keep the existing coordinator Fleet tab untouched; WS-F removes it after
  cutover.
