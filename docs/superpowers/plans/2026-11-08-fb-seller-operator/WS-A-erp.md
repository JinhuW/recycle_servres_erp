# WS-A — ERP: seller pool, seller hosts, control and holds, run log

Everything the operator and the UI need from the backend. It builds against
CONTRACTS §2, §3, §4 and §6 and needs nothing else merged. Nothing here starts
a container or touches Facebook.

## Owns

- One migration (CONTRACTS §3) and its `docs/DATABASE.md` sections.
- `packages/shared/src/fbSeller.ts`: the §2 `operator` block, `FbHoldKind`,
  `FbSellerAccountRow`, `FbBrowserTile`, `FbOperatorRunInput` and
  `FbOperatorRunRow`.
- `packages/shared/src/fleet.ts`: `HeartbeatAnswer.control`, and a comment on
  `ClaimAnswer` for empty secrets to seller hosts.
- `apps/backend/src/fleet/claim.ts`: the host-kind clause, the empty secrets,
  and `next-task` handing nothing while control or a hold is set.
- The worker routes in `apps/backend/src/routes/fleet.ts`: `seller/hold`,
  `seller/run`, `seller/spend`, `seller/tile`, and `control` on the heartbeat
  answer.
- Host add and edit: `kind`.
- `apps/backend/src/routes/fbSeller.ts` and a new
  `apps/backend/src/services/fbSellerPool.ts`: the §6 routes.
- `apps/backend/src/services/fbAds.ts` `placeAd`: the
  `location_outside_metro` rule.
- `apps/backend/src/services/fbConfig.ts`: validation for the `operator` block.
- `apps/backend/src/routes/facebookPool.ts`: purchaser take and Add to fleet
  skip `purpose = 'seller'`, and `push/accounts` accepts `purpose`. Update the
  `fb-pool-add` skill text to match.

## Do

1. **Migration first**, with defaults that leave today's rows unchanged: every
   account `search`, every host `search`.
2. **Claim**: add the clause beside `engineRuns` and `roleRuns`
   (`src/fleet/claim.ts`, around line 393). A seller host claims only seller
   accounts, and a search host never does. A seller host's claim answer blanks
   `password` and `totp_secret`. Keep the cloak, exhausted-port and epoch rules
   exactly as they are.
3. **Purpose and role stay in step.** Moving an account to `seller` sets its
   slot's `role = 'seller'`, and moving back sets `search`. Refuse
   `account_running` while a worker holds the slot.
4. **Control and hold.** `take` and `release` lock the slot row
   (`FOR UPDATE`), write the columns, and add an `fb_pool_events` entry naming
   the manager. `release` clears both control and hold. `seller/hold` raises an
   alert through `alertManagers` (`src/lib/fbSellerAlert.ts`) with the reason in
   words, once per kind while it is held.
5. **Reminder.** Add a pass to the RS-565 tick (`src/services/fbPacing.ts`)
   that alerts once when `control_since` is older than
   `control_reminder_minutes`.
6. **Spend.** `seller/spend` sums `fb_operator_runs.cost_usd` for
   `path = 'agent'` over today's calendar day in `active_hours.tz`, as RS-565's
   `agentSpentTodayUsd` does for fbAgent.
7. **Tiles.** Store the image under `fb-seller/tiles/<no>.jpg` with the R2
   helper the screenshot route uses, set `tile_key` and `tile_at`, and stream
   it back on `GET /tiles/:no` to managers only.
8. **Exit uniqueness.** In the proxy check path (RS-538,
   `fleet_proxy_checks`), when two seller slots measure the same exit IP, raise
   an `exit_shared` hold on both.

## Tests

Add them beside the existing suites:

- `tests/fleet-claim.test.ts`:
  - a search host never claims a seller account, and a seller host claims
    nothing else;
  - a seller claim answer has empty secrets;
  - control or a hold empties `next-task`.
- `tests/facebook-pool.test.ts`:
  - a seller account is hidden from purchaser take and from Add to fleet;
  - `account_running` is refused.
- A new `tests/fb-seller-operator.test.ts`:
  - take and release, `held_by_other`, and release clearing a hold;
  - the hold route is idempotent, and a stale epoch gives 200
    `accepted: false`;
  - the run route is idempotent on `run_uid`;
  - spend sums agent runs only, over the right day;
  - tile upload and fetch are manager-only;
  - `location_outside_metro`;
  - `exit_shared`;
  - the control reminder alerts once.
- `pnpm typecheck`; the backend suite.

## Exit criteria

- [ ] Migration, routes and services merged with the tests above, as an ERP minor bump with a CHANGELOG section.
- [ ] `docs/DATABASE.md` and `docs/FEATURES.md` (Leads ▸ Facebook) updated.
- [ ] Search workers unchanged: the existing fleet suites pass with no edit to their expectations.
- [ ] README Status updated.
