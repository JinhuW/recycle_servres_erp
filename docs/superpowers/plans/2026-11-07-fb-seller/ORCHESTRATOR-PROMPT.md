# Orchestrator prompt

The orchestrator runs as an Orca coordinator session (the `orchestration`
skill) and dispatches one Orca worker per workstream, each in its own
worktree. Paste the block below into the coordinator session.

````text
You are the orchestrator for RS-565, Facebook seller accounts. I am opting in
to multi-agent orchestration with Orca workers.

Read, in this order, before doing anything else:
1. AGENTS.md (the first rule: never cause a Facebook login) and CLAUDE.md
2. docs/superpowers/plans/2026-11-07-fb-seller/README.md
3. docs/superpowers/plans/2026-11-07-fb-seller/CONTRACTS.md
4. docs/tickets/RS-565-facebook-seller-accounts-post-buy-ads-route-messenge.md

Then run the workstreams as Orca workers, one worktree and branch each, off
origin/dev, PR to dev, squash-merged by you one at a time:

- Wave 1: A1 alone, and B at the same time (B needs only the contract).
  Merge A1 as soon as CI is green.
- Wave 2, once A1 is on dev: A2, C, D1, D2, E in parallel (B keeps going).
- Wave 3, once A2, B, C, D1, D2, E are merged: R (a fresh worker, given only
  CONTRACTS.md and the merged diff range).
- Wave 4: F.local. F.live never without the owner's explicit yes for each
  numbered step.

Every worker's brief contains: its WS file path, README.md and CONTRACTS.md
paths, the sentence "CONTRACTS.md is frozen; if you need a change, stop and
report it instead of changing it", the files it owns, its exit criteria, and
the README's "Rules for every agent". Tell each to run its tests, bump the
root version (ERP code) or write under [Unreleased] (tracker code), add the
CHANGELOG section, and hand back for merge; you rebase-check numbers
(migration, version, CHANGELOG heading) right before merging.

Absolute limits for every worker: no command on 10.10.10.73, 10.10.60.14,
10.10.60.10 or oci-sg-1 that starts, stops, restarts or recreates a
container, runs deploy.sh or edits a file; no re-login; no fleet release; no
Railway variable; no push to main; no live Facebook action; no secret from
fb_pool_accounts, FB_POOL_KEY, the coordinator vault or secrets.env in a
commit, fixture, log or PR body; no tracker Postgres test on 5432 or 55432;
no pkill of dev servers; never push the vendored monitor to upstream origin.

When a worker reports a contract change request, pause it, decide (or ask
me), change CONTRACTS.md in one PR, and tell every running worker.

After each merge, update the README Status table (or check the worker did)
and send me one short message: what merged, what is running, what is
blocked and why. Never predict a running worker's result.

Begin by confirming you have read the four documents, listing the workers
you will start now with one line each, and then start them.
````
