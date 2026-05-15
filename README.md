# Recycle Servers ERP — Mobile

Mobile companion app for the Recycle Servers inventory ERP. Field purchasers
scan part labels with their phone, the AI fills out the spec sheet, and the
order lands in the warehouse pipeline. Built as two services:

- **`backend/`** — Cloudflare Worker + Hono + Postgres (via Hyperdrive in prod,
  direct connection in dev). Cloudflare Images for label-scan storage.
  Cloudflare Workers AI vision for OCR, with a deterministic stub fallback so
  the demo works without an account.
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
┌─────────────────┐         ┌──────────────────────┐
│  React PWA      │  HTTPS  │  Cloudflare Worker   │
│  (Vite, mobile) │ ──────► │  (Hono router)       │
│                 │         │                      │
│  - Capture flow │         │  ┌────────────────┐  │
│  - Orders/Mkt   │         │  │ /api/auth      │  │
│  - i18n EN/ZH   │         │  │ /api/orders    │  │
└────────┬────────┘         │  │ /api/scan      │  │
         │ multipart upload │  │ /api/market    │  │
         └─────────────────►│  └────────────────┘  │
                            │           │          │
                            │           ▼          │
                            │  ┌────────────────┐  │
                            │  │ Cloudflare     │  │
                            │  │ Images (label  │  │
                            │  │ photos)        │  │
                            │  └────────────────┘  │
                            │           │          │
                            │           ▼          │
                            │  ┌────────────────┐  │
                            │  │ Workers AI     │  │
                            │  │ (vision OCR)   │  │
                            │  └────────────────┘  │
                            │           │          │
                            └───────────┼──────────┘
                                        ▼
                              ┌──────────────────┐
                              │  Postgres        │
                              │  (via Hyperdrive)│
                              └──────────────────┘
```

## Environment variables

Backend (`backend/.dev.vars`, see `.dev.vars.example`):

```
DATABASE_URL=postgres://recycle:recycle@localhost:5432/recycle_erp
JWT_SECRET=dev-secret-change-me
OPENROUTER_API_KEY=                # label OCR — default provider when set
# OPENROUTER_OCR_MODEL=google/gemini-2.0-flash-001   # or anthropic/claude-sonnet-4.5, openai/gpt-4o
CF_ACCOUNT_ID=                     # leave blank in dev to use stub Image storage
CF_IMAGES_TOKEN=
```

Frontend (`frontend/.env.local`):

```
VITE_API_BASE=http://localhost:8787
```

## Deployment notes

- Provision a Hyperdrive binding pointing at your Postgres (Neon/Supabase/RDS).
  Add the binding as `HYPERDRIVE` in `wrangler.toml` and the Worker auto-uses
  it instead of `DATABASE_URL`.
- Provision Cloudflare Images and create an API token with `Images:Edit`
  permissions; set `CF_ACCOUNT_ID` and `CF_IMAGES_TOKEN` as Worker secrets.
- OCR provider is chosen by credentials: `OPENROUTER_API_KEY` set → OpenRouter
  (default); else a Workers AI `[ai]` binding → Llama 3.2 vision; else the
  deterministic stub. No feature flag needed.
- Frontend deploys as static assets — Cloudflare Pages, Vercel, or any CDN.
