---
id: RS-025
title: Serial-chip review findings before the prod cut
type: bug
status: in-progress
priority: P2
created: 2026-09-04
reporter: jinhu
branch: fix/rs-025-serial-chip-review-findings
pr:
version:
related: [RS-023, RS-022]
---

## Ask

> /code-review high dev vs main. then push to main before fix everything

## Context

A `high`-effort review of the diff a `dev` → `main` release would ship
(`origin/main...origin/dev`: 3 commits, 18 files, all frontend — RS-023's serial
chips and brand dialog, plus RS-022's close-out) returned five findings.  The
release bookkeeping itself is clean: `dev` is `1.126.0`, the changelog section
and the `v1.126.0` tag match, and `main` carries nothing that was never
back-ported.  What the review found is in RS-023's new chip field, which has
never been on `main` — so this is the last cheap moment.

| | Where | Cost if shipped |
|---|---|---|
| 1 | `SerialChipsField.tsx:44` | **A scanned serial is stored truncated.**  The field decides which characters are still being typed with `raw.endsWith(pending)`.  A scan writes from outside, and if the code it appends happens to end with the same characters as the half-typed input, that tail is stripped off the *scanned* value.  The next chip edit persists the short serial |
| 2 | `tokens.css:341` + `phone.css:369` | The scan button is absolutely positioned inside the field, which is now a `max-height: 190px` scroller — so past ~10 chips the button scrolls out of the box.  It goes unreachable in exactly the 32-stick lot the chips were built for |
| 3 | `desktop.css:1507` | `.order-readonly` greys `input, select, textarea`; the chip field is a `div`, so a Done PO shows one full-strength, live-looking serial field among greyed neighbours.  Edits are still blocked by the disabled fieldset — it only *looks* editable |
| 4 | `SerialChipsField.tsx:132` | Backspace arms the last chip, but nothing disarms it: click away, come back, one Backspace deletes a serial with no warning and no undo.  Tapping the scan button does the same on iOS, which does not blur an input when a `<button>` is tapped |
| 5 | `docs/tickets/INDEX.md:9` | RS-023's Shipped column reads `—` though its ticket records `version: 1.126.0`.  Second time: `fab8f38` fixed the same staleness for RS-021 a release ago |

Finding 1 needs no exotic input.  Chips `["X"]`, `2` typed but not yet chipped,
tap scan: the value becomes `"X\n2\nSNX0012"`, which ends with `2`, so the field
renders `X`, `2`, `SNX001` and puts `2` back in the input.

## Acceptance criteria

- [ ] A serial appended from outside the field (the QR scanner) is chipped
      whole, whatever the half-typed text in the input happens to be — including
      when the scanned code ends with those same characters.
- [ ] The uncommitted-text decision is made by identity — is this the value the
      field itself last emitted — not by a suffix match, and a unit test covers
      the truncation case through to the parsed serial list.
- [ ] Typing a character does not clear the input: an ordinary keystroke still
      round-trips through the parent unchanged.
- [ ] The scan button stays docked in the field's corner when the chip list
      overflows and scrolls.
- [ ] On a read-only (Done) order, the serial field dims with the other fields
      and its chips stay legible.
- [ ] An armed chip disarms when the input loses focus, and when a scan writes
      into the field — the red outline never survives onto a chip the user did
      not arm.
- [ ] `docs/tickets/INDEX.md` shows RS-023 shipped in 1.126.0.

## Out of scope

- Anything in RS-024 / PR #268 (pending payments), which is open on `1.127.0`
  and unmerged.
- The read-only `SerialNumbers` pills, the serial validators, and serial
  storage — all untouched, as in RS-023.

## Notes

- Plan: `~/.claude/plans/crystalline-forging-nautilus.md`.
- Version is **1.126.1**, not 1.127.0: PR #268 already holds 1.127.0.  Landing
  the patch first keeps that bump valid; the reverse order would renumber a
  reviewed PR.
- Finding 5's cause, so it stops recurring: `ticket.sh status <id> done`
  reindexes immediately, so filling `version:` *after* it writes an empty
  Shipped cell (`git show c66ffba`).  Fill the fields first, reindex second.
