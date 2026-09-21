---
id: RS-095
title: Public sell intake endpoint for cash4ram.com
type: story
status: in-review
priority: P2
created: 2026-09-21
reporter: jinhu
branch: feat/public-intake
pr:
version: 1.172.0
related: []
---

## Ask

> Use the claude_design MCP (https://api.anthropic.com/v1/design/mcp, auth via /design-login) to import this project:
> https://claude.ai/design/p/4a83831b-0145-4d0b-8a55-71bd5e6b54e7?file=Cash4RAM+Sell+Page.html
>
> Focus on these files (the whole project is readable):
> - `Cash4RAM Sell Page.html`
>
> Also read these files the selection imports:
> - `c4r-app.jsx`
> - `cash4ram.css`
> - `components/c4r-data.jsx`
> - `components/c4r-form.jsx`
> - `components/c4r-sections.jsx`
> - `components/shared.jsx`
> - `components/whatsapp.jsx`
> - `styles.css`
> - `tweaks-panel.jsx`
> - `whatsapp.css`
>
> Implement: `Cash4RAM Sell Page.html`

> It should also optimized for SEO, GEO.

Asked to choose where the form submits (no public ERP intake existed), the
requester picked: "Add a public ERP intake endpoint too".

## Context

The cash4ram.com design (a Recycle Servers LLC consumer brand: photograph a
RAM/SSD/CPU label, enter counts and a PayPal email, get a written offer) mocks
an "ERP payload" shaped like `suppliers` + `orders`/`order_lines`. Nothing on
the backend accepts it: every write to those tables sits behind the cookie JWT
(`authMiddleware`), and the only unauthenticated surfaces are the vendor portal
(`/api/public/vendor/:token`) and the Shippo webhook. The site lives in its own
repo (`recycle_servers/cash4ram/`) and calls the ERP through the Cloudflare
Worker origin, so CORS and the proxy secret already apply.

The draft-PO path is centralised in `services/orderDraft.ts`
(`insertDraftOrderTx`, v1.157+), which is what the intake reuses so a web
submission is an ordinary Draft PO that staff price in the existing PO screen.

## Acceptance criteria

- [x] `POST /api/public/intake` accepts a JSON body or a multipart body
      (`payload` JSON field + `photo-<line>-<n>` files) without a cookie or
      `X-Requested-By`, and answers `201 { ref, lines, units }` where `ref` is
      the new PO id.
- [x] The PO is a Draft owned by `INTAKE_OWNER_USER_ID` (else the oldest active
      manager), `payment = company`, `payment_method = paypal`,
      `commission_rate = 0`, `source` mapped from the site's `?src=`
      (facebook → facebook, reddit → reddit, otherwise other), notes carrying
      the PayPal email; lines at `unit_cost 0`, `condition 'Pulled — Untested'`.
- [x] RAM lines land with `classification` (RDIMM/UDIMM/LRDIMM/SODIMM) and the
      derived `type`; CPU lines land as category `Other` with
      `item_type = CPU`.
- [x] Photos are stored through `uploadAttachment` and appear as
      `order_line_photos` on the line; a non-image MIME is refused with 415.
- [x] A supplier row (`owner_id NULL`, `source = web`, `status = prospect`,
      name = email) is created once per email and reused on later submissions.
- [x] Managers get a notification for every accepted submission.
- [x] Bad input answers 400; the honeypot field answers 200 without writing;
      the sixth request from one IP inside a minute answers 429 with
      `Retry-After` readable cross-origin.
- [x] `autoTrackParts` is not run for web submissions (no anonymous writes to
      `ref_prices`).

## Out of scope

- OCR / label-scan prefill for the public form (`/api/scan/label` stays
  auth-gated).
- A separate `intake` table or a "convert to PO" step — the submission *is* the
  draft PO.
- Widening `orders.source` to a new `web` value (would touch the shared
  `PACKAGE_SOURCES` enum and its label map); `suppliers.source` gets `web`
  instead.
- Production wiring: adding `https://cash4ram.com` to `CORS_ALLOWED_ORIGINS`
  and setting `INTAKE_OWNER_USER_ID` on Railway — documented, not done.

## Notes

- Plan reviewed under `plan-first`; the reviewer caught that the local
  checkout was 57 releases behind `origin/dev`, that `payment = self` means
  "purchaser paid out of pocket" (0126), and that RAM `type` is
  Server/Desktop/Laptop, not the DIMM class (0027).
- Supplier dedupe rides the real unique index
  (`ON CONFLICT (owner_id, match_key)`), so `john.doe@x` and `johndoe@x`
  resolve to the same house-account supplier instead of a 500.
- The site side lives in `recycle_servers/cash4ram/` (Vite + React + TS, SSR
  prerender, four routes).
