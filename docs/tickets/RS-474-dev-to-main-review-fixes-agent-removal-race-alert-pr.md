---
id: RS-474
title: dev to main review fixes: agent removal race, alert price drops, NaN counts, Fleet leftovers
type: bug
status: done
priority: P2
created: 2026-10-30
reporter: jinhu
branch: JinhuW/rudderfish-review-fixes
pr:
version: 1.390.1
related: [RS-467, RS-469, RS-470, RS-471, RS-472]
---

## Ask

> /code-review high for the dev to main. fix all issue and release to prod.

## Context

The high-effort review of the `origin/main...origin/dev` release range (RS-467
to RS-472, up to v1.389.1) returned ten findings. Two blocked the release: the
fleet agent's new `remove` could stop a worker someone had just started, and
the alert sender sent a price-drop claim with the old price, so the drop came
back `duplicate`.

## Acceptance criteria

- [x] The agent's `remove` runs a plain `docker rm`, which Docker refuses for a
  running container. It never stops a worker started between observe and apply.
- [x] The alert sender claims a listing with the price of the newest sighting:
  the WITHHELD document's own price, or else the newest verdict's.
- [x] A sighting at a new price is asked about again even when it is stamped no
  later than the one already handled, for example from a cached verdict.
- [x] The bridge files a withheld sighting at a new price as a new document. The
  follower then ships it at once instead of leaving it for the cron bridge.
- [x] A `NaN` or `Infinity` unit count reads as no count, and no longer aborts
  the bridge.
- [x] The sender coerces the count once, and a doc holding `0` no longer beats
  a real count.
- [x] A timestamp the sender cannot read (`Z`, or 7 fractional digits on
  Python 3.10) no longer aborts the pass.
- [x] The Fleet tab drops a stopped worker above its host's count once the host
  stops reporting its container, whether the row reads Parked or Free.
- [x] Add to fleet will not swap a picked proxy that a reload removed or filled
  for a random one. It says so and waits for another pick.
- [x] Comments that said hosts never remove a worker are corrected.

## Out of scope

The follower still ships a repeat sighting at the same price only through the
cron bridge. At the same price, the coordinator would answer `duplicate`
anyway.
