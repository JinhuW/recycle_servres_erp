# Review-fix planning brief (2026-10-31)

You are writing **one workstream** of the implementation plan that fixes the
findings of `docs/review-2026-10-31/` (read its `README.md` and
`architecture-todo.md` first). This is planning only: **change no code, touch
no live resource.**

Worktree: `/Users/jinhu/orca/workspaces/recycle_servres_erp/brant`, at
`origin/dev` f0c1d856. Shared by all planners: never `git checkout`, `reset`,
`stash`, commit or push.

## Ground rules

- No Facebook logins, restarts, relogins or session-file access, and no live
  writes of any kind (Railway, Cloudflare, VMs, prod DB). Reading code, docs,
  lane JSON and repro tests is all you need. A step that needs a live action
  goes in the plan as an **owner gate**, never done now.
- Secrets: names only, never values.
- Repo rules apply to the plan's content: `AGENTS.md` (first rule: never cause
  a Facebook login without a reason; ship container changes in one deploy),
  area `AGENTS.md`, ticket/CHANGELOG/FEATURES workflow, one PR per ticket to
  `dev`, version bump per code push, TS inside the ERP preferred over Python
  for new services.

## Input

`inputs/<WS>.json`: every finding assigned to your workstream (ID, final
severity, verdict, title, location, the reviewer's proposed fix and
regression test, the lane JSON path for full evidence, and IDs it
deduplicates). Read the full finding in the lane JSON and the cited code
before planning a fix; the reviewer's proposed fix is a hint, not a decision.
If a finding is wrong or already fixed on f0c1d856, say so and drop it.

## Output

Write `docs/superpowers/plans/2026-10-31-review-fixes/<WS>.md`:

1. **Goal and scope**: one paragraph; the finding IDs covered.
2. **Tickets**: group findings into shippable tickets (one PR each, at most a
   day or two of work; P3s may be batched by area). For each ticket:
   - title, findings closed, severity, which app/tracker it versions under
     (ERP root `package.json` bump, `trackers/facebook` VERSION + release, or
     reddit SHA), and whether it needs a deploy that restarts workers (= a
     login; say how it rides an existing deploy);
   - **Change**: the concrete edits with file paths and functions (read the
     code; name lines where helpful), schema/migration steps, and ordering
     constraints between sides of a contract;
   - **Tests**: the regression test(s) to add, where they live, and which
     repro under `docs/review-2026-10-31/repro/` they port from;
   - **Owner gates**: decisions or live actions only the owner can take,
     phrased as a yes/no question or an exact action;
   - **Rollout and verification**: how to ship and how to confirm it worked
     live (read-only checks), plus rollback;
   - **Effort**: S (< 2 h), M (half day), L (1–2 days).
3. **Order**: the ticket sequence inside the workstream, and any dependency on
   another workstream (name it: WS-A … WS-I).
4. **Dropped / deferred**: findings you drop or defer, with the reason.

Every finding ID in your input must appear exactly once: in a ticket or in
Dropped/deferred. Prefer fewer, coherent tickets over one per finding. Keep
prose terse; tables are welcome.

When done, send `worker_done` with a three-sentence summary: number of
tickets, P1/P2 tickets first, and owner gates count, with
`--report-path docs/superpowers/plans/2026-10-31-review-fixes/<WS>.md`.
