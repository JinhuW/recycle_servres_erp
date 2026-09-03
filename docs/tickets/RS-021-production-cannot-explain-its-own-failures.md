---
id: RS-021
title: Production cannot explain its own failures
type: bug
status: in-progress
priority: P2
created: 2026-09-03
reporter: Jinhu
branch: session/20260902-121934
pr:
version:
related: [RS-013, RS-020]
---

## Ask

> Fetch all error log in the railway and see all error logs to see if it related
> to a system bugs.
> If yes, Then create an fix plan for all of them.

Then, after the triage came back and the fix plan was written:

> go head and accomplish the,

Last of three PRs from that triage.
[RS-013](./RS-013-demo-shipping-labels-must-not-charge-a-po-and-bank-s.md)
carried money correctness and
[RS-020](./RS-020-boot-fx-and-ocr-each-hang-or-die-on-a-transient-that.md) the
transient retries. This one is the reason the triage was hard: the log is
clean, and several of the things worth knowing never reach it.

## Context

**A rejected request cannot be diagnosed after the fact.** The request logger
records method, path, status and duration — on a 4xx the line is byte-identical
to a 200 except for the status integer. A real example from the window: someone
tried to save PO-1384, was refused twice, changed something, and succeeded
twenty seconds later. Whether that was a status guard doing its job or the
editor offering an action the backend forbids is unrecoverable, because
`PATCH /api/orders/:id` has six distinct 409 branches and the log line matches
all of them equally.

**Seventeen log sites bypass the logger**, across eight files, and they are
concentrated in exactly the code that handles money and freight — rate fetch
failed, label purchase failed, label purchased but upload failed, the tracking
sweep, the Shippo webhook, the scan failures. `console.*` output carries no
version, no commit and no `requestId`, and it is unstructured text in a stream
where everything else is JSON. Railway also tags all stderr as `level: "error"`,
so these sit indistinguishable from the corepack boot banner.

**OCR partial-fill records are written nowhere in production.** The block that
records a scan where the model returned only some expected fields — the ones
that become a PO line with a wrong speed or a missing capacity — is gated
entirely on `ERROR_LOG_DIR`, which is unset on Railway. That sink is a
Docker/compose feature; on Railway stdout is the only sink. With 166 scans in
the six-day window feeding inventory and cost, this is the highest-volume
quality signal in the system and none of it is kept.

**The Shipping page tells a warehouse user to set an environment variable.**
`SHIPPO_API_TOKEN` is unset, so `POST /api/packages/:id/refresh` answers 501.
Two people added a package and pressed Refresh within seconds — the gesture of
someone expecting tracking to work — and `handleFetchError` popped a blocking
dialog titled "Something went wrong" containing the raw backend string
*"Tracking is not configured — set SHIPPO_API_TOKEN"*. `DesktopTracker` and
`DesktopCoordinator` both catch their own 501 and render a proper
not-configured state; Shipping is the one shell that does not.

**`dbScope` is a no-op documented as the thing that prevents pool exhaustion.**
It is mounted under a comment claiming it binds a pooled client per request and
closes it at the end. The implementation awaits `next()` and nothing else.
Runtime risk is zero — the shared pool is correct — but the comment describes
the design that was *removed*, so the next person to touch connection handling
will trust it.

## Acceptance criteria

- [ ] A 4xx response's `error` string appears on its request log line; 2xx and
      5xx lines are unchanged (5xx already gets a stack from `app.onError`).
- [ ] No `console.warn`/`console.error` remains in `apps/backend/src` outside
      `lib/log.ts` itself.
- [ ] A partial-fill scan emits a structured line in production, carrying the
      category, the coverage ratio and which fields were missing — and **not**
      the extracted values, which transcribe a customer's label.
- [ ] Pressing Refresh with tracking unconfigured shows an explanation in the
      page, not a blocking "Something went wrong" dialog naming an env var.
- [ ] `dbScope` and its mount are gone, and no comment claims a per-request
      pool.

## Out of scope

- Reading `providers.tracking` from `/api/health` to disable the Refresh button
  before it is pressed. Nicer, but it needs `Health`-type and cache plumbing
  for a button that now explains itself.
- Setting `SHIPPO_API_TOKEN` in production — an ops decision.
- A statement timeout on the health probe (see RS-020's out-of-scope).

## Notes

Plan: `~/.claude/plans/precious-dazzling-cat.md`. Triage report:
https://claude.ai/code/artifact/a857947f-56fb-4a70-b4d5-b0ec94c6b2d8

The response body is not readable directly in the logging middleware —
`c.res.body` is a live stream that the server has yet to consume. `c.res.clone()`
is safe here because nothing in the app streams a response: the MCP server
explicitly avoids SSE and the coordinator proxy buffers.
