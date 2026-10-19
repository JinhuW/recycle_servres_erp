---
id: RS-320
title: Attachments on a sell order for the sell records
type: story
status: done
priority: P2
created: 2026-10-19
reporter: jinhu
branch: sell-order-attachments-ui
pr: 783
version: v1.294.0
related: []
---

## Ask

> Add an attachment section in the sell order
>
> [screenshot of the sell-order page's right column: Payment receiver, Internal notes, History]
>
> so we can upload the sell records.
> /frontend-design:frontend-design design the UI for attacment uploads

## Context

A sell order can already hold files, but only as evidence of a status change:
the Shipped / Awaiting payment / Done / Closed dialog takes a note and
attachments, stored per status in `sell_order_status_attachments` and shown
read-only under "Tracking & evidence" (`routes/sellOrders.ts`, v1.3-era
migration 0003). There is no place to file a document that belongs to the
order as a whole — the marketplace sale record, the invoice sent, a packing
list — and nothing can be uploaded from the view page without opening a
status transition.

The right-hand column of the sell-order page (v1.194.0) is where the order's
side records live: payment receiver, internal notes (live-saved since
v1.249.0) and the folded History. The new section sits there, between
Internal notes and History, and saves live the way the notes do.

## Acceptance criteria

- [ ] The sell-order page's right column has an "Attachments" card, in view
      and edit mode, between Internal notes and History.
- [ ] A manager can drop or pick files there (PDF, PNG, JPG, WEBP, XLSX, CSV,
      within the workspace upload cap); each lands as a row with filename,
      size, and who uploaded it when. Images open in the lightbox, other
      files in a new tab.
- [ ] Each row has a remove control; removing deletes the file from storage.
- [ ] Uploads and removals persist immediately, not on the form's Save, and
      survive a cancelled edit.
- [ ] The order's History records each attachment added and removed.
- [ ] `GET /api/sell-orders/:id` returns the list as `order.attachments`;
      `POST /api/sell-orders/:id/attachments` (multipart `file`) and
      `DELETE /api/sell-orders/:id/attachments/:attachmentId` are manager-only
      and apply the same MIME and size rules as the evidence uploads.

## Out of scope

- Moving or merging the per-status evidence into this section. Evidence
  stays tied to its status transition.
- The mobile shell: it has no sell-order page.
- Categorising attachments (invoice vs. sale record) or a per-file note.

## Notes

- Order-level files get their own table, `sell_order_attachments`
  (migration 0185), rather than a sentinel status in the evidence table whose
  `status` column is checked against real statuses.
- The card reuses `AttachmentDropzone` (compact) and `AttachmentChip`; the
  chip grows an optional second line for "uploaded by · when".
