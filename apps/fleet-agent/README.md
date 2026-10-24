# fleet-agent

One container per Docker host. It keeps the host's Facebook workers as the
ERP desires: it asks the ERP every 30 s how many workers this host should
run and on which image, compares that with the containers carrying its
label, and starts, restarts, replaces or removes workers to match. It then
reports what runs. The workers themselves claim an account from the ERP and
pull their own cities; the agent never sees a password, a cookie or a city.

## Run on a host

Register the host in the ERP (Hosts tab → Add host) and copy its token once.
Then, as a user in the `docker` group:

```sh
docker run -d --name fleet-agent --restart always \
  -e FLEET_URL=https://api.recycleservers.com \
  -e FLEET_HOST_ID=worker-60-14 \
  -e FLEET_HOST_TOKEN=... \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v fleet-agent-state:/state \
  ghcr.io/jinhuw/fleet-agent:<root version>
```

Nothing else goes on the host: no compose files, no config, no secrets, no
session files. A new host is this command and a row in the Hosts tab. Leave
the host on `authoritative = false` until its first reports arrive, then
flip it and set a capacity; the agent starts one worker every three minutes
until it reaches the count.

Logs are one JSON object per line in `docker logs fleet-agent`.

## Environment

| Var | Required | Meaning |
| --- | --- | --- |
| `FLEET_URL` | yes | ERP base URL, e.g. `https://api.recycleservers.com` |
| `FLEET_HOST_ID` | yes | the host id as registered in the ERP; worker ids are `<host>-1`, `<host>-2`, … |
| `FLEET_HOST_TOKEN` | yes | the host's bearer token, shown once when the host is added |
| `FLEET_INTERVAL` | no | seconds between ticks (default 30) |
| `FLEET_STATE_DIR` | no | where the last desired answer and the start memory live (default `/state`) |
| `FLEET_STAGGER_SECONDS` | no | minimum seconds between two worker starts (default 180). Lower it only in tests: every start is a Facebook login |
| `FLEET_AGENT_VERSION` | no | overrides the version in reports (the image bakes the root version in) |

## What one tick does

1. `GET /api/fleet/hosts/{id}/desired` with the host token. If the ERP does
   not answer, the last answer cached in `/state/desired.json` is used and
   the outage is logged once; with no cache the agent observes only.
2. `docker ps -a --filter label=rs.fleet.host={id}`: the workers this agent
   owns. Containers without the label are invisible to it, so old compose
   workers can run beside it during a cutover.
3. Plan, a pure function (`src/plan.ts`):
   - start missing workers up to `count`, lowest free id first, one per
     tick, at least `FLEET_STAGGER_SECONDS` after the previous start;
   - remove workers beyond `count`, highest id first (only when the ERP
     says `authoritative` and answered this tick);
   - replace the one worker `roll.replace` names if it is not yet on the
     desired image (stop, then run on the new image);
   - restart an exited worker by its exit code: `75` (stale epoch or no
     slot) after 60 s, `70` (claim failed) after 10 min, anything else after
     60 s, counted; five such restarts in 30 min leave it stopped and
     reported.
4. Apply. A worker is started with exactly
   `docker run -d --name rs-fleet-{worker_id} --label rs.fleet.host={id}
   --label rs.fleet.worker={worker_id} --restart no --shm-size 1g
   -e RS_FLEET_URL -e RS_FLEET_HOST_ID -e RS_FLEET_HOST_TOKEN
   -e RS_FLEET_WORKER_ID -e RS_VNC_PORT={port} -p 127.0.0.1:{port}:5900
   {image}`; the image is pulled first if the host does not have it. The
   variables are handed to the CLI through its environment, so the token is
   never in a process list. A removal is `docker stop -t 30` then `docker rm`.
5. `POST /api/fleet/hosts/{id}/report` with the agent's version and every
   labelled container (`worker_id`, `image`, `state`, `started_at`).

With `authoritative: false` the agent runs steps 1, 2 and 5 only and logs
the plan it would have applied. Offline it restarts exited workers and
nothing more: blind is not the time to change things.

## What it never does

- Open an inbound port. VNC and logs go from the worker out to the ERP.
- Write a file on the host other than its own `/state` volume.
- Touch a container without the `rs.fleet.host={id}` label.
- Start more than one worker per tick, or two within the stagger.
- Start, stop or replace anything while the ERP says `authoritative: false`.
- Keep credentials: the host token is the only secret it holds, and it hands
  the ERP's URL, the host id and that token to each worker, which claims its
  own account.

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
