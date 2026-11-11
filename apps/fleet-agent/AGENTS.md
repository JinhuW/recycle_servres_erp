# Fleet agent — `apps/fleet-agent/`

One container per Docker host. It keeps that host's Facebook workers matching
what the ERP desires. [README.md](README.md) is the manual: the environment,
what one tick does, what it never does, running it on a host and
confirmed-stop recovery. This file is the traps. The root
[AGENTS.md](../../AGENTS.md) has the repo map and workflow. Bare paths such as
`src/plan.ts` are under `apps/fleet-agent/`; anything else is relative to the
repo root.

## Every start is a Facebook login

Root AGENTS.md → *First rule* applies here more than anywhere: this code
decides when a worker's browser opens. Ask the owner before a change that
loosens any of these.

- One start per tick, and never within the stagger of the previous one
  (`DEFAULT_STAGGER_MS`, three minutes). Lower `FLEET_STAGGER_SECONDS` only
  in tests.
- Nothing running is stopped for being above the count. A held worker stays
  stopped until a person acts (README → *What it never does* lists the
  holds).
- Offline, on a cached desired state, nothing is created or replaced; at
  most an exited worker is restarted.
- Observe only when the ERP says `authoritative: false`, when it answers
  401, 403 or 404, or when another agent for the same host is on the daemon.
- A start is written to `/state` before `docker run`, and is not made if it
  cannot be written.
- The host token never enters a container. A worker gets a single-use claim
  ticket, passed as `RS_FLEET_CLAIM_TICKET` and, for older worker images, as
  `RS_FLEET_HOST_TOKEN`: that name carries the ticket too.

## Code conventions

- **`src/plan.ts` stays pure**: no Docker, no network, no clock of its own.
  Every rule that starts or stops a worker lives there, so `tests/plan.test.ts`
  covers it without a daemon.
- **Nothing in the loop throws.** `src/client.ts` answers `null`, `false`,
  `'refused'` or `'stale'`; each `src/docker.ts` action answers an error
  string, and a read answers `null` when the daemon cannot be asked. One
  failed call must not stop the next tick.
- **No runtime dependencies.** The image is node, the Docker CLI and `dist/`.
  Don't add one, and don't import `@recycle-erp/shared`.
- **Relative imports end in `.js`** (NodeNext). The backend and frontend use
  extensionless imports, so fix them when moving code across.

## Hand-kept copies

Nothing checks that these agree. Change both sides in one PR.

| Here | There |
| --- | --- |
| `src/types.ts`: `Desired`, `ReportContainer`, `Report`, `Hold`; the ticket answer `src/client.ts` parses | `packages/shared/src/fleet.ts`: `DesiredAnswer`, `FleetHostContainer`, `FleetHostReport`, `ClaimTicketAnswer`. They already differ: the shared `hold` also admits any string. The `DesiredAnswer` in `src/client.ts` is a different type of the same name. |
| `IMAGE_REF` in `src/types.ts` | `IMAGE_REF` in `apps/backend/src/fleet/hosts.ts` |
| The `EXIT_*` codes in `src/plan.ts` | The `EXIT_*` codes in `trackers/facebook/rs_worker/entry.py`, which mirror the vendored monitor's. Match them by value: the names differ. |
| Worker ids as `<host>-<n>` (`workerId`, `workerIndex` in `src/plan.ts`) | `ownWorkerId` in `apps/backend/src/fleet/hosts.ts`; `workerIndex` in `apps/frontend/src/pages/desktop/fleet/fleetBoard.ts` |
| `src/agent.ts`, `src/state.ts`, `tests/helpers/fake-docker.ts` | `apps/backend/tests/fleet-hosts.test.ts` imports them by path, so a rename or a changed export breaks the backend suite |

## Contract with the ERP

`src/client.ts` calls `GET /api/fleet/hosts/:id/desired` and
`POST …/stopped`, `…/tickets` and `…/report`, served by
`apps/backend/src/fleet/hosts.ts` behind `hostAuth`
(`apps/backend/src/fleet/auth.ts`). `FLEET_URL` is the ERP's Cloudflare
Worker, never the Railway origin (README → *Environment*). Every call
carries `X-Fleet-Agent-Instance`, and `X-Fleet-Docker-Daemon` once the
daemon id is known. The three POSTs are CSRF-exempt by the
`FLEET_HOST_REPORT` pattern in `apps/backend/src/csrf.ts`, so a new POST
route needs adding there. Agents in the field outlive an ERP release: deploy
the backend side first and keep it accepting what older agents send (root
AGENTS.md → *Contracts*).

## Tests

- `pnpm --filter recycle-erp-fleet-agent test`, `typecheck` and `build`. No
  database. `.github/workflows/backend-tests.yml` runs the suite, with
  `pnpm typecheck` and the backend suite, on any change under
  `apps/fleet-agent/`.
- `FLEET_AGENT_LIVE_DOCKER=1` adds `tests/live-docker.test.ts` against the
  real daemon. It never runs the worker image.
- After changing the protocol, the planner, `src/state.ts` or the fake
  Docker, also run the backend's
  `cd apps/backend && npx vitest run tests/fleet-hosts.test.ts`. That one
  needs the backend's test database
  ([apps/backend/AGENTS.md](../backend/AGENTS.md) → *Tests*).
- Never validate a change by restarting a live agent's workers. The tests
  compose the real planner with a fake Docker for that reason.

## Version and image

- **The agent has no version of its own.** The `0.1.0` in its `package.json`
  means nothing. The image build writes the root `package.json` version to
  `VERSION`, `src/version.ts` reads it, and `FLEET_AGENT_VERSION` overrides
  what a report says. A change here is ERP code: it needs the root bump and
  a `CHANGELOG.md` section (root AGENTS.md → *Workspace*).
- **Don't assume a merge published the image.** How it is built and pushed,
  and the gate on its CI job, are in `docs/agents/erp-ops.md` →
  *Fleet agent image*.
- A host runs a new agent only when someone re-runs its `docker run`, which
  leaves running workers alone (README → *Run on a host*).
