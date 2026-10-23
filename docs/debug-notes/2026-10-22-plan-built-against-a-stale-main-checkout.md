# A plan built in the main checkout described a repo fifty releases old

**Date:** 2026-10-22 · **Ticket:** RS-350 · **Cost:** one full re-plan and a
second review before any code was written.

## What happened

The session started in the main checkout, which sat on `dev` at v1.260.0.
The whole investigation and the first approved plan were written against that
tree: no Accounting page, no commission *Company paid* option, next migration
0182. `scripts/new-session.sh` then cut the worktree from `origin/dev`, which
was at v1.314.0 — fifty-four releases on, with the Accounting page (RS-340),
the commission payer's company option (RS-328) and migrations up to 0196. The
plan's central reading ("the accounting page must mean the Payments page")
was false against the code the branch would actually change.

## Why it is easy to hit

Nothing in the main checkout says it is stale: `git status` is clean and the
session hook only says you are not in a worktree. Every file read, every
`grep`, every ticket listed is internally consistent, so the plan reads as
well-grounded. The gap only shows when a worktree is cut from `origin/dev`.

## Rule

**Cut the worktree first, read second.** Run `scripts/new-session.sh
--print-only` and `EnterWorktree` before the first `grep`, even for the
read-only part of planning — the worktree is on `origin/dev`, the checkout is
on whatever it was last pulled to. If a plan has to be written from the main
checkout, start with `git fetch origin dev && git log --oneline HEAD..origin/dev
| wc -l` and treat a non-zero count as "the code I am about to read is not the
code I will change".

## Also found on the way

`pnpm dev` does not run migrations: the dev runner is `tsx watch`, and only the
container boot path (`scripts/migrate.mjs`) migrates. A dev DB behind the
branch fails at login with `column "credential_version" does not exist` (or
whatever the newest migration added). Run `pnpm db:migrate` against the dev DB
before `pnpm dev` when the branch carries migrations.
