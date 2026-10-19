# Reddit tracker

Watches subreddits for people selling used server hardware, has an LLM decide
whether each post is something Recycle Servers wants to buy, and alerts buyers
on Telegram with a summary and the post link. Reactions on those alerts come
back as **leads**, and every verdict records the prompt version that made it,
so a prompt change is judged by the leads it earns.

It lives at `trackers/reddit/` in the monorepo as a **standalone pnpm project**
(own `pnpm-workspace.yaml`, lockfile and Dockerfile), so every command below
runs from this folder. Traps and conventions are in [AGENTS.md](AGENTS.md).

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
3. **notify** — sends each target to Telegram once, records the message ids it
   went out as, then marks it notified.

They are separate loops so Reddit pacing (which can mean a minute of waiting)
never holds up evaluation, and an LLM outage never stops post discovery.

The **api** process runs one more loop, **reactions**, which long-polls the
bot's updates for reactions on alert messages (see *Measuring the prompt*).

### Measuring the prompt

- **Prompt versions.** A version is the exact model and system prompt
  (`eval_prompt` plus enabled rules) a post was judged with, stored once in
  `prompt_versions` and referenced from every verdict. Editing a rule makes a
  new version; editing it back reuses the old one.
- **Leads.** Every alert's Telegram message id is recorded in
  `alert_messages`. When someone reacts to the alert, the api's reactions loop
  records it. Any reaction except 👎 makes the post a **lead**; a 👎 alone
  marks it **not a lead**. This works in groups, where Telegram says who
  reacted, and in channels, where it only sends totals. Every buyer alert
  ends by asking for that reaction ("React 👍 if you act on this, 👎 if it's
  not useful").
- **Response schema.** The model gives its reasoning before its verdict. A
  version's identity includes the schema (`prompt_versions.response_schema`),
  so the verdicts from the earlier verdict-first schema stay in their own
  versions.
- **Dev chat.** With `telegram_dev_chat_ids` set, every alert also goes there
  as a review: the alert plus the model's reasoning and prompt version. The
  dev chat is where the team labels alerts without spamming buyers.
- **Candidate prompt.** With `candidate_eval_prompt` set, every post is judged
  a second time by the candidate. This doubles OpenRouter calls while a trial
  runs.
  - The candidate's verdicts go to `candidate_verdicts` and never change a
    post's status.
  - A post only the candidate flags is reviewed in the dev chat alone, never
    sent to buyers.
  - `GET /api/prompt-stats` scores every version and sets the candidate
    against the live prompt on the same posts. `POST
    /api/prompt-candidate/promote` makes it live.

  `docs/prompt-evaluations/` records each trial and the numbers behind it.

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
pnpm test        # 213 tests; needs the compose Postgres running
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
| `TELEGRAM_BOT_TOKEN` | unless `ALERT_TRANSPORT=console` | — |
| `OPENROUTER_API_KEY` | workers only | — |
| `ALERT_TRANSPORT` | no | `telegram` (`console` prints alerts to stdout instead) |
| `ROLE` | no | `worker` (`api` runs the HTTP server instead of the loops) |
| `API_PORT` / `API_TOKEN` | api role | `8080` / — |
| `WORKER_ID` | no | `hostname-pid-random` |
| `REDDIT_USER_AGENT` | no | `recycle-servers-tracker/1.0 (contact: …)` |
| `REDDIT_MAX_RPM` | no | `1` |
| `LOG_LEVEL` | no | `info` |

Database-backed settings: `eval_prompt`, `llm_model`, `telegram_chat_ids`,
`max_post_age_hours`, `telegram_dev_chat_ids`, `candidate_eval_prompt` and
`candidate_llm_model`. The last three default to empty, which means off.
Watched subreddits live in the `subreddits` table. Named buying rules live in
`rules`; the enabled ones are appended to `eval_prompt` at evaluation time, so
each post is still one LLM call (two while a candidate is on trial).

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
| `GET` | `/api/workers?status&limit&offset` | Fleet heartbeats, newest first. `status` is `all`, `live`, `stale` (90 s silent) or `dead` (10 min). |
| `DELETE` | `/api/workers/:id` | Drop a worker's row, e.g. one that died. |
| `GET` | `/api/rules` | All buying rules. |
| `POST` | `/api/rules` | Add one. `{"name": "ECC RAM", "prompt": "Flag DDR4/DDR5 ECC RAM lots."}` |
| `PATCH` | `/api/rules/:id` | Change `name`, `prompt` or `enabled`. |
| `DELETE` | `/api/rules/:id` | Remove one. |
| `GET` | `/api/settings` | All runtime settings. |
| `PUT` | `/api/settings/:key` | Change one. `{"value": …}` |
| `GET` | `/api/stats?since` | Counts by status (only posts discovered since `since`, when given), per-subreddit health, the oldest pending post, failed posts. |
| `POST` | `/api/posts/:id/requeue` | Retry a post that gave up. |
| `POST` | `/api/telegram/test` | Send a test message to the configured chats. |
| `GET` | `/api/prompt-stats?since` | Per prompt version: posts judged, targets, buyer and dev-chat leads; for a candidate, `vsLive`, its verdicts against live on the same posts. `config` has the live and candidate prompts as configured now. |
| `PUT` | `/api/prompt-candidate` | Start or replace a trial. `{"prompt": "…", "model": ""}`; `model` is optional, and `""` means `llm_model`. |
| `DELETE` | `/api/prompt-candidate` | End the trial. Its verdicts stay, so its version keeps its numbers. |
| `POST` | `/api/prompt-candidate/promote` | Make the candidate the live prompt (and model). Disables the rules, which the candidate was judged without, and clears the candidate. |

The ERP's Monitors ▸ Reddit page drives the workers, rules, subreddits,
matches, stats, prompt-stats and prompt-candidate routes through its backend
proxy; see *Contracts* in the root `AGENTS.md`
before changing their shapes.

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

### Prompt experiments

1. **Create the dev chat.** It can be a group or a channel. Add
   `@recycle_servers_alert_bot` as an **admin**: Telegram only sends reaction
   updates to admins. The api logs a `telegram_chat_member` event with the
   new chat's id as soon as the bot is added.
2. **Point reviews at it:**
   `PUT /api/settings/telegram_dev_chat_ids` with `{"value": ["-100…"]}`.
3. **Start a trial:** `PUT /api/settings/candidate_eval_prompt` with the full
   prompt text. Optionally set `candidate_llm_model` to trial a model too.
4. **Label in the dev chat.** React 👍 to a review that is a real lead, and 👎
   to one that should not have alerted. Buyers' reactions in the alert chat
   count too.
5. **Read `GET /api/prompt-stats`.** Compare the candidate's `vsLive` cells:
   - leads in `candidateOnly` are deals it adds;
   - leads in `liveOnly` are deals it would lose;
   - notLeads in `liveOnly` are junk it drops.
6. **Promote, or end the trial.** Promote with
   `POST /api/prompt-candidate/promote`. To end it instead, set
   `candidate_eval_prompt` to `""`.
7. **Record the outcome** in `docs/prompt-evaluations/`.

## Deployment

Merging deploys nothing. Both targets are pushed by hand from this folder.

**Railway — project `reddits-tracker`.** Services `Postgres`, `api`
(`ROLE=api`, `API_PORT`, `API_TOKEN`) and one `worker` on Railway's IP range.
Both app services build this Dockerfile through `railway.toml` and differ only
in env vars. Read the Railway link hazard under *Deploying* in
[AGENTS.md](AGENTS.md) first, then:

```bash
railway status                       # must show project reddits-tracker
railway up --service api --detach    # or --service worker
```

Postgres has public networking on, because the OCI VMs connect over the
internet.

The `api` service must run with `ALERT_TRANSPORT=telegram`. That is what
starts its reactions loop; in console mode the api never polls Telegram, which
is what keeps a local api from taking production's updates. Telegram allows
one `getUpdates` poller per bot, so nothing else may poll this bot's updates.

**Worker fleet — Oracle Cloud Always Free.** VMs from `infra/terraform/`
(see [infra/README.md](infra/README.md)), each with its own public IP and
therefore its own Reddit budget. Code ships as a multi-arch image on GHCR:

```bash
docker buildx build --platform linux/arm64,linux/amd64 \
  -t ghcr.io/jinhuw/reddits_tracker:latest \
  -t ghcr.io/jinhuw/reddits_tracker:$(git rev-parse --short HEAD) --push .
scripts/deploy-workers.sh <sha>      # tag defaults to latest
```

`deploy-workers.sh` reads `scripts/secrets.env` (copy `secrets.env.example`;
gitignored and kept out of the image by `.dockerignore`) and takes the VM IPs
from `terraform output worker_ips`. On each VM in turn it writes
`/opt/reddits_tracker/.env`, logs into GHCR, pulls the image and replaces the
`tracker` container, so the fleet never fully stops. That env file sets
`ALERT_TRANSPORT=console` unless `secrets.env` says otherwise.

Every VM gets the *same* env — `WORKER_ID` is generated per process. Scaling
up means starting the container on another machine; there is nothing to
register. Beyond the free tier, any cheap VPS with a distinct IP works.

Migrations run on every container start, which is safe at any scale: the runner
takes a cluster-wide advisory lock and keeps a filename ledger.

**When Reddit blocks a VM** (datacenter ranges sometimes get 403s), that worker
backs off on its own and the rest of the fleet carries on. `GET /api/stats`
shows `last_status` per subreddit. If one IP stays blocked, move that worker to
a different provider.

## Verifying a deployment

1. `GET /health` returns `ok: true`.
2. `GET /api/workers?status=live` lists every VM, the Railway worker and the
   api.
3. `GET /api/stats` shows every subreddit with `last_status: "ok"` and a
   non-zero `new` count within a couple of minutes.
4. `POST /api/telegram/test` arrives in the chat.
5. A real for-sale post reaches `notified` and the Telegram message has a
   working link.
6. `PUT /api/settings/eval_prompt` changes behaviour within 60 s, no restart.
7. Two workers running at once produce no duplicate alerts.
8. Killing a worker mid-poll: its claims free up within 5 minutes.
9. A reaction on a new alert shows up in `GET /api/prompt-stats` within a
   minute, and the api log has no `another process is polling` warnings.

## Layout

```
Dockerfile         one image for every role; node is PID 1
railway.toml       Railway build config, shared by api and worker
migrations/        raw SQL, applied in order, once each
scripts/
  migrate.ts       migration runner (advisory-locked, safe from any number of VMs)
  deploy-workers.sh  push env + image to every OCI VM
src/
  index.ts         entry point; ROLE picks the worker loops or the API
  config.ts        env parsing, fails fast on a bad boot
  db.ts            postgres.js client
  claims.ts        all fleet coordination SQL — the core of the design
  reddit.ts        Atom feed fetch + parse
  pacing.ts        per-IP rate limiter and backoff
  llm.ts           OpenRouter evaluation
  rules.ts         named buying rules, composed into the eval prompt
  prompts.ts       prompt versions, candidate verdicts, per-version lead stats
  review.ts        dev-chat reviews of alerts and candidate-only posts
  alerts.ts        alert transport: Telegram or console
  telegram.ts      Telegram formatting + delivery
  heartbeat.ts     per-process row in `workers` for fleet visibility
  api.ts           admin/UI HTTP surface
  settings.ts      database-backed runtime config
  logger.ts        leveled logger tagged with the worker id
  loops/           poll, evaluate, notify, reactions (api only) + the shared ticker
tests/             vitest against real Postgres, one database per file
infra/             OCI worker fleet (terraform) — see infra/README.md
docs/debug-notes/  traps worth not re-hitting
docs/prompt-evaluations/  each prompt trial: hypothesis, prompt text, the numbers
```
