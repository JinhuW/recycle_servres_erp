---
id: RS-159
title: Pre-release review fixes for v1.201.0–v1.202.0
type: bug
status: backlog
priority: P1
created: 2026-10-02
reporter: jinhu
branch: fix/prerelease-review-v1-202
pr:
version:
related: [RS-157, RS-158]
---

## Ask

> /code-review high dev -> main, fix all issue and release to prod.

## Context

A `/code-review high` of `origin/main...origin/dev` covered v1.201.0 (RS-157,
the review-mode move prompt and the PO list button) and v1.202.0 (RS-158, the
phone Products landing). It returned six findings. Neither release had reached
main (still v1.200.2), so the fixes ship in the same release, as v1.202.1.

Each finding was checked against `origin/dev`:

1. **Moving a Draft from review mode skipped the hand-off.** "Move to Reviewing"
   posted `/advance {toStage:'reviewing'}`. A manager's stage-jump holds only the
   proof rules (cost, transaction id, screenshots). The facts the hand-off
   collects (source, delivery, tracking, payment method) are deliberately
   unchecked there, so a Draft from before the hand-off existed is never stuck.
   As a result the PO reached Reviewing with all of them null. The PO page never
   allows this: its stepper offers only the next step, and Draft → In Transit
   goes through the hand-off.
2. **The stale-stage guard was a client race.** Both review mode and box-check
   Approve read the PO with a GET, then posted an absolute `toStage`. A move
   landing between the two could still be jumped backwards, for example a PO
   that had just reached Ready to Pay sent back to Reviewing.
3. **The prompt's stage came from `order.status`.** That field can read `Mixed`,
   and it was English inside the Chinese sentence ("目前处于 In Transit"). There
   were no PO stage-name keys at all. The box check's stale-stage message had
   the same problem.
4. **The phone landing could outlive its PO.** `productsLanding` was cleared
   only once the path left every PO. Opening the line form on PO-A, reaching
   PO-B, then pressing Cancel kept A's landing. A later visit to A by link then
   opened at the bottom.
5. **Each Move read the whole PO** (lines, photos, events, packages) to compare
   one field. This goes away with #2.
6. **The list row stayed stale after a re-prompt.** Cancelling and clicking
   again asked about the old stage and repeated the round trip.

## Acceptance criteria

- [x] `POST /api/orders/:id/advance` accepts `fromStage`. If the PO's lifecycle
      (read under the row lock) differs, it refuses with 409
      `{ code: 'stageMoved', lifecycle }`, moves nothing, and writes no event.
      The check runs before `sameStage`. The lifecycle is what the caller may
      see, so a purchaser is never told "Sold".
- [x] `/advance` accepts `enforce: 'all'`, which holds every leave-Draft blocker,
      the hand-off's facts included. Without it a manager's jump behaves as
      before.
- [x] Review mode's Move sends `{ toStage: 'reviewing', fromStage, enforce: 'all' }`
      with no GET first. A Draft missing a hand-off fact gets the server's
      message and stays Draft.
- [x] A stale Move asks again from where the PO really is, or opens straight
      away if it is past Reviewing. The list row, or the PO page's stage, takes
      the real stage.
- [x] Box-check Approve sends `fromStage: 'reviewing'` with no GET first. A
      stale Approve names the PO's real stage in the reader's language.
- [x] The prompt and the stale-stage message name the stage from the lifecycle,
      translated (zh: 草稿 / 在途 / 审核中 / 待付佣金 / 已完成 / 已售罄).
- [x] On the phone, a Products landing is dropped once any other PO opens, or
      once the shell is idle on no PO at all. The return from the line form to
      the same PO still lands, even after the address changed under the form.

## Out of scope

- The PO page's own Save also posts an absolute `toStage` from page state
  (`DesktopEditOrder.tsx` manager save paths). It is the same race class and
  has been in prod for a long time. It was not part of this review and is left
  as a follow-up.
- Translating the stepper's stage chips. Only sentences that name a stage use
  the new keys.
- `detailMeta` in `MobileApp` uses the same off-every-PO-only clear. It
  pre-dates these releases and was not in the findings.
- A Draft moved from review mode still skips In Transit. So there is no
  `order_submitted` notification (that one is for a purchaser's submission) and
  no `handoff` timeline event. The `submitted` event is written, and the facts
  were audited when they were set.

## Notes

Plan: `~/.claude/plans/zazzy-exploring-sifakis.md`.

`enforce: 'all'` is opt-in per request, not a new server default. The
server's "a manager jump skips the facts" escape hatch is deliberate
(`services/orderTxnRule.ts`), and about twenty backend test files jump Drafts
with `toStage`. A client can only make the check stricter.

Deploy skew: the new bundle has no GET guard. Until Railway serves 1.202.1, a
stale Move or Approve could jump stages. The release is confirmed against
prod health, not only the Worker.

The phone fix changed during verification. The plan's rule ("idle with the
address on another PO") dropped the landing on an ordinary return. `goBack`
sets the capture idle and then calls `navigate`, and the address lands one
render later. So after the address had changed under the form, Back reopened
the PO at the top. The rule now keys on the PO actually opened
(`detailOrder`). Every exit from the PO line form (Cancel, the camera's ×,
Save) runs through `goBack`/`doneToDetail` and navigates back to the PO.
`cancelCapture` (idle, address untouched) is not reachable from that flow
today, so the review's leak path is a guard, not a reproduced bug.

Seen while verifying, not touched: pressing Enter to dismiss the error dialog
after a refused move re-opens the review-mode prompt. The prompt hands focus
back to the row button that opened it, and the error dialog doesn't take
focus, so Enter activates the button underneath. This predates these releases.
