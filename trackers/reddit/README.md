# reddits_tracker

Watches subreddits for people selling used server hardware, has an LLM decide
whether each post is something Recycle Servers wants to buy, and alerts buyers
on Telegram with a summary and the post link.

Built to run as **5–10 identical workers on separate VMs sharing one Postgres**.
Reddit rate-limits per IP, so throughput comes from adding machines; the
database is the only thing they share, and it handles both scheduling and
deduplication.

## How it works

```
                      ┌──────────── shared Postgres (Railway) ────────────┐
                      │  subreddits · posts · settings                     │
                      └───────────────────────────────────────────────────┘
                          ▲              ▲                    ▲
        ┌─────────────────┘              │                    └──────────────┐
   VM 1 (own IP)                    VM 2 (own IP)   …    API service (Railway)
   poll → evaluate → notify        poll → evaluate…       HTTP admin + UI feed
```

Each worker runs three independent loops:

1. **poll** — claims every subreddit that is due, fetches them all in *one*
   Reddit request, and records the posts it found.
2. **evaluate** — sends unjudged posts to OpenRouter, storing a verdict, a
   one-line summary and the asking price.
3. **notify** — sends each target to Telegram once, then marks it notified.

They are separate loops so Reddit pacing (which can mean a minute of waiting)
never holds up evaluation, and an LLM outage never stops post discovery.

### Why posts are never processed twice

Two mechanisms, both in `src/claims.ts`:

- **`FOR UPDATE SKIP LOCKED` + a 5-minute claim TTL.** A subreddit claimed by
  one worker is invisible to every other worker's claim query, so two VMs never
  fetch the same subreddit at once. Claims are advisory metadata rather than
  held locks: a worker that dies has its work picked up after the TTL, with no
  reaper process involved.
- **`INSERT … ON CONFLICT (reddit_id) DO NOTHING`.** The Reddit fullname is the
  primary key, so a post seen by several workers is evaluated and alerted
  exactly once.

### Reddit access

There are no Reddit credentials. The anonymous JSON API is 403-blocked for all
User-Agents, so the tracker reads the **Atom feed** instead, which is still
open:

```
https://www.reddit.com/r/homelabsales+hardwareswap+homelab/new.rss?limit=100
```

One request returns up to 100 posts across every watched subreddit. The
anonymous bucket refills roughly every 40 s (`REDDIT_MAX_RPM` defaults to `1`),
and responses' `x-ratelimit-*` headers feed back into the pacer so Reddit's own
accounting drives our timing.

See `docs/debug-notes/reddit-anonymous-json-blocked.md` before changing
anything about how posts are fetched.

## Local development

```bash
docker compose up -d postgres        # Postgres on 127.0.0.1:5433
cp .env.example .env                 # fill in the two API keys
pnpm install
pnpm db:migrate
pnpm dev                             # worker
ROLE=api API_TOKEN=devtoken pnpm dev # admin API on :8080
```

```bash
pnpm test        # 139 tests; needs the compose Postgres running
pnpm typecheck
```

Tests create a throwaway database per test file against the compose server —
the claim logic depends on real row-locking semantics, which no in-memory fake
reproduces.

## Configuration

Secrets and per-machine facts go in the environment. Everything you would want
to change while the fleet is running lives in the database and is edited
through the API — no redeploy, and changes reach every worker within 60 s.

| Variable | Required | Default |
| --- | --- | --- |
| `DATABASE_URL` | yes | — |
| `TELEGRAM_BOT_TOKEN` | yes | — |
| `OPENROUTER_API_KEY` | workers only | — |
| `ROLE` | no | `worker` (`api` runs the HTTP server instead of the loops) |
| `API_PORT` / `API_TOKEN` | api role | `8080` / — |
| `WORKER_ID` | no | `hostname-pid-random` |
| `REDDIT_USER_AGENT` | no | `recycle-servers-tracker/1.0 (contact: …)` |
| `REDDIT_MAX_RPM` | no | `1` |
| `LOG_LEVEL` | no | `info` |

Database-backed settings: `eval_prompt`, `llm_model`, `telegram_chat_ids`,
`max_post_age_hours`. Watched subreddits live in the `subreddits` table.

## HTTP API

Everything except `/health` needs `Authorization: Bearer $API_TOKEN`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness, post counts. No auth — for uptime checks. |
| `GET` | `/api/matches?limit&since` | **The deliverable**: summary, price and link for every target. |
| `GET` | `/api/subreddits` | Watched subreddits with polling health. |
| `POST` | `/api/subreddits` | Add or re-enable one. `{"name": "homelabsales", "pollIntervalSeconds": 90}` |
| `PATCH` | `/api/subreddits/:name` | Enable/disable, change interval. |
| `DELETE` | `/api/subreddits/:name` | Stop watching. |
| `GET` | `/api/settings` | All runtime settings. |
| `PUT` | `/api/settings/:key` | Change one. `{"value": …}` |
| `GET` | `/api/stats` | Counts by status, per-subreddit health, failed posts. |
| `POST` | `/api/posts/:id/requeue` | Retry a post that gave up. |
| `POST` | `/api/telegram/test` | Send a test message to the configured chats. |

```bash
# Point the tracker at what you actually want to buy
curl -X PUT localhost:8080/api/settings/eval_prompt \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"value": "Only flag DDR4/DDR5 ECC RAM and Xeon Scalable CPUs."}'

# Decide who gets alerted
curl -X PUT localhost:8080/api/settings/telegram_chat_ids \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"value": ["123456789"]}'

# Read the item list
curl localhost:8080/api/matches -H "Authorization: Bearer $API_TOKEN"
```

## Deployment

**Postgres and the API — Railway.** Add a Postgres plugin with public
networking on (the VMs connect over the internet), then deploy this repo as a
service with `ROLE=api`, `API_PORT=8080` and an `API_TOKEN`. That service is
what a future UI talks to.

**Workers — Oracle Cloud Always Free.** Up to 4 ARM A1 VMs plus 2 AMD micro
VMs, each with its own public IP and therefore its own Reddit budget. On each:

```bash
docker build -t reddits-tracker .
docker run -d --restart unless-stopped \
  --env-file /opt/reddits_tracker/.env reddits-tracker
```

Every VM gets the *same* `.env` — the only per-machine differences (`WORKER_ID`,
IP address) happen automatically. Scaling up means starting the container on
another machine; there is nothing to register. Beyond the free six, any cheap
VPS with a distinct IP works.

Migrations run on every container start, which is safe at any scale: the runner
takes a cluster-wide advisory lock and keeps a filename ledger.

**When Reddit blocks a VM** (datacenter ranges sometimes get 403s), that worker
backs off on its own and the rest of the fleet carries on. `GET /api/stats`
shows `last_status` per subreddit. If one IP stays blocked, move that worker to
a different provider.

## Verifying a deployment

1. `GET /health` returns `ok: true`.
2. `GET /api/stats` shows every subreddit with `last_status: "ok"` and a
   non-zero `new` count within a couple of minutes.
3. `POST /api/telegram/test` arrives in the chat.
4. A real for-sale post reaches `notified` and the Telegram message has a
   working link.
5. `PUT /api/settings/eval_prompt` changes behaviour within 60 s, no restart.
6. Two workers running at once produce no duplicate alerts.
7. Killing a worker mid-poll: its claims free up within 5 minutes.

## Layout

```
migrations/      raw SQL, applied in order, once each
scripts/         migrate runner (advisory-locked, safe from any number of VMs)
src/
  claims.ts      all fleet coordination SQL — the core of the design
  reddit.ts      Atom feed fetch + parse
  pacing.ts      per-IP rate limiter and backoff
  llm.ts         OpenRouter evaluation
  telegram.ts    alert delivery
  api.ts         admin/UI HTTP surface
  settings.ts    database-backed runtime config
  loops/         poll, evaluate, notify + the shared ticker
docs/debug-notes/  traps worth not re-hitting
```
