# ERP fleet task queue — design

**Ticket:** RS-394 · **Date:** 2026-10-24 · **Status:** planned; implementation
plan in [`../plans/2026-10-24-erp-fleet/`](../plans/2026-10-24-erp-fleet/README.md)

## The ask

> The current facebook worker is working based on schedule. Ultrathink if we can keep worker active, which means when the queue has task, then it will start to work. instead of waiting on certain timepoint to start the task.
>
>
> Maybe worth to introduce a message queue service as well?

Later the same day: the long-term goal is a dynamic city list (add and remove
cities); avoid local VM configuration and make it easy to scale; sharing
account and password data with workers is fine; workers may live on several
hosts; it should be part of the ERP, in TypeScript/Node.

## The problem

A worker searches only from `start_at` (13:00 UTC; 17:00 for the `b`
partners). With the city queue (RS-372) it asks `next-city` city by city, but
the first empty answer ends the item until the next day, and the coordinator
refuses `outside_window` beyond 8 h after `start_at`. At 11:15 UTC on
2026-10-24 all 127 cities were due for both items and the 15 healthy workers
sat idle; over five days the fleet searched from about 13:00 to 18:00 UTC and
idled the other 19 hours. Every worker is a hand-written compose file plus a
config, a secrets file and a session file on one homelab VM, so adding a
worker or a host is a config-and-deploy job, and each deploy restarts
workers, which is a Facebook login.

The browser and session stay up between sweeps: a worker logs in once per
container start, not per sweep. Waiting is a scheduling choice.

## The design

**Pull from an explicit task queue in the ERP's Postgres; no clock, no
broker.**

- `fleet_cities` is the catalog people edit in the ERP. A new city's slug is
  verified by a worker job before it is enabled (a wrong slug searches the
  account's own city silently). Removing a city cancels its waiting tasks.
- `fleet_tasks` holds one open task per (city, item): `due_at`, priority,
  state (`ready → leased → done | cancelled | expired`). The scheduler writes
  the next task when one finishes (`due = done + DAY / per_day`), returns
  expired or stuck leases, and sends `NOTIFY fleet_tasks`.
- A worker **claims a slot** at boot: a pool account (`fb_pool_accounts`,
  already sealed under `FB_POOL_KEY`) plus its sticky proxy, device profile
  and a **lease epoch**. Every later call carries the epoch; a stale one is
  refused (409) and that worker exits, so one account never runs on two hosts.
  A slot prefers the host it last ran on.
- The worker **long-polls** `next-task` (held up to 50 s, woken by
  `LISTEN/NOTIFY`). It asks only while HEALTHY with a live page; a wake never
  causes a login. With the ERP unreachable it keeps its session and searches
  nothing: no own-list fallback.
- The pick is per account at claim time: priority, then home → familiar →
  most overdue, within the account's daily budget (360 min from leases), not
  while quarantined (then only probe tasks). `FOR UPDATE SKIP LOCKED` makes it
  safe for several backend instances.
- Hosts run one `fleet-agent` container (TypeScript) with the ERP URL and a
  host token; the ERP sets each host's capacity and image version; the agent
  starts identical worker images, staggered, and rolls releases one idle
  worker at a time. No inbound ports: VNC and logs go out to the ERP.
- The Python coordinator keeps listing dedupe, alert claims, Telegram,
  challenges and Messenger. Workers still post listings to it. Its city queue,
  roster push and console fleet routes retire after cutover.

Fixes carried from the review of the RS-372 spec: a maximum task duration
(`task_max_minutes`) bounds lease renewal; only parked states release a task,
DEGRADED does not; a quarantined slot gets a probe task every 6 h and a
manual release; a 4xx answer never triggers a fallback sweep.

## Why not a message queue service

- The claim is per account (home cities, budget, quarantine) and decided at
  claim time; a broker hands the next message to whoever asks, so a
  dispatcher would still be needed, and it would be the ERP.
- Tasks, the city log, budgets and the catalog change in one transaction. A
  broker is a second copy to keep in step (purging a removed city, leases in
  two places).
- About 254 tasks a day from 41 consumers; Postgres-as-queue is the standard
  answer at this scale, and `LISTEN/NOTIFY` gives sub-second wake-ups.
- Hosts on other networks talk HTTPS out to the ERP only; a broker would need
  its own exposed endpoint and credentials on every host.
- Revisit when the fleet takes on many job types with cross-service retries
  and dead letters, or the control plane spans several processes beyond what
  `SKIP LOCKED` covers.

## Why inside `apps/backend`, in TypeScript

The pool, the sealing key, manager auth, migrations, CI, versioning and the
Railway deploy already exist there; the fleet adds about 40 held long-polls
and a 30-second scheduler tick. If worker traffic ever needs isolating, the
same code runs as a second Railway service with `FLEET_ROLE=worker-api` on the
same database. The worker container stays Python because it runs the vendored
monitor; its change is a "fleet mode" that renders its config from the claim
answer and loops on `next-task`.

## Rollout

Six workstreams (see the plan folder). The live fleet is untouched until the
cutover: pilot four accounts on the first new host (`worker@10.10.60.14`),
one login each, two days of watching, then the rest a few minutes apart. The
homelab VM then holds only the coordinator, the console, the agent and fleet
workers.
