# A wait for a PR's checks hung for six hours: the PR was conflicting, so no check ever ran

**Symptom.** During the v1.237 release, the RS-215 fix PR (#577) was opened
and a background loop waited for its checks:

```bash
until gh pr checks 577 --json bucket --jq 'all(.[]; .bucket != "pending")' | grep -q true; do sleep 30; done
```

Nothing came back for six hours. The release sat between "PR opened" and
"PR merged" until a peer session's message happened to wake the agent.

## Root cause

A docs-only ticket-close PR (#576) merged to `dev` a minute before #577 was
opened. Both edited `docs/tickets/INDEX.md`, so #577 was `CONFLICTING` from
the start. GitHub runs no `pull_request` workflow on a PR it can't merge, so
the PR had no checks at all. `gh pr checks` then printed
"no checks reported on the … branch", exited non-zero and wrote no JSON. The
`grep` never matched and the loop slept forever. It had no exit for "this PR
will never get checks". A loop that only exits on success is a hang in
waiting.

## Fix

- Rebase onto `origin/dev`. `docs/tickets/INDEX.md` is generated, so
  resolve its conflict with `scripts/ticket.sh index` rather than by hand.
  Then push, and the checks start.
- Wait on a PR with a loop that has every terminal state. Check
  mergeability first and on each pass:

  ```bash
  m=$(gh pr view N --json mergeable --jq .mergeable)   # CONFLICTING → stop and rebase
  ```

  Also stop on `fail`, and stop when the PR still reports no checks after a
  few minutes.

## How not to hit it again

- Any PR touching `docs/tickets/INDEX.md` or `CHANGELOG.md` races with every
  other session's ticket-close PR. Right before waiting on CI, run
  `gh pr view N --json mergeable,mergeStateStatus`.
- When a wait has no terminal state besides success, its silence looks
  exactly like "still running". Give every wait loop a failure exit and a
  time limit.
