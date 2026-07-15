# PO attachment upload: "too large" had three stacked causes

**Symptom.** Uploading a phone photo to a purchase-order status (Submission /
Done evidence) failed with an image-too-large error, even for ordinary
screenshots.

## Root causes (all three, layered)

1. **`isUploadPath` in `apps/backend/src/index.ts` did not list the PO path.**
   `/api/orders/:id/status-meta/:status/attachments` fell through to the
   global **1 MiB** JSON body cap, so anything bigger 413'd
   (`Payload too large`) before the route ever ran. Sell orders had their
   path registered; purchase orders didn't. **Trap:** the allowlist is
   per-exact-path — every new multipart endpoint must be added there, or it
   silently inherits the 1 MiB cap.
2. Frontend hardcoded a 10 MiB reject (`fileTooLarge`) in
   `StatusChangeDialog`, `DesktopEditOrder`, `DesktopSubmit` — masking the
   server behavior and blocking files the server could handle.
3. The route itself 413'd anything over `upload_max_bytes` (default 10 MiB)
   instead of doing anything useful with an image.

## Fix (v1.17.2)

- PO path added to the `isUploadPath` allowlist (regex now covers
  `orders|sell-orders`).
- New `apps/backend/src/lib/image-shrink.ts` (`sharp`): images over
  `upload_max_bytes` are downscaled/re-encoded to fit the cap **before** the
  size check and before the AI receipt rename (`maybeRenameReceipt`), in both
  the PO and sell-order attachment routes. Best-effort: undecodable input
  returns the original file and the existing 413 applies. PDFs are never
  recompressed.
- Frontend client checks raised to the 50 MiB server hard cap.
- Tests: `apps/backend/tests/attachment-image-shrink.test.ts` (unit + route,
  incl. a regression test for the 1 MiB body-cap omission).

## Related fix in the same change

Done-evidence attachments were read-only after the PO reached Done (the
evidence dialog only opens on the transition *into* Done). `AttachmentChip`
now gets `onRemove` for managers in `DesktopEditOrder` and mobile
`OrderDetail`, mirroring the backend `canWriteMeta` gate (manager-only for
Done).
