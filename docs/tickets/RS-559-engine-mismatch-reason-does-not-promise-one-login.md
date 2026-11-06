---
id: RS-559
title: Engine mismatch reason does not promise one login
type: bug
status: done
priority: P2
created: 2026-11-06
reporter: jinhu
branch: JinhuW/stargazer-2
pr: "#1131"
version: 1.433.2
related: []
---

## Ask

> yes, then merge to main and release to prod.

Asked in reply to: "Do you want me to fix finding 1 now and ship it to `dev`? It's a small wording change, and it would reach prod with your next release."

## Context

v1.433.1 (RS-558) changed the `engine_mismatch` refusal in
`apps/backend/src/fleet/workers.ts` to say "Park then Unpark restarts it, which is
one login." The release review found that promise too strong. Park sets
`worker_id = NULL`, so the first-choice match in the claim query
(`apps/backend/src/fleet/claim.ts`) no longer applies, and the worker's next claim
can take another free slot. The worker can then log in to another account before
the parked account gets its own login. The same text also dropped the next normal
start, which still applies to a worker that is not stuck.

## Acceptance criteria

- [x] The refusal no longer says Park then Unpark is one login.
- [x] The refusal says the engine changes at the next normal start.
- [x] The refusal says a worker parked on a problem never reaches that start, and that Park then Unpark can take more than one login.
- [x] `docs/FEATURES.md` matches the new text.

## Out of scope

- The other nine findings from the v1.433.1 review.
- Changing how Park, Unpark or the claim query behave, such as keeping a parked
  account tied to its worker.
