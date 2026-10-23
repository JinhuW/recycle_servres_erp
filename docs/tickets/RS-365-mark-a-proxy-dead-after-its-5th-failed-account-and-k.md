---
id: RS-365
title: Mark a proxy DEAD after its 5th failed account, and keep each worker's account history
type: story
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/rasbora
pr: 842
version: 1.319.0
related: []
---

## Ask

> Update the Fleet, Once one proxy failed over 4 account, then mark the proxy as DEAD.
>
> For each workers. Pls also track the history of all account it used.

## Context

Every Facebook worker browses through one proxy (`fleet.toml` → `proxy_env`;
the `/v1/fleet` document shows it as `proxy.url`, `scheme://host:port` with the
login cut out, since v1.278.0). When an account breaks on a worker the manager
replaces it through **Assign account** (`POST /api/facebook-pool/:no/assign`)
and sends the old one to Problem or Retired; the weekly liveness check
(`services/fbPoolAliveCheck.ts`, v1.280.0) moves a disabled one to Problem too.
Nothing tied those failures to the proxy, so a burned IP kept eating fresh
accounts, and nothing listed which accounts a worker had had: the pool ledger
(`fb_pool_events`) records `assigned` with the worker but no proxy and has no
per-worker view.

Answers to the questions asked before planning:

- An account **fails** on a proxy when it leaves a worker as **Problem or
  Retired** — Assign's "where does the old one go", the weekly check, or a
  manager's edit, retire or delete. Back to Available is a rotation, not a
  failure.
- "Over 4" is literal: the **5th** distinct failed account marks it DEAD.
- DEAD shows on the proxy and **Assign refuses** a worker behind it until a
  manager revives the proxy (after swapping the IP, say).

## Acceptance criteria

- [x] Every time a pool account goes onto a worker, a history row opens with the worker, account #, UID and the worker's proxy URL at that moment; it closes with the outcome (Available, Problem, Retired, moved to another worker, removed) whichever path moved it.
- [x] The worker page lists every account the worker has used, newest first: #, login, proxy, from–to, outcome.
- [x] A proxy with more than 4 distinct accounts failed on it (since its last revive) reads **DEAD** in the Fleet table's Proxy column and on the worker page; below that it shows its failed count.
- [x] Assign to a worker behind a DEAD proxy is refused (409 `fpProxyDead`) before anything reaches the worker; the dialog says so up front and disables Assign.
- [x] A manager can **Revive** a DEAD proxy from the worker page; failures before the revive stop counting.
- [x] Assignments already in the pool ledger appear in the history (backfilled), marked "proxy not recorded".

## Out of scope

- Counting the worker's own failed or locked logins (the coordinator's
  `login_attempts` ledger): it would need a facebook-tracker release and a
  contract change, and a failed login is often transient.
- Keying a proxy by its exit IP: the lookup can be pending or failed at the
  moment of Assign, and the fleet page already treats the URL as the proxy.
- The VM's own IP (no proxy) is never marked DEAD.
- The pool editor's worker picker does not pre-mark DEAD workers; its Assign
  gets the same refusal.

## Notes

- ERP-only. The backend reads the `/v1/fleet` document it already proxies to
  learn a worker's proxy at Assign time; no tracker change, no fleet release.
- History is kept by a trigger on `fb_pool_accounts`, so all six writers
  (both of `/assign`'s updates, `PUT`, `/retire`, `DELETE` and the weekly
  check) record it without each one being edited.
- Backfilled rows carry no proxy, so failures before this release do not count
  toward DEAD.
- Plan: `~/.claude/plans/sorted-splashing-pnueli.md` (session-local).
