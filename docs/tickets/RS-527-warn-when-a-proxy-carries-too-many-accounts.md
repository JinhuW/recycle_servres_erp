---
id: RS-527
title: Warn when a proxy carries too many accounts
type: story
status: done
priority: P2
created: 2026-11-04
reporter: jinhu
branch: JinhuW/proxy-crowding-dot
pr: 1087
version: 1.419.0
related: []
---

## Ask

> when a proxy is used by 5 account.
> [Image #1]
> then show a yellow note. If it is over 10 account, then it will show a red dot.
> Make sure when i hover the dot, it will show the reason.

## Context

The Used by column in `apps/frontend/src/pages/desktop/fleet/FleetProxiesTab.tsx`
shows "n of limit accounts" and turns amber at the configured
`max_accounts_per_proxy`, which is 2 today and can't be set above 10
(`apps/backend/src/fleet/cities.ts`). Nothing marks a proxy as crowded on fixed
thresholds, and homelab rows show no count at all.

## Acceptance criteria

- [x] A row with 0–4 accounts shows no dot.
- [x] A row with 5–10 accounts shows a yellow dot.
- [x] A row with 11 or more accounts shows a red dot.
- [x] Hovering the dot shows the count and the reason.
- [x] The count is non-parked ERP accounts plus homelab workers.
- [x] The dot's hover text is translated in en and zh.

## Out of scope

- Making the thresholds configurable.
- Changing `max_accounts_per_proxy` or its cap of 10.
- A filter or sort for crowded proxies.

## Notes

Exactly 10 is yellow, because the ask says red when "over 10". The yellow "note"
is a dot too, because the ask says "hover the dot". With the limit at 2 and capped
at 10, ERP rows show no dot until the limit reaches 5, and an ERP-only proxy can't
normally reach red; red in practice means a port homelab workers also use.
