---
id: RS-098
title: Phone file drop boxes offer the photo library and files, not only the camera
type: bug
status: in-progress
priority: P2
created: 2026-09-21
reporter: jinhu
branch: feat/file-drop-photo-library
pr:
version:
related: [RS-071, RS-084, RS-088]
---

## Ask

> The current file drop box only support use camera (at least in the Iphone), update them to also allow select from photo library or file folder.

## Context

The screenshot drop boxes on the phone PO page (Cost Payment's PayPal / cash
/ chat screenshot, the Commission screenshot), the same boxes inside the
hand-off dialog, and the "+" tile on the line-photo strip all sit on a hidden
`<input type="file">` that carries `capture="environment"`. On iOS Safari —
and Android Chrome — that attribute *skips* the OS chooser ("Take Photo or
Video / Photo Library / Choose File") and opens the rear camera straight
away, so a screenshot already on the phone could not be attached from the
phone at all.

Without `capture`, the same `accept="image/*"` input shows the full sheet,
camera included. The fix is to drop the attribute; nothing new is built.
The label-scan screens (`Camera.tsx`, the desktop `LineDrawer`) never carried
it and already show the chooser.

## Acceptance criteria

- [ ] On an iPhone, tapping the Cost Payment screenshot box, the Commission
      screenshot box, the hand-off dialog's payment box, or the line-photo
      "+" tile opens the OS sheet offering the camera, the photo library and
      Files — not the camera alone.
- [ ] Desktop behaviour is unchanged (browsers there ignored `capture`).
- [ ] `grep -rn 'capture=' apps/frontend/src` is empty; `AttachmentDropzone`
      no longer has a `capture` prop and `PaymentFields` /
      `CommissionPaymentFields` no longer take a `phone` prop whose only job
      was to set it.

## Out of scope

- The live label-scan viewfinder (`Camera.tsx`, `SnScanner.tsx`) — those are
  `getUserMedia` streams, not file pickers, and were not asked about.
- Any change to what file types each box accepts.

## Notes

- Plan: `~/.claude/plans/cryptic-swimming-feigenbaum.md`.
- One more tap for someone who *did* want the camera (sheet → Take Photo);
  that is the trade the ask makes.
- The line-photo input is `multiple`, so the library sheet now also lets
  several photos be picked at once.
