# Tickets

A ticket is the record of **what was asked, in the asker's own words**, before
anyone started arguing about the solution. Everything else in this repo —
specs, plans, commits, the changelog — describes what we decided to build. Only
the ticket says what was actually requested.

Tickets live here as Markdown files, one per file, named
`RS-<nnn>-<slug>.md`. [`INDEX.md`](./INDEX.md) is generated; don't edit it.

## Creating one

```sh
scripts/ticket.sh new "Purchasers can edit a PO until it is Done" \
  --type story --priority P2
```

Claude Code drafts these directly from a request — see the `ticket-workflow`
skill in `.claude/skills/`, or type `/ticket`. The `## Ask` block is filled with
the requester's words **verbatim**: not tidied, not translated into solution
language, not summarised. If the request arrived as three fragmented sentences,
the ticket carries three fragmented sentences. That is the field that makes the
ticket worth keeping a year later.

Because `plan-first` governs this repo, a ticket is *drafted* while planning and
*written* as the first step of implementation — not before the plan is
approved.

## Fields

| Field | Values | Notes |
|---|---|---|
| `id` | `RS-001`… | Allocated by `ticket.sh new`, which checks `origin/dev` as well as the local worktree. |
| `type` | `story` `bug` `task` `chore` | `story` = new user-visible capability; `task` = internal work with no user-facing change. |
| `status` | `backlog` `in-progress` `in-review` `done` `wont-do` | Change it with `ticket.sh status RS-001 done` — that re-indexes for you. |
| `priority` | `P1` `P2` `P3` | P1 urgent, P2 normal, P3 someday. |
| `branch` | branch name | Where the work happened. |
| `pr` | `#221` | Filled at PR time. |
| `version` | `1.106.0` | Filled when it ships — this is the join to `CHANGELOG.md`. |
| `related` | `[RS-004]` | Other tickets. |

## Sections

- **Ask** — verbatim. Never paraphrased.
- **Context** — what makes it worth doing; what a reader needs to judge the
  acceptance criteria.
- **Acceptance criteria** — testable statements. "The orders table shows the
  stage chips", not "improve the orders page".
- **Out of scope** — what was considered and deliberately dropped. This is what
  stops the same argument being had twice.
- **Notes** — decisions, links to the spec/plan, surprises.

## ID collisions

Several Claude Code sessions run against this repo at once, each in its own
worktree off `origin/dev` — the same setup that already produces colliding
version bumps and migration numbers. `ticket.sh new` fetches `origin/dev` and
allocates above the highest id it finds there *and* locally, which makes a
collision rare rather than impossible. If two land anyway, `ticket.sh index`
prints a warning: rename one file and edit its `id:` line.

## Where a ticket sits in the workflow

1. Request → ticket here (`status: backlog`).
2. Plan approved → `in-progress`, branch and design docs linked in **Notes**.
3. PR opened → `in-review`, `pr:` filled.
4. Shipped → `done`, `version:` filled, and the release's `CHANGELOG.md`
   section references the ticket.

See the "Tickets, changelog & features" section of the root `CLAUDE.md`.
