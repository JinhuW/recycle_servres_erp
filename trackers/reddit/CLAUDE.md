# reddits_tracker — working notes

Distributed Reddit for-sale monitor. Read `README.md` first for what it does
and how to run it; this file is only about traps and conventions.

## Read before changing these

- **Anything about fetching posts** → `docs/debug-notes/reddit-anonymous-json-blocked.md`.
  The JSON API is dead for anonymous clients; the Atom feed is what works, and
  the real rate limit is ~1 request per 40 s per IP, not 10/min.
- **The Dockerfile CMD or shutdown path** → `docs/debug-notes/signals-must-reach-node.md`.
  node must be PID 1 or SIGTERM never reaches the shutdown handler.

## Design invariants

Breaking any of these breaks the fleet, and the tests that cover them are in
`tests/claims.test.ts`, `tests/poll.test.ts` and `tests/pipeline.test.ts`.

1. **One Reddit request per poll cycle, not one per subreddit.** The poll loop
   claims a batch and fetches them through the `r/a+b+c` multireddit path.
   Splitting it into per-subreddit requests multiplies rate-limit usage for no
   gain.
2. **Take the rate-limit slot before claiming.** A claim held while waiting on
   the pacer hides those subreddits from every other worker.
3. **Claims are advisory with a TTL, checked inline in the claim query.** No
   reaper process, and no lock held across an HTTP call.
4. **`reddit_id` is the dedup key.** Never insert posts without
   `ON CONFLICT DO NOTHING`, and never alert from anything other than a claimed
   `target` row.
5. **Secrets in env, business config in the `settings` table.** If a change
   should reach a running fleet without a redeploy, it belongs in the database.

## Conventions

- TypeScript only, Google style, `.ts` extensions on relative imports (tsx and
  vitest resolve them; nothing is emitted).
- Raw SQL through postgres.js. No ORM.
- New schema goes in a new `migrations/000N_*.sql`; never edit an applied file.
- Tests run against real Postgres (`docker compose up -d postgres`). The claim
  logic depends on `FOR UPDATE SKIP LOCKED`, which fakes do not reproduce.
- There is **no CLI** by design — the HTTP API is the only admin surface, so a
  UI can do everything an operator can.

## Local gotchas

- `pnpm` build approvals live in `pnpm-workspace.yaml` under `allowBuilds:`,
  not in `package.json`. esbuild must be allowed or every pnpm command exits 1.
- Killing a locally-started worker: signal the innermost node process, not the
  pnpm wrapper (see the signals debug note).
