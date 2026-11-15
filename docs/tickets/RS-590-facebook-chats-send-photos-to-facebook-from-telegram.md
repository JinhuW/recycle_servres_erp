---
id: RS-590
title: Facebook chats: send photos to Facebook from Telegram and the ERP
type: story
status: in-progress
priority: P2
created: 2026-11-15
reporter: jinhu
branch: feat/fb-chat-send-images
pr:
version:
related: [RS-589]
---

## Ask

> release the extension and keep moving to deleliver all feature for sending image

## Context

RS-589 (v1.460.0, extension 0.4.0) brought buyers' photos into the ERP and
Telegram. The other direction is still text only: a photo posted in a chat's
Telegram topic is answered "Only text can be sent to Facebook", the ERP
composer has no attach, and the extension can only type keys.

## Acceptance criteria

- [ ] A photo (or album) posted in a chat's Telegram topic is queued as one
      reply per Telegram message, its caption as the text, and reaches Facebook.
- [ ] The ERP composer can attach photos (button, paste, drop), shows them
      before sending, and sends them with or without text.
- [ ] `POST /push/outbox/claim` hands a reply with photos only to an extension
      that claims with `caps: ["media"]`; it stays queued for older ones.
- [ ] The extension downloads the photos from `GET /push/media/:id`, attaches
      them through the debugger (`DOM.setFileInputFiles`), types the caption and
      sends; it reports `failed` if it cannot attach, before anything is sent.
- [ ] A photo reply is matched to its bubble on Facebook by the photo, not by
      empty text; a caption Facebook shows as its own bubble is not stored twice.
- [ ] A reply with photos typed in the ERP is mirrored to Telegram with them.

## Out of scope

Video, stickers and files other than JPEG, PNG and WebP.

## Notes

The composer's file input was not checked on a live page (no Facebook tab is
opened for testing). The extension finds it next to the composer and fails
safely; the first real send confirms it.
