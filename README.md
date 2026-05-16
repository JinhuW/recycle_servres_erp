# Recycle Servers ERP — Mobile

Mobile companion app for the Recycle Servers inventory ERP. Field purchasers
scan part labels with their phone, the AI fills out the spec sheet, and the
order lands in the warehouse pipeline. Built as two services:

- **`backend/`** — Node + Hono + Postgres. Runs as a Docker container; Cloudflare
  R2 (via its S3-compatible API) stores label-scan images and sell-order
  attachments. OpenRouter vision does label OCR, with a deterministic stub
  fallback so dev/tests run offline.
- **`frontend/`** — Vite + React + TypeScript PWA. Two shells share auth +
  i18n + API client and switch on viewport width:
    - **Mobile (< 720px)**: 8 phone screens — Login, Role picker, Dashboard,
      Capture (camera + AI), Orders, Market, Profile, Language sheet.
    - **Desktop (≥ 720px)**: sidebar shell with Dashboard, Purchase orders
      (with line-item drill-down), Inventory + edit page (with append-only
      audit log), Market value table, Sell orders pipeline, Settings
      (Members/Customers/Workflow tabs).

## Quick start

```bash
# 1. Boot Postgres locally
docker compose up -d

# 2. Run migrations + seed
cd backend
npm install
npm run db:migrate
npm run db:seed

# 3. Start the Worker on :8787
npm run dev

# 4. In a second terminal, start the SPA on :5173
cd ../frontend
npm install
npm run dev
```

Open <http://localhost:5173> in mobile-emulator mode (Chrome devtools → iPhone
14 Pro). Sign in with `marcus@recycleservers.io` / `demo` (any password works
in dev).

## Architecture

```
┌─────────────────┐  HTTPS  ┌──────────────────────┐
│  React SPA      │ ──────▶ │  Caddy (web)         │
│  (served by     │         │   / → static SPA     │
│   Caddy)        │         │   /api → backend     │
└─────────────────┘         └──────────┬───────────┘
                                        │
                             ┌──────────▼───────────┐
                             │  backend (Node/Hono) │
                             │  Postgres · R2 (S3)  │
                             │  OpenRouter OCR      │
                             └──────────────────────┘
```

## Environment variables

Backend (`apps/backend/.env`):

```
DATABASE_URL=postgres://recycle:recycle@localhost:5432/recycle_erp
JWT_SECRET=dev-secret-change-me
OPENROUTER_API_KEY=                # label OCR — required in prod, stub used when absent
# OPENROUTER_OCR_MODEL=google/gemini-2.0-flash-001   # or anthropic/claude-sonnet-4.5, openai/gpt-4o
R2_S3_ENDPOINT=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=recycle-erp-attachments
R2_ATTACHMENTS_PUBLIC_URL=https://static.recycleservers.com
```

Frontend (`frontend/.env.local`):

```
VITE_API_BASE=http://localhost:8080/api
```

## Deployment

Single-host Docker Compose:

1. Create `apps/backend/.env` with `JWT_SECRET`, `OPENROUTER_API_KEY`, and the
   R2 S3 settings (`R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET=recycle-erp-attachments`,
   `R2_ATTACHMENTS_PUBLIC_URL=https://static.recycleservers.com`). Generate the
   R2 credentials in the Cloudflare dashboard → R2 → Manage API Tokens.
2. `docker compose up -d --build`
3. The app is served at `http://<host>:8080` (put it behind your TLS-terminating
   edge/reverse proxy). The backend runs DB migrations on startup; on first
   deploy, seed demo/reference data once with
   `docker compose exec backend node scripts/seed.mjs`.

Local dev (only Postgres in Docker):

```bash
docker compose up -d postgres
pnpm --filter recycle-erp-backend dev
pnpm --filter recycle-erp-frontend dev
```
