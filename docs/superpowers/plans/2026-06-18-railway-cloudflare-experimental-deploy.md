# Experimental Railway + Cloudflare Deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a second, experimental deployment — backend on Railway, frontend on Cloudflare Workers Static Assets reverse-proxying the API — without modifying the production Docker stack.

**Architecture:** A single Cloudflare Worker serves the built SPA and reverse-proxies `/api`, `/oauth`, `/.well-known` to a Railway backend service, so the browser sees one origin and the existing `SameSite=Lax` cookie + CSRF auth works unchanged. The Railway backend builds from the existing `apps/backend/Dockerfile` (configured in Railway service settings, not in-repo) against a Railway-managed Postgres.

**Tech Stack:** Cloudflare Workers (Static Assets, `wrangler`), Railway (Docker build from connected GitHub repo, managed Postgres), Railway MCP tools, existing Hono/Node backend + Vite/React frontend.

## Global Constraints

- Branch: `experiment/railway-cloudflare-deploy`. All work here.
- Additive only — do NOT modify `docker-compose*.yml`, the Dockerfiles' behavior, `README.md`, or `CLAUDE.md`.
- New code artifacts live under `deploy/cloudflare/`. The dedicated runbook is `docs/deployment-railway-cloudflare.md`.
- Backend gets **zero source changes** — the same-origin proxy is what makes that possible.
- Railway workspace: **My Projects** (`0556aaa2-93c8-4aeb-8a0d-5f71fc83671b`).
- Reuse `R2_*` + `OPENROUTER_API_KEY` from repo-root `.env`; generate a fresh `JWT_SECRET`; set `NODE_ENV=production`, `ENABLE_DEMO_ACCOUNTS=false`, and override `ADMIN_PASSWORD`.
- Commit messages end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

### Task 1: Cloudflare Worker scaffold (SPA + API reverse-proxy)

**Files:**
- Create: `deploy/cloudflare/wrangler.toml`
- Create: `deploy/cloudflare/worker.js`
- Create: `deploy/cloudflare/.gitignore`

**Interfaces:**
- Produces: a deployable Worker that, given env var `BACKEND_URL` (Railway public origin) and an `ASSETS` static-assets binding pointing at `apps/frontend/dist`, serves the SPA and proxies API surfaces. Consumed by Task 3 (deploy) and Task 4 (wiring).

- [ ] **Step 1: Write `deploy/cloudflare/wrangler.toml`**

```toml
name = "recycle-erp-experiment"
main = "worker.js"
compatibility_date = "2026-06-18"

# Static SPA build output. run_worker_first=true makes the Worker run for
# every request so it can decide API-proxy vs. asset; not_found_handling
# serves index.html for client-side routes via env.ASSETS.fetch().
[assets]
directory = "../../apps/frontend/dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = true

[vars]
# Filled in Task 4 with the Railway backend public URL (https, no trailing slash).
BACKEND_URL = "https://REPLACE-WITH-RAILWAY-URL"
```

- [ ] **Step 2: Write `deploy/cloudflare/worker.js`**

```js
// Same-origin edge: serve the SPA and reverse-proxy the backend's API/OAuth
// surfaces to Railway. The browser only ever talks to this Worker, so the
// backend's SameSite=Lax cookies and X-Requested-By CSRF header keep working
// with no backend changes.
const API_PREFIXES = ['/api', '/oauth', '/.well-known'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = API_PREFIXES.some(
      (p) => url.pathname === p || url.pathname.startsWith(p + '/'),
    );
    if (!isApi) {
      // Static asset or SPA route (index.html fallback per not_found_handling).
      return env.ASSETS.fetch(request);
    }
    const backend = env.BACKEND_URL.replace(/\/$/, '');
    const target = backend + url.pathname + url.search;
    // new Request(target, request) copies method, headers (Cookie,
    // X-Requested-By, Content-Type) and body. redirect:'manual' lets OAuth
    // 3xx pass through to the browser unchanged.
    return fetch(new Request(target, request), { redirect: 'manual' });
  },
};
```

- [ ] **Step 3: Write `deploy/cloudflare/.gitignore`**

```gitignore
.wrangler/
node_modules/
```

- [ ] **Step 4: Verify the SPA builds (produces the dist/ the Worker serves)**

Run: `pnpm --filter recycle-erp-frontend build`
Expected: completes 0; `apps/frontend/dist/index.html` exists. Confirm with `test -f apps/frontend/dist/index.html && echo OK` → `OK`.

- [ ] **Step 5: Commit**

```bash
git add deploy/cloudflare/
git commit -m "feat(deploy): cloudflare worker scaffold for experimental deploy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Provision Railway project + Postgres + backend service

**Files:** none in-repo (all via Railway MCP). Build config is set in Railway service settings, not committed.

**Interfaces:**
- Consumes: GitHub repo connection for branch `experiment/railway-cloudflare-deploy`, repo-root `.env` secrets.
- Produces: a Railway backend service with a public domain (`<svc>.up.railway.app`) answering `/api/health` 200. This URL is consumed by Task 4.

> Railway MCP tool params are validated at call time; inspect each tool's schema before calling. The steps below name the tool and the intent.

- [ ] **Step 1: Create the project**

Tool: `create_project` — name `recycle-erp-experiment`, workspace `0556aaa2-93c8-4aeb-8a0d-5f71fc83671b`. Capture `projectId` and the default `environmentId` (production).

- [ ] **Step 2: Add managed Postgres**

Tool: `search_templates` for `postgres`, then `deploy_template` with the Postgres template into the project/environment (or `create_service` from the `postgres` image with a `create_volume` mount if no template). Capture the Postgres service id. Verify with `list_services` that a Postgres service exists.

- [ ] **Step 3: Create the backend service from the GitHub repo**

Tool: `create_service` (name `backend`), then `connect_service_source` to the GitHub repo for branch `experiment/railway-cloudflare-deploy`. If GitHub is not connected to the Railway account, STOP and ask the user to authorize the Railway GitHub app (interactive, dashboard) — note it in the runbook.

- [ ] **Step 4: Point the build at the existing Dockerfile**

Tool: `update_service` — set root directory `/` and dockerfile path `apps/backend/Dockerfile`; set the healthcheck path `/api/health`. Confirm with `get_service_config`.

- [ ] **Step 5: Set backend env vars**

Tool: `set_variables` on the backend service:
- `DATABASE_URL` → Postgres reference (use `add_reference_variable` referencing the Postgres service's connection URL).
- `NODE_ENV=production`
- `JWT_SECRET` → freshly generated: `openssl rand -base64 48`
- `ENABLE_DEMO_ACCOUNTS=false`
- `ADMIN_PASSWORD` → a generated strong value (record it for the user, do NOT commit it)
- `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ATTACHMENTS_PUBLIC_URL` → copied from repo-root `.env`
- `OPENROUTER_API_KEY` → copied from repo-root `.env`
- `CORS_ALLOWED_ORIGINS` → placeholder `https://recycle-erp-experiment.PLACEHOLDER.workers.dev` (real value set in Task 5; the backend requires it non-empty at boot)

- [ ] **Step 6: Generate a public domain and deploy**

Tools: `generate_domain` on the backend service (capture `<svc>.up.railway.app`); `deploy`. Then poll `list_deployments` / `get_logs` until the build+release succeed (logs show migrations run + server listening).

- [ ] **Step 7: Verify the backend is up**

Run: `curl -sS https://<svc>.up.railway.app/api/health` (substitute the captured domain).
Expected: HTTP 200 with the health JSON (DB reachable). If 5xx, read `get_logs` and fix env/build before continuing.

---

### Task 3: Deploy the Worker (frontend) to Cloudflare

**Files:** uses `deploy/cloudflare/` from Task 1; no new repo files.

**Interfaces:**
- Consumes: `apps/frontend/dist` (Task 1 build), `wrangler login` session.
- Produces: a `<app>.workers.dev` URL serving the SPA. Consumed by Task 5.

- [ ] **Step 1: Confirm wrangler auth**

Run: `npx wrangler whoami`
Expected: shows the logged-in account. If not logged in, STOP and ask the user to run `npx wrangler login` (interactive).

- [ ] **Step 2: Rebuild the SPA (fresh dist)**

Run: `pnpm --filter recycle-erp-frontend build`
Expected: completes 0; `apps/frontend/dist/index.html` present.

- [ ] **Step 3: Deploy the Worker**

Run: `cd deploy/cloudflare && npx wrangler deploy`
Expected: deploy succeeds, prints the Worker URL `https://recycle-erp-experiment.<account>.workers.dev`. Capture it.

- [ ] **Step 4: Verify static serving**

Run: `curl -sS -o /dev/null -w "%{http_code}\n" https://recycle-erp-experiment.<account>.workers.dev/`
Expected: `200` (index.html served).

---

### Task 4: Wire the proxy target (Worker → Railway)

**Files:** Modify `deploy/cloudflare/wrangler.toml` (`BACKEND_URL`).

**Interfaces:**
- Consumes: Railway backend URL (Task 2), Worker deploy (Task 3).
- Produces: proxied API reachable through the Worker origin.

- [ ] **Step 1: Set `BACKEND_URL` in `wrangler.toml`**

Replace `https://REPLACE-WITH-RAILWAY-URL` with the captured `https://<svc>.up.railway.app` (no trailing slash).

- [ ] **Step 2: Redeploy the Worker**

Run: `cd deploy/cloudflare && npx wrangler deploy`
Expected: deploy succeeds.

- [ ] **Step 3: Verify the proxy reaches the backend through the Worker origin**

Run: `curl -sS https://recycle-erp-experiment.<account>.workers.dev/api/health`
Expected: same 200 health JSON as the direct Railway call — proves same-origin proxying works.

- [ ] **Step 4: Commit the wired config**

```bash
git add deploy/cloudflare/wrangler.toml
git commit -m "chore(deploy): wire worker BACKEND_URL to railway backend

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Close the CORS loop and verify end-to-end auth

**Files:** none in-repo (Railway env var update via MCP).

**Interfaces:**
- Consumes: Worker URL (Task 3), backend service (Task 2).
- Produces: a working login flow on the experiment.

- [ ] **Step 1: Set the real `CORS_ALLOWED_ORIGINS`**

Tool: `set_variables` on the backend — `CORS_ALLOWED_ORIGINS=https://recycle-erp-experiment.<account>.workers.dev`. This both satisfies the boot guard and resolves the OAuth issuer to the public origin.

- [ ] **Step 2: Redeploy the backend**

Tool: `deploy`; wait for healthy via `list_deployments` / `environment_status`.

- [ ] **Step 3: Verify login sets cookies through the Worker origin**

Run:
```bash
curl -sS -i -X POST https://recycle-erp-experiment.<account>.workers.dev/api/auth/login \
  -H 'Content-Type: application/json' \
  -H 'X-Requested-By: recycle-erp' \
  -d '{"email":"admin@recycle.local","password":"<ADMIN_PASSWORD from Task 2>"}'
```
Expected: 200 with `Set-Cookie: at=...; ... SameSite=Lax; Secure` and `rt=...; Path=/api/auth`. (`Secure` present because `NODE_ENV=production`.)

- [ ] **Step 4: Manual smoke in a browser**

Open the Worker URL, log in as the admin, confirm the dashboard loads and an authenticated `/api` call (e.g. inventory list) succeeds. Confirm a label scan/upload works (R2 + OpenRouter reused).

---

### Task 6: Write the dedicated deployment runbook

**Files:**
- Create: `docs/deployment-railway-cloudflare.md`

**Interfaces:**
- Consumes: the concrete IDs/URLs/commands established in Tasks 1–5.
- Produces: a standalone, reproducible runbook. Does NOT edit `README.md` or Docker docs.

- [ ] **Step 1: Write `docs/deployment-railway-cloudflare.md`**

Include, with the real values filled in:
- A bold **Experimental** banner and a one-line "this runs alongside, and does not replace, the Docker Compose stack."
- Prerequisites: Railway access, `npx wrangler login`, source `.env` with `R2_*` + `OPENROUTER_API_KEY`.
- Architecture diagram (copy from the design spec).
- Railway setup: project/Postgres/backend service, the Dockerfile build settings, and the full env-var table (from the spec, with the generated `JWT_SECRET`/`ADMIN_PASSWORD` shown as "generate, don't commit").
- Cloudflare setup: the `deploy/cloudflare/` files, `pnpm --filter recycle-erp-frontend build`, `npx wrangler deploy`.
- The **URL wiring order** (deploy Railway → set Worker `BACKEND_URL` → deploy Worker → set backend `CORS_ALLOWED_ORIGINS` → redeploy backend).
- Verification curls (health + login) from Tasks 2/4/5.
- Teardown: `wrangler delete` the Worker; delete the Railway project.

- [ ] **Step 2: Verify links/paths resolve**

Run: `test -f deploy/cloudflare/wrangler.toml && test -f deploy/cloudflare/worker.js && echo OK`
Expected: `OK` (the paths the runbook references exist).

- [ ] **Step 3: Commit**

```bash
git add docs/deployment-railway-cloudflare.md
git commit -m "docs(deploy): experimental railway + cloudflare runbook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Same-origin proxy model → Task 1 (worker.js) + Task 4 (wiring) + Task 5 (verify). ✓
- Railway backend from existing Dockerfile, no source changes → Task 2. ✓
- Env var table incl. reused R2/OpenRouter, fresh JWT, admin hardening → Task 2 Step 5. ✓
- Cloudflare Workers Static Assets → Task 1 + Task 3. ✓
- Dedicated runbook, no README edits → Task 6. ✓
- Execution scope (Railway via MCP, CF via wrangler) → Tasks 2/3. ✓
- Out of scope (no OAuth keys, no custom domains, no Compose edits) → respected; no task adds them. ✓

**Placeholder scan:** `BACKEND_URL`, `<svc>`, `<account>`, `ADMIN_PASSWORD` are runtime-resolved values, each with an explicit step that fills them — not plan gaps. No "TBD"/"handle errors"/"similar to" placeholders.

**Type/name consistency:** `BACKEND_URL`, `ASSETS` binding, `/api`/`/oauth`/`/.well-known` prefixes, and the Worker name `recycle-erp-experiment` are used consistently across Tasks 1, 3, 4, 5.

**Dependency note:** Task 2 (GitHub connect) and Task 3 (`wrangler login`) have interactive prerequisites that STOP and defer to the user if unmet — surfaced explicitly rather than assumed.
