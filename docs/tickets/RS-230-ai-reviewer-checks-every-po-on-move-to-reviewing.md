---
id: RS-230
title: AI reviewer checks every PO on move to Reviewing
type: story
status: in-progress
priority: P2
created: 2026-10-11
reporter: jinhu
branch: feat/po-ai-review
pr:
version:
related: []
---

## Ask

> Summary how to run this validation. At the same time. I would like to create an Agent to run these tyep validation works for each PO. When i move the order to reviewing.
>
>
> All PO information will be review by an ai agents.
>
>
> Pls create an detail plan about how to run this

## Context

On 2026-10-11 a one-off audit decoded the part number of every RAM line in
prod and found 350 lots whose generation, rank, capacity, type or speed
contradicted it — scans and hand entry had drifted, and the PN itself was
often the misread part (`HMAA`/`HMA8x`, Micron `PZ`/`PDZ`, `-1G6`/`-1G9`,
O vs 0).  It ran long after the stock was bought.  Nothing validates a PO's
lines while the box is still on the review bench.

A PO enters review in `advanceOrderTx` (`services/orderAdvance.ts`); Review
mode is `routes/orders/checks.ts` + `DesktopBoxCheck.tsx`.  OpenRouter vision
already exists in `ai/openrouter.ts`.  There was no RAM part-number decoder.

Decided with the requester: the agent **suggests, a manager applies**; it
checks **all lines, RAM deepest**; it goes to the **web only for PNs the
decoder cannot parse**.

## Acceptance criteria

- [x] `docs/po-spec-audit-runbook.md` documents the manual audit procedure.
- [x] Moving a PO to Reviewing (setting enabled) queues exactly one AI review in the same transaction.
- [x] The worker produces findings — decoder-only with the stub provider, plus vision and web steps with OpenRouter.
- [x] RAM lines are checked for generation, capacity, rank, type and speed vs PN; DDR3 PC3 speed and kit-per-module conventions are honoured; known misreads are flagged.
- [x] Non-RAM lines get required-field and price-sanity checks.
- [x] A manager can Apply a finding (line edited with a `line_edited` event; 409 if the line changed since) or Dismiss it.
- [x] Manual Re-run works; a revert to Draft supersedes a pending review.
- [x] Cost per PO is recorded and capped by a setting.
- [x] The PO's manager is notified when the review completes.

## Out of scope

- Auto-applying fixes.
- An MCP tool for findings.
- Sell-order review.
- Re-auditing historical POs (the runbook covers that).
- Blocking the advance to Ready to pay.

## Notes

Plan: `~/.claude/plans/distributed-painting-barto.md` (session plan, approved 2026-10-11).

Where the build moved off the plan:

- **No new decoder.** RS-228 (v1.243.0) had already shipped
  `packages/shared/src/ramPartDecode.ts`. The reviewer reuses it; the only
  addition is `ramFieldsAgree`.
- **Apply goes through the client's line PATCH, then `resolve`.** The plan had
  a server-side apply endpoint. The PATCH handler is one 900-line transaction
  carrying the serial rules, the category and goods-total derivation and the
  audit. Re-implementing it would fork those rules. `resolve: applied` refuses
  unless the line already holds the suggestion, so the record can't lie.
- **The label witness is the scan's own extraction first.** `label_scans.extracted`
  is free. The photo is re-read through the model only when the line has no
  scan, or when its part number disputes it. That keeps a clean PO at roughly
  zero cost.
- **Not built:**
  - the *AI n* chip on the PO edit page;
  - the soft confirm on *Approve for payment*.

  The findings live in Review mode, where the review happens. Add these if
  managers ask for them.
- The model path (re-read, web lookup) is only exercised with a real
  `OPENROUTER_API_KEY`. CI and local runs use the stub, so before enabling in
  prod, turn it on on the dev environment against real POs and compare the
  findings and the per-PO cost.
