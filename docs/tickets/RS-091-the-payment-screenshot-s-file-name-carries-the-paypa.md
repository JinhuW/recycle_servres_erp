---
id: RS-091
title: The Payment screenshot's file name carries the PayPal transaction ID
type: story
status: in-progress
priority: P3
created: 2026-09-20
reporter: jinhu
branch: feat/rs-091-paypal-txn-in-filename
pr:
version:
related: [RS-088]
---

## Ask

> pls also append the transcation id to the file name as well for the uploaded file.

(with a screenshot of the Cost Payment attachment chip reading
`2026-09-21-paypal-1400.00.jpg`)

## Context

Since RS-088 (v1.167.0) the PayPal screenshot on the Cost Payment tab is a
`Payment` attachment uploaded with `?scan=paypal`. The upload ran two OCR
passes: the receipt renamer, which gives the file its
`<date>-<method>-<amount>.<ext>` name, and — only after the row was written —
the PayPal scan that fills the transaction ID field. The name therefore said
which method and how much, but not which payment; matching a chip to a row in
the Bank payments ledger meant opening the image.

## Acceptance criteria

- [ ] A `?scan=paypal` upload whose scan reads a transaction ID is stored as
      `<date>-<method>-<amount>-<TXNID>.<ext>` (e.g.
      `2026-09-21-paypal-1400.00-8XY12345AB678901C.jpg`), and that is the name
      in the attachment chip, the DB row and the `attachment_added` event.
- [ ] When the receipt rename had nothing to say, the ID is still appended to
      the original name (`IMG_4432-8XY….jpg`).
- [ ] When the scan fails, the file is kept under its plain name and the
      response still answers `scan: null`.
- [ ] Uploads without `?scan=paypal`, and on any bucket other than `Payment`,
      are unchanged.

## Out of scope

- Renaming attachments already stored before this shipped.
- Re-naming the file when the user corrects the transaction ID field later.

## Notes

The scan moves ahead of the R2 upload (it has to, to name the file) and runs
concurrently with the receipt rename, so the wall time is max(rename, scan)
rather than rename → upload → scan.
