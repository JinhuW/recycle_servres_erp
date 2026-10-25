---
id: RS-390
title: RMB Flow entries take AI-renamed payment screenshots; Reference removed
type: story
status: done
priority: P2
created: 2026-10-24
reporter: jinhu
branch: JinhuW/gudgeon
pr: 866
version: 1.333.0
related: []
---

## Ask

> help me answer why it can not create:
>
> [Image #1]
>
> also help me add a feature to upload screenshot with ai recognization.

> remove this reference:
> [Image #2]

> The AI feature is for screenshot renmaing

Image #1 is the desktop *Record entry* dialog: Paid · Purchase · PO-1524
(Stefen, Reviewing, PO cost $54,820.00, Business Account) · ¥366,090 ·
10/24/2026 · Alipay · Paid by Jinhu, with *Record payment* disabled. Image #2
is the dialog's *Reference* field ("Transfer or receipt number").

## Context

**Why it could not be created.** PO-1524's cost payment is *Company pay*: the
Business Account paid it, so that money belongs on Payments, not in the RMB
Flow. The form's `payerLock` (`lib/accountingForm.ts`) disables the button and
says so in a grey line under *Paid by*. The server refuses the same entry in
`payerAllowedTx` (`routes/accounting.ts`): "the cost was paid from the Business
Account — change that on the PO". To book it, set the PO's payment to *Self
pay* and Paid by Jinhu, which a manager can still do while the PO is
Reviewing. No code change is needed for this part.

**Screenshots.** An entry records money that moved through a manager's hands
(Alipay, WeChat, a bank transfer), and until now it kept no proof of that.
PO and sell-order payment evidence already go through `maybeRenameReceipt`
(`ai/receipt.ts`), which reads the screenshot and stores it as
`<date>-<method>-<amount>.<ext>`, so a list of them can be read without
opening each one. The user clarified that the AI's job here is the same
rename, not filling in the form.

**Reference.** Nobody uses the free-text transfer number. Now that a
screenshot can sit on the entry, the screenshot is the record.

## Acceptance criteria

- [x] An entry's drawer (desktop), its phone detail and Review's detail list
      the entry's screenshots. On the first two a manager can add or remove
      one while the entry is not voided.
- [x] An uploaded image is stored under the AI name
      `<date>-<method>-<amount>.<ext>` when the model can read it, and under
      its original name otherwise. The upload never fails because of the
      rename.
- [x] *Record entry* on desktop and phone takes screenshots before saving
      (pick, drop, or paste on desktop). They upload onto the new entry once
      it is saved. A failed upload leaves the entry saved and says so.
- [x] Adding or removing a screenshot shows in the entry's history and on
      Activity, and leaves the entry's sign-off and version alone.
- [x] Only managers can add or remove a screenshot, and a voided entry
      refuses both (409).
- [x] The *Reference* input is gone from *Record entry* and the edit form on
      both shells. An entry that already has a reference still shows it, and
      editing that entry keeps it.

## Out of scope

- Filling in the form from the screenshot. The user ruled this out: the AI is
  for renaming.
- Dropping the `reference` column or its stored values.
- A paperclip marker on log rows.
- Making the Business-Account lock louder than the line under *Paid by*.

## Notes

- Plan: `~/.claude/plans/scalable-bubbling-lantern.md` (session plan, not in
  the repo).
- Verified: `tests/accounting-attachments.test.ts` (rename with a stubbed
  model reply, original name with no key, 403/409/415/404, Review rows,
  version and sign-off untouched, reference kept on edit). A Playwright run
  on a private copy of the local DB (desktop 1440 and phone 390) covered
  pick, paste and remove before saving, the lightbox over the dialog, upload
  on save, live add and remove in the drawer, the history lines, the edit
  form, the phone entry screen and the phone sheet. Review's pane was checked
  through the API, not on screen. Locally the OCR is the stub, so the rename
  itself was exercised only by the test.
- The run found that the attachment chip's remove button and the lightbox's
  close button defaulted to `type="submit"`, so either would have saved the
  entry from inside the form. Both are now `type="button"`.
- New entries hold their files locally and upload them after the create,
  the same way the new-PO page buffers its Submission evidence
  (`DesktopSubmit.tsx`), because an entry has no id to attach to until it
  exists.
