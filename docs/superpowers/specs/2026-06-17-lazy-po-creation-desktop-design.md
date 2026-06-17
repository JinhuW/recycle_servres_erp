# Lazy PO creation on desktop submit

**Date:** 2026-06-17
**Scope:** `apps/frontend/src/pages/desktop/DesktopSubmit.tsx` (frontend only)

## Problem

The desktop submit form eagerly creates a server-side Purchase Order the moment
a category is picked: the `OrderForm` mount effect fires `POST /api/orders/draft`
to get a `draftId` so per-line confirms have somewhere to attach. If the user
then abandons the form, that empty PO lingers in the database forever — and the
`PO-NNNN` counter has already been burned, leaving gaps in the id sequence.
Open the form three times, abandon each, and you get three orphaned empty POs.

Mobile already guards against this (it probes for existing drafts before
creating) and is **out of scope**. The backend is **unchanged**.

## Goal

An empty PO must never be written. The PO is created at the moment its first
line is persisted, **born already containing content**. This eliminates both
orphaned empty drafts and wasted id numbers from abandoned desktop forms.

## Approach: born-with-content (lazy creation)

`POST /api/orders` already requires ≥1 line and creates the PO atomically with
its content. So this is a frontend-only change — no new route, no migration.

### Core change: lazy `orderId`

- **Remove** the mount-time effect (`DesktopSubmit.tsx:303-313`) calling
  `createDraftOrder(category)`.
- **Rename** `draftId` → `orderId` (state starts `null`); it stays `null` until
  the first successful persist, then holds the real PO id.
- **Add** a helper `persistLines(linesToAdd, metaPatch)`:
  - `orderId === null` → `POST /api/orders` with
    `{ category, ...meta, lines: linesToAdd }`, store the returned id in
    `orderId`, return it.
  - else → `PATCH /api/orders/:orderId` with `{ addLines: linesToAdd, ...meta }`
    (today's behavior).
  - Always returns the resolved id so callers can chain (evidence upload).

### Write paths rewired through the helper

- **`handleConfirmLine`** (line 445): drop the `if (!draftId)` guard; call
  `persistLines([toWireLine(l)], meta)`, then mark the line `_confirmed`. First
  confirm creates the PO; later confirms PATCH.
- **`doSubmit`** (line 475): call `persistLines(unconfirmedLines.map(toWireLine),
  meta)` to resolve the final id, then run evidence upload against it. A
  single-line order that is never confirmed is born here in one `POST`.
- **`doSubmitToExisting`** (line 508): unchanged except the throwaway cleanup
  (line 519) becomes **null-safe** — `if (orderId) try { deleteOrder(orderId) }`.
  If the user went straight to "add to existing" without ever confirming a line,
  no order was created, so there is nothing to delete.

### UI / gating adjustments

- **Submit button** (line 835) and `submitDisabledReason` (line 560): remove the
  `!draftId` / `subStartingDraft` condition — creation happens *on* submit now,
  so an unborn order no longer blocks it. Gating reduces to: warehouse selected +
  all lines ready + not already submitting.
- **Id chip** (line 583): show the existing `subDrafting` placeholder while
  `orderId` is `null`, swap to the real id once created. No new strings.
- **Merge-target exclusion** (`eligibleDraftTargets`, line 329): keep passing
  `orderId` as `excludeId`; `null` early on is harmless.

## What stays the same

Backend, migrations, the `POST /api/orders/draft` endpoint (mobile still uses
it), the "add to existing draft" merge flow, duplicate-part and part-number
confirm modals, evidence buffering/upload, and autosave-per-line semantics after
the first line.

## Error handling

First-persist failure: `persistLines` throws, the existing `try/catch` in each
caller surfaces `aiError`, and `orderId` stays `null` — a retry creates the PO
fresh. No empty row is ever left behind, which is the whole point.

## Testing

Frontend tests are sparse and this logic is UI-bound. Add focused coverage for
the one pure seam — the POST-vs-PATCH branch decision (no order yet → create;
order exists → patch). Remaining UI behavior (chip placeholder, submit enabled
before creation) is validated by visiting it.
