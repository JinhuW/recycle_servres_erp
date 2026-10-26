---
id: RS-414
title: Re-run a WeChat market day from the page
type: story
status: done
priority: P2
created: 2026-10-26
reporter: jinhu
branch: JinhuW/merrow-2
pr:
version: 1.363.0
related: []
---

## Ask

> enable this wechat page, trigger mannually.
>
> [screenshot: Monitors / WeChat on Sun, Oct 25 · rules — "Claude was unavailable for this day, so memtrade read the posts with its own rules…" and "Claude 抽取不可用… 429 | api_error | You've hit your weekly limit"]

Asked whether that meant re-running Oct 25 by hand or a button, the answer was
"Add a 'Re-run' button".

## Context

memtrade, on the office Mac, builds each day's report and pushes it to
`/api/wechat-market/push/*` (`apps/backend/src/routes/wechatMarket.ts`). When
Claude is out (Oct 25: the weekly limit) it falls back to its rules and the page
shows the degraded banner. Until now the only ways to redo a day were a shell on
the Mac (`pnpm report --date D`) or waiting for the 08:00 run, which repairs
degraded days of the last 14 once Claude works again.

The ERP runs on Railway and can't reach the Mac; memtrade can reach the ERP. So
the page queues a request in the ERP, memtrade polls for it with its
`wechat:write` token, reruns the day, pushes it the usual way and reports back.

## Acceptance criteria

- [x] Managers see a **Re-run** button on every stored day, and one in the
      degraded banner when the day fell back to rules.
- [x] Clicking it queues the day; while a request for that day is queued or
      running, another click adds nothing.
- [x] The page shows Queued, then Running since …, then the outcome; on done it
      reloads the day, on failure it shows memtrade's error.
- [x] memtrade picks a request up within about a minute, runs `run --date D`,
      pushes the day and reports done (saying whether Claude was still out and
      it fell back again) or failed.
- [x] A running request nobody finishes within 2 h reads as failed (stale) and
      can be queued again.
- [x] A rerun never overlaps the 08:00 run on the Mac.

## Out of scope

- Rerunning a date with no stored report.
- Choosing rules or Claude from the page.
- A history of reruns: the page shows each day's latest request only.

## Notes

- memtrade side: `rerun` CLI command, `scripts/daily-report.sh rerun`, the
  `com.wehatai.memtrade-rerun` LaunchAgent (every 60 s), and a lock shared with
  the 08:00 run. memtrade treats a 404 from the claim route as nothing queued,
  so the poller is quiet against an ERP that doesn't have the route yet.
