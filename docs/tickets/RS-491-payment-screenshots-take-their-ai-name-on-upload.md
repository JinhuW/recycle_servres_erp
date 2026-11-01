---
id: RS-491
title: Payment screenshots take their AI name on upload
type: story
status: done
priority: P2
created: 2026-10-31
reporter: jinhu
branch: JinhuW/eelgrass-3
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1041
version: 1.398.0
related: [RS-390]
---

## Ask

> The file name should rename when i upload instead of after i click the record payment buttom.

(With a screenshot of the form's Screenshots list: `dcf835ce60ce8cd1b6e2371106f3f676.jpg`, `iShot_2026-10-31_19.41.14.png`, and others still under their raw names.)

## Context

On *Record entry* / *Record payment* (desktop `EntryDialog`, phone
`PhAccountingSheet`) the entry doesn't exist yet, so picked screenshots wait in
`AcctPendingAttachments` and upload only on submit
(`useAccountingEntryForm.submit`). The rename to `<date>-<method>-<amount>.<ext>`
ran on the server at that upload (`maybeRenameReceipt`, shipped v1.333.0,
RS-390), so the list showed raw names until the entry was recorded.

The form already OCRs each image as it is added
(`POST /api/accounting/scan-receipt`) to fill in the amount. That reading is all
the name needs.

## Acceptance criteria

- [x] A screenshot added to a new entry shows the `<date>-<method>-<amount>.<ext>`
      name once the scan returns. It shows its original name only until then.
- [x] A screenshot the model can't read keeps its own name. PDFs aren't scanned
      and keep theirs.
- [x] The stored attachment carries the name the chip showed.
- [x] The desktop dialog and the phone sheet behave the same, since both use the
      shared hook.

## Out of scope

Skipping the second OCR at upload. The server still renames on upload, so the
entry drawer's live uploads and API clients are unchanged.

## Notes

`/scan-receipt` now returns `{ receipt, filename }`, and `filename` comes from
`buildReceiptName`, so the format lives in one place. The hook swaps the pending
`File` for a renamed copy and moves `liveFiles`, `readings` and `receiptFile` to
the new object, because removal and "Use screenshot" match files by identity.
