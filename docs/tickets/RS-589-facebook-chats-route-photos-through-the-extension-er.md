---
id: RS-589
title: Facebook chats: route photos through the extension, ERP and Telegram
type: story
status: in-progress
priority: P2
created: 2026-11-15
reporter: jinhu
branch: feat/fb-chat-images
pr:
version:
related: [RS-582, RS-583]
---

## Ask

> The current chrome extension does not support image bridge.
> [Image #1]
>
> also in the telegram.
>
>
> pls think of an fix plan for routing the image as well.

> fan out agents and start the imeplementation

(The screenshot: Leads ▸ Facebook ▸ Chats on v1.459.0, Chris Herrmann's chat,
with two grey "Photo" boxes where the buyer's photos should be.)

## Context

No hop carries a photo's bytes. The extension reads each bubble photo as a
signed fbcdn link, which expires. The chats page draws a placeholder per link
on purpose. Telegram gets `sendPhoto` with the link, which Telegram's servers
often cannot fetch, and a history transcript writes `[photo]`. A photo posted
in a Telegram topic is refused with "Only text can be sent to Facebook".

## Acceptance criteria

- [ ] The extension uploads each bubble photo to `POST /api/fb-chat/push/media`
      and sends the returned ids as `media` on the sync row.
- [ ] The same bytes uploaded again return the same id and add no row.
- [ ] Rows stored before this change get their `media` filled in when a later
      sync lines up with them.
- [ ] An extension that sends only `images` still syncs; the hub tries to fetch
      the links itself while they are fresh.
- [ ] The chats page shows each stored photo, with a larger view on click, and
      keeps the placeholder when none is stored.
- [ ] Photos are served only through `GET /api/fb-chat/media/:id` to signed-in
      users.
- [ ] Telegram gets the photo itself (uploaded bytes, not a link), live and in
      history transcripts, in bubble order.

## Out of scope

Sending photos to Facebook (Telegram photo replies, an attach button in the
chats composer, the extension attaching a file). That needs the composer's
file input checked on a live page first; it is the next ticket.

## Notes

Plan: the explainer published with the session (three phases; this ticket is
phases 1 and 2).
