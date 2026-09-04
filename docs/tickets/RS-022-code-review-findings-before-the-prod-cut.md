---
id: RS-022
title: Code-review findings before the prod cut
type: bug
status: in-progress
priority: P2
created: 2026-09-04
reporter: jinhu
branch: fix/rs-022-review-findings
pr:
version:
related: [RS-018, RS-020, RS-021]
---

## Ask

> /code-review high and identify all high priority issue , fix them, then push to main

## Context

A `high`-effort review of the diff a `dev` → `main` release would ship
(`origin/main...origin/dev`: v1.123.1, v1.124.0, v1.125.0 — ~1,640 insertions
across 34 files) returned eight findings.  **None was High severity**: three
Mediums and five Lows.  All eight verified against source; no false positives.

Two of the three Mediums are in RS-018's dispute work, which shipped three days
ago and has never been on `main` — so this is the last cheap moment to fix them.

The findings, and what each actually costs:

| | Where | Cost if shipped |
|---|---|---|
| 1 | `index.ts` 4xx logger + `oauth/server.ts:144` | Unauthenticated, unthrottled log flood — the open-DCR 400 echoes the caller's own text back into the log line, and the throttle counts *created clients*, so a validation failure creates none |
| 2 | `routes/bankTx.ts` feed | A red Dispute chip on rows the tile and filter deliberately hide — a manager sees the badge, clicks Disputed, and gets nothing |
| 3 | `banktx/paypal.ts` dispute pagination | Picks the first link carrying `next_page_token=` rather than `rel: "next"`; PayPal's `self` link carries it too from page 2, so the loop can re-fetch one page 20× — 1,000 duplicate detail GETs and ingestion truncated at 50 cases |
| 4 | `DesktopPayments.tsx:455` | Every dispute-sync failure — timeout, 500, DNS blip — reads *"PayPal disputes not authorised"*, sending an admin to fix a setting that is already correct |
| 5 | `DesktopPayments.tsx` ×3 | A EUR case renders `$1,240.00`; `currency` is carried on the wire and dropped at render |
| 6 | `DesktopPayments.tsx:1092` | Colliding React keys — PayPal records both parties' fund movements at one timestamp and type |
| 7 | `scripts/migrate.mjs:39` | A wrong password is retried 6× over ~23s logging "database not reachable yet" — the misleading line an operator sees while the container looks merely slow |
| 8 | `DesktopPayments.tsx:155,178` | Deploy-skew comments cite v1.122.0; disputes shipped in v1.124.0 |

## Acceptance criteria

- [ ] `POST /oauth/register` with a hostile `redirect_uris` entry returns a fixed
      RFC 7591 error code, and that text does not appear in the request log line.
- [ ] A 4xx `error` string is bounded at 256 chars **after** parsing, so a long
      body no longer costs the line its reason.
- [ ] The payments feed returns `disputes: null` on money-in rows; money-out rows
      still carry the case.  The chip, tile, and filter agree.
- [ ] Dispute pagination prefers `rel: "next"` and stops when the next URL
      repeats.
- [ ] The header chip says "not authorised" only for a 403/NOT_AUTHORIZED
      message, and something neutral otherwise (EN + ZH).
- [ ] Dispute amounts, timeline amounts, and refunded amounts render in the
      case's own currency.
- [ ] `migrate.mjs` retries `57P03` and the socket-error class, and fails fast on
      `28P01` / `3D000`.
- [ ] Backend + frontend suites, typecheck, and build all green.

## Out of scope

**Showing disputes filed against us.**  Finding 2 is fixed by hiding them, which
is what RS-018 specified — but a chargeback *against* us is money we may lose,
and it is now invisible by design.  Widening that is a product decision for
Jinhu, not a review fix.

## Notes

The plan-review pass corrected three of the fixes as first drafted, two of which
would have made things worse:

- Capping `ERROR_BODY_MAX` at 256 would have **broken the feature it protects**:
  the slice happens on the raw body *before* `JSON.parse`, so truncating makes
  the parse throw and the line loses its reason entirely.  A committed-lines 409
  carrying three `offendingLineIds` UUIDs already exceeds 256 bytes.  The cap
  belongs on the extracted string.
- Skipping the log reason for all `/oauth/` paths would have blanked ~10 distinct
  fixed RFC reasons on `/oauth/token` — the connector diagnostics CLAUDE.md
  singles out — for zero security gain, since the only interpolated string is the
  one line in DCR.  The two admin sites cited as exposed are behind
  `authMiddleware` + a manager gate at `/api/oauth/clients` anyway.
- Narrowing the migrate retry to socket codes alone would have been a **boot
  regression**: `57P03` (`cannot_connect_now`) is what Postgres returns while
  starting up and arrives as a `PostgresError`, not a socket error.  That is
  precisely the transient the retry exists for.
