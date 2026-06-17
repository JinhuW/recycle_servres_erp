# PO submit-time optional attachment — design

**Date:** 2026-06-17
**Status:** Approved (pending spec review)

## Goal

When a purchaser submits a Purchase Order on the **desktop** shell, let them
optionally attach one or more files (e.g. a payment receipt / evidence) using
the same upload + preview UX as the existing "Done" evidence. The attachment is:

- **Always optional**, identical for Company-pay and Self-pay (the closed set of
  commission payment types). It never blocks submission.
- **Viewable and editable later** on the order page (add/remove files), like the
  Done-status evidence.

The accompanying **note reuses the existing order-level "Order notes"** field —
there is **no separate evidence note**. The `Submission` evidence is
**attachments-only**.

## Non-goals

- Mobile submit form (`apps/frontend/src/pages/SubmitForm.tsx`).
- Required-attachment validation.
- Any payment-type-specific behavior (Company vs Self behave identically).
- A separate per-evidence note (explicitly folded into existing order notes).

## Background — existing infrastructure reused

- **Tables** (`migrations/0068_order_status_meta.sql`): `order_status_meta`
  (note, keyed `(order_id, status)`) and `order_status_attachments` (file rows,
  keyed by `(order_id, status)`, **no FK to the meta-note row**). Both have an
  inline `CHECK (status IN ('Done'))`.
- **Endpoints** (`apps/backend/src/routes/orders.ts`):
  - `POST  /:id/status-meta/:status/attachments` — multipart upload to R2.
  - `DELETE /:id/status-meta/:status/attachments/:attachmentId`.
  - `PUT   /:id/status-meta/:status` — upsert note (**not used** by Submission).
  - All three are **manager-only** today and gate `status` via
    `PO_META_STATUSES = new Set(['Done'])`.
- **`GET /:id`** assembles `statusMeta` generically (orders.ts:248-257):
  attachment rows alone create a `statusMeta[status]` entry via `??=`, so
  `statusMeta['Submission']` flows to the client **with no response changes** and
  with `note: null` (correct — the note lives in order notes).
- **Frontend**: `StatusChangeDialog.tsx` (live-save upload + dropzone),
  `AttachmentChip.tsx` (image lightbox / file link + remove), `api.upload`.
- **Ownership**: `orders.user_id`. The owner-or-manager guard
  (`effectiveRole(u) !== 'manager' && order.user_id !== u.id → 403`) and the
  draft-edit rule (`u.role !== 'manager' && lifecycle !== 'draft' → 403`,
  orders.ts:693) are the existing patterns to mirror.

## Design

### 1. Storage — new meta key `'Submission'`

Reuse the existing tables with a new status key `'Submission'` (no new tables).

**Migration `0069_status_meta_submission.sql`:** widen the inline CHECK on both
tables from `('Done')` to `('Submission','Done')` by dropping and re-adding the
auto-named constraints:

```sql
ALTER TABLE order_status_meta
  DROP CONSTRAINT order_status_meta_status_check,
  ADD  CONSTRAINT order_status_meta_status_check CHECK (status IN ('Submission','Done'));
ALTER TABLE order_status_attachments
  DROP CONSTRAINT order_status_attachments_status_check,
  ADD  CONSTRAINT order_status_attachments_status_check CHECK (status IN ('Submission','Done'));
```

(Verify the auto-generated constraint names against the live schema during
implementation; adjust if Postgres named them differently.)

Attachments already `ON DELETE CASCADE` with the order, so an abandoned draft's
evidence cleans itself up.

### 2. Backend — per-status authorization

Add `'Submission'` to `PO_META_STATUSES`. Replace the blanket
`effectiveRole(u) !== 'manager'` check in the **attachment POST and DELETE**
endpoints (and, for consistency, the note PUT) with a per-status helper:

- `'Done'` → **manager-only** (unchanged; regression-guarded by a test).
- `'Submission'` → allowed for **manager**, OR the **owner
  (`order.user_id === u.id`) while `lifecycle === 'draft'`**. After the order
  leaves Draft, the owner is locked out (manager-only) — mirrors orders.ts:693.

The note `PUT` is not exercised by Submission (note lives in order notes), but
the same gate applies so behavior is uniform.

### 3. Frontend submit form (`DesktopSubmit.tsx`) — buffered upload

Add an optional **"Attachment"** section to `OrderForm` (dropzone + chip list,
visually matching the Done dialog's upload area). **No note textarea** — the
existing "Order notes" field already in the form is the note.

**Buffered, not live-save.** The draft id exists at submit time, but the
*submit-to-existing* path (`doSubmitToExisting`) merges lines into a different
order and **deletes the throwaway draft** — live-saved evidence keyed to that
draft would be lost. Instead:

1. The section holds selected `File[]` in form state, previewing each via an
   object URL (image thumbnail / filename chip with a local remove).
2. After `doSubmit` / `doSubmitToExisting` resolves the **final order id**
   (the new draft, or the merge target), upload each buffered file to
   `POST /api/orders/<finalId>/status-meta/Submission/attachments`.
3. If the order submits but a post-submit upload fails, the submit still
   **succeeds**; show a **non-blocking warning** ("order submitted — add the
   attachment from the order page"). The edit-later surface (§4) is the safety
   net. Client-side guard: reject files > 10 MB before buffering (matches the
   dialog), with server validation authoritative.

### 4. Frontend order page (`DesktopEditOrder.tsx`) — view + edit later

Add a **"Submission attachment"** block mirroring the existing read-only Done
evidence block (orders edit page lines ~757-775): render
`statusMeta['Submission'].attachments` with `AttachmentChip` (preview + download).

When the viewer may edit (**owner while Draft, or manager**), show add/remove
controls wired to the **live-save** meta endpoints (stable order id here, so
live-save is correct and matches the Done dialog). Re-use the dropzone styling /
`AttachmentChip onRemove`.

### 5. i18n

New EN + ZH strings for the submit-section label, dropzone hints, the
post-submit upload warning, and the order-page block title. No new note strings.

## Testing

Backend integration tests (real Postgres, the layer most likely to break):

- Migration applies; `order_status_attachments` / `order_status_meta` accept
  `status = 'Submission'` and still reject an unknown status.
- **Owner** can POST then DELETE a `Submission` attachment on **their own Draft**;
  `GET /:id` returns it under `statusMeta.Submission` with `note: null`.
- **Non-owner purchaser** → 403 on POST/DELETE Submission.
- **After advancing past Draft**, owner → 403; **manager** → OK.
- **Regression:** `Done` meta endpoints remain **manager-only** (owner purchaser
  → 403).

Frontend tests are sparse by convention; cover any non-trivial pure helper
(e.g. the buffered-file upload sequencer) and verify the surfaces manually.

## Rollout

- Migration `0069` (next number; head is `0068`).
- Ship as its own SemVer release via `scripts/release.sh`; update CHANGELOG.

## Open verification during implementation

- Exact auto-generated CHECK constraint names.
- The precise insertion points in `DesktopSubmit.tsx` (`OrderForm`,
  `doSubmit` / `doSubmitToExisting`) and `DesktopEditOrder.tsx` (Done block).
