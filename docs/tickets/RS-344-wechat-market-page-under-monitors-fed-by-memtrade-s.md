---
id: RS-344
title: WeChat market page under Monitors, fed by memtrade's daily push
type: story
status: in-review
priority: P2
created: 2026-10-22
reporter: jinhu
branch: feat/wechat-market-report
pr: 817
version: v1.312.0
related: []
---

## Ask

> I would like to push all these information to ERP system.
>
> /frontend-design:frontend-design
> The system is here. @../../recycle_servers_v2
>
> Pls follow the exitsing UI to help me create a new dediacted wechat report page under tracker page.

## Context

"These information" is memtrade's daily report. memtrade (`~/Projects/wehat_ai/memtrade`, a
standalone TS project on the office Mac, outside this repo) reads every WeChat
group the team trades memory modules in and, at 08:00 ET each day, turns the
past 24 hours of 收货 (buy) and 出货 (sell) posts into a market report: what
each module is bid and asked at, by brand, capacity, speed and part code; how
many traders stand behind each price; the day-over-day move; Claude's market
notes; and the posts themselves. It keeps the whole history in its own
SQLite archive and serves the HTML on the LAN. The managers want it inside
the ERP, under the monitors ("tracker page" is the Monitors group: Facebook
and Reddit today).

Prices come in four tax bases (RMB 含税, RMB 未税, RMB without a basis, USD).
16000 含税 and 15000 未税 can be the same deal, so a change or a spread is
only ever computed within one basis — the same rule memtrade's own report
follows.

memtrade redoes a day when its first run had to fall back to rules (Claude
unavailable), so the ERP has to take the same day again and replace it.

## Acceptance criteria

- [x] `PUT /api/wechat-market/push/days/:date` stores a report day and
      replaces any earlier copy: its lines, groups and posts go with it.
      `POST …/days/:date/points` adds its posts in batches of ≤500, a retried
      batch counts once, and it answers 404 before the day exists. Both take
      only a Bearer token with `wechat:write`, need no CSRF header, and refuse
      a malformed body with a 400 that names the first bad field, storing
      nothing.
- [x] `wechat:write` is a new OAuth scope that a manager can give a service
      client in Settings → Connectors. Dynamic client registration never
      grants it, asked for or not.
- [x] `GET /api/wechat-market/days`, `/days/:date?kind=`, `/days/:date/points`
      and `/history` are manager-only (401 without a session, 403 for a
      purchaser).
- [x] **Monitors ▸ WeChat** (`/wechat`, `/wechat/<date>`) shows the newest
      day by default and any other by dropdown or arrows. It follows the
      Monitors pages' chrome: KPI cards, Claude's notes, most wanted / most
      offered specs, and a price board by brand & code, spec or part code
      with bid, ask, range bar, spread, traders, supply signal and the move
      since the previous report day. A line opens to its posts and its last
      30 report days.
- [x] Degraded days, partly delivered posts and memtrade's warnings show as
      banners. With nothing pushed yet the page says how to connect memtrade.
- [x] memtrade pushes every day the ERP has not had since it was last
      computed at the end of `run` and `backfill`, and on `push`. A failed
      push leaves the day queued and never fails the run.

## Out of scope

- The phone shell: Monitors is desktop-only.
- Feeding WeChat prices into Market values (`ref_prices`) or the max-buy
  guidance. memtrade's short codes (DM0, AFR) don't map to our part numbers
  without a lookup nobody has written.
- Purchaser access. The posts carry traders' names and phone numbers; the
  page starts manager-only like the Reddit monitor.
- Deleting a day from the ERP. memtrade never drops a day either.

## Notes

- Lines are stored with both sides on one row (`buy_*`, `sell_*`), each
  side's price buckets as JSONB, because the page always shows them side
  by side and a bucket list is variable.
- Bulk inserts go through `jsonb_to_recordset` with one JSON parameter: a
  day runs to ~1000 lines × 25 columns, past Postgres's 65535 bind params.
- memtrade rebuilds a day's lines from its stored trade points rather than
  storing them twice. Checked on 2026-10-18…22: the rebuilt per-line stats
  and prices match what each run saved, row for row.
