# PO submit — spreadsheet attachments

Accept `.xlsx` and `.csv` files in the Submission attachments section of the
desktop purchase-order submit page.

## Problem

The Submission dropzone on `DesktopSubmit` accepts PDFs and raster images only.
Vendors routinely send a spreadsheet alongside (or instead of) a receipt — a lot
manifest, a price list — and today there is nowhere to put it. The file has to
be emailed separately, so it never lands on the PO.

Six layers refuse a spreadsheet today. All six have to move together; changing
any subset leaves the upload failing somewhere else:

| Layer | Where | Behaviour |
| --- | --- | --- |
| File picker | `AttachmentDropzone.tsx` `accept` default | Spreadsheets not offered in the OS dialog |
| Route gate | `routes/orders.ts` PO status-meta attachment POST | `allowedMime` miss → 415 |
| Workspace setting | `workspace_settings.upload_allowed_mime` | Stored list is 4 image/PDF types |
| Hard allowlist | `lib/settings.ts` `SAFE_UPLOAD_MIME` | Narrows to PDF + raster images |
| Storage gate | `r2.ts` `uploadAttachment` | Same allowlist, defence in depth |
| OCR rename | `ai/receipt.ts` `maybeRenameReceipt` | Skips PDF only |

`getUploadLimits` **intersects** the stored setting with `SAFE_UPLOAD_MIME`, so
widening the constant alone changes nothing on a deployed database. The
migration is load-bearing, not cosmetic.

## Scope

Accepted types are exactly two:

- `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (`.xlsx`)
- `text/csv` (`.csv`)

Legacy `.xls` (`application/vnd.ms-excel`) is deliberately excluded: it is an OLE
container and the standard macro-malware wrapper. It cannot execute in a
browser, but our attachments bucket is public, and we would become the thing
redistributing it.

The allowlist is process-wide, so the backend widening reaches every upload
route. The **file picker** is widened only on the PO Submission dropzone —
sell-order evidence and PO Done keep today's picker. This is a UI-level
distinction, not a security boundary: a direct POST of an `.xlsx` to the
sell-order evidence route will now succeed. That is accepted. A per-surface
server-side allowlist was considered and rejected as more machinery than the
risk warrants, given both surfaces are authenticated and internal.

Out of scope: parsing the spreadsheet. The file is stored and downloadable, and
nothing reads its contents. Also out of scope: `image/webp`, which sits in
`SAFE_UPLOAD_MIME` but not in the seeded setting and is therefore rejected in
production today. Pre-existing, unrelated, left alone.

## Design

### Backend

**`apps/backend/src/lib/settings.ts`** — add both MIME types to
`SAFE_UPLOAD_MIME` and `DEFAULT_UPLOAD_ALLOWED_MIME`. Extend the existing
stored-XSS comment to record why these two are safe where SVG and HTML are not:
an `.xlsx` is a ZIP container and never renders in a browser, and `text/csv` is
not a type browsers will parse as markup.

**`apps/backend/migrations/0077_upload_allowed_mime_spreadsheets.sql`** — union
the two types into the stored `upload_allowed_mime` array. Idempotent, and
additive rather than a replace, so a deliberately narrowed workspace setting
keeps whatever else it has.

**`apps/backend/src/r2.ts`** — set `ContentDisposition: 'attachment'` on
`PutObject` for anything that is neither an image nor a PDF. The bucket is
public and serves the declared `Content-Type`; forcing a download on everything
else removes the question of what a browser might decide to do with a text type.
Images keep rendering inline for the lightbox, PDFs keep rendering inline.

**`apps/backend/src/ai/receipt.ts`** — `maybeRenameReceipt` currently returns
early for `application/pdf` and treats everything else as an image, so a
spreadsheet would be sent to OpenRouter as image bytes: a guaranteed-useless
call that costs money and latency on every upload. Replace the PDF check with a
positive `image/*` guard. This is a real defect the widening would expose, not a
speculative hardening.

### Frontend

**`apps/frontend/src/pages/desktop/DesktopSubmit.tsx`** — pass explicit `accept`
and `boxHint` props to the Submission `AttachmentDropzone`. No other call site
changes.

**`apps/frontend/src/lib/i18n.tsx`** — add `uploadHintSheets` (en + zh). The
existing `uploadHint` reads `PDF, PNG, JPG · up to 10 MB each` and would be
wrong on this surface.

`AttachmentChip` needs no change: it already routes non-images to a plain
download link, and a spreadsheet renders with the generic file icon.

### Error handling

Unchanged and already correct. An unsupported type returns 415 from the route;
an oversized file returns 413 after `shrinkImageToFit` declines to recompress a
non-image. The submit page buffers evidence locally and uploads after the PO
exists, so a rejected attachment surfaces a warning without losing the order —
that path already exists for oversized images.

## Testing

Backend integration tests, matching the existing `sell-attachment-mime.test.ts`
shape:

- `.xlsx` and `.csv` upload to the PO Submission attachment route → 201, and the
  stored `mime_type` round-trips.
- `.xlsm` and `text/html` → 415. Guards the decision to exclude macro formats.
- A workspace setting listing a type outside `SAFE_UPLOAD_MIME` still cannot
  widen acceptance.
- `maybeRenameReceipt` returns the file untouched for a spreadsheet, with no
  OpenRouter call.

Frontend: no new test. The change is two props and a string; the repo's own
convention is to add frontend tests for non-trivial pure helpers only.

## Risks

The public-bucket exposure is the only one worth naming. It is bounded by: two
inert types, `Content-Disposition: attachment` on both, an authenticated upload
path, and the unchanged 10 MB cap. The residual risk is that an internal user
uploads a malicious spreadsheet and another internal user downloads it — which
is equally true of the PDFs the system already accepts.
