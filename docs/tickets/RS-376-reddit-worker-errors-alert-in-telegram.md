---
id: RS-376
title: Reddit worker errors alert in Telegram
type: story
status: in-progress
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/telescopefish-alerts
pr:
version:
related: [RS-368, RS-375]
---

## Ask

> also pls help me create an alerts for the reddits tracker as well.
> in case any error in the reddit workers.

## Context

The fleet (the Railway `worker`, 5 OCI workers and the `api`) had no
alerting, only logs. Its heartbeat records when each loop last *succeeded*,
but a per-post failure is a `warn` line inside an iteration that still
succeeds. A dead OpenRouter key, a Reddit block or a failed Telegram send
would therefore never show up there.

The requester chose all three kinds of alert: worker down, a loop that keeps
failing, and every error line. They go to the "Homelab Alerts" group through
the relay's `POST /alert` (RS-375): down and failing to "Reddit · Workers",
the error stream to "Reddit · Errors".

## Acceptance criteria

- [ ] A worker whose heartbeat has been silent for 10 minutes raises one
      "down" alert. It resolves when the worker beats again, or when its row
      is removed
- [ ] A loop (poll, evaluate or notify) that fails 3 iterations in a row
      raises an alert naming the worker, the loop and the last error, and
      resolves on a clean iteration. An iteration fails if it throws or logs
      a warn/error
- [ ] Every warn/error line from any worker reaches "Reddit · Errors" within
      about a minute, batched per tick and grouped by message with a count
      and the workers it came from
- [ ] An api restart doesn't send an open alert again. An alert or digest the
      relay refused is retried on the next tick
- [ ] `workers.loops` (the ERP `/api/workers` contract) is unchanged

## Out of scope

- Alerting on the api's own crash. Railway's webhook already covers it
  (RS-368).
