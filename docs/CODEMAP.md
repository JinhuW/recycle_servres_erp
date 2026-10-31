# Code map

A navigation aid, not a spec. Paths and entry points were checked against the
tree on 2026-10-31; verify the source before relying on a detail. Rules, deploy
targets and contracts live in [AGENTS.md](../AGENTS.md) and each area's own
`AGENTS.md`. What the system does is in [FEATURES.md](FEATURES.md), and the
tables are in [DATABASE.md](DATABASE.md).

## Architecture

The ERP is a Hono API (`apps/backend`) over one Postgres, queried with raw SQL
through `postgres`. Its UI is one React SPA (`apps/frontend`) with a desktop
shell and a phone PWA shell. Both apps import `packages/shared` as TS source.
`apps/fleet-agent` runs on each Docker host and keeps that host's Facebook
worker containers as the ERP's fleet queue (`apps/backend/src/fleet`) wants
them. The two trackers are separate programs that the ERP reaches only over
HTTP: `trackers/reddit` (TS) and `trackers/facebook` (Python).

## Modules

| Area | Path | Responsibility | Start reading at |
| --- | --- | --- | --- |
| API boot | `apps/backend/src/` | env, background loops, middleware chain, route mounts | `server.ts` (loops, shutdown), `index.ts` (middleware order + every `app.route`) |
| Auth | `apps/backend/src/{auth,csrf}.ts`, `oauth/`, `lib/role.ts` | cookie JWT + refresh family, CSRF header, OAuth for MCP/service clients, roles | `auth.ts`, `oauth/server.ts`, `oauth/guard.ts` |
| Purchase orders | `apps/backend/src/routes/orders/`, `services/order*.ts` | PO create/patch/lifecycle/review checks/AI review | `routes/orders/index.ts`, `services/orderAdvance.ts` |
| Inventory | `routes/inventory.ts`, `services/sellableInventory.ts` | each `order_lines` row is a lot; lists, analysis, transfers | `routes/inventory.ts` |
| Sales | `routes/sellOrders.ts`, `routes/sellOrderPack.ts`, `services/sellOrder*.ts`, `routes/afterSales.ts` | sell orders, status transitions, sign-off, pack mode | `ALLOWED_TRANSITIONS` in `routes/sellOrders.ts` |
| Money | `routes/accounting.ts` (RMB book), `banktx/` + `routes/{bankTx,internalTx}.ts` (USD bank) | entries, payer write-back, Mercury/PayPal sync and matching | `banktx/sync.ts`, `banktx/match.ts` |
| Integrations | `apps/backend/src/{ai,mail,shipping}/`, `r2.ts`, `routes/market.ts`, `mcp/` | OpenRouter OCR, IMAP/SMTP, Shippo, R2 files, market prices, MCP tools | each folder's `index.ts`; stubs are picked when a key is missing |
| Fleet queue | `apps/backend/src/fleet/`, `routes/{fleet,facebookPool}.ts` | slots, task queue, claims, hosts, proxies, VNC | `claim.ts` (worker protocol), `scheduler.ts` (30 s reconcile), `hosts.ts` (agent API) |
| Tracker proxies | `routes/{tracker,coordinator,wechatMarket}.ts`, `vncBridge.ts` | allowlisted forwarding to the trackers; memtrade push | the contracts table in `AGENTS.md` |
| UI shells | `apps/frontend/src/{App,DesktopApp,MobileApp,main}.tsx` | width picks the shell at load; views switch per shell | `DesktopApp.tsx` |
| UI plumbing | `apps/frontend/src/lib/` | `api.ts` (fetch, refresh, CSRF), `route.ts` (hash routes), `desktopNav.ts`, `i18n.tsx` + `i18n.zh.ts`, per-area clients (`fleet.ts`, `coordinator.ts`, `tracker.ts`, …) | `api.ts`, `route.ts` |
| UI pages | `apps/frontend/src/pages/` (phone), `pages/desktop/` (desktop) | one file or folder per view | `pages/desktop/fleet/FleetPage.tsx` for the fleet tabs |
| PWA | `apps/frontend/src/sw.ts`, `vite.config.ts`, `public/_headers` | service worker, manifest, CSP | `sw.ts` |
| Shared | `packages/shared/src/` | pure helpers and wire types, re-exported from `index.ts` | `index.ts` |
| Fleet agent | `apps/fleet-agent/src/` | per-host loop: desired state in, `docker` commands out, report back | `main.ts` → `agent.ts` (tick) → `plan.ts` |
| Reddit tracker | `trackers/reddit/src/` | `ROLE=api` (admin API, Telegram reactions) or `ROLE=worker` (poll → evaluate → notify) | `index.ts`, `loops/` |
| Facebook tracker | `trackers/facebook/rs_*` | `rs_console` (the only service the ERP calls), `rs_coordinator` (control plane, CLI `rsc`), `rs_worker/entry.py` (worker image entry) | `rs_console/rs_console/app.py` |
| Ops | `deploy/`, `backup/`, `infra/terraform/`, `.github/workflows/` | Worker deploy, prod→dev sync, uptime, R2 backup, DNS; CI | `docs/agents/erp-ops.md` |

## Flows

- **Request.** `server.ts` boots, then `index.ts` runs request id and logging →
  `PROXY_SECRET` gate → CORS → metrics → `csrf.ts` → body caps → per-prefix
  `authMiddleware` → route. Some sub-apps (tracker, coordinator, aiModels,
  wechatMarket, webSubmissions, OAuth admin) apply their own manager guard.
- **Purchase to sale.** package `create-po` (`routes/packages.ts`) → Draft PO →
  hand-off (`services/orderHandoff.ts`) → review checks
  (`services/poReviewChecks.ts`) → Ready to Pay / Done → lines become sellable
  → sell order (`routes/sellOrders.ts`) → sign-off
  (`services/sellOrderSignoff.ts`) → Done takes qty off the lots → bank link
  and accounting entries.
- **Fleet.** `fleet-agent` GETs `/api/fleet/hosts/:id/desired` and gets a
  ticket per container → the worker calls `POST /api/fleet/worker/claim`
  (`fleet/claim.ts`) → heartbeat and `next-task` long-poll → `scheduler.ts`
  expires leases and writes the next tasks.
- **Background loops.** These are all started in `apps/backend/src/server.ts`:
  FX, package tracking, bank sync, mail inbox, PO AI review, pool alive check,
  fleet scheduler, proxy health, web-submission purge.

## Schemas, config, tests

| What | Where |
| --- | --- |
| ERP migrations | `apps/backend/migrations/NNNN_*.sql`, append-only, run by `apps/backend/scripts/migrate.mjs` (one transaction each, `schema_migrations` checksum) |
| Reddit tracker migrations | `trackers/reddit/migrations/`, run by `trackers/reddit/scripts/migrate.ts` |
| Env schema | `apps/backend/src/env.ts` + `types.ts` (`Env`) |
| User preferences | `apps/backend/src/preferences.ts` (`SCHEMA`) |
| Backend tests | `apps/backend/tests/*.test.ts`, integration against real Postgres; each run makes its own DB (`tests/helpers/global-setup.ts`, needs `TEST_DATABASE_URL`) |
| Frontend tests | colocated `*.test.ts(x)` under `apps/frontend/src` |
| Other tests | `apps/fleet-agent/tests`, `trackers/reddit/tests`, `trackers/facebook/*/tests` (pytest, own venvs) |

## Where to change what

| Task | Touch |
| --- | --- |
| New ERP endpoint | route file in `apps/backend/src/routes/`, mount in `index.ts`, client in `apps/frontend/src/lib/`, test in `apps/backend/tests/` |
| New table or column | a new migration, plus `docs/DATABASE.md` |
| New desktop page | `pages/desktop/X.tsx`, lazy import and view in `DesktopApp.tsx`, path in `lib/route.ts`, nav entry in `lib/desktopNav.ts` |
| New phone page | `pages/X.tsx`, `MobileApp.tsx`, `MOBILE_VIEW_TO_PATH` in `lib/route.ts`, `components/PhTabBar.tsx` |
| New UI string | the key in both `lib/i18n.tsx` and `lib/i18n.zh.ts` (`i18nParity.test.ts` fails otherwise) |
| Role rule | `apps/backend/src/lib/role.ts` |
| New Bearer (non-cookie) write surface | `exempt()` in `apps/backend/src/csrf.ts` |
| Fleet worker protocol | `fleet/claim.ts` + wire types in `packages/shared/src/fleet.ts` + `trackers/facebook/rs_worker/entry.py` |
| Fleet agent behaviour | `apps/fleet-agent/src/plan.ts`; the ERP side is `fleet/hosts.ts` |
| Tracker endpoint the ERP shows | the tracker, the ERP route allowlist, the frontend client, in one PR (see AGENTS.md *Contracts*) |

## Commands

These are run from the repo root unless the row says otherwise.

| Purpose | Command |
| --- | --- |
| Dev servers (backend :8787, frontend :5173) | `pnpm dev` |
| Typecheck (backend, frontend, shared, fleet-agent) | `pnpm typecheck` |
| Build | `pnpm build` |
| Backend tests | `pnpm --filter recycle-erp-backend test` |
| Frontend tests | `pnpm --filter recycle-erp-frontend test` |
| Fleet agent tests | `pnpm --filter recycle-erp-fleet-agent test` |
| Migrate / seed / reset local DB | `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:reset` |
| Reddit tracker | `cd trackers/reddit && pnpm test` (also `pnpm typecheck`) |
| Find unused locals | `npx tsc --noEmit --noUnusedLocals`, run inside a package |
| Ticket / changelog | `scripts/ticket.sh new "<title>"`, `scripts/changelog.sh draft` |

There is no linter config in the TS packages. The `tsconfig` files keep
`noUnusedLocals` off, so run the command above before a cleanup.

## Non-obvious conventions

- Per-request DB fan-out goes through `allLimited` (`lib/concurrency.ts`), at
  most 4 at a time. The prod pool is `max: 10`.
- Comments explain *why* only. Business rules that look like config are fixed:
  commission payment types are exactly Company pay and Self pay.
- `trackers/reddit` is a separate pnpm project. Root `pnpm` commands and root CI
  never reach it, and no workflow tests either tracker.
- The full backend suite can flake under parallel load (seen 2026-10-31:
  `facebook-pool`, `fleet-hosts`, `oauth-endpoints`,
  `sell-order-price-template` failed in a full run and passed alone). Re-run a
  failing file alone before calling it a regression.
- Starting a Facebook worker is a login. Read the first rule in AGENTS.md
  before touching `trackers/facebook`, `apps/fleet-agent` or `fleet/`.
