---
id: RS-588
title: WeChat: Activity tab, acknowledged warnings disappear, live re-run status
type: story
status: done
priority: P2
created: 2026-11-13
reporter: jinhu
branch: session/20261113-112922
pr: 1203
version: 1.459.0
related: [RS-587, RS-344]
---

## Ask

> help me create a new tab to capture some metrics for the wehcat communication history.
>
> [Image #2]
> when i acknowledge the error, it should disappear.
>
>
> It will be great to know the re-run status instead of keep just show "Re-run queued"

(The screenshot: Monitors ▸ WeChat after v1.458.0, with the "Jinhu asked for a
re-run (1 hr. ago)" banner and an acknowledged warning still showing as a grey
line with Undo.)

## Context

- v1.458.0 (RS-587) moved an acknowledged warning to a grey line under the
  banner. The ask is for it to go away.
- A queued re-run read "memtrade on the office Mac picks it up within a minute
  or two" for as long as it waited. The real cause was that memtrade's
  LaunchAgents had broken on that Mac, and the page couldn't tell. The ERP
  never recorded when memtrade last asked for work.
- The page had no view of the groups' message history across days. The data is
  already pushed with each report: `wechat_market_days` totals,
  `wechat_market_groups` per group and day, `wechat_market_points` timestamps.

## Acceptance criteria

- [x] Acknowledging a warning removes it from the page for everyone.
- [x] `POST /push/reruns/claim` records memtrade's check-in, whatever the
      answer (`wechat_market_heartbeats`). Each re-run carries `pollSeenAt`.
- [x] The re-run banner shows the steps: Asked → Picked up by memtrade → Redone
      and sent, with their times. A queued request says when memtrade last
      checked for work. When it hasn't checked in 5 minutes, the banner and the
      header chip turn to a warning saying memtrade has stopped checking.
- [x] A new **Activity** tab (`?view=activity`) shows, up to the selected day:
  - messages per report day over 14, 30 or 60 days, with flagged days marked
    and a click through to a day;
  - the selected day against the median of the 7 days before it;
  - that day's trade posts by hour, with stretches of 3+ quiet hours shaded;
  - a group × day heatmap with each group's last message day.

## Out of scope

- Per-hour counts of *all* messages: the ERP only gets each day's total from
  memtrade, so the hourly chart counts trade posts.
- Fixing memtrade's LaunchAgents on the office Mac. That's an ops change on
  that machine, and it waits for the owner's go-ahead.

## Notes

- The heatmap shades by quintiles of the cells that had messages. A log scale
  left most groups in one or two shades, because group sizes span three
  orders of magnitude.
