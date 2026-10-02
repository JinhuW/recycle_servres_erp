---
name: verify
description: Build/launch/drive recipe for verifying recycle-erp changes end-to-end against the local dev stack.
---

# Verifying recycle-erp changes locally

## Launch

- Port 8787 may be occupied by an unrelated local process — check first, and
  if busy run on an alternate port:
  `PORT=8899 VITE_API_BASE=http://localhost:8899 JWT_SECRET=local-dev-secret pnpm dev`
  (repo-root `.env` has no `JWT_SECRET`; the backend throws without one — any
  value works locally). Frontend lands on :5173, health check:
  `curl http://127.0.0.1:<port>/api/health` → `{"status":"ok","version":…}`.
- The dev DB is the local docker Postgres from `docker-compose.override.yml`
  (`recycle-erp-testdb`) — safe to create draft POs; DELETE them afterwards
  (`DELETE /api/orders/<id>` works on drafts).

## API driving

- Login: `curl -c cookies.txt -X POST /api/auth/login -H 'Content-Type: application/json' -H 'X-Requested-By: recycle-erp' -d '{"email":"marcus@recycleservers.io","password":"demo"}'`
  (seed users: alex/sofia = managers, marcus/priya = purchasers, password `demo`).
- Every mutating request needs `-b cookies.txt` + `X-Requested-By: recycle-erp`
  (CSRF guard 403s otherwise).

## UI driving (Playwright MCP)

- Resize to ≥1440×900 for the desktop shell (<720px renders the mobile shell).
- Sign in with email+password, then a **role picker** appears for managers —
  its "Continue as Manager" card is a dead click for Playwright's normal
  click; dispatch via `browser_evaluate`:
  `[...document.querySelectorAll('button')].find(x => x.textContent.includes('Continue as Manager')).click()`.
- Routes are hash-based: `/#/inventory`, `/#/submit`, etc. Purchasers have no
  Inventory nav — use a manager for inventory pages.
- Editing source files while the UI is open triggers a Vite full reload that
  resets in-page state (drafts survive server-side).
