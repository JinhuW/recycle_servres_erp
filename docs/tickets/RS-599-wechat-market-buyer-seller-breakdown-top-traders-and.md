---
id: RS-599
title: WeChat market: buyer/seller breakdown, top traders and sentiment
type: story
status: done
priority: P2
created: 2026-11-16
reporter: jinhu
branch: session/20261116-073514
pr: 1226
version: 1.472.0
related: [RS-344, RS-587, RS-588]
---

## Ask

> 在wechat部分，我想要知道买卖双方更具体的数字， 比如买多少卖多少人数。
> 最好添加一些情绪分析。

Follow-up answers (plan mode): new numbers = 全天买卖总量, 人数细分, 活跃交易者榜;
sentiment = 全天 + 每个规格; shown on the ERP page and in memtrade's daily report.

## Context

Monitors ▸ WeChat (`/wechat`, `DesktopWechat.tsx`) shows only
"N buyers · N sellers · N posts" in the toolbar. Quantities appear only inside
an expanded row (`buy_qty`/`sell_qty` per line), and nothing says who the
active traders are. The only market read is memtrade's 紧缺…过剩 signal from
the buy/sell post ratio; there is no sentiment.

memtrade (outside this repo, `~/Projects/wehat_ai/memtrade`) classifies and
aggregates; the ERP stores and shows what it pushes to
`/api/wechat-market/push/*`. The new figures are computed once in memtrade and
pushed, so the page and the HTML report agree.

Definitions:
- **Quantity**: per sender per line the largest qty, summed (as `sideStats`
  does). Posts that state a quantity are counted too: most don't, so the total
  is a floor.
- **Buy-only / sell-only / both**: distinct senders by the sides they posted.
- **New buyers/sellers**: senders not seen on that side in the previous 30
  report days; null without history.
- **Mood** per post, by price direction: bullish (急收, 加价收, 缺货, 涨价,
  惜售), bearish (急出, 清仓, 甩货, 特价, 降价, 压价), neutral; plus `urgent`.
- **Sentiment index**: one vote per sender (latest post),
  (bullish − bearish) / voters × 100; none under 3 voters. ≥ 20 bullish,
  ≤ −20 bearish.

## Acceptance criteria

- [x] The push contract takes optional day `totals` quantity/breakdown fields,
      `traders`, `sentiment`, per-line `sentiment` and per-point `mood`/`urgent`;
      a push from the current memtrade (none of these) is still accepted.
- [x] Migration adds the columns, all nullable.
- [x] The Board tab shows a 买卖双方 card (traders, posts, quantity buy vs sell,
      buy-only/both/sell-only, new buyers/sellers, change from the previous day).
- [x] The Board tab shows a 市场情绪 card (index, label, bullish/neutral/bearish
      voters, urgent posts, buy and sell side split).
- [x] The Board tab shows an 活跃交易者 card, top 10 buyers / sellers.
- [x] The board table has a sentiment column; evidence posts show their mood.
- [x] The Activity tab charts daily buy/sell quantity and the sentiment index.
- [x] A day pushed without the new fields shows "—", not an error.
- [x] memtrade extracts mood, aggregates the figures, pushes them, and its
      HTML/Markdown report shows the same blocks.

## Out of scope

- Per-group sentiment.
- Backfilling sentiment for old days automatically: re-extraction costs a
  Claude run per day; managers can use Re-run per day. Quantities, breakdown
  and traders backfill by re-pushing stored days (no LLM).
- Mobile page (there is none for WeChat).

## Notes

Plan: `~/.claude/plans/wechat-scalable-robin.md`. Ship order: ERP to dev
first (accepts the optional fields), then memtrade.

- Numbered RS-596, then RS-598, while open: both numbers, with their
  migration and versions, went to changes merged first (the Actions board,
  inventory last-collected). This one took migration 0250 and, after other changes took v1.466.0–v1.471.0, v1.472.0.
- memtrade's side was built and tested in a copy beside it
  (`~/Projects/wehat_ai/memtrade-rs596`), not in the live folder, because
  the 08:00 report and the re-run poller run from there.
- On 40 real posts, the first prompt called every standing 高价收 recycling
  ad bullish. The prompt and the rules fallback now treat that slogan as
  neutral unless urgency, shortage or a price rise comes with it.
- A line naming two speeds ("64G 5600/6400 10万") splits into two items
  carrying the same figure; units count it once.
- The last box above is ticked for the code, which is ready and tested;
  memtrade's live folder is swapped only when the owner says so.
