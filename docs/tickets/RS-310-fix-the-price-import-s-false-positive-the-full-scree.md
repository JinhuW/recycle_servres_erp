---
id: RS-310
title: Fix the price import's 元 false positive, the full-screen Watch overlap and the cookie Assign fallback
type: bug
status: in-progress
priority: P1
created: 2026-10-19
reporter: jinhu
branch: fix/release-review-erp
pr:
version:
related: [RS-296, RS-301, RS-308]
---

## Ask

> /code-review max pls review all dev to prod change.
>
> fan out as much as possible agents to review them.

> yes. The goal is to merge to prod
>
> The currency is only need rmb and usd,Do not bother to think of others.

## Context

The max review of everything on `dev` but not on `main` (v1.281.1 → v1.291.0)
confirmed two ERP findings that ship with the release. The "yes" above answers
"Should I fix the two ERP issues and merge the tracker release branch into
dev?". A follow-up review of RS-306–RS-308, which landed during the first one,
found a third. The fix for that one, a password fallback, was picked from the
options offered.

- **Price import (RS-301, `services/sellOrderPriceImport.ts`).** The CNY mark
  matched any 元. A dollar sheet on a tab named 电子元器件 ("electronic
  components"), or with 元件 / 元旦 / 单元 in its price header, was converted
  at the CNY rate: $100 became $13.86. Only RMB and USD sheets come in, so the
  other-currency cases the review raised (yen ¥ formats, 韩元, "HKD $") are
  dropped.
- **Full screen (RS-296, `styles/desktop.css`).** At 1100 CSS px or narrower,
  the stacked rule `.fl-watch.with-account .fl-watch-stage { height: 56vh }`
  ties the full-screen `height: auto` on specificity and comes later, so the
  stage painted over the sign-in panel. A 1366×768 laptop at 125% scaling
  (about 1093×614) is enough to hit it.
- **Cookie-first Assign (RS-308, `routes/facebookPool.ts`).** The changelog
  said an older fleet falls back to the password login; the code returned the
  seed's error. Prod runs facebook-tracker 0.12.4, whose console has no
  `PUT /v1/workers/{id}/session`. Every Assign of an account holding its own
  cookie would have returned 404 after the vault write. A cookie without `xs`
  gets a 422 on 0.12.5 with the same result.

## Acceptance criteria

- [x] A tab or price header with 元 inside a word (电子元器件, 元件, 元旦, 单元)
      no longer reads as yuan; a dollar sheet titled 电子元器件 imports at face
      value.
- [x] 单价（元）, 单价/元, 300元, ¥/￥, RMB/CNY/人民币 still read as yuan, and
      美元 as dollars.
- [x] In full screen at 1100 CSS px or narrower with the sign-in panel open,
      the stage and the panel sit side by side and nothing overlaps (the 2FA
      code and "Type into browser" receive clicks).
- [x] Outside full screen, the stacked layout at 1100 px or narrower is
      unchanged.
- [x] When the session seed answers 4xx (404 from an older console, 422 or 409
      for a refused cookie), the Assign queues the password Re-login and
      completes; a 5xx still fails the Assign.
- [x] When that fallback Re-login fails, the pool row stays unchanged and no
      `assigned` event is written.

## Out of scope

- Currencies other than RMB and USD (the ask says not to).
- The tracker-side findings of the same review (fleetd, coordinator, deploy
  script). They ship with the next facebook-tracker release, not this ERP one.
- The cookie path's toast still says "Re-login is queued".

## Notes

- Full screen was checked in headless Chromium with the real Fullscreen API at
  1024×640, 1093×614, 1100×700, 1280×720, 1440×900 and 1536×864. At ≤1100 px
  the body is now `753px 340px`, and every probe point reaches its target.
- The 元 rule is `(?<!单)元(?![一-鿿])`: 元 not followed by another
  CJK ideograph and not preceded by 单.
