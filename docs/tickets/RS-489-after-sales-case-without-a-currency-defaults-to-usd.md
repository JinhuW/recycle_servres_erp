---
id: RS-489
title: After-sales case without a currency defaults to USD, not the order's
type: bug
status: backlog
priority: P1
created: 2026-10-31
reporter: jinhu
branch: fix/after-sales-currency-compat
pr:
version:
related: [RS-483]
---

## Ask

> yes, patch first and release

(Answering the pre-release review of dev → main, which flagged that an
after-sales case opened with no currency took the sell order's currency.)

## Context

RS-483 (v1.395.0) gave after-sales cases a currency. When a create request
named none, the server used the sell order's currency. The only clients that
send no currency are desktop tabs still on the bundle from before v1.395.0,
whose amount field reads "Amount (USD)". On an RMB order their dollar figure
would be stored as RMB, about 7x too small.

The other direction matters too. The prod Worker deploys on the main push even
when Railway lags. A new bundle talking to an old backend got no `currency` on
cases and rendered "undefined 10.00".

## Acceptance criteria

- [ ] `POST /api/after-sales` with no `currency` stores USD, whatever the order's currency.
- [ ] The new UI still starts the amount at the order's currency and always sends it.
- [ ] A case read without `currency` shows as USD in the list, on the case page and on the sell order.

## Out of scope

Other review findings, left as follow-ups: the new-case form shows line prices
in USD beside an RMB amount; the summary tile drops RMB cases when no FX row
exists; the per-file reload in the edit dialog's attachments; the stale comment
in `accounting.ts`; `docs/DATABASE.md` for `currency_code`.
