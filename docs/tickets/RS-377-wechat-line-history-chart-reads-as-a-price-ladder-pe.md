---
id: RS-377
title: WeChat line history chart reads as a price ladder per report day
type: story
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/naga
pr: 853
version: 1.326.0
related: []
---

## Ask

> refine the graph here for the wechat page.
> [Image #1]

The image was a screenshot of an opened line's "Last 30 report days" chart.
Its dots were flattened ovals and a bid on 10-18 sat alone in the top corner.
The only number was "¥1,150–¥1,500 tax not stated", in the middle of the date
row, and there was no y-axis.

## Context

Opening a line on Monitors ▸ WeChat shows its posts, a history chart, prices by
tax basis and the day's facts. The chart is `HistoryChart` in
`apps/frontend/src/pages/desktop/DesktopWechat.tsx`, styled by `.wx-chart*` in
`styles/facebookPool.css`. It plots each side's headline median for each report
day, in the tax basis most of them were quoted in (`chartBasis`).

What was wrong with it:

- It drew into a 320×96 viewBox stretched across the panel with
  `preserveAspectRatio="none"`. `non-scaling-stroke` kept the lines thin, but
  the circles came out as wide ovals.
- It had no y-scale. The only way to read a value was a native `<title>` on a
  2.2px dot.
- A day nobody quoted broke the line, so an early point floated with no link
  to the rest of the trend.
- Only the first and last dates were labelled, and the chart had no legend.

`/api/wechat-market/history` already returns each side's `min`, `max` and `n`,
not just the median. The board's ladder column (`Ladder`) draws exactly that:
a min–max bar with a median tick per side. The dashboard's `CashflowChart`
(`pages/desktop/DashboardChart.tsx`) already draws in pixel space through
`useElementWidth`, with `niceStep` ticks, a crosshair tooltip and arrow-key
focus.

## Acceptance criteria

- [x] Dots render as circles at any panel width (pixel-space SVG, no `preserveAspectRatio="none"`).
- [x] Price gridlines carry labels, and the scale covers every drawn bar.
- [x] Each priced day draws each side's min–max bar in its own lane (bid left, ask right), with the median dot on it.
- [x] A dashed bridge crosses days without a quote, instead of a break in the line.
- [x] Each side's latest median is labelled beside its last dot, and the two labels never overlap.
- [x] The chart has its own legend (Bid, Ask, Range of quotes), with the tax basis on the same row.
- [x] Hover, and focus with ←/→/Esc, show one tooltip per day with each side's median, traders, range and the spread. A side reads "Not quoted", or shows its price muted with its basis when it was quoted only in another basis.
- [x] The new strings exist in en and zh.

## Out of scope

- A table view of the history.
- Picking the tax basis inside the chart. It stays the basis most days were
  quoted in.
- The mobile shell, which has no line detail.
- Backend changes: the `/history` payload already carries min, max and n.

## Notes

- Design: the bars are the board's ladder turned upright, one per report day,
  so the chart and the board column read as one system. A shaded bid–ask band
  was considered and dropped: it fights the bars and breaks apart around the
  gaps. The tooltip carries the spread instead.
- The bid/ask pair (`--info` `#418ad1`, `--pos` `#029e72`) passes the dataviz
  palette validator on white: deutan ΔE 15.6, normal ΔE 17.6, and both colors
  clear 3:1 contrast.
