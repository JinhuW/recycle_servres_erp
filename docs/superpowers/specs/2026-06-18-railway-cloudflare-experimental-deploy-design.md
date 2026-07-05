# Experimental Railway + Cloudflare deployment — design

**Status:** approved (2026-06-18)
**Branch:** `experiment/railway-cloudflare-deploy`
**Nature:** Experimental. A second, throwaway-friendly deployment that runs
*alongside* the production Docker Compose stack. It must not modify the Compose
files, the Dockerfiles' behavior, `README.md`, or any existing convention. All
new artifacts are additive.

## Goal

Run the ERP without the self-hosted Docker stack:

- **Backend** (Hono/Node + Postgres) on **Railway**.
- **Frontend** (Vite/React SPA + PWA) on **Cloudflare Workers Static Assets**.

The browser must see a **single origin** so the existing auth model keeps
working untouched.

## Why same-origin (the pivotal constraint)

The app today is same-origin in prod (Caddy proxies `/api`, `/oauth`,
`/.well-known` to the backend):

- Auth cookies `at`/`rt` are httpOnly, `SameSite=Lax`, `secure` only when
  `NODE_ENV=production` (`apps/backend/src/auth.ts`).
- The SPA calls the backend with **relative** paths and the `X-Requested-By`
  CSRF header (`apps/frontend/src/lib/api.ts`).

A naive split (SPA on Cloudflare calling Railway directly) is cross-origin:
`Lax` cookies would not ride along, and we'd need `SameSite=None;Secure` +
CORS-with-credentials + a `VITE_API_BASE` rewrite of `api.ts`. Rejected as too
invasive for an experiment.

**Chosen model:** the Cloudflare Worker serves the SPA *and* reverse-proxies
the API paths to the Railway backend, so the browser only ever talks to the
Worker origin. Same-origin → `Lax` cookies, CSRF, and relative paths all work
with **zero backend source changes**.

## Topology

```
Browser ──https──> Cloudflare Worker (<app>.workers.dev)
                     ├─ /                  → serve SPA static assets (dist/)
                     ├─ /api/*        ┐
                     ├─ /oauth/*      ├─ reverse-proxy ─https─> Railway backend
                     └─ /.well-known/*┘                          (<svc>.up.railway.app)
                                                                      │
                                                                      └─> Railway Postgres (private)
```

## Components

### 1. Cloudflare Worker (`deploy/cloudflare/`, new, additive)

- `wrangler.toml`:
  - `main = "worker.js"`
  - `assets = { directory = "../../apps/frontend/dist", binding = "ASSETS", not_found_handling = "single-page-application" }`
  - `[vars] BACKEND_URL = "<railway public url>"` (filled after the backend is
    deployed; documented as a wiring step).
- `worker.js`: a `fetch` handler.
  - If `pathname` starts with `/api`, `/oauth`, or `/.well-known`:
    proxy to `BACKEND_URL + pathname + search`, forwarding method, headers
    (Cookie, `X-Requested-By`, Content-Type, …) and body verbatim; return the
    upstream response (including `Set-Cookie`) unchanged. `redirect: 'manual'`
    so 3xx (OAuth) pass through.
  - Otherwise: `return env.ASSETS.fetch(request)` (SPA fallback handles
    client-side routes).
- Build: `pnpm --filter recycle-erp-frontend build` (relative paths, **no**
  `VITE_API_BASE`) → `wrangler deploy`.

### 2. Railway backend

- New project in workspace **My Projects**: a **Postgres** instance + one
  **backend service**.
- Backend builds from the **existing** `apps/backend/Dockerfile`:
  - Build context = repo root, dockerfile path = `apps/backend/Dockerfile`.
  - Configured in the Railway **service settings** (root dir `/`, dockerfile
    path) — **not** via a committed `railway.json`, so the repo stays
    unchanged. The Dockerfile's `CMD` already runs
    `migrate → init-admin → start`, which suits Railway's single instance (no
    migration race).
- `PORT` is injected by Railway; `server.ts` already reads `process.env.PORT`.
- Healthcheck path: `/api/health` (returns 200 only when Postgres is
  reachable).

#### Backend env vars (set on the Railway service)

| Var | Value | Why |
|-----|-------|-----|
| `DATABASE_URL` | Railway Postgres reference var | DB connection |
| `NODE_ENV` | `production` | enables `secure` cookies + CORS guard |
| `CORS_ALLOWED_ORIGINS` | the Worker URL | required at boot in prod; also resolves the OAuth issuer |
| `JWT_SECRET` | freshly generated | isolate experiment sessions from prod |
| `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ATTACHMENTS_PUBLIC_URL` | reused from current `.env` | full attachment/scan storage |
| `OPENROUTER_API_KEY` | reused from current `.env` | label OCR (else silent stub) |
| `ADMIN_PASSWORD` | overridden (not `admin`) | internet-exposed; harden the seeded admin |
| `ENABLE_DEMO_ACCOUNTS` | `false` | prevents username enumeration |
| `OAUTH_SIGNING_KEY_CURRENT` | freshly generated Ed25519 key | **required at boot** when `NODE_ENV=production` (`env.ts:42`) |

- **Boot-guard correction (discovered during execution):** `env.ts` refuses to
  boot in production without `OAUTH_SIGNING_KEY_CURRENT` (base64-encoded
  Ed25519 PKCS#8 PEM — generate with `openssl genpkey -algorithm ed25519 |
  base64 -w0`). This was originally scoped out; it is in fact mandatory, so a
  fresh key is generated and set. `OAUTH_SIGNING_KEY_PREVIOUS` stays unset (no
  rotation needed on the experiment).

### 3. Dedicated ops page (`docs/deployment-railway-cloudflare.md`, new)

A standalone runbook, clearly marked **experimental**, separate from the Docker
docs. It does **not** edit `README.md`. Covers:

- Prerequisites (Railway access, `wrangler login`, the source `.env` secrets).
- Railway provisioning steps + the env-var table.
- Cloudflare Worker build + deploy commands.
- The URL wiring order (chicken-and-egg):
  1. Deploy Railway backend → get `<svc>.up.railway.app`.
  2. Set Worker `BACKEND_URL` to it; `wrangler deploy` → get `<app>.workers.dev`.
  3. Set backend `CORS_ALLOWED_ORIGINS` to the Worker URL; redeploy backend.
- Teardown (delete Railway project, delete Worker).

## Execution scope

- **Railway:** provisioned now via the Railway MCP (project, Postgres, service,
  build config, env, deploy).
- **Cloudflare:** Worker + wrangler scaffolded in-repo; deploy is run via
  `wrangler deploy` (needs the user's `wrangler login`).

## Out of scope / non-goals

- No changes to `docker-compose*.yml`, the Dockerfiles' behavior, `README.md`,
  or `CLAUDE.md`.
- No custom domains (use default `*.workers.dev` / `*.up.railway.app`).
- No `OAUTH_SIGNING_KEY_PREVIOUS` / key rotation, and no MCP-client setup on the
  experiment. (`OAUTH_SIGNING_KEY_CURRENT` itself is **required** — see the
  boot-guard correction above.)
- No CI/CD wiring; deploys are manual.

## Risks / notes

- PWA service worker is served as a static asset; runtime caching targets
  assets, not the proxied API, so it does not interfere with auth.
- The seeded admin is internet-reachable on the experiment — hence the
  `ADMIN_PASSWORD` override and `ENABLE_DEMO_ACCOUNTS=false`.
- Reusing prod R2 means experiment uploads land in the prod attachments
  bucket. Acceptable for now; teardown does not purge them.
