---
id: RS-125
title: Box check: the count starts full
type: task
status: done
priority: P2
created: 2026-09-28
reporter: jinhu
branch: feat/po-box-check
pr: "#429"
version: 1.188.1
related: [RS-124]
---

## Ask

> The default should be full instead of 0

(On the Box check page, the Counted column showed 0 / qty on every line.)

## Context

v1.188.0 (RS-124) started every line's count at 0, and a line was checked once
its count reached the qty. Most lines arrive complete, so counting 27 lines up
from zero is the slow path.

Decisions (2026-09-28): a scan checks the matching line instead of counting a
unit; ticking a line whose count was lowered opens the flag editor as Short count.

## Acceptance criteria

- [x] An untouched line reads qty / qty and unchecked.
- [x] Checked is its own state: ticking checks, unticking keeps the count; reaching qty never auto-checks.
- [x] Lowering a line's count turns it amber; ticking it opens the flag editor prefilled "Short count · Counted n of m".
- [x] A scan checks the first unchecked line with that part number (or serial).
- [x] Check all remaining skips amber lines.

## Out of scope

Changing line qty from a count (still a flag only).
