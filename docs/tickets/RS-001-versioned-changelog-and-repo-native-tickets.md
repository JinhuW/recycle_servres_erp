---
id: RS-001
title: Versioned changelog and repo-native tickets
type: story
status: in-review
priority: P2
created: 2026-08-31
reporter: jinhu
branch: feat/changelog-and-tickets
pr: "#223"
version:
related: []
---

## Ask

> I would like for all version can also include a change log which can also
> feed the claude code to understand all features.
>
> for future update.
>
> When i ask a new change. Let we create an kind of jira ticket style ticket in
> the repo. The claue code should create an jira ticket from my words.

## Context

Two things were missing, and they are the same problem seen from both ends.

`CHANGELOG.md` existed but had been dead since **v1.16.1** (2026-07-12).
Everything after it was hand-appended into one permanent `## [Unreleased]`
blob, and that stopped too, on 2026-08-06. By the time this ticket was written
the repo was on v1.106.0 with **159 of 215 `v*` tags carrying no section at
all**. The file's own header pointed at `scripts/release.sh`, a generator built
for the retired Docker/`main` release flow that nothing in the live
Railway/Cloudflare pipeline calls. The one gate that existed —
`.githooks/pre-push` — is opt-in per clone, and `git config core.hooksPath` is
unset in every worktree, so it had never run once.

At the other end, a change request arrived in chat, became a branch, became a
PR, and the original words were gone. `docs/superpowers/specs/` and `plans/`
cover work large enough to warrant a design doc; neither records the ask
verbatim, nor its status.

## Acceptance criteria

- [x] Every `v*` tag has a `## [X.Y.Z]` section in `CHANGELOG.md`, verifiable
      by `scripts/changelog.sh check`.
- [x] Hand-written prose from before the gap survives the rebuild verbatim,
      and `backfill` is idempotent.
- [x] A push to `dev` that bumps `package.json` without adding the matching
      changelog section fails CI, with the missing header named in the error.
- [x] `docs/FEATURES.md` states what the system does today, by area, with the
      version that introduced each behaviour.
- [x] `scripts/ticket.sh new` allocates an id that accounts for tickets on
      `origin/dev`, not just the local worktree.
- [x] A change request from Jinhu produces a ticket whose `## Ask` is his own
      words, unparaphrased, before implementation starts.

## Out of scope

- Surfacing the changelog inside the running app — the settings footer and
  mobile About sheet keep showing version and build date only.
- Retiring `scripts/release.sh` and its `package.json` entry points. Its
  changelog generator is superseded, but the rest of it is a separate decision.
- Closing the `main`-hotfix gap: `version-check.yml` triggers only on `dev`, so
  a hotfix pushed straight to `main` still bypasses the gate.

## Notes

- Backfilled sections are one bullet per squash commit. ~25% of historical
  subjects carry no `(#NNN)`, so those bullets have no PR link; the early
  post-`release.sh` ranges hold up to 8 commits, so not every section is a
  one-liner.
- `1.52.0`, `1.53.0` and `1.58.1` passed through `package.json` on `dev`
  without ever being tagged — their commits fold into the next tagged section.
  `1.9.0` is the mirror image: a section with no tag. Both are recorded in the
  changelog preamble rather than papered over.
- This work was deliberately cut onto its own branch off `origin/dev`. The
  session branch it started on carried an unpushed clients/suppliers feature
  labelled v1.105.0 — a version `dev` had already tagged for a different PR.
  That work is untouched on `session/20260828-175116`.
