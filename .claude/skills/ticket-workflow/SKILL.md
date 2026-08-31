---
name: ticket-workflow
description: Use when the user asks for a change to this repo — a new feature, a fix, a tweak, a "can you make it…" — to capture the request as a ticket in docs/tickets/ before implementing, and to close the loop afterwards through CHANGELOG.md and docs/FEATURES.md. Also use when asked to file, update, list or close a ticket.
---

# Ticket workflow

Every change request becomes a ticket in `docs/tickets/` before it becomes
code. The ticket's job is to preserve **what was actually asked**, in the
asker's own words, so that a year later the reasoning is recoverable from the
repo instead of from a chat log nobody kept.

## When this fires

A request to change the software: "add X", "fix Y", "can the orders page
also…", "I want it to…". Not for questions, reads, investigations, or work
already covered by an open ticket — check `docs/tickets/INDEX.md` first.

## Order of operations — this matters

This repo runs `plan-first`: nothing is written until a plan is reviewed and
approved. A ticket is a written file, so it does **not** get written first.

1. **Draft the ticket inside plan mode** and show it as part of the plan.
2. On approval, `scripts/ticket.sh new "<title>"` and fill the file in — this
   is implementation step 1.
3. Then build.

Do not create the ticket before the plan is approved, and do not start building
before the ticket exists.

## Writing the ticket

```sh
scripts/ticket.sh new "<short imperative title>" --type story --priority P2
```

`--type`: `story` (new user-visible capability) · `bug` · `task` (internal
work, no user-facing change) · `chore`. `--priority`: `P1` urgent · `P2`
normal · `P3` someday. Infer both; don't interrupt to ask.

Then fill the sections:

- **Ask** — the user's words, **verbatim**. Copy them. Do not tidy the grammar,
  do not fix the spelling, do not translate them into solution language, do not
  merge three sentences into one. If the request came in fragments, the ticket
  carries fragments. This is the only irreplaceable field in the file: every
  other section can be reconstructed from the code, and this one cannot.
  Quote it as a Markdown blockquote.
- **Context** — why it is worth doing, and what a reader needs in order to
  judge the acceptance criteria. Cite what you found in the codebase: the
  route, the current behaviour, the version it last changed in.
- **Acceptance criteria** — testable statements, as a checklist. "The orders
  table shows a stage chip per status", not "improve the orders page". Tick
  them as they land.
- **Out of scope** — what was considered and deliberately dropped. This is what
  keeps the same argument from being had twice.
- **Notes** — decisions made along the way, links to the spec/plan under
  `docs/superpowers/`, surprises worth recording.

## Closing the loop

When the work ships:

1. `scripts/ticket.sh status RS-nnn done` (re-indexes automatically).
2. Fill `pr:` and `version:` in the frontmatter — `version:` is the join to
   `CHANGELOG.md`.
3. Add the `## [X.Y.Z]` section to `CHANGELOG.md` **in the same push as the
   version bump**. `version-check.yml` fails the push otherwise;
   `scripts/changelog.sh draft` prints a starting point from the branch's
   commits, which you then rewrite into prose — what changed, and why it was
   worth doing.
4. If user-visible behaviour changed, edit the matching bullet in
   `docs/FEATURES.md` and cite the new version. Nothing enforces this one; it
   rots if you skip it.

## Other commands

```sh
scripts/ticket.sh list --status backlog
scripts/ticket.sh index          # regenerate docs/tickets/INDEX.md
```

If `index` warns about a duplicate id, two sessions allocated the same number:
rename one file and edit its `id:` line.

See `docs/tickets/README.md` for the field vocabulary.
