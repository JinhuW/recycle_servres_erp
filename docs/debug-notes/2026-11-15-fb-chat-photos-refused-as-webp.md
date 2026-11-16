# Facebook chat photos were all refused: WebP and the workspace upload setting

**Date:** 2026-11-15 · **Fixed in:** v1.462.1 (ERP), 0.5.1 (extension) · RS-590

## Symptom

After v1.460.0 and extension 0.5.0 shipped, the Chats page still drew grey
"Photo" boxes, and `fb_chat_media` on dev stayed empty. The extension had synced
the chat, and both its `POST /api/fb-chat/push/media` calls got **415 in about
8 ms**.

## Cause

- Facebook serves most chat photos as `image/webp`. That was checked by fetching
  the stored `scontent-*.fbcdn.net` links: no cookie is needed, and they carry
  `access-control-allow-origin: *`.
- `storeFbChatMedia` obeys `getUploadLimits()`, as every storing route must. The
  workspace's `upload_allowed_mime` (copied to dev from prod) lists
  PDF/JPEG/PNG/XLSX/CSV and **not WebP**, although the code default includes it.
  So every WebP photo was refused before it was decoded.
- The extension caches a 415 as permanent, so it never tried again.
- Separately, the buyer's avatar (a 200×200 file shown under each group of their
  messages) passed the extension's 80 px width test and was stored as a photo.

## Fix

- WebP chat photos are re-encoded to JPEG before the type check (`webpToJpeg` in
  `lib/fbChatMedia.ts`). Telegram also handles JPEG better as a photo.
- A bubble read again with fewer photos than were stored has its links trimmed,
  which clears the avatars.
- Extension 0.5.1 drops avatars (the same file in more than one message, or an
  `alt` that is only a name). It retries a refused photo after 6 hours.

## How to check quickly next time

- Dev HTTP logs, filtered on `@path:/api/fb-chat/push/media`: the status of each
  upload.
- `SELECT count(*) FROM fb_chat_media` and `fb_chat_accounts.photo_replies`.
- `SELECT value FROM workspace_settings WHERE key = 'upload_allowed_mime'`. A
  workspace setting narrows what the code allows, so a type the code takes can
  still be refused.
