---
name: verify
description: Build/launch/drive recipe for verifying recycle-erp changes end-to-end against the local dev stack.
---

# Verifying recycle-erp changes locally

## Launch

- Other sessions' dev servers often hold 8787, 8899 and 5173. Check a port by
  number, `lsof -nP -iTCP:<port> -sTCP:LISTEN` (a grep for ` :5173 ` misses
  `*:5173`), and pick free ones, e.g. backend 8931 and vite 5180:
  `PORT=8931 JWT_SECRET=local-dev-secret pnpm dev` in `apps/backend`, then
  `VITE_API_BASE=http://localhost:8931 pnpm exec vite --port 5180 --strictPort`
  in `apps/frontend` (repo-root `.env` has no `JWT_SECRET`; the backend throws
  without one — any value works locally).
- Health check: `curl http://127.0.0.1:<port>/api/health` →
  `{"status":"ok","version":…}`. The `version` must equal this worktree's
  `package.json`. Otherwise another session's backend is answering and yours
  died with `EADDRINUSE` (see its log). See
  [the debug note](../../../docs/debug-notes/2026-10-22-local-verify-reached-another-sessions-dev-server.md).
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
