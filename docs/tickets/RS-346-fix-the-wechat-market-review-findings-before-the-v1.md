---
id: RS-346
title: Fix the WeChat market review findings before the v1.312 release
type: bug
status: done
priority: P1
created: 2026-10-22
reporter: jinhu
branch: JinhuW/glassfish-wechat
pr: 819
version: v1.312.2
related: [RS-344, RS-345]
---

## Ask

> /code-review high from dev to prod. release to prod. ocne you fix all identified issues.

## Context

PR #817 (WeChat market page, RS-344, v1.312.0) reached `dev` after the
release review had run, the same way #812 did before v1.310 (RS-342). A
release now would ship it to prod unreviewed, so it got its own high-effort
review. That review found ten defects:

1. **Bids/Asks filtered the wrong set.** The line detail filtered, in the
   browser, the newest 100 posts across both sides. The endpoint's `side`
   parameter was never sent, so on a busy line *Asks* showed a handful of
   sells under a note saying these were the newest 100.
2. **History chart mixed bases.** Bid and ask medians shared one scale even
   when one side was quoted in USD and the other in RMB含税.
3. **Most wanted / Most offered could open an empty board.** Those cards rank
   by traders, priced or not, while *Priced lines only* stayed on.
4. **One unnamed group or sender rejected a whole push.** `str` refused empty
   strings for `groups[].name` and `points[].senderName`, so a WeChat group
   with no topic set failed every day's push from then on.
5. **A stale batch could land in a replaced day.** Point batches named no
   run, so a retried batch from an earlier push of the day was stored in the
   push that replaced it.
6. **Timestamps checked looser than stored.** `Date.parse` accepts formats
   Postgres's `timestamptz` cast rejects, which surfaced as a 500, not the
   400 that names the field.
7. **An impossible date loaded forever.** `/wechat/2026-02-30` got a 400,
   which only toasted and left the board on its skeleton.
8. **Two Unbranded headers.** `null` and `未注明` sorted apart, so unbranded
   quotes showed under two headers.
9. **The day list counted every day's points.** `GET /days` ran a
   `COUNT(*)` over `wechat_market_points` for every report day, on every
   visit.
10. **The spec rows were fetched twice.** The side panel and the board each
    requested a day's spec rows.

## Acceptance criteria

- [x] *Bids* and *Asks* request their own side (`side=buy|sell`), each up to
      100 posts.
- [x] The history chart draws both sides in one tax basis (the most quoted,
      latest on a tie) and labels the axis with it.
- [x] Picking a spec from a top card turns *Priced lines only* off when the
      spec has no price.
- [x] A push with an empty group name or sender name is stored. The page
      shows the group's or sender's id instead.
- [x] `PUT /push/days/:date` returns a `pushId`. A points batch naming another
      one is a 409 `day_replaced`, and one without a `pushId` is taken as
      before.
- [x] A timestamp that isn't ISO 8601 with a zone is a 400 naming the field.
- [x] A route date the API rejects shows the no-report banner.
- [x] Unbranded quotes sit under one header.
- [x] The day keeps its stored point count (`stored_points`, migration 0195),
      and `GET /days` reads it.
- [x] A day's rows of one kind are requested once while the page is open.

## Out of scope

- memtrade sending `pushId`. It lives outside this repo, at
  `~/Projects/wehat_ai/memtrade` (`src/erp.ts` → `pushDay`). The ERP accepts
  batches with and without it, so the ERP ships first and memtrade can start
  sending it whenever it is next changed.

## Notes

- Found by a review of #817 (de88abc5). memtrade writes every timestamp with
  `toISOString()`, so the stricter check refuses nothing it sends today.
