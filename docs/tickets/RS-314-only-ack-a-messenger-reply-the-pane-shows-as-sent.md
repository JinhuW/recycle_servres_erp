---
id: RS-314
title: Only ack a Messenger reply the pane shows as sent
type: bug
status: backlog
priority: P2
created: 2026-10-19
reporter: jinhu
branch: fix/rs-314-messenger-ack
pr:
version:
related: [RS-311]
---

## Ask

> create a plan to fix them:
>
> Found on the way, not fixed
>
> - is_visible(timeout=…) is ignored by Playwright 1.64, so every such "wait" in poster/messenger/monitor is an instant snapshot.
> - Messenger's send check (get_by_text(...).last) may ack an unsent reply.
> - Challenge screenshots write outside the coordinator's data volume (RS_SCREENSHOT_DIR unset): none from past checkpoints survived.
> - Phase 2 candidate: a decision-model pre-screen in front of the listing LLM, after a shadow run against ai_eval history.

## Context

`rs_messenger/rs_messenger/sender.py` `send_message` types the reply, presses
Enter and verifies with `page.get_by_text(probe).last.wait_for(…)`, probe being
the first 60 characters. That matches anywhere on the page: a draft still in the
composer when Enter did not submit, an older identical bubble, or the thread
list's preview. Each of those acks the row `sent` to the coordinator
(`POST /v1/messages/outbound/{id}/ack`) while the seller never got the reply.
On the coordinator a `failed` ack is terminal: `mark_outbound` never re-queues,
and nothing reads `attempts`. A lost ack after a real send leaves the row
`queued`, so the next poll sends the reply twice.

The inbox scraper already reads the pane as direction-tagged rows
(`EXTRACT_MESSAGES_JS`, "You sent" ancestors mark `out`); the composer draft and
the thread list never carry that marker.

Plan: `docs/superpowers/plans/2026-10-19-rs311-follow-ups.md`.

## Acceptance criteria

- [ ] A reply is acked `sent` only when the pane shows one more outgoing (`out`) row containing the probe than before typing, and the composer no longer holds the text.
- [ ] A draft left in the composer is cleared, and the row is acked `failed` with a message that says the reply was not submitted; an older identical bubble alone never counts as sent.
- [ ] Before typing, an outgoing row that already contains the probe is treated as sent without typing, so a lost ack does not produce a duplicate.
- [ ] A `failed` ack keeps the row `queued` until the third failure (`OUTBOUND_MAX_ATTEMPTS`), unless the client marks it `permanent`; a late failure never demotes a `sent` row. SQLite and Postgres behave the same.
- [ ] The ack response says what happened (`outcome`, `attempts`) and the sender logs it. Clients that omit `permanent` keep working.
- [ ] `rs_messenger` gains tests for `send_message` with a fake page; the coordinator tests cover the retry cap, `permanent` and the no-demotion rule.

## Out of scope

- A claimed/leased state for outbound rows. One sequential sender per account and 60 s pacing make concurrent drains of one row impossible at today's volume.
- Reconciling `sent` rows with what the inbox later shows.
- Non-English Messenger UI (`selectors.py` is English-only already).

## Notes

