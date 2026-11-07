---
id: RS-540
title: Answer recycleservers.com quotes from their own mailbox
type: story
status: done
priority: P2
created: 2026-11-05
reporter: jinhu
branch: feat/quotes-mailbox
pr: "#1097"
version: 1.424.0
related: []
---

## Ask

> I would like to update the website mission to alaos aggrate to the @/Users/jinhu/Projects/recycle_servers/recycle_servres_erp.
> Manager should also able to replay in the erp.

## Context

"Website mission" means the website's submissions. The inbox and email replies
already exist (RS-123, RS-161), and `POST /api/public/quote` is live. Two gaps
remained: the recycleservers.com form still posted only to Formspree, and the
ERP has one mailbox, `sell@ram4cash.com` in production. Quote replies would have
gone out from a ram4cash address, and repointing `MAIL_USER` would have stopped
reading replies to sell@. The requester supplied the `quotes@recycleservers.com`
Lark box for this.

## Acceptance criteria

- [x] A reply on a `recycleservers` submission goes out from `MAIL_QUOTES_USER`;
      a `ram4cash` one still goes out from `MAIL_USER`.
- [x] A customer's answer in either box lands on its thread, and each box keeps
      its own watermark.
- [x] With `MAIL_QUOTES_*` unset, behaviour is exactly as today (quotes use
      `MAIL_USER`).
- [x] The draft on the thread page shows the From address the send will really
      use.
- [x] A non-production environment without `MAIL_ALLOW_TO` still sends nothing,
      from either box.

## Out of scope

New mail that isn't a reply to an ERP message stays in Lark, as today (see the
forgery reasoning in `mail/match.ts`). WhatsApp. A general N-mailbox config.

## Notes

- The site's change lives in the separate home-page repo (`JinhuW/sixgill`
  branch) and must deploy after this ships and the variables are set, or quote
  replies go out from sell@ram4cash.com.
- Formspree stays as the site's backup email, as RS-123 decided.
- The poll is per box, so a quotes box adds one IMAP login every two minutes.
- Went live 2026-11-07: `MAIL_QUOTES_*` set on production, the site change
  shipped as `recycle_servers_home_page` 2abcad9, and a labelled test from the
  live form stored WS-1005 with the Formspree copy also sent.
