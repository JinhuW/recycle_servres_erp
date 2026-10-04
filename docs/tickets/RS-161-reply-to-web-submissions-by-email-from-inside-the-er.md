---
id: RS-161
title: Reply to web submissions by email from inside the ERP, and see the customer's replies there
type: story
status: in-progress
priority: P2
created: 2026-10-04
reporter: jinhu
branch: feat/ws-email-thread
pr:
version:
related: []
---

## Ask

> Set up the sytem to reply in the system.
>
> I hope we can communiate in the system. i will give you all the info to use the email:
>
> [screenshots: the WS-1003 detail page with its "Reply by email" button; the
> Lark mailbox IMAP/SMTP settings — smtp.larksuite.com 465 SSL / 587 starttls,
> imap.larksuite.com 993 SSL, 200 mails per 100 s, 450 per sender per day]

## Context

"Reply by email" on a web submission was a `mailto:` link. It opened the
clicking manager's own mail client, so the customer's answer landed in a
personal inbox the ERP never saw, and nobody else could follow the
conversation. The repo had no mail code at all.

The company has a Lark mailbox with IMAP/SMTP turned on. Railway only allows
outbound SMTP on the Pro plan, and the workspace is on Pro.

Decisions taken with the requester before planning:
- **Two-way thread.** The ERP sends over SMTP and pulls the customer's replies
  back over IMAP.
- **One shared company mailbox**, with its credentials in env vars only.
- **Attachments on a reply are listed, not imported.** The thread names them
  and points to Lark mail.
- **The sender name and subject follow the site.** ram4cash.com sellers get
  "ram4cash"; recycleservers.com quotes get "Recycle Servers".

## Acceptance criteria

- [ ] A manager can write a reply on a WS page. It is sent from the shared
      mailbox to the submission's email and shown in a Conversation thread
      with its status: sending, sent, failed or not confirmed.
- [ ] The first sent reply moves a `new` submission to `contacted`. Every send
      stamps `handled_by` and `updated_at`.
- [ ] Customer replies are pulled from the Lark INBOX about every 2 minutes and
      appear in the thread. The pull is read-only, so Lark's read state is
      untouched.
- [ ] A reply is matched to a submission only when its `In-Reply-To` or
      `References` names a message the ERP sent. A WS id in the subject is
      not enough. Anything else, including mail whose From names several
      addresses, stays in Lark only.
- [ ] Every inbound message shows its raw sender address. A warning appears
      when that address isn't the submission's or Lark's DMARC check failed.
- [ ] Attachments on a reply are listed by name with "open in Lark mail".
      Inline signature images aren't counted.
- [ ] Managers get an in-app notification for each reply, except on `spam`
      submissions.
- [ ] Mail stays dark until `MAIL_USER` and `MAIL_PASSWORD` are set. Until
      then the page keeps the mailto link, and `/api/health` reports
      `providers.mail`.

## Out of scope

- Importing inbound attachments
- Outbound attachments
- Bounce detection
- Mail that matches no submission
- IMAP IDLE push
- Per-staff mailboxes
- A mobile WS page (there is none)

## Follow-up ask

> Pls redeisgn the way it is commnicate in the page, it shuold still has the mail style.

The first cut drew the thread as chat bubbles. It became a mail thread
instead:
- the subject on top
- earlier messages folded to one line each
- the newest open with its From / To
- a reply draft with From / To / Subject rows

The requester chose that layout over an inbox-plus-reading-pane and a stack
of printed letters.

## Notes

- Plan: `~/.claude/plans/rustling-doodling-bird.md`.
- **Live check against the real box `sell@ram4cash.com` (2026-10-04)**
  - **Logins.** The SMTP login on 465 and the read-only IMAP EXAMINE on 993
    both worked.
  - **Send.** One reply was sent to the box itself. Lark filed it in 已发送
    (Sent) with the ERP's Message-ID unchanged, which is what reply threading
    rests on.
  - **INBOX.** The self-addressed copy never reached INBOX, so a customer
    reply's In-Reply-To match and Lark's DMARC stamping are still unseen
    live.
- **Follow-up, not built.** The poll reads INBOX only. A customer reply that
  Lark files as 垃圾邮件 (Junk) never reaches the thread.
- **The subject fallback was removed** after a background security review.
  A WS id and a forgeable From were enough to attach mail to a thread.
- `MAIL_*` goes on the Railway **prod** backend only. Dev's database is a
  nightly copy of prod, so a test send from dev would reach a real customer.
