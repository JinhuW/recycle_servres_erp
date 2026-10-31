# Architecture follow-ups — review 2026-10-31

These consolidate issues that several lanes reported from different sides. Each
one points at the findings it would close; they are not counted again.

- [ ] **Put every Facebook-login path behind one ledgered, confirmed gate.**
  The repo's first rule is enforced by convention only. This review found logins
  that start outside the ledger or with no confirmation:
  - two legacy launchd jobs on the office Mac that replay a personal session
    from the house IP ([B5-01, B5-02](live-resources.md));
  - 31 boot logins in 24 h on the homelab, driven by four desired-count changes
    ([B3-01](live-resources.md));
  - lease expiry during an ERP outage that lets new workers take live slots
    ([A4-01](fleet-integrations-todo.md));
  - pool Assign firing side effects before any locked state
    ([A4-03](fleet-integrations-todo.md));
  - one-click host, capacity and Resend-login controls
    ([A6-05, A6-06](frontend-todo.md));
  - a seeded cookie overwritten by a stale backup
    ([A10-04](facebook-tracker-todo.md));
  - an agent five fixes behind that removes signed-in workers
    ([B4-01](live-resources.md)).

  [C2-01](docs-drift.md) adds that the rule's wording doesn't name the ERP fleet
  at all. The fix: one server-side "this causes a login" check that requires an
  explicit confirm token, writes the ledger before acting, and holds
  locked/challenged accounts instead of re-booting them. Then retire the Mac
  jobs.

- [ ] **Make scheduled jobs fail loudly.** Railway marks a cron deployment
  SUCCESS when its script exits non-zero, and webhooks don't cover cron exits.
  Four jobs are broken right now:
  - db-sync has been down since 10-28 ([A5-01](schema-todo.md));
  - uptime-monitor has been silent since 10-28 ([A11-01](tooling-deps-todo.md));
  - the nightly inspection routine is blocked but reports SUCCEEDED
    ([B4-03](live-resources.md));
  - keyword-eval has failed since 10-25 ([B5-03](live-resources.md)).

  The fleet host isn't scraped by Prometheus either
  ([B4-04](live-resources.md)). Each job should push a heartbeat or failure to
  the `railway-alerts` relay, with a dead-man alert when the heartbeat stops.
  The uptime probe must also treat an edge 429 as "unknown", not "down"
  ([B1-04](live-resources.md)).

- [ ] **Finish the 2026-10-21 rotation, then cut blast radius.** Still open:
  - the backup R2 key can read and delete every dump, with no lock rule
    ([A11-02](tooling-deps-todo.md));
  - the facebook-tracker Postgres password is unrotated and on a public TCP
    proxy ([B1-02](live-resources.md));
  - the internet-facing rs-console holds the vault key and token secret
    ([A10-01](facebook-tracker-todo.md));
  - fbc-api has no Access app in front ([B2-01](live-resources.md));
  - a secrets `.bak` sits untracked in the main checkout
    ([B4-05](live-resources.md)).

  Split secrets per container, add an R2 lock rule and a separate prune key,
  and put Access in front of fbc-api.

- [ ] **Gate prod deploys on CI and on what actually runs.**
  - `main` merges deploy the backend and run migrations without waiting for CI
    ([A11-03](tooling-deps-todo.md));
  - prod watchPatterns skip manifest-only releases
    ([B1-05](live-resources.md));
  - the fleet agent on hosts is pinned to an old image
    ([B4-01](live-resources.md));
  - `deploy.sh` verifies a topology the VM no longer runs
    ([A10-02](facebook-tracker-todo.md)).

  Turn on required checks and Railway "wait for CI". Make the agent version
  part of the release, and delete or rewrite `deploy.sh` around fleet-agent.

- [ ] **Centralize session and credential validity** (carried over, still
  open). Rotation and redemption take locks in different orders, so a rotation
  racing a password change survives it ([A1-01](security-todo.md)). One
  credential-version check, under one lock order, closes A1-01 and its
  deadlock variant A1-02.

- [ ] **One persisted capture/edit state machine** (carried over, still open).
  A failed autosave deletes a draft that already holds a line
  ([A7-01](mobile-pwa-todo.md)). Queued photos are dropped on navigation
  ([A6-07](frontend-todo.md)). A double tap adds a line twice
  ([A6d-02](frontend-todo.md)), and sign-out drops pending saves
  ([A6b-01](frontend-todo.md)).

- [ ] **Document every ERP→console call as contract.** `facebookPool.ts`'s
  `/session` and `/restore-session` calls, and their fallback to relogin, are
  in neither contract doc ([C2-02](docs-drift.md); also raised as A8-01 and
  A10-14). Add them to the AGENTS.md *Contracts* table with a test on both
  sides.

- [ ] **Separate financial facts from projections** (carried over, still open).
  Realized cost is still recomputed from mutable PO data
  ([A3 carryover](carryover-2026-10-13.md)). An unbounded FX override
  ([A3-01](finance-todo.md)) and the commission preview drifting from the
  backend's clamp ([A6d-05](frontend-todo.md)) are both symptoms.

Other 2026-10-13 architecture items: the domain lock protocol and moving
packing persistence below HTTP (BD-11) are still open per lane A2. The durable
side-effect lifecycle is still open per A4 (A4-03 is an instance). The
integration-test gates are still open per A6b and A11. The frontend has no DOM
test environment, which is why A6's seven PLAUSIBLE verdicts could not be
reproduced. See [carryover-2026-10-13.md](carryover-2026-10-13.md).
