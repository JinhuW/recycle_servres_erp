# Facebook tracker — `trackers/facebook/`

Facebook Marketplace fleet for Recycle Servers. It has three parts:

- **Monitor**: region-pinned worker VMs search Marketplace for server hardware,
  an LLM filters the results, and a coordinator dedupes them and alerts Telegram.
- **Poster**: publishes "we buy servers" ads.
- **Messenger**: bridges seller inboxes to the same chat.

It is all **Python**, unlike the rest of this repo. `README.md` is the full
manual (around 860 lines), so read its sections by name rather than end to end.
This file covers the map, the gates and the traps. The root
[AGENTS.md](../../AGENTS.md) has the repo map and workflow.

## Components

| Path | What | Entry |
| --- | --- | --- |
| `rs_coordinator/` | Control plane (FastAPI): listing dedupe, Telegram alerts, Fernet account vault + TOTP, 2FA codes, heartbeats, challenges, incidents, message routing, per-worker config generation. SQLite locally, Railway Postgres in prod (`POSTGRES.md`). | `rs_coordinator.app:app` :8500; CLI `rsc` |
| `rs_console/` | Allowlisted, read-mostly facade over the coordinator. It serves the fleet dashboard and a noVNC bridge and is **the only surface the ERP talks to**. | `rs_console.app:app` :8600 |
| `rs_poster/` | Buy-ad poster (Playwright). Owns the Facebook session and account lock. | `rs-poster`, `rs-session` |
| `rs_messenger/` | Inbox scraper; sends the replies the coordinator queues. Depends on `rs-poster`. | `rs-messenger` |
| `rs_router/` | Bridges mautrix-meta Matrix rooms to the coordinator's messages API (stdlib only). | `rs-router` |
| `rs_fleetd/` | Host agent, one per Docker host: runs the workers the coordinator assigns to it (`fleet.py`), rolls releases one worker at a time, keeps everything running when the coordinator is down (stdlib + docker CLI). | `rs-fleetd` |
| `configs/` | `master.toml` (what to search) + `fleet.toml` (who searches where) → `configs/generated/` via `rsc gen-configs`. | — |
| `deploy/`, `scripts/`, `infra/` | Compose files for the homelab VM, the deploy/release/secret/vendor gates, and Terraform for the coordinator's Railway Postgres. | — |

Each component has its own `pyproject.toml`. Workers are the vendored
`ai-marketplace-monitor` fork, which calls the coordinator over HTTP with Bearer
tokens. README → *How it fits together* has the diagram.

The coordinator's tables are described in the root
[docs/DATABASE.md](../../docs/DATABASE.md). A change to `SCHEMA` or to an
`*_EXTRA_COLUMNS` list in `rs_coordinator/db.py` updates that section in the
same PR.

## Contract with the ERP

The ERP backend (`apps/backend/src/routes/coordinator.ts`, `src/vncBridge.ts`)
proxies the ERP's Monitors ▸ Facebook pages to rs_console at
`COORDINATOR_API_URL` (`https://fbc-api.recycleservers.com`, a Cloudflare
tunnel). It sends Bearer `COORDINATOR_API_TOKEN`, which must equal
rs_console's `RS_CONSOLE_TOKEN`, plus Cloudflare Access headers.

Forwarded today:
- `GET /v1/workers`, `/v1/fleet`, `/v1/stats/reviews`, `/v1/stats/alert-hits`,
  `/v1/config/filter-prompt`, `/v1/challenges`,
  `/v1/challenges/{id}/screenshot`. `/v1/fleet` is composed here, so a new
  field in it is a contract change too: its `status_changes` (from the
  coordinator's `/v1/stats/status-changes`) feed the ERP's Recent activity.
- `GET /v1/logins?worker_id=` (one worker's login ledger, without the device
  fingerprints) for the account timeline on the ERP's worker page.
- `POST /v1/workers/{id}/relogin`, `/v1/challenges/{id}/resolve`
- `PUT /v1/accounts/{id}` (credentials write)
- `PUT /v1/config/settings` (search settings; `rs_console/settings.py` lists
  the keys, and the README's *Settings saved from the ERP* says where they live)
- `PUT /v1/workers/{id}/cities` (one worker's cities, into its own config)
- `PUT /v1/workers/{id}/queue` and `PUT /v1/queue/everyone` (`{enrolled}`:
  one worker, or every worker, into the city queue or out of it). `/v1/fleet`
  also carries the queue: today's round as `queue`, and each worker's part in
  it as its `queue`. Both are `null` against a coordinator that predates the
  queue.
- `GET/POST /v1/queue/start` (start the city round now instead of at the
  workers' start times: the preview, and the start, signed `updated_by`).
  `/v1/fleet`'s `queue.started` is the running start, and is absent against
  a coordinator that cannot start one.
- `GET /v1/city-log?worker_id=|city=&hours=` (the city log: each city a
  worker searched, from handout to result, with its steps). A coordinator
  that predates it answers 404, and the ERP then shows no log.
- `GET/PUT /v1/city-tiers` (how often cities are searched: the rank rule and
  pins, kept by the coordinator; workers read them through
  `POST /v1/workers/{id}/search-plan`)
- the VNC websocket

**Not forwarded to the ERP: the rest of the city queue** (README → *City queue*).

- **Workers** ask the coordinator directly with
  `POST /v1/workers/{id}/next-city`, and report each city's start and end
  with `POST /v1/workers/{id}/city-events`.
- **rs_console** pushes the coordinator `PUT /v1/queue/roster` every 10
  minutes.
- **Operators** use `rsc queue status|enroll|unenroll|set|show|start|log` in
  rs-coordinator for the queue and its settings (`/v1/queue/settings`,
  `/v1/queue/status`).
- **The replay** is the console's `POST /v1/queue/shadow`, run with
  `python -m rs_console.queue_shadow`.

The ERP reaches the queue only through `/v1/fleet` and the two enrollment
routes above.

Renaming or reshaping any of these is a change to both sides (root AGENTS.md →
*Contracts*). Ship the console first and keep it backward-compatible until the
ERP release lands. `rs_console/rs_console/static/fleet.css` mirrors the ERP's
`tokens.css` and `desktop.css` by copy, so keep the two in step.

## Versioning, releases, deploys

- **One version for the whole fleet.** It lives in `VERSION`, the pyprojects
  and `CHANGELOG.md` (Keep a Changelog; while on 0.x, a minor bump is
  breaking). Write the change under `[Unreleased]`, then run
  `scripts/release.sh patch|minor|X.Y.Z`. That runs every gate and suite, bumps
  the version, commits **only this folder**, and tags `facebook-tracker/vX.Y.Z`.
  `--dry-run` changes nothing.
- **Releases are judged on this subtree only.** `scripts/check-release-tag.sh`
  wants a clean tree here, an existing `facebook-tracker/v$(cat VERSION)` tag,
  and no change under `trackers/facebook/` since that tag. ERP commits
  elsewhere never block it. The ERP's own `v*` tags are a different namespace;
  never create a bare `v*` tag for this tracker.
- **Deploy with `scripts/deploy.sh`.** It runs the release gate, then rsyncs
  this tree to `jinhu@10.10.10.73:~/recycle_servers/facebook_tracker`, rebuilds
  the coordinator, the console and the worker image, restarts the workers,
  verifies they run this tree, and stamps the VM. Once the VM runs `rs-fleetd`,
  "restarts the workers" becomes `rsc fleet release <version>`: the agent
  recreates one worker at a time and the deploy never touches a compose worker
  again (README → *Fleet agent and rolling releases*). Use
  `scripts/deploy.sh sync` for config-only changes and `scripts/deploy.sh
  check` to verify only. Details are in README → *Deploying to the homelab
  worker* and `deploy/README.md`.
- **The vendored monitor is gitignored and pinned.** `ai-marketplace-monitor/`
  (AGPL-3, our patches on its local `recycle-patches` branch) and
  `facebook-marketplace-bot/` (reference only) are cloned into this folder, not
  tracked. `VENDOR.md` pins their revisions and `scripts/check-vendor.sh`
  verifies them. Release, deploy and the worker image all fail until they are
  cloned here. Never push `recycle-patches` to the upstream `origin`.
- **History.** This tree was imported from the archived `JinhuW/facebook_tracker`
  repo with its history rewritten (a proxy-credentials file and the
  once-inlined vendor tree were dropped). Commit hashes cited before 2026-10-16,
  here or in the ERP `CHANGELOG.md`, resolve only in that archived repo.

## Secrets

- Live credentials sit next to this tree and are only gitignored:
  `configs/secrets.env`, `configs/sessions/`, the Matrix bridge configs and
  `fb_state*.json`. That includes Facebook sessions, the vault key and the
  coordinator tokens.
- `scripts/check-secrets.sh` scans what is staged; `--all` scans every tracked
  file. Run it before committing here, because the repo-level
  `.githooks/pre-commit` scanner does not know these path rules. If a line is
  wrong-flagged, append `pragma: allowlist secret`.
- Rotate anything that ever reached a commit; a secret in history does not come
  back out quietly.

## Tests

Two venvs, created in this folder: `.venv-coordinator`, which holds the
`rs_*` packages, and `.venv-aimm`, which holds the vendored monitor. The exact
commands are in README → *Tests*:

```bash
AIMM_PYTHON=$PWD/.venv-aimm/bin/python .venv-coordinator/bin/python -m pytest \
    rs_coordinator/tests rs_poster/tests rs_messenger/tests
sh scripts/tests/test-version-gate.sh && sh scripts/tests/test-check-secrets.sh \
    && sh scripts/tests/test-deploy-filter.sh
```

Without `AIMM_PYTHON`, the generated-config tests skip silently. Running
`scripts/release.sh --dry-run patch` is the one-shot check of the gates, the
suites above and the vendored monitor's.

- **Run rs_console's suite from inside `rs_console/`**:
  `cd rs_console && ../.venv-coordinator/bin/python -m pytest tests -q`. From
  this folder, `python -m pytest` puts the cwd first on `sys.path`, so the outer
  `rs_console/` (no `__init__.py`) imports as a namespace package and shadows
  the real one. Collection then fails with `No module named 'rs_console.app'`,
  or `cannot import name '__version__' from 'rs_console' (unknown location)` if
  the package is installed. `release.sh` runs it (and `rs_fleetd/tests`) from
  inside the package; it does not run `rs_router/tests`, so run that by hand
  when you touch it.
- **Never point `RS_TEST_DATABASE_URL` at port 5432 or 55432.** Those are the
  ERP's local databases (its compose Postgres and the `recycle-erp-testdb`
  container), and `test_postgres.py` drops every table it touches.
  `conftest.py` only refuses a URL equal to `RS_DATABASE_URL` /
  `DATABASE_URL`, so it cannot catch this. Use a throwaway on a free port, as
  in `rs_coordinator/POSTGRES.md`.
- **Running the coordinator by hand from an ERP shell** picks up the ERP's
  `DATABASE_URL` (the root `.env` points it at the `recycle-erp-testdb`
  container on 55432), so `RS_COORDINATOR_DB` is ignored and the coordinator
  creates its tables in the ERP's test database. Start it with
  `env -u DATABASE_URL -u RS_DATABASE_URL …` and check that `/healthz` says
  `"backend":"sqlite"`.

## Constraints

README → *Constraints worth knowing* is the authoritative list. In short:

- Automating Marketplace violates Facebook's ToS, so treat every worker
  account as replaceable.
- Keep the pacing in `master.toml` / `ads.toml` conservative.
- Poster selectors live in `rs_poster/rs_poster/selectors.py`; run
  `rs-poster post --dry-run` after any Facebook UI change.
- Keep the AGPL monitor a separate process that talks over HTTP, and never
  distribute it.
