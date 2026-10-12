---
id: RS-234
title: Every save of a RAM line asks the part # question
type: bug
status: done
priority: P2
created: 2026-10-11
reporter: jinhu
branch: fix/ram-part-question-on-save
pr: 616
version: 1.247.2
related: [RS-228, RS-233]
---

## Ask

> dev to prod change. Identfy all issues , fix them, then release to prod.

That review (RS-233) kept its finding 26 for a follow-up. The requester then
approved the follow-up through the agent coordinating the session. The words
below are the coordinator's, relaying that approval, and not the requester's:

> Submitting or saving a RAM line that was never confirmed in the drawer must
> ask the 'specs disagree with the part #' question, the same way confirming
> in the drawer does. Requirements: - Cover every path that saves a PO:
> desktop and mobile, the drawer, inline edits, Submit and Save. - Don't ask
> twice for a line the user already confirmed. - Add tests for the paths you
> change.

## Context

RS-228 (v1.243.0) checks a RAM line against its own part number. The readout
under Part # shows the decode. "Specs don't match the part #" was asked only
by the desktop drawer's Confirm and the phone form's save, when a named field
contradicts the part #. Every other write of a line skipped it:

- New PO (`DesktopSubmit`):
  - Submit order sends every line not confirmed in the drawer.
  - Adding the next line (or opening Scan RAM sheet) saves the open line
    through `settleActiveLine`.
  - The RAM sheet's auto-save (RS-116) saves every stick that passes
    `lineSaveBlock`.
- PO page (`DesktopEditOrder`): Save writes every new or edited line.
- Inventory editor (`DesktopInventoryEdit`): Save PATCHes the line's specs
  and part #.

The answer lived in the drawer's component state. Nothing outside the drawer
could tell whether the question had been answered, and closing the drawer
forgot the answer.

## Acceptance criteria

- [x] One rule, `lib/ramPartQuestion.ts`, is shared by:
  - the drawer;
  - the phone form;
  - every save path.
- [x] New PO, Submit order:
  - asks about each line not confirmed in the drawer, product by product,
    naming each;
  - Cancel stops the submit, and answers already given stand.
- [x] New PO: adding the next line (or opening Scan RAM sheet) saves the open
  line only after the question.
- [x] RAM sheet auto-save:
  - asks about each stick before the save;
  - cancelling holds that stick, and every later one in question, unsaved;
  - the message counts the held sticks.
- [x] PO page, Save:
  - asks about each new or edited line;
  - Cancel stops the save and takes back a stage move.
- [x] Inventory editor: Save asks about a RAM line.
- [x] Phone form: still asks at save.
- [x] Nothing is asked twice:
  - "keep as entered" is stored on the line (`_partKept`), so Submit and Save
    skip what the drawer asked;
  - a line confirmed in the drawer isn't asked again;
  - fixing one field doesn't reopen the others;
  - a saved line's own disagreements count as answered until an edit changes
    one or adds one. This holds on the PO page, in Review mode, in the
    inventory editor and in the phone form.
- [x] Recording "keep" doesn't mark a PO line edited, so a purchaser's
  submitted PO isn't sent back to Draft by the answer alone.
- [x] Taking a value from the part # can make the spec cascade clear another
  field. When it does, the save stops with the usual "still needed" message.
- [x] Tests cover:
  - the rule;
  - the multi-line settle;
  - the seed on loaded lines;
  - the dirty rule.

## Out of scope

- **Applying an AI-review finding** (Review mode). It writes one checked value
  onto a line already on the PO, and the review's own `checkRam` judges the
  line against the part #.
- **Storing "keep as entered" on the server.** A saved line's disagreements
  count as answered instead. So a line saved before v1.247.2 through a path
  that didn't ask is asked about only once an edit changes or adds a
  disagreement. The readout and the AI review still show it.
- **A component-test renderer for the page flows.** The repo has none: no
  jsdom, no testing-library. Following the codebase's convention, the pure
  half is unit-tested, and the flows were driven in a browser instead (see
  Notes).

## Notes

- **What "keep" covers.** It now covers each disagreement shown, keyed by
  canonical part # + field + the form's value. RS-228's key was the exact set,
  so fixing one field reopened the rest; with the new key that no longer
  happens in the drawer either.
- **How the saves ask.**
  - `usePartQuestion()` (`components/RamPartCheck.tsx`) is the dialog as a
    call a save can wait on.
  - `settlePartQuestions` asks line by line and writes each answer back as it
    is given. It returns the lines a cancel left unsettled: Submit and Save
    treat those as a stop, and the sheet holds them.
- **Seeding.**
  - `orderLineToEditLine` seeds `_partKept` with the disagreements a loaded
    line was saved with; this covers the PO page and Review mode.
  - The inventory editor seeds its own at load.
  - The phone form seeds from the line it is editing.
- **Verification.** The flows below were driven with Playwright against the
  local stack, desktop shell and phone shell, with the purchaser and manager
  seed users. All passed, and every PO the run made was deleted afterwards.
  - Submit: Keep, then Cancel, then a second Submit and Use.
  - The drawer's Confirm, then Submit, which didn't ask again.
  - PO-page Save:
    - a qty edit didn't ask;
    - a speed edit asked, naming `#1`;
    - Cancel stopped the save;
    - the drawer's Confirm with Use.
  - Inventory editor:
    - a rank edit asked;
    - a price edit didn't.
  - Phone: a qty edit didn't ask; a rank edit did.
  - RAM sheet, with the stub's label read rewritten to contradict the part #:
    - two sticks, each asked about by name;
    - Keep, then Cancel: one saved, one held and counted.
