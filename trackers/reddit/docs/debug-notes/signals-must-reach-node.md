# SIGTERM must reach node, not a pnpm or tsx wrapper

**Discovered:** 2026-08-14, verifying graceful shutdown.

## Symptom

`kill -TERM <pid>` on the process started by `pnpm start` did nothing. The
worker kept polling and evaluating; the shutdown handler never ran.

## Cause

`pnpm exec tsx src/index.ts` produces a four-deep process tree:

```
pnpm.cjs exec tsx src/index.ts        <- signal sent here
  └─ pnpm exec tsx src/index.ts
       └─ tsx/dist/cli.mjs src/index.ts
            └─ node --import …/loader.mjs src/index.ts   <- handler lives here
```

Neither pnpm layer forwards SIGTERM to its child, so the signal died at the
top. Sending SIGTERM to the innermost node process works correctly: all three
loops stop and `releaseAllClaims` runs.

## Why it matters in production

Docker sends SIGTERM to PID 1 and SIGKILLs everything ~10 s later. With
`CMD ["sh", "-c", "pnpm db:migrate && pnpm start"]`, PID 1 is `sh`, node is
three levels down, and the container is always hard-killed. The worker then
never releases its claims, so the subreddits and posts it held stay invisible
to the rest of the fleet until the 5-minute claim TTL lapses — on every deploy,
on every restart.

## Fix

The Dockerfile runs node directly, with `exec` so it becomes PID 1:

```
CMD ["sh", "-c", "node --import tsx scripts/migrate.ts && exec node --import tsx src/index.ts"]
```

`node --import tsx` loads the same TypeScript loader the tsx CLI would, without
the extra process.

## Rules

- Do not change the Dockerfile CMD back to `pnpm start`.
- When killing a locally-started worker, target the innermost node process
  (`ps -eo pid,ppid,command | grep index.ts`), not the pnpm pid — otherwise you
  are testing the wrapper, not the shutdown path.
- The 5-minute claim TTL is the safety net for hard kills, not the normal path.
  If deploys start looking slow to pick work back up, check this first.
