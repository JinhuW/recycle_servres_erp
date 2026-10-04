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
- [ ] A reply is matched to a submission in one of two ways:
      - its `In-Reply-To` or `References` names one of our sent messages, or
      - its subject carries the WS id **and** it comes from the submission's
        address, with no DMARC failure.

      Anything else, including mail whose From names several addresses, stays
      in Lark only.
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

## Notes

- Plan: `~/.claude/plans/rustling-doodling-bird.md`.
- `MAIL_*` goes on the Railway **prod** backend only. Dev's database is a
  nightly copy of prod, so a test send from dev would reach a real customer.
