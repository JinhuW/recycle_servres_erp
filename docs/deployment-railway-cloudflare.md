# Deployment: Railway + Cloudflare (Experimental)

> **EXPERIMENTAL** — this deployment runs alongside, and does not replace, the
> production Docker Compose stack. It is a throwaway-friendly second target on
> branch `experiment/railway-cloudflare-deploy`. The Compose files, Dockerfiles,
> `README.md`, and `CLAUDE.md` are **not** touched.

---

## Architecture

The browser only ever talks to the Cloudflare Worker. The Worker serves the SPA
for non-API paths and reverse-proxies `/api`, `/oauth`, and `/.well-known` to the
Railway backend. This preserves same-origin semantics so the existing auth model
(`SameSite=Lax` httpOnly cookies, `X-Requested-By` CSRF, relative paths in
`api.ts`) works with **zero backend source changes**.

```
Browser ──https──> Cloudflare Worker (recycle-erp-experiment.jinhuwang1127.workers.dev)
                     ├─ /                  → serve SPA static assets (dist/)
                     ├─ /api/*        ┐
                     ├─ /oauth/*      ├─ reverse-proxy ─https─> Railway backend
                     └─ /.well-known/*┘               (backend-production-7b10.up.railway.app)
                                                                     │
                                                                     └─> Railway Postgres (private network)
```

Config files: `deploy/cloudflare/wrangler.toml` and `deploy/cloudflare/worker.js`.

---

## Prerequisites

- Railway account with access to the `recycle-erp-experiment` project (workspace
  **My Projects**).
- Node ≥ 20, `pnpm@11.0.9`.
- `wrangler` available (`npx wrangler` is fine).
- Cloudflare account. Run `npx wrangler login` once to obtain OAuth credentials
  before running any `wrangler` commands (see [Wrangler stale token gotcha](#gotcha-1-wrangler-stale-token) below).
- Repo-root `.env` that contains the R2 credentials (`R2_S3_ENDPOINT`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
  `R2_ATTACHMENTS_PUBLIC_URL`) and `OPENROUTER_API_KEY`.

---

## Railway Setup

### Project and environment

| Field | Value |
|---|---|
| Project name | `recycle-erp-experiment` |
| Project ID | `e811d744-769f-4418-9f22-f371fd889923` |
| Environment | `production` (id `75358457-88d9-42a6-b152-07b57d681c39`) |

### 1. Provision Postgres

Deploy the `postgres` template into the project. Railway assigns a private
`DATABASE_URL`. Service ID: `4e8431c0-d347-4c20-a6a8-9e54b9cf1417`.

### 2. Provision the backend service

Create a service named `backend` (id `26d2f448-d4f2-4f67-b2ef-1628ef27a5c0`).
Connect it to GitHub repo `JinhuW/recycle_servres_erp`, branch
`experiment/railway-cloudflare-deploy`.

In **Service Settings → Build**, set:

| Setting | Value |
|---|---|
| Root directory | `/` |
| Dockerfile path | `apps/backend/Dockerfile` |
| Health check path | `/api/health` |

`PORT` is injected automatically by Railway; `server.ts` already reads it.

### 3. Set backend environment variables

Set the following in the `backend` service's **Variables** tab. Never commit
secret values.

| Variable | Value / how to generate |
|---|---|
| `DATABASE_URL` | Railway reference variable `${{Postgres.DATABASE_URL}}` — add via the "Reference" button, not plain text |
| `NODE_ENV` | `production` |
| `ENABLE_DEMO_ACCOUNTS` | `false` |
| `CORS_ALLOWED_ORIGINS` | the Worker URL (see [URL wiring order](#url-wiring-order)) |
| `JWT_SECRET` | generate fresh: `openssl rand -base64 48` — do not reuse prod value, do not commit |
| `ADMIN_PASSWORD` | generate and record out-of-band — do not commit; the seeded admin is internet-reachable |
| `OPENROUTER_API_KEY` | copy from repo-root `.env` |
| `R2_S3_ENDPOINT` | copy from repo-root `.env` |
| `R2_ACCESS_KEY_ID` | copy from repo-root `.env` |
| `R2_SECRET_ACCESS_KEY` | copy from repo-root `.env` |
| `R2_BUCKET` | copy from repo-root `.env` |
| `R2_ATTACHMENTS_PUBLIC_URL` | copy from repo-root `.env` |
| `OAUTH_SIGNING_KEY_CURRENT` | generate fresh Ed25519 PKCS#8 PEM, base64-encoded: `openssl genpkey -algorithm ed25519 \| base64 -w0` — **mandatory**; the prod boot guard in `apps/backend/src/env.ts` refuses to start without it |

`OAUTH_SIGNING_KEY_PREVIOUS` is not required (no key rotation needed for the
experiment).

**Why `OAUTH_SIGNING_KEY_CURRENT` is mandatory:** `env.ts` has a production boot
guard that rejects startup unless `JWT_SECRET` is non-default, the DB password is
not `recycle`, `CORS_ALLOWED_ORIGINS` is set, `OPENROUTER_API_KEY` is set, and
`OAUTH_SIGNING_KEY_CURRENT` is set. Missing any one of these causes a hard crash
on startup.

> **Note on R2 reuse:** experiment uploads land in the same R2 bucket as
> production. This is acceptable for a throwaway experiment. Teardown does not
> purge uploaded objects.

### 4. Deploy and confirm

Trigger a deploy. Check the Railway logs for the migration run, `init-admin`
completion, and the health-check passing at `/api/health`. The backend public URL
is:

```
https://backend-production-7b10.up.railway.app
```

---

## Cloudflare Setup

### Config files

`deploy/cloudflare/wrangler.toml` — already configured with the backend URL:

```toml
name = "recycle-erp-experiment"
main = "worker.js"
compatibility_date = "2026-06-18"

[assets]
directory = "../../apps/frontend/dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = true

[vars]
BACKEND_URL = "https://backend-production-7b10.up.railway.app"
```

`deploy/cloudflare/worker.js` — routes `/api/*`, `/oauth/*`, `/.well-known/*` to
the Railway backend; all other paths fall through to the SPA static assets.

### 1. Build the frontend

From the repo root:

```bash
pnpm --filter recycle-erp-frontend build
```

This writes the production SPA into `apps/frontend/dist/`. The worker's
`[assets] directory` in `wrangler.toml` points to that path relative to
`deploy/cloudflare/`.

Do **not** set `VITE_API_BASE`; the SPA uses relative paths and the Worker
handles the proxy.

### 2. Deploy the Worker

```bash
unset CLOUDFLARE_API_TOKEN   # see gotcha below
cd deploy/cloudflare
npx wrangler deploy
```

The Worker is deployed as `recycle-erp-experiment` to:

```
https://recycle-erp-experiment.jinhuwang1127.workers.dev
```

---

## URL Wiring Order

There is a chicken-and-egg dependency: the Worker URL must be known to set
`CORS_ALLOWED_ORIGINS`, but `CORS_ALLOWED_ORIGINS` must be set before the
backend will start.

The correct sequence:

1. **Deploy the Railway backend** with a placeholder or without
   `CORS_ALLOWED_ORIGINS` (it will crash on startup — that is expected at this
   point).
2. **Build the frontend** (`pnpm --filter recycle-erp-frontend build`).
3. **Confirm `BACKEND_URL`** in `deploy/cloudflare/wrangler.toml` matches the
   Railway backend URL (`https://backend-production-7b10.up.railway.app`).
4. **Deploy the Worker** (`unset CLOUDFLARE_API_TOKEN && cd deploy/cloudflare && npx wrangler deploy`).
   Note the Worker URL: `https://recycle-erp-experiment.jinhuwang1127.workers.dev`.
5. **Set `CORS_ALLOWED_ORIGINS`** on the Railway backend service to the Worker URL.
6. **Redeploy the backend** (Railway redeploys automatically on variable change).
   The prod boot guard now passes and the service comes up healthy.

---

## Verification

After both the backend and Worker are live, run these curls to confirm end-to-end
connectivity.

### Health check — direct to Railway backend

```bash
curl -i https://backend-production-7b10.up.railway.app/api/health
```

Expected: `HTTP/2 200` with a JSON body containing `"status":"ok"` or similar.

### Health check — via the Cloudflare Worker

```bash
curl -i https://recycle-erp-experiment.jinhuwang1127.workers.dev/api/health
```

Expected: same `200` response proxied through the Worker.

### Login — via the Cloudflare Worker (validates CSRF, cookies, and proxy)

```bash
curl -i -X POST \
  -H "Content-Type: application/json" \
  -H "X-Requested-By: recycle-erp" \
  -d '{"email":"admin@recycle.local","password":"<ADMIN_PASSWORD>"}' \
  https://recycle-erp-experiment.jinhuwang1127.workers.dev/api/auth/login
```

Expected: `HTTP/2 200` with `Set-Cookie: at=...` and `Set-Cookie: rt=...` headers.

---

## Gotchas

### Gotcha 1: Wrangler stale token

`~/.zshenv` may export `CLOUDFLARE_API_TOKEN`. Wrangler prefers environment
variables over OAuth; if that token has been revoked you'll see:

```
✘ [ERROR] Invalid access token [code: 9109]
```

Fix: comment out the `export CLOUDFLARE_API_TOKEN=…` line in `~/.zshenv` or run
`unset CLOUDFLARE_API_TOKEN` in the current shell before any `wrangler` command.
`CLOUDFLARE_ACCOUNT_ID` can stay set — it is fine. OAuth login (`npx wrangler login`)
then works normally.

### Gotcha 2: Changelog pre-push gate

The pre-push hook rejects pushes that have `feat`/`fix` commits without a
matching `CHANGELOG.md` entry. For this throwaway experiment branch, bypass the
hook:

```bash
git push --no-verify
```

Do not use `--no-verify` on `main`.

---

## Known limitations & risks

This is an experiment; it accepts trade-offs the production Docker stack does not.

- **`/metrics` is publicly reachable.** The backend mounts an unauthenticated
  Prometheus endpoint at `/metrics`. In the Docker stack this was bound to
  loopback only (`127.0.0.1:9090`, per the 2026-06-10 security review). On
  Railway there is a single public port, so
  `https://backend-production-7b10.up.railway.app/metrics` is world-readable
  (heap/GC internals, HTTP route histograms, OAuth grant counters). The Worker
  does **not** proxy `/metrics` (only `/api`, `/oauth`, `/.well-known`), but the
  Railway URL exposes it directly. Acceptable for a throwaway experiment; a
  real deploy would need Railway private networking or an auth-guarded metrics
  route.
- **R2 bucket is shared with production.** Experiment uploads (label scans,
  attachments) land in the same R2 bucket as prod. **Teardown does NOT remove
  them** — the objects persist in the prod bucket after the experiment is gone.
- **Seeded admin is internet-reachable.** Hence the overridden `ADMIN_PASSWORD`
  and `ENABLE_DEMO_ACCOUNTS=false`.

---

## Teardown

When the experiment is no longer needed:

### Delete the Cloudflare Worker

```bash
cd deploy/cloudflare
npx wrangler delete recycle-erp-experiment
```

This removes the Worker and its routes. The static assets uploaded to Cloudflare
are removed with it. It does **not** remove the `deploy/cloudflare/` source files
from the repo.

### Delete the Railway project

In the Railway dashboard, navigate to the `recycle-erp-experiment` project →
**Settings** → **Danger Zone** → **Delete Project**. This destroys the Postgres
instance and all data. R2 objects uploaded during the experiment are not deleted
(they share the prod bucket).

---

*Branch: `experiment/railway-cloudflare-deploy` — do not merge to `main`.*
