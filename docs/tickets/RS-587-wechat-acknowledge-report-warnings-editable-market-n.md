---
id: RS-587
title: WeChat: acknowledge report warnings; editable market-note prompt
type: story
status: backlog
priority: P2
created: 2026-11-13
reporter: jinhu
branch: session/20261113-112922
pr:
version: 1.458.0
related: [RS-344]
---

## Ask

> for this historical.
>
> [Image #1]
>
> enable an acknoeledge

(The screenshot: Monitors ▸ WeChat for 2026-11-11, with the yellow banner
"数据可能不完整：2026-11-11 08:00 → 2026-11-11 13:17 共 5.3 小时没有任何群消息…")

> add an setting table to allow us to edit the prompt for market note.

## Context

memtrade's warnings (`wechat_market_days.warnings`) show as a yellow banner on
every view of the day, forever. A gap in a past day's group history can't be
filled after the fact, so once someone has seen it, the banner is noise.

The market notes (`day.summary`) are written by memtrade on the office Mac,
which hands Claude `prompts/summary.md` as the system prompt. Changing it meant
editing a file on that Mac.

## Acceptance criteria

- [x] Each warning in the banner has an **Acknowledge** button (managers). An
      acknowledged warning moves to a quiet line with who and when, and can be
      undone.
- [x] Acknowledgements are shared by the team and survive a re-run that
      repeats the warning word for word; a new or reworded warning shows again.
- [x] A `wechat_market_settings` table holds the market-note prompt. The WeChat
      page's new **Settings** tab edits it, shows memtrade's built-in prompt
      when none is set, and can go back to it.
- [x] memtrade fetches the prompt (`POST /push/settings`, `wechat:write`)
      before writing the notes, sending its built-in one along, and falls back
      to its own when the ERP can't be reached.

## Out of scope

- Editing memtrade's extraction prompt (`prompts/extract.md`): the parser
  depends on its output shape. The settings table is key/value, so it can be
  added later.

## Notes

- Acks are keyed by `(report_date, warning text)` with no foreign key to the
  day, because a push deletes and re-inserts the day.
- memtrade changes live in its own repo (`wehat_ai/memtrade`: `src/erp.ts`,
  `src/cli.ts`, `src/report/summary.ts`).
