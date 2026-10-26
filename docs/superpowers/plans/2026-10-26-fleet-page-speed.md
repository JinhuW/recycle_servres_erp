# Fleet page speed (RS-403)

**Ticket:** [RS-403](../../tickets/RS-403-fleet-page-loads-its-data-fast.md) ·
**Date:** 2026-10-26 · **Evidence:** read-only measurements of 2026-10-26
(explainer `http://10.10.100.225:8800/fleet-page-speed.html`).

## Why it is slow (measured)

| # | Cause | Number |
| --- | --- | --- |
| 1 | `FleetAccountsTab` waits on one `Promise.all`; its slowest member is `/api/coordinator/fleet` | 5,001–5,893 ms, 160 KB, 42 workers |
| 2 | Coordinator `/v1/accounts`: 1 list query + 41 single-account lookups over the internet to Railway Postgres | 2,095 ms (`select 1` 19–41 ms, new connection 212 ms) |
| 3 | Console `/v1/fleet` runs its steps one after another | healthz 152, workers 71, configs 79, accounts 2,095, 41 session metas 811, stats 142, queue 725 ms |
| 4 | No cache on the ERP proxy or in the console | every viewer poll is one full rebuild |
| 5 | Duplicate fetches on one load | 14 requests for 8 URLs (pool snapshot ×3, coordinator fleet ×2, challenges ×2, slots ×2, workers ×2) |
| 6 | Polling | 10 s tab poll + 30 s counts ≈ 50 requests/min per viewer; Analysis also polls coordinator fleet |
| 7 | The pool snapshot unseals every secret of every row, for pages that need status and holder | 3× per load |

## Target

ERP rows on screen in ≈ 0.3 s; coordinator rows within ≈ 0.1 s more when the
ERP cache is warm; console load bounded by the ERP (≤ 1 call per 15 s per
route), not by the number of viewers.

## Workstreams (run in parallel)

Each runs in its own worktree off `origin/dev`, opens a PR to `dev`,
squash-merges, and rebases right before merging. S1, S2 and S3 are ERP code:
each bumps the root minor version with its own `CHANGELOG.md` section (expect
collisions; renumber on rebase). S4 is tracker code:
`trackers/facebook/CHANGELOG.md` `[Unreleased]`, no release, no deploy.

### S1 · ERP proxy cache (backend)

**Owns:** `apps/backend/src/routes/coordinator.ts`, a new
`apps/backend/src/lib/coordinatorCache.ts`, tests in
`apps/backend/tests/coordinator-routes.test.ts` or a new
`coordinator-cache.test.ts`.

- Cache the GET answers of `/fleet` and `/challenges` (and `/workers`,
  `/stats/reviews`, `/stats/alert-hits`, `/filter-prompt`, keyed by path +
  query) in process memory:
  - younger than **15 s**: serve it;
  - older, up to **5 min**: serve it at once and refresh in the background,
    one refresh per key at a time (single flight);
  - none, or older than 5 min: the caller waits on the refresh; concurrent
    callers share that one upstream call.
- Only `2xx` answers are cached. An upstream error with a cached copy serves
  the copy as stale; without one it passes the error through as today.
- Any successful non-GET coordinator route (re-login, settings, queue,
  challenge resolve, …) clears the whole cache.
- Answer headers `X-Cache: hit|stale|miss` and `Age: <seconds>`.
- One cache per backend process is fine (one Railway instance; two would only
  double the upstream rate).

### S2 · Pool summary without secrets (backend + shared)

**Owns:** `apps/backend/src/routes/facebookPool.ts` (new route only),
`packages/shared/src/facebookPool.ts` (new type), a new
`apps/backend/tests/facebook-pool-summary.test.ts`.

Contract, which S3 builds against:

```ts
// GET /api/facebook-pool/summary, same auth as GET /api/facebook-pool
export type PoolAccountSummary = {
  no: number; uid: string | null; email: string | null; note: string;
  status: string; holder: string | null; holderId: string | null;
  since: number | null; addedAt: number; cookieAt: number | null;
  aliveCheckedAt: number | null; batch: string | null;
  hasCookie: boolean; cookieUid: string | null;
};
// answer: { accounts: PoolAccountSummary[] }
```

No `unseal` call and no secret column in the SELECT. Same row order as the
snapshot (`ORDER BY no`). Field types follow the snapshot's existing fields
of the same name; adjust a nullability here only if the column says so, and
note it in the PR.

### S3 · Page loads progressively (frontend)

**Owns:** `apps/frontend/src/pages/desktop/fleet/*`,
`apps/frontend/src/lib/coordinator.ts`, `apps/frontend/src/lib/fleet.ts`, the
pool client (add `summary()`), their tests, one line in `docs/FEATURES.md`.

- **Split the waits.** In `FleetAccountsTab` and `FleetAnalysisTab`, load
  the ERP's own data and the coordinator's data in separate polls, so the
  table renders ERP rows as soon as they arrive and coordinator rows fill in
  later. Rows must not flicker or reorder when coordinator data lands.
- **One fetch per URL.** A small request dedupe in the client: the same GET
  URL in flight, or answered within the last ~2 s, returns the same result.
  Used by the fleet tabs, the tab-bar counts and `DesktopCoordinator`.
- **Poll less.** Coordinator data every **30 s**; ERP fleet data stays at
  10 s. `useFleetPoll` skips a tick while the previous read is in flight.
- **Use the pool summary** (S2) where the page needs only status, holder and
  uid (Fleet tab, counts). Until S2 is on `origin/dev`, fall back to
  `snapshot()` on 404 so the PRs merge in any order; drop the fallback only
  if S2 merged first.
- Tests: unit tests for the dedupe helper and the in-flight skip; the
  existing fleet smoke tests keep passing.

### S4 · Console and coordinator faster at the source (tracker)

**Owns:** `trackers/facebook/rs_console/` (the `/v1/fleet` builder),
`trackers/facebook/rs_coordinator/` (`/v1/accounts`), their tests,
`trackers/facebook/CHANGELOG.md` `[Unreleased]`.

- `/v1/accounts`: fetch in the list query what the per-account lookups fetch
  (one query), answer unchanged.
- `/v1/fleet`: run its independent upstream calls concurrently (bounded), and
  give the proxy lookup a short timeout so an empty cache cannot add 3 s.
- Tests for both; the full coordinator and console suites pass.
- **No deploy.** Shipping it means recreating `rs-coordinator` and
  `rs-console` on the homelab VM, which serve the live workers: an owner
  decision, and never `deploy.sh` (it restarts workers, which is a Facebook
  login each).

## Shared files

`CHANGELOG.md` (S1, S2, S3 each add a section), `package.json` (version),
`docs/FEATURES.md` (S3). The later PR rebases after the earlier merges.

## Done

- [ ] S1 merged · [ ] S2 merged · [ ] S3 merged · [x] S4 merged (not deployed)
- [ ] After S1–S3 are on dev: Fleet tab load on `inventory-dev` measured
      (first ERP rows, coordinator rows, request count) and recorded here.
