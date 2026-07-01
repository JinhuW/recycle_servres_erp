# Railway + Cloudflare Deployment — Security & Best-Practice Review

> Date: 2026-06-19 · Branch: `experiment/railway-cloudflare-deploy`
> Scope: live Railway project `recycle-erp-experiment` (dev + production) and the
> Cloudflare Worker / R2 fronting it. Findings verified against live Railway
> variables/domains and repo config, not just docs.

## Verified topology

- **Cloudflare Worker** (`recycle-erp-experiment.jinhuwang1127.workers.dev`) —
  serves the SPA from `ASSETS` and dumb-proxies `/api`, `/oauth`, `/.well-known`
  to a Railway backend (`deploy/cloudflare/worker.js`).
- **Railway project `recycle-erp-experiment`**, two environments (dev +
  production), three services: `backend`, `Postgres`, `db-sync` (nightly
  prod→dev clone cron). **No backup service is actually deployed.**
- **Cloudflare R2** — `recycle-erp-attachments` bucket via Terraform
  (single-bucket-scoped token, custom domain `static.recycleservers.com`,
  TLS 1.2).

## Verdict

The shape is reasonable for an experiment (edge SPA + proxied API, managed
Postgres, scoped R2). But **dev and production are not isolated** — they share
every secret and the same R2 bucket — and **production Postgres + the backend
origin are directly exposed to the internet**. Several findings are genuinely
critical for anything holding real customer data.

---

## 🔴 CRITICAL

### C1. Production and dev share *every* secret
`JWT_SECRET`, `OAUTH_SIGNING_KEY_CURRENT`, `ADMIN_PASSWORD`, the R2
access key/secret, and `OPENROUTER_API_KEY` are **byte-identical** across the
prod and dev backend services.

- **Token forgery across environments** — a JWT/OAuth token minted by dev
  validates on prod (same signing material). Combined with C2/C3 (dev is a
  nightly full copy of prod with weaker controls), dev becomes a production
  breach surface.
- **Shared blast radius** — a dev leak *is* a prod leak; rotation must touch
  both.

**Fix:** Independent `JWT_SECRET`, `OAUTH_SIGNING_KEY_CURRENT`,
`ADMIN_PASSWORD`, and a separate R2 token per environment. All values have been
surfaced during review — **rotate now** and make prod distinct from dev.

### C2. Production Postgres is exposed on a public TCP proxy with the superuser
Prod `Postgres` publishes `thomas.proxy.rlwy.net:41763` and the connection
string is the `postgres` **superuser**. The endpoint is internet-reachable; the
only control is the password (Railway TCP proxies don't support IP allowlists).
It exists solely so the `db-sync` cron (running in the *dev* environment) can
read prod, because Railway has no cross-environment private networking.

**Fix (best first):**
1. Run the sync inside the *prod* environment writing outward to dev, so the
   public proxy lands on the low-value side (dev), not prod.
2. If prod must stay reachable, create a dedicated **read-only role** for the
   sync (the code comment already asks for this; it currently uses superuser).
3. At minimum rotate `POSTGRES_PASSWORD` and keep the proxy off outside the
   sync window.

### C3. Nightly prod→dev clone copies all production PII into the weaker environment
`deploy/railway-sync/sync.sh` runs `pg_dump --clean … prod | psql … dev` nightly
at 04:00 UTC. Dev then holds a complete copy of prod customers, users, password
hashes, and financial data — with the same admin password and JWT secret (C1).

**Fix:** Anonymize during the copy (scrub emails/names/hashes), or sync
schema-only + synthetic seed. A true mirror requires prod-grade controls on dev.

### C4. A predictable, static admin login exists on production
Only `ADMIN_PASSWORD` is set in Railway; `ADMIN_EMAIL`/`ROLE` fall back to the
`apps/backend/Dockerfile` defaults (`admin@recycle.local`, role `manager`).
`init-admin.mjs` re-provisions it every boot. Prod therefore has a known manager
account with a static, dev-shared password.

**Fix:** Unique prod `ADMIN_EMAIL` + strong unique `ADMIN_PASSWORD`; rotate the
current one; consider making init-admin one-shot rather than every-boot.

---

## 🟠 HIGH

### H1. The backend origin is directly reachable, bypassing the Worker
`backend-production-7b10.up.railway.app` (and the dev equivalent) are public
Railway domains. The Worker premise ("the browser only ever talks to this
Worker") is not enforced — anyone can curl the Railway domain and hit
`/api`/`/oauth` directly. The Worker adds no WAF/rate-limit/bot protection
(`worker.js:22` is a pass-through); CORS only restrains browsers.

**Fix:** Worker injects a secret header (e.g. `X-Edge-Auth: <random>`); backend
rejects `/api`+`/oauth` requests lacking it (exempt `/api/health`). Store the
secret as a Worker var + backend env. Optionally add Cloudflare WAF/rate-limit
on the Worker route.

### H2. Production `CORS_ALLOWED_ORIGINS` points at the dev Worker origin
Both prod and dev backends set
`CORS_ALLOWED_ORIGINS=https://recycle-erp-experiment.jinhuwang1127.workers.dev`
(a `*.workers.dev` dev URL), while `wrangler.toml` hard-codes `BACKEND_URL` to
the prod backend. Prod trusts a dev-tier origin and it's unclear a distinct prod
Worker exists.

**Fix:** One Worker + one CORS origin per environment; prod on a real custom
domain (not `workers.dev`).

### H3. No automated production backups are running
`deploy/railway-backup/` is well-designed (streaming `pg_dump | gzip | rclone`
to R2, v18 client pinned) but the service is **not deployed** — `list_services`
shows only `backend`, `Postgres`, `db-sync`. Prod relies entirely on the Railway
volume; no offsite/point-in-time dump exists.

**Fix:** Deploy the backup cron in prod, verify objects land in R2, confirm the
backups bucket has its own lifecycle + a **separate** scoped token from the
attachments token.

### H4. Dev writes to the production R2 attachments bucket
`R2_BUCKET=recycle-erp-attachments` + the same R2 creds are used by both
environments. Dev uploads/deletes land in the bucket prod serves at
`static.recycleservers.com`, and the DB clone copies prod attachment keys into
dev.

**Fix:** Separate bucket (`…-attachments-dev`) + separate scoped token per
environment. The Terraform module already parametrizes bucket name and scopes
the token to one bucket — clean extension.

---

## 🟡 MEDIUM

### M1. Real client IP is lost at the edge
`worker.js` forwards nothing identifying the caller, so the backend sees
Cloudflare's IP. App-level IP throttling (e.g. password-reset) keys off the
wrong address; error-log records lose attribution.

**Fix:** Forward `CF-Connecting-IP` as `X-Forwarded-For`; backend trusts it only
because the origin is locked to the edge (H1).

### M2. `db-sync` holds prod superuser creds in the dev env
The only guard is the source==target equality check. A transposition where both
URLs differ but DEV points at prod would `--clean` prod.

**Fix:** Read-only prod role (can't drop/clean), and/or assert the target host
matches an expected dev hostname before running `psql`.

### M3. No edge rate-limiting / WAF on auth + OAuth endpoints
Login, refresh, password-reset, and `/oauth/token` have no Cloudflare
rate-limit rule (and via H1 are also exposed raw on the origin). Credential
stuffing is unthrottled at the network layer.

**Fix:** Cloudflare rate-limit rules on `/api/auth/*`, `/oauth/token` once
traffic is forced through the Worker (H1).

---

## 🟢 LOW / Notes

- **L1.** `wrangler.toml` mixes a committed prod `BACKEND_URL` with a
  `workers.dev` host. Consider `[env.production]`/`[env.dev]` splits.
- **L2.** Terraform R2 CORS is GET/HEAD-only with parametrized origins
  (`r2.tf:15`) — good. Confirm `var.cors_allowed_origins` isn't `*`.
- **L3.** Backend `Dockerfile` ships insecure dev defaults (`JWT_SECRET=dev-…`,
  `ADMIN_PASSWORD=admin`, `ENABLE_DEMO_ACCOUNTS=true`) as `ENV`. Railway
  overrides them today, but a boot guard that refuses to start in
  `NODE_ENV=production` with default `JWT_SECRET`/`ADMIN_PASSWORD` would make a
  missing-env failure loud (extend the existing `OAUTH_SIGNING_KEY_CURRENT`
  guard pattern).

---

## What's done well (keep)

- `NODE_ENV=production` + `CORS_ALLOWED_ORIGINS` set; `ENABLE_DEMO_ACCOUNTS=false`
  in prod.
- R2 token **scoped to a single bucket** via Terraform (`token.tf`) — a leak
  can't touch the tfstate bucket. Exemplary.
- Sync is one-directional with an identical-URL safety rail and
  `--single-transaction` restore (fails closed).
- Non-root container `USER node`, real DB-reachability `HEALTHCHECK`, build
  provenance labels.
- Secrets live in Railway, not git; R2 custom domain pins `min_tls = 1.2`.

---

## Recommended order of action

1. **Rotate everything now** (all secrets surfaced) and make prod values
   *distinct* from dev (C1, C4, parts of C2/H4).
2. **Lock the origin to the edge** — Worker-injected secret header + backend
   check (H1); also enables M1/M3.
3. **Close the prod-DB exposure** — read-only sync role + reconsider proxy
   direction (C2/M2); anonymize or stop the PII clone (C3).
4. **Separate R2 bucket + token per env** (H4) and **deploy the backup cron**
   (H3).
5. Per-env CORS/Worker on a real prod domain (H2).

Most impactful single change: **#1 + #2 together** — converts "dev compromise =
prod compromise" and "origin is wide open" into an isolated, edge-gated setup.

---

## C5 (NEW, CRITICAL) — backend R2 token has account-wide access  ✅ FIXED 2026-06-19

> **Resolved.** Replaced with bucket-scoped tokens (prod→attachments,
> dev→attachments-dev, state→tfstate), each verified `AccessDenied` outside its
> bucket; both backends redeployed healthy; the broad `874aaa…` key retired from
> all configs (revoke it — see NEXT-STEPS). IaC reconciliation pending (tokens
> were created via API; see `infra/terraform/NEXT-STEPS.md`).


Discovered while doing H4. The backend's R2 credential
(`R2_ACCESS_KEY_ID=874aaa…`, set on **both** dev and prod Railway backends) was
tested against every bucket in the account and can **read/write all of them**:

| Bucket | Backend key access | Should be |
|---|---|---|
| `recycle-erp-tfstate` (infra secrets, plaintext) | ✗ ACCESSIBLE | denied |
| `recycle-db-backup` (DB backups) | ✗ ACCESSIBLE | denied |
| `recycle-erp-attachments` | ✓ needed | allowed |
| `inventory-images` | ✗ ACCESSIBLE | denied |

`token.tf` *declares* this token as scoped to the attachments bucket only, and
the `environments/prod` Terraform output confirms the access key it manages **is
`874aaa…`** — so the bucket-scoping in `token.tf` is **not taking effect**; the
token is effectively account-wide. Impact: a compromised backend (or the key,
now surfaced in this session) can read every infra secret in tfstate and
**delete the DB backups**. Likely cause: the `resources={bucket_key:"*"}` scope
is ignored because the attached permission groups (`Workers R2 Storage
Write/Read`) are account-level. Fix needs a genuinely bucket-scoped token,
created + verified (`tfstate` must return AccessDenied), then set on both
backends — **blocked on a CF token with `API Tokens → Edit`**. Rotate `874aaa…`
after (it's the Terraform-state key and is now exposed).

## Implementation status (2026-06-19)

Selected for action: C2, C4, H1, H2, H3, H4, M1, M2, M3, L3.

| Item | Status | Notes |
|---|---|---|
| **H1** edge-lock origin | **Coded, DORMANT** | `worker.js` injects `X-Proxy-Secret`; `index.ts:62-70` refuses requests lacking it (exempts `/api/health`, also gates `/metrics`). Uncommitted in working tree. **Not active** — `PROXY_SECRET` is unset on both Railway backend envs and not yet a Worker secret. Activate by setting the same value on the Worker(s) first, then the backend. |
| **H2** per-env Worker/CORS | **Done (committed)** | Frontend split into prod + dev Workers with custom domains `inventory-prod/dev.recycleservers.com` (commits `0266e3b`, `e201677`, `e0af1ee`). Follow-up: point each backend's `CORS_ALLOWED_ORIGINS` at its own custom domain (still `…workers.dev` in live vars). |
| **M2** sync host guard | **Done** | `deploy/railway-sync/sync.sh`: refuses when target host == prod host; optional `EXPECTED_DEV_DB_HOST` pin. |
| **L3** prod boot guard | **Already satisfied** | `env.ts:17-19` refuses default `JWT_SECRET` in prod; `init-admin.mjs:51` refuses the default admin password in prod. No new code needed. |
| **M1** forward client IP | **TODO (fold into H1 worker edit)** | Add to `worker.js`: strip inbound then `proxied.headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP'))`. Left to the active worker.js edit to avoid a collision. |
| **C2** prod DB exposure | **Live-ops, pending go** | Create read-only sync role; rotate `POSTGRES_PASSWORD`; reconsider public TCP proxy direction. Touches running prod. |
| **C4** prod admin login | **Live-ops, pending go** | `init-admin` preserves the existing `admin@recycle.local`; setting `ADMIN_PASSWORD` won't rotate it. Must change the live user's password/email in the prod DB. |
| **H3** backup cron | **Not needed (resolved)** | `recycle-db-backup` already runs **hourly** `pg_dump` (custom format), 114 objects since 2026-06-14 — better than the planned daily job. The redundant `recycle-erp-backups` bucket created during this review was `terraform destroy`'d. Verify that hourly job targets the Railway prod DB if the experiment becomes prod. |
| **H4** R2 per env | **Done** | `recycle-erp-attachments-dev` bucket + r2.dev URL + scoped dev token created and wired; dev backend redeployed healthy. Bundled with the C5 fix. IaC reconciliation pending. |
| **M3** edge rate-limit | **Blocked on H2 domain** | Cloudflare rate-limit rules need the custom domain (now exists post-H2); add rules on `/api/auth/*`, `/oauth/token`. |
