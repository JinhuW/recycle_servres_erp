# WS-D · `apps/fleet-agent`: one container per host

**Depends on:** `CONTRACTS.md` §6 and §10 only; test against a mock.
**Owns:** `apps/fleet-agent/` (new workspace package: `package.json`,
`src/*.ts`, `Dockerfile`, `tests/`), root `pnpm-workspace.yaml` already covers
`apps/*`.

Port the behaviour of `trackers/facebook/rs_fleetd/rs_fleetd/{agent,plan,docker,state}.py`
to TypeScript; drop per-worker config sync (the worker renders its own).

## Tasks

1. Package: Node 24, TypeScript, no runtime deps (`node:child_process` for
   the `docker` CLI, `fetch` for HTTP). `tsx` for dev, `tsc` build, vitest.
2. Loop every 30 s (`FLEET_INTERVAL` override):
   1. `GET /api/fleet/hosts/{id}/desired` with the host token; on failure use
      the last cached answer (`/state/desired.json`) and log once.
   2. Observe: `docker ps -a --filter label=rs.fleet.host={id}` → running
      workers by `worker_id` label.
   3. Plan (`plan.ts`, pure function, unit-tested): start missing workers up
      to `count` (ids `{host}-1..n`, lowest free), stop extras (highest id
      first, only when `authoritative`), replace `roll.replace` (stop, then
      start on the new image), restart exited containers by exit code
      (`75` → after 60 s, `70` → after 10 min, other → after 60 s with a
      counter; 5 crashes in 30 min → leave stopped and report).
   4. Apply with `docker run -d --name rs-fleet-{worker_id} --label
      rs.fleet.host={id} --label rs.fleet.worker={worker_id} --restart no
      --shm-size 1g -e RS_FLEET_URL -e RS_FLEET_HOST_ID -e RS_FLEET_HOST_TOKEN
      -e RS_FLEET_WORKER_ID -e RS_VNC_PORT={port} -p 127.0.0.1:{port}:5900
      {image}`. Pull the image first if missing. **Starts are staggered by
      at least 3 minutes** (each start is a Facebook login).
   5. `POST /api/fleet/hosts/{id}/report` with version and containers.
3. `authoritative=false`: observe and report only; never start or stop.
4. Logs: one line per action, JSON, to stdout (the host's docker logs).
5. `Dockerfile`: `node:24-alpine`, docker CLI installed, `/var/run/docker.sock`
   mounted at run time, `/state` volume. Image `ghcr.io/jinhuw/fleet-agent`
   (WS-F wires the workflow).
6. `README.md` in the package: how to run on a host (the one-liner from
   `HOSTS.md`), env vars, what it never does (no inbound ports, no files).
7. Tests: planner cases (scale up, scale down, roll one, crash backoff,
   non-authoritative no-op, stagger), a fake `docker` shim in tests, a mock
   `desired` server.
8. Root version minor bump + changelog.

## Exit

- [ ] On a dev machine with Docker, the agent pointed at WS-B's dev backend
      with a registered host starts `count` worker containers (any image that
      exits 0 is fine for this check), reports them, scales down when
      capacity drops, and stays observe-only when `authoritative=false`.

## Notes for the agent

- `rs_fleetd` has a `conftest.py` with the docker shim pattern; mirror it.
- Never touch containers without the `rs.fleet.host` label: the homelab VM
  will run old compose workers next to the agent during cutover.
