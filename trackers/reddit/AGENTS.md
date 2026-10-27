# Reddit tracker — `trackers/reddit/`

Distributed Reddit for-sale monitor: a fleet of workers polls subreddits through
the Atom feed, an OpenRouter model judges each post, and buy-worthy listings go
to Telegram once each. Read `README.md` for what it does and how to run it; this
file is only about traps and conventions. The root [AGENTS.md](../../AGENTS.md)
has the repo map and workflow.

## Where it sits in the monorepo

- **A standalone pnpm project.** It has its own `pnpm-workspace.yaml`,
  `pnpm-lock.yaml` and Dockerfile, and is not part of the root workspace. Run
  every command from this folder: `pnpm install`, `pnpm typecheck`, `pnpm test`.
  Root `pnpm` commands and root CI never see it.
- **The ERP drives it over HTTP.** `apps/backend/src/routes/tracker.ts` proxies
  an allowlist (`GET /api/workers`, `DELETE /api/workers/:id`,
  `GET|POST /api/rules`, `PATCH|DELETE /api/rules/:id`,
  `GET|POST /api/subreddits`, `PATCH|DELETE /api/subreddits/:name`,
  `GET /api/matches`, `GET /api/stats`, `GET /api/prompt-stats`, `GET /api/analytics`,
  `GET /api/seen`,
  `PUT|DELETE /api/prompt-candidate`, `POST /api/prompt-candidate/promote`,
  `PUT /api/settings/llm_model` and no other settings key)
  for the ERP's Monitors ▸ Reddit page. Changing one of those response shapes,
  or adding a route the page needs, is a change to both sides; see the root AGENTS.md
  under *Contracts*. Keep the tracker backward-compatible until the ERP release
  ships, because the two deploy separately.
- **Versioning.** There is no release process. OCI images are tagged with the
  short commit SHA (now a monorepo SHA) plus `latest`.
- **History.** It was imported from the archived `JinhuW/reddits_tracker`
  repo, so commit hashes cited before 2026-10-16 resolve only there.

## Read before changing these

- **Anything about fetching posts** →
  [docs/debug-notes/reddit-anonymous-json-blocked.md](docs/debug-notes/reddit-anonymous-json-blocked.md).
  The JSON API is dead for anonymous clients and the Atom feed is what works.
  The real rate limit is about 1 request per 40 s per IP, not 10/min.
- **The Dockerfile CMD or shutdown path** →
  [docs/debug-notes/signals-must-reach-node.md](docs/debug-notes/signals-must-reach-node.md).
  node must be PID 1 or SIGTERM never reaches the shutdown handler.
- **A `logger.warn`/`error` call, or a loop's error handling** → README
  *Ops alerts*. Every warn/error line reaches the ops Telegram group. One
  logged in a loop's scope also counts that iteration as failed, and three in
  a row page. Something routine belongs at `info`.
- **Telegram delivery or `telegram_chat_ids`** →
  [docs/debug-notes/telegram-supergroup-migration.md](docs/debug-notes/telegram-supergroup-migration.md).
  A group upgraded to a supergroup gets a new `-100…` chat id, and every alert
  to the old id fails.
- **The eval prompt, rules, `src/llm.ts` or the response schema** →
  [docs/prompt-evaluations/](docs/prompt-evaluations/). Every verdict is
  scored by prompt version, so a wording change belongs in a candidate trial
  with its numbers written up, not straight in `eval_prompt`.
- **The response schema** (`RESPONSE_SCHEMA` in `src/llm.ts`) is part of
  every prompt version's identity, through `RESPONSE_SCHEMA_ID` in the hash.
  Changing the schema starts every version afresh, so give the new shape a
  new id, and measure it first. `reasoning` comes before `is_target` because
  structured output writes fields in order: with the verdict first, the model
  committed before it counted.
- **`scripts/deploy-workers.sh` or `GHCR_READ_TOKEN`** →
  [docs/debug-notes/ghcr-read-token-dead.md](docs/debug-notes/ghcr-read-token-dead.md).
  The pull token is a classic PAT that dies silently; check it with one
  `curl` before deploying.
- **The multi-arch image build failing for `linux/amd64`** →
  [docs/debug-notes/amd64-image-build-crashes-node.md](docs/debug-notes/amd64-image-build-crashes-node.md).
  The emulator colima registers can crash node with an `uv__io_poll`
  assertion. Re-register it with `tonistiigi/binfmt`, and don't drop amd64:
  part of the fleet is E2.1.Micro.

## Design invariants

Breaking any of these breaks the fleet. The tests that cover them are
`tests/claims.test.ts`, `tests/poll.test.ts`, `tests/pipeline.test.ts` and
`tests/reactions.test.ts`.

1. **One Reddit request per poll cycle, not one per subreddit.** The poll loop
   claims a batch and fetches it through the `r/a+b+c` multireddit path.
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
6. **A candidate prompt never reaches buyers.** Its verdicts go to
   `candidate_verdicts` and never touch `posts.status`. A post only the
   candidate flags is reviewed in the dev chat from the evaluate loop, by the
   worker that judged it; `rejected` is terminal, so that happens once.
7. **Only the api process polls `getUpdates`.** Telegram allows one poller per
   bot token, and a second one splits the reactions between them. The
   reactions loop starts only in the api role with `ALERT_TRANSPORT=telegram`.
   The Facebook tracker uses a different bot, so the two never collide.
8. **The Telegram user session lives in the api alone.** Used from two IPs
   at once it gets revoked. Workers only stand down while
   `telegram_state.user_sender_at` is fresh. They never open the session.
   Even two api copies during a redeploy must not overlap: the api connects
   only after `acquireUserSender` succeeds, and disconnects before
   `releaseUserSender`.

## Conventions

- TypeScript only, Google style, with `.ts` extensions on relative imports.
  tsx and vitest resolve them, and nothing is emitted. (The ERP apps use
  extensionless imports; don't copy code across without fixing them.)
- Raw SQL through postgres.js. No ORM.
- New schema goes in a new `migrations/000N_*.sql`; never edit an applied file.
  This database is separate from the ERP's: both runners key a
  `schema_migrations` ledger by filename and both start at `0001_init.sql`, so
  the two must never share a database. `scripts/migrate.ts --reset` drops every
  table in `public`.
- A new migration updates the Reddit section of the root `docs/DATABASE.md`,
  and its *As of* line, in the same PR.
- Tests run against real Postgres (`docker compose up -d postgres`, on
  `127.0.0.1:5433`). The claim logic depends on `FOR UPDATE SKIP LOCKED`, which
  fakes do not reproduce.
- There is **no CLI** by design. The HTTP API is the only admin surface, so a UI
  can do everything an operator can.
- `ALERT_TRANSPORT=console` prints alerts to stdout instead of Telegram, which
  is useful locally and makes the bot token optional.

## Deploying

- **Railway project `reddits-tracker`** has services `api` (`ROLE=api`),
  `worker` and `Postgres`, and both app services share `railway.toml`. They are
  deployed by CLI upload from this folder, not from GitHub, so merging code
  does not deploy it.
- **Run `railway status` first, every time.** It must show project
  `reddits-tracker`. The Railway CLI uses the *closest linked ancestor
  directory*, and the repo root is linked to the ERP project
  `recycle-erp-experiment`. From an unlinked folder, `railway up` ships this
  code into the ERP backend. If this checkout isn't linked, run
  `railway link` (project `reddits-tracker`, env `production`). Then run
  `railway up --service <api|worker> --detach`.
- **OCI worker fleet** (`infra/terraform/`, see `infra/README.md`):
  1. Build the multi-arch image `ghcr.io/jinhuw/reddits_tracker:<sha>` with
     `docker buildx … --push .` from this folder.
  2. Run `scripts/deploy-workers.sh <sha>`.

  `scripts/secrets.env` and `infra/terraform/terraform.tfvars` are gitignored
  local files.
- After any deploy, walk through "Verifying a deployment" in `README.md`.

## Local gotchas

- `pnpm` build approvals live in `pnpm-workspace.yaml` under `allowBuilds:`,
  not in `package.json`. esbuild must be allowed or every pnpm command exits 1.
- To kill a locally started worker, signal the innermost node process, not the
  pnpm wrapper (see the signals debug note).
- The compose Postgres has a fixed `container_name: reddits_tracker_pg`. Only
  one copy can run at a time, whichever checkout started it.
