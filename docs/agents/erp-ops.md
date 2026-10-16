# ERP operations — Docker, Cloudflare Workers, Terraform

Read this before deploying or releasing the ERP, or touching `deploy/`,
`backup/`, `infra/`, `docker-compose*.yml` or a Railway / Cloudflare setting.
The release flow itself (`dev` → `main` is a full release) is in the root
[AGENTS.md](../../AGENTS.md); the trackers deploy separately — see their own
`AGENTS.md`.  Long-form runbooks: `docs/deployment-railway-dev-prod.md`,
`docs/deployment-railway-cloudflare.md`, `docs/backups-cloud-runbook.md`.

## Docker & ops

- **The backend container exits on SIGTERM** (v1.196.1).  The Dockerfile
  `exec`s `node --import tsx src/server.ts`, so node holds the signal, and
  `lib/shutdown.ts` stops the loops, drains in-flight requests for 20s, cuts
  what is left (MCP streams never end on their own), closes the pool and
  exits by 25s.  A new background loop must return `{ stop }` and join the
  `loops` list in `server.ts`.  Railway's draining window has to exceed 25s,
  or SIGKILL lands first: the backend's `drainingSeconds` is 30 on prod and
  dev (set through the Railway API).  Don't put `pnpm start` back in the CMD: `sh -c`
  held PID 1 and forwarded nothing.
- **`seed.mjs` and `migrate.mjs --reset` refuse a non-local `DATABASE_URL`**
  (v1.196.1), and anything at all under `NODE_ENV=production` (v1.200.2).
  Local means `localhost`, `127.0.0.1`, `::1` or the compose `postgres`
  service — which is the real database on a self-hosted prod stack, hence
  the `NODE_ENV` check.  Override with `ALLOW_DESTRUCTIVE_SEED=true` or
  `ALLOW_DESTRUCTIVE_RESET=true`.  A shell can carry a `DATABASE_URL` left
  over from a Railway session, which is how a laptop reseed could reach real
  data.
- **The nightly prod→dev copy scrubs credentials**
  (`deploy/railway-sync/scrub.sql`, v1.196.1).  It truncates the refresh,
  OAuth and login-attempt tables and nulls OAuth client secrets, inside the
  restore transaction.  A new table holding a token belongs in that file.  An
  FK onto a scrubbed table fails `tests/sync-scrub.test.ts`, which is the
  point.  Qualify every name in it with `public.`, because the dump before it
  empties `search_path` (v1.211.1).

- `docker-compose.yml` is the prod-shaped stack.  Every service has
  `cap_drop: ALL` + `no-new-privileges` + memory caps + JSON log rotation.
  When you add a service, copy that block.
- The Postgres container is **not host-published** in prod — `backend`
  reaches it as `postgres:5432` over the compose net.  The override file
  re-publishes it on `127.0.0.1:5432` for the host vitest suite only.  Never
  bind it to `0.0.0.0`.
- Postgres needs `CHOWN, DAC_OVERRIDE, FOWNER, FSETID, SETGID, SETUID`
  re-added (its entrypoint runs as root then drops to `postgres`).  Caddy
  needs `NET_BIND_SERVICE` (binds :80 non-root via file caps).  Don't widen
  these.
- Single `.env` at the repo root drives the whole stack — Compose
  interpolation, the backend container's `env_file:`, and host-side
  `pnpm dev` (via `apps/backend/scripts/load-env.mjs`, which resolves the
  path off its own location so CWD/workspace filter don't matter).
  `POSTGRES_PASSWORD` defaults to `recycle` if unset; override in prod.
  See [the Docker migration design][3].
- `CORS_ALLOWED_ORIGINS` is required in production — the backend throws on
  startup if `NODE_ENV=production` and it's unset.
- **Unhandled-500 sink.** `app.onError` writes a JSONL record to
  `ERROR_LOG_DIR/errors.jsonl` (compose mounts `./data/errors:/var/log/recycle-erp`).
  Rotates at 10 MB, keeps last 10.  Pre-create the host dir with
  `mkdir -p data/errors && sudo chown 1000:1000 data/errors` — without it
  the backend (UID 1000) can't write and the sink silently degrades to
  stdout-only.  Records are version/commit-stamped by `appendErrorRecord`
  itself — callers never pass them.  See `apps/backend/src/lib/error-log.ts`.

## Cloudflare Worker deploys

- Deploy the frontend Workers with `deploy/cloudflare/deploy.sh <prod|dev>` —
  it builds, deploys, and smoke-checks every public hostname through
  Cloudflare. Don't run bare `wrangler deploy`.
- **Every public hostname must be declared in `wrangler.toml` routes**
  (`custom_domain = true`). Deploys reconcile custom domains against the
  file; a domain attached only via the CF dashboard gets its DNS record +
  cert deleted by the next deploy → sitewide 523 while Railway stays green.
  See `docs/debug-notes/2026-07-13-cloudflare-worker-custom-domain-deleted.md`.
- Pushes to `main` and `dev` auto-deploy their Worker via
  `.github/workflows/deploy-frontend.yml` (needs `CLOUDFLARE_API_TOKEN` repo
  secret); the branch picks the target (`main` → prod Worker). The Railway
  production environment also tracks `main` (the `prod` branch is retired,
  2026-07-20), so a `dev`→`main` merge is a full release. The `uptime-monitor` Railway cron
  (`deploy/railway-uptime/`) probes prod every 5 min as the backstop.
- **Browser security headers live in `apps/frontend/public/_headers` under
  `/*`** (CSP, frame, nosniff, referrer, permissions). Cloudflare applies them to
  what the Worker fetches from `ASSETS` and to the SPA fallback built from
  `index.html`, so don't duplicate them in `worker.js`. Every CSP change must
  also bump the `csp-rev` meta in `index.html`: the service worker serves
  navigations from its precached index.html *with the headers it was cached
  with*, and only re-precaches when the file's bytes change.
- **The real client IP reaches the backend as `X-Client-IP`**, set by the
  Worker from `CF-Connecting-IP`. Railway rewrites `X-Forwarded-For` to a
  Cloudflare egress address shared by every user, so anything keyed per IP
  must read `X-Client-IP`.  In the backend that means `lib/clientIp.ts`: `full`
  to store, `key` (IPv6 grouped by /64) for a limiter.  A limit that would
  lock people out when every request looks like the same few Cloudflare
  addresses must skip itself while `X-Client-IP` is absent, as the per-IP
  login budget does.

## Infrastructure (Terraform)

- `infra/terraform/` owns Cloudflare side: R2 attachments bucket, custom
  domain, scoped API token.  State lives in the `recycle-erp-tfstate` R2
  bucket.  See [the Terraform module design][4].
- The attachments bucket carries `prevent_destroy = true`.  If you need to
  destroy it, edit the lifecycle block in the same change — don't pass
  `-target` flags to work around it.

[3]: ../../docs/superpowers/specs/2026-05-16-docker-migration-design.md
[4]: ../../docs/superpowers/specs/2026-05-17-cloudflare-terraform-module-design.md
