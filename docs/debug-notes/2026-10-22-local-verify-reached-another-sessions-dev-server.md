# Local verify reached another session's dev server

**2026-10-22, ERP v1.316.0 (RS-351).**

## Symptom

`pnpm dev` from a session worktree failed with `Port 5173 is already in use`,
although `lsof -iTCP -sTCP:LISTEN | grep ' :5173 '` had shown nothing. On
alternate ports (backend `PORT=8899`, vite `--port 5180`), the health check
answered `{"status":"ok","version":"1.315.0"}` and a `curl` login worked, yet
the browser's sign-in failed with **HTTP 500** and vite logged
`http proxy error: /api/auth/login … ECONNREFUSED`.

## Cause

Two other sessions' servers, not this one's:

- Another worktree's vite already held 5173. `lsof` prints a wildcard bind as
  `*:5173`, so a pattern with a space before the colon never matches it.
- The 8899 health check and `curl` login were answered by another session's
  backend. Its version, 1.315.0, was that session's bump, not this
  worktree's, which still read 1.314.0. This worktree's backend had died at
  start with `EADDRINUSE :::8899`; the log showed it, the health check hid it.
  When the other backend stopped, vite's proxy had nothing to reach, and the
  ERP shows a proxy failure as HTTP 500.

## Fix

Pick ports no session uses by default (here backend 8931, vite 5180), then
check that the server answering is your own:

```bash
lsof -nP -iTCP:8931 -sTCP:LISTEN          # by port, not grep: matches *:8931 too
curl -s http://127.0.0.1:8931/api/health  # "version" must equal this worktree's package.json
grep EADDRINUSE <backend log>             # a backend that never bound says so here
```

Point vite at it with `VITE_API_BASE=http://localhost:8931 pnpm exec vite --port 5180 --strictPort`
from `apps/frontend`. Leave the other sessions' servers running: they belong
to work in progress.

## Also

Playwright MCP's `page.screenshot({ path })` inside `browser_run_code_unsafe`
resolves the path against the Playwright server's own directory, so a file
read back from the worktree is a stale one from an earlier call. Use the
`browser_take_screenshot` tool, which writes under the worktree's
`.playwright-mcp/`. That folder is also the only place `browser_run_code_unsafe`
loads a `filename` from; it is gitignored.
