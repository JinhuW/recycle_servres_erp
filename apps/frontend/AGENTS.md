# ERP frontend — `apps/frontend/`

The root [AGENTS.md](../../AGENTS.md) has the repo map, workflow and the
ERP↔tracker contracts; this file is the frontend's conventions.  Paths are
relative to the repo root.

## Frontend

- One bundle, two shells.  `apps/frontend/src/App.tsx` decides which to
  render: viewport width `< 720` → `MobileApp`; else `DesktopApp`.  Each is
  lazy-imported so each shell ships its own chunk.  When adding a feature,
  identify which shell(s) it lives in and keep its components scoped to that
  subtree (`pages/desktop/`, `pages/` for mobile).
- Use `apps/frontend/src/lib/api.ts` for every backend call.  It sets
  `credentials: 'include'`, attaches the `X-Requested-By: recycle-erp` CSRF
  header on mutating requests, and single-flights refresh.  Do **not** call
  `fetch('/api/…')` directly — you'll skip CSRF and refresh logic.
- Translatable strings go through `useT()` from `lib/i18n.tsx`.  Don't ship
  raw English in JSX.
- User preferences (theme, list-view modes, etc.) flow through
  `lib/preferences.tsx`.  Add new keys there, not in component-local state.
- Dialogs use `components/Modal.tsx`.  Escape is a stack (`lib/escapeStack.ts`)
  where only the top entry fires, so **never turn Escape off with
  `useEscapeKey(fn, !busy)` while a dialog is open** — the key would fall
  through to the layer under it.  Guard inside the handler instead; `active`
  is only for something mounted but hidden, like a closed drawer.  Nested
  dialogs render as siblings of the `<Modal>`, not children.

## Elsewhere

- **Auth & CSRF** (the cookies and the `X-Requested-By` header `lib/api.ts`
  handles) and **Tests** (frontend vitest layout included) are in
  [apps/backend/AGENTS.md](../backend/AGENTS.md).
- Browser security headers / CSP (`public/_headers`, the `csp-rev` meta) and
  the Worker deploy: [docs/agents/erp-ops.md](../../docs/agents/erp-ops.md) →
  *Cloudflare Worker deploys*.
- The Monitors pages (`DesktopTracker.tsx`, `DesktopCoordinator.tsx`,
  `FleetAccounts.tsx`, `FleetWatch.tsx`) render tracker data through the
  backend proxies — root AGENTS.md → *Contracts*.
