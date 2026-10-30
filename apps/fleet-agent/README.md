# fleet-agent

One container per Docker host. It keeps the host's Facebook workers as the
ERP desires: it asks the ERP every 30 s how many workers this host should
run and on which image, compares that with the containers carrying its
label, and starts, restarts or replaces workers to match. It removes only a
stopped worker above the count whose image new workers no longer start on,
which is not a login. It then
reports what runs. The workers themselves claim an account from the ERP and
pull their own cities; the agent never sees a password, a cookie or a city.

## Run on a host

Register the host in the ERP (Hosts tab → Add host) and copy its token once.
Then, as a user in the `docker` group:

```sh
docker run -d --name fleet-agent --restart always --stop-timeout 120 \
  --log-opt max-size=10m --log-opt max-file=3 \
  -e FLEET_URL=https://inventory-dev.recycleservers.com \
  -e FLEET_HOST_ID=worker-60-14 \
  -e FLEET_HOST_TOKEN=... \
  -e FLEET_OPENSEARCH_URL=http://10.10.10.73:9200 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v fleet-agent-state:/state \
  ghcr.io/jinhuw/fleet-agent:<root version>
```

The agent's settings reach only workers it starts afterwards: re-running
the agent with a new one does not touch running workers, which pick it up
the next time it starts them.

Nothing else goes on the host: no compose files, no config, no secrets, no
session files. A new host is this command and a row in the Hosts tab. Leave
the host on `authoritative = false` until its first reports arrive, then
flip it and set a capacity; the agent starts one worker every three minutes
until it reaches the count.

Logs are one JSON object per line in `docker logs fleet-agent`. A standing
note (a worker held, a start waiting its turn) is logged when it first holds,
not every tick. `--stop-timeout 120` lets a tick in progress finish its
`docker stop` and write down what it did before the container goes.

Run one agent per host. An agent that finds another running container with
the same `FLEET_HOST_ID` on its daemon observes only, logs an error and puts
`agent.conflict` in its report until the other one is gone.

## Environment

| Var | Required | Meaning |
| --- | --- | --- |
| `FLEET_URL` | yes | the ERP through its Cloudflare Worker: `https://inventory-dev.recycleservers.com` (dev) or `https://inventory.recycleservers.com` (prod), never the Railway origin. The Worker adds the shared worker env to a claim answer, and prod refuses requests that skip it. Passed to workers unchanged as `RS_FLEET_URL` |
| `FLEET_HOST_ID` | yes | the host id as registered in the ERP; worker ids are `<host>-1`, `<host>-2`, … |
| `FLEET_HOST_TOKEN` | yes | the host's bearer token, shown once when the host is added. The agent keeps it to itself: workers get a claim ticket instead |
| `FLEET_INTERVAL` | no | seconds between ticks (default 30, at least 5) |
| `FLEET_STATE_DIR` | no | where the last desired answer, the start memory, the holds, the stop handoff and the agent's instance id live (default `/state`) |
| `FLEET_IMAGE_PREFIX` | no | comma-separated repositories this host runs (default `ghcr.io/jinhuw/aimm-recycle`). A desired image outside them is never pulled or run; existing workers are left as they are |
| `FLEET_STAGGER_SECONDS` | no | minimum seconds between two worker starts (default 180). Lower it only in tests: every start is a Facebook login |
| `FLEET_OPENSEARCH_URL` | no | where the workers ship their structured events (`ai_eval`, `listing_skip`, `listing_alert`, …), passed to each worker it starts as `AIMM_OPENSEARCH_URL`. Unset, no worker ships any, and a rated listing is only in the container's text log, about three hours deep. The fleet's is the homelab's, `http://10.10.10.73:9200`; `host.docker.internal` does not resolve in a worker |
| `FLEET_OPENSEARCH_INDEX` | no | the index prefix, passed as `AIMM_OPENSEARCH_INDEX` (default `fb-tracker`; daily indices `fb-tracker-YYYY.MM.DD`) |
| `FLEET_AGENT_VERSION` | no | overrides the version in reports (the image bakes the root version in) |

## What one tick does

1. `GET /api/fleet/hosts/{id}/desired` with the host token. If the ERP does
   not answer, the last answer cached in `/state/desired.json` is used and
   the outage is logged once; with no cache the agent observes only. A `401`,
   `403` or `404` is not an outage: the host was deleted or its token revoked,
   and the agent observes only, cache or not.
2. `docker ps -a --filter label=rs.fleet.host={id}`: the workers this agent
   owns. Containers without the label are invisible to it, so old compose
   workers can run beside it during a cutover. It also looks for another
   agent for the same host on the daemon (above).
3. Plan, a pure function (`src/plan.ts`):
   - start missing workers up to `count`, lowest free id first, one per
     tick, at least `FLEET_STAGGER_SECONDS` after the previous start. The
     previous start is the later of the one the agent wrote down and the
     newest `StartedAt` Docker shows, so a lost `/state` or a start whose
     answer was lost still counts;
   - leave workers beyond `count` alone: one running keeps running (its
     browser is signed in, and starting one again is a login), one stopped
     stays stopped until the count reaches it again. Since v1.385.0 nothing
     is removed;
   - replace the one worker `roll.replace` names if it is not yet on the
     desired image (stop, then run on the new image), beyond `count` too.
     It takes the tick's start before any other run or restart, which could
     fail without moving the stagger and hold the release up. A worker
     stopped for its replacement whose run failed is run again, beyond
     `count` too, and keeps its account reserved meanwhile;
   - restart an exited worker by its exit code: `75` (stale epoch or no
     slot) after 60 s, or after 10 min once it has had five 75/70 restarts
     in 30 min; `70` (claim failed) after 10 min; any other code after 60 s,
     counted; five counted restarts in 30 min hold it (below);
   - leave stopped, and report with a distinct `state` and `hold`:
     - `operator_needed`: it exited `78`, could not reach Facebook or its
       proxy;
     - `crash_limit`: it hit the crash limit. The hold stays on that
       container after the window has passed and across agent restarts;
     - `operator_stopped`: it exited `0` or `143` while this agent ran and
       the agent had not stopped it, i.e. someone ran `docker stop`. An exit
       from before the agent started (a host or daemon restart) is restarted
       as usual.

     A person brings a held worker back with `docker rm rs-fleet-{worker_id}`
     (the agent runs a fresh one on its next turn). `docker start` on a
     container this agent created claims with its spent claim ticket, exits
     `75` before the browser opens, and is then recreated like any `75`; it
     works only on a container from an agent before the tickets (no
     `rs.fleet.claim_ticket` label) and not started from a handoff. A fresh
     worker is a Facebook login.
4. Apply. Right before each `docker run` the agent asks the ERP for a claim
   ticket (`POST /api/fleet/hosts/{id}/tickets {worker_id, handoff_epoch?}`):
   single use, bound to that worker id and handoff epoch, ten minutes to
   live. Without one nothing is run and the start is not counted. A start is
   written to `/state` before it is made, and not made if it cannot be
   written. A worker is started with exactly
   `docker run -d --name rs-fleet-{worker_id} --label rs.fleet.host={id}
   --label rs.fleet.worker={worker_id} [--label rs.fleet.handoff_epoch={n}]
   --label rs.fleet.claim_ticket=1 --restart no --shm-size 1g
   -e RS_FLEET_URL -e RS_FLEET_HOST_ID -e RS_FLEET_CLAIM_TICKET
   -e RS_FLEET_HOST_TOKEN -e RS_FLEET_WORKER_ID -e RS_VNC_PORT={port}
   [-e RS_FLEET_HANDOFF_EPOCH={n}] [-e AIMM_OPENSEARCH_URL
   -e AIMM_OPENSEARCH_INDEX] -p 127.0.0.1:{port}:5900 -- {image}`, the
   OpenSearch pair only when `FLEET_OPENSEARCH_URL` is set.
   `RS_FLEET_CLAIM_TICKET` and `RS_FLEET_HOST_TOKEN` both carry the
   ticket: a worker image before facebook-tracker 0.14.5 claims with the
   second name only. The host token itself never enters a container. A
   tag is pulled before every start, so a tag pushed again is picked up; a
   digest (`…@sha256:…`) is pulled only when missing. Release images should
   be digest-pinned. The variables are handed to the CLI through its
   environment, so the ticket is never in a process list. A replacement
   stops the old container with `docker stop -t 30` then `docker rm`.
5. `POST /api/fleet/hosts/{id}/report` with the agent's version, its
   identity and every labelled container (`worker_id`, `image`, `state`,
   `started_at`, and the optional `hold`, `exit_code`, `image_id`). While a
   long pull or a row of stops runs, the last report is repeated every 60 s
   so the ERP does not count the host as silent.

Every call to the ERP carries `X-Fleet-Agent-Instance` (a UUID kept in
`/state/instance-id`) and `X-Fleet-Docker-Daemon` (the daemon's
`docker info` id); `stopped` and `report` carry them in the body too.

With `authoritative: false` the agent runs steps 1, 2 and 5 only and logs
the plan it would have applied. Offline it restarts exited workers and
nothing more (not a worker started from a handoff or with a claim ticket:
its reservation or ticket is spent, so it waits to be recreated online):
blind is not the time to change things. Online, an exited worker is always
recreated (stop confirmation, then a fresh ticket and `docker run`).

## What it never does

- Open an inbound port. VNC and logs go from the worker out to the ERP.
- Write a file on the host other than its own `/state` volume.
- Touch a container without the `rs.fleet.host={id}` label.
- Start more than one worker per tick, or two within the stagger.
- Restart a worker it holds (`operator_needed`, `crash_limit`,
  `operator_stopped`).
- Pull or run an image outside `FLEET_IMAGE_PREFIX`.
- Start, stop or replace anything while the ERP says `authoritative: false`.
- Hand out the host token. It is the only secret the agent holds; each
  worker gets the ERP's URL, the host id and a claim ticket good for one
  claim for that worker, and claims its own account with it. A compromised
  worker container can therefore claim no other account and cannot call
  `desired`, `report`, `stopped` or `tickets`.

## Development

```sh
pnpm --filter recycle-erp-fleet-agent test         # planner, docker CLI, agent with a mock ERP
pnpm --filter recycle-erp-fleet-agent typecheck
pnpm --filter recycle-erp-fleet-agent build        # tsc → dist/
FLEET_URL=http://127.0.0.1:8787 FLEET_HOST_ID=lab FLEET_HOST_TOKEN=... FLEET_STATE_DIR=/tmp/fleet-state \
  pnpm --filter recycle-erp-fleet-agent dev
```

`FLEET_AGENT_LIVE_DOCKER=1 pnpm --filter recycle-erp-fleet-agent test`
also runs `tests/live-docker.test.ts`: it builds a throwaway `alpine:3`
image that sleeps, points a mock ERP at it, and checks that the real daemon
ends up with the right containers, labels, ports and environment, then
removes everything it made. It never runs the worker image.

The image builds from the repository root:
`docker build -f apps/fleet-agent/Dockerfile -t ghcr.io/jinhuw/fleet-agent:$(node -p "require('./package.json').version") .`

### Confirmed-stop recovery

With backend v1.348.0, desired includes each worker's account/epoch in `leases`.
The agent persists that identity under /state before stopping the container;
after Docker confirms removal it posts `/hosts/:id/stopped`. The backend fences
the old epoch and reserves the same account. The new container receives
RS_FLEET_HANDOFF_EPOCH; a lost stop reply is retried and never licenses a second
browser. Keep /state durable across agent restarts. A reservation still waiting is
released (`restart: false`) when the worker falls beyond `count` or the host
turns observe-only. One lost with `/state` is cleared by parking and
unparking the slot. A confirmed stop is spent once a container for that
worker exists again; the next stop takes a fresh identity from `leases`.

Roll commands repeat until a fresh epoch/version passes the heartbeat gate.
The agent leaves an already-updated running container alone, preserves its
start stagger, and leaves held workers stopped. Exit 75 may be recreated
through a confirmed-stop handoff when online. Offline behavior
continues to keep running containers and uses the cached desired state.

Shared credentials are supplied by the Cloudflare Worker's FLEET_WORKER_ENV secret on a
successful claim, not by Docker arguments. Deploy backend support before the
new agent/worker. No live restart is needed to validate this protocol: the
backend's fleet-hosts tests compose this planner with a fake Docker driver.
