---
id: RS-173
title: Web-submission email can run on dev behind a test-recipient list
type: story
status: done
priority: P2
created: 2026-10-04
reporter: jinhu
branch: fix/mail-dev-allowlist
pr: "#501"
version: 1.209.2
related: [RS-161]
---

## Ask

> I tried in the dev, But seem it is not working

## Context

RS-161 (v1.209.0) shipped email replies on the web-submission page. It is dark
until `MAIL_USER` and `MAIL_PASSWORD` are set, and those were deliberately kept
off dev: dev's database is a nightly copy of prod, so every WS on dev is a real
customer, and a send from dev would email them. Dev `/api/health` therefore
read `mail: "off"` and the page showed the mailto link and "Email isn't set up
on this server". Nothing was broken.

The requester chose to make dev usable behind a safety list: a server with
`MAIL_ALLOW_TO` sends only to the listed addresses.

## Acceptance criteria

- [x] With `MAIL_ALLOW_TO` set, a reply to a listed address (or one in a listed
      domain) is sent. Any other recipient is refused with 403, and nothing is
      recorded.
- [x] On a submission whose address isn't on the list, the draft says so and
      Send is disabled, including the ⌘/Ctrl+Enter shortcut.
- [x] On any Railway environment other than `production`, mail stays off
      unless `MAIL_ALLOW_TO` is set, and boot logs why. Setting `MAIL_*` on dev
      alone can never reach a customer.
- [x] `/api/health` reports `mailRestricted` beside `mail`.

## Out of scope

- A `[dev]` subject prefix. Test mail from dev looks real, and replies land in
  the shared inbox.
- Setting the Railway variables. The requester does that.

## Notes

- Plan: `~/.claude/plans/rustling-doodling-bird.md`.
- Dev's test threads and test submissions vanish every night with the
  prod→dev copy.
