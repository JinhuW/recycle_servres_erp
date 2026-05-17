# Design: Migrate backend off Cloudflare Workers to Docker

**Date:** 2026-05-16
**Status:** Approved

## Problem

The backend currently runs as a Cloudflare Worker (`wrangler dev` / `wrangler
deploy`). This is not the intended deployment model. We want a self-hosted,
Docker-based stack.

The codebase is already mostly Cloudflare-agnostic: it uses Hono,
`postgres` (postgres-js), `@tsndr/cloudflare-worker-jwt` (pure JS), and Node's
`AsyncLocalStorage`. The only true Cloudflare seams are:

1. The Workers runtime itself (no Node HTTP server).
2. The R2 bucket binding (`env.R2_ATTACHMENTS`).
3. The Workers AI binding (`env.AI`, OCR fallback only).

## Decisions

- **Object storage:** keep the existing Cloudflare R2 bucket, but access it via
  its S3-compatible API instead of the Workers binding. Zero data migration;
  public CDN URL unchanged.
- **Scope:** full self-hosted stack in one `docker compose up` — backend,
  frontend (static build behind a reverse proxy), and Postgres.
- **Workers AI:** removed entirely. OpenRouter is already the production OCR
  default; the deterministic stub is kept for tests/offline.

## Architecture

```
Browser ──443──> Caddy ──┬── /            -> static frontend (built SPA)
                         └── /api/*       -> backend:8787 (Node + Hono)
                                                  ├── Postgres (compose service)
                                                  ├── Cloudflare R2 (S3 API, external)
                                                  └── OpenRouter (OCR, external)
```

Caddy is the single public entrypoint: reverse proxy, automatic HTTPS, and
static file serving for the SPA.

## Component changes

### Runtime seam (Workers → Node)

- New entry `apps/backend/src/server.ts` imports the existing `app` from
  `index.ts` and serves it via `@hono/node-server`.
- Env handling: Cloudflare injects `c.env` (bindings) today. Replace with a
  config object built once from `process.env`. `server.ts` does
  `serve({ fetch: (req) => app.fetch(req, buildEnv()) })`.
- The existing test suite already calls `app.fetch(req, testEnv)` with an
  explicit env object. That path is **unchanged** — no test rework needed.
- `Env` type in `types.ts` changes from Cloudflare bindings (`AI`,
  `R2_ATTACHMENTS`) to plain config fields (DB URL, JWT secret/issuer, R2 S3
  credentials, OpenRouter key/model).

### R2 seam (binding → S3 API)

- Rewrite `src/r2.ts` to use `@aws-sdk/client-s3` pointed at R2's S3 endpoint
  (`https://<account>.r2.cloudflarestorage.com`). `put`/`delete` become
  `PutObjectCommand` / `DeleteObjectCommand`.
- Bucket (`recycle-erp-attachments`) and public URL unchanged → existing stored
  files keep working, zero data migration. `R2_ATTACHMENTS_PUBLIC_URL` must be
  the exact base the R2 custom domain serves objects under — for
  `static.recycleservers.com` that is
  `https://static.recycleservers.com/recycle-erp-attachments` (objects are
  served at `/<bucket>/<key>`), not the bare domain.
- Preserve the existing stub fallback (returns `data:` URLs when storage is
  unconfigured) so tests stay offline.
- **Prerequisite (user-provided):** an R2 API token (Access Key ID + Secret)
  and the account R2 S3 endpoint, supplied as env vars / Docker secrets.

### Workers AI seam (remove)

- Delete `src/ai/workers-ai.ts`.
- Simplify `src/ai/index.ts` provider selection to `openrouter | stub` (drop
  the `workers-ai` branch).
- Remove the `AI` field from `Env`. Runtime behavior unchanged (OpenRouter is
  already the prod default).

### Containers & tooling

- **Backend Dockerfile:** multi-stage — pnpm install → `tsc` build → slim Node
  runtime running `dist/server.js`. Entrypoint runs `db:migrate` then starts
  the server (single instance, so no migration race).
- **Frontend:** build stage produces static assets; Caddy serves them. Vite's
  dev proxy stays for local development.
- **docker-compose.yml:** extend the existing file (keep the `postgres` service
  as-is) with `backend`, `frontend` (build), and `caddy`. Secrets via a
  git-ignored `.env`.
- **package.json:** `dev` → `tsx watch src/server.ts`; remove `deploy`
  (wrangler) and the `wrangler` / `@cloudflare/workers-types` / Workers-AI
  related deps. `.dev.vars` → `.env` (dotenv is already a dependency).

## Verification

- `pnpm typecheck` clean.
- `vitest run` green (suite essentially untouched).
- `docker compose up` brings the full stack live, with a working login and a
  label-scan smoke test against real R2.

## Scope guardrails (YAGNI)

Out of scope: Kubernetes, CI/CD pipeline, multi-replica / load balancing,
migrating data off R2, local OCR model. Single-host Docker Compose only.
