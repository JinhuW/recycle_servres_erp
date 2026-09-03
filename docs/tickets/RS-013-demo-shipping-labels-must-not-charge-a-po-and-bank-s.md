---
id: RS-013
title: Demo shipping labels must not charge a PO, and bank sync must report its failures
type: bug
status: in-progress
priority: P1
created: 2026-09-02
reporter: Jinhu
branch: session/20260902-121934
pr:
version:
related: []
---

## Ask

> Fetch all error log in the railway and see all error logs to see if it related
> to a system bugs.
> If yes, Then create an fix plan for all of them.

Then, after the triage came back and the fix plan was written:

> go head and accomplish the,

Asked in the Claude Code terminal against the production Railway service. The
triage read 12,497 log lines across five production deployments (27 Aug –
2 Sep). The log itself was clean; these two defects were found by chasing the
few real 4xx/5xx into the code, and neither of them emits a log line at all.

Jinhu chose the shape of this fix in plan mode. Offered a hard refusal of stub
label purchases, he picked **"stop the money and mark it earlier"** — the
purchase still works, it just moves no money and says what it is before you
commit. He also chose to land on `dev` now rather than hotfix `main`, and to
split the triage into three PRs by theme; this is the first.

## Context

**Production runs with `labels: "stub"`.** `SHIPSAVING_APP_KEY` and
`SHIPSAVING_APP_SECRET` are unset, so `pickShippingClient` falls through to
`stubShippingClient` (`shipping/index.ts:26-35`). That is deliberate — the
comment above it says credentials may lag deploys and deploys must not block on
them. What was not deliberate is where the demo money ends up.

The stub returns plausible rates (`USPS Priority $12.45`, `UPS Ground $9.80`,
`FedEx Home $11.20`), and the rate object is provider-anonymous at every hop
from `listRates` to the buy handler's replay lookup. The wizard renders them as
ordinary rate cards under a `Buy for $12.45` button. On purchase,
`shipments.ts` folds `label.amount` into `orders.other_fees`, where
`po-cost.ts` amortizes it into per-line cost and commission. The only marker is
a `Demo` chip that is suppressed for `draft` and `quoted` — absent through rate
selection and purchase, appearing only once the money is already on the order.

Verified latent, not realized: across the six-day window production saw one
shipment created, zero rate fetches and zero label purchases. No PO has been
corrupted.

**Bank reconciliation can stop without saying so.** `startBankSyncLoop` runs
Mercury and PayPal every six hours and both keys are set in production.
`doSync` catches each provider's failure into `result.perSource[source].error`
and `tick()` discards the result, so the surrounding `catch` is unreachable for
provider errors — and it is a `console.warn`, which bypasses `lib/log.ts`
anyway. Nothing logs on success either. Six days of production logs contain
zero `[banktx]` lines, which is equally consistent with 24 clean passes and 24
silent failures. That is the defect: from production the question cannot be
answered.

## Acceptance criteria

- [ ] Buying a label from a stub rate leaves the PO's `other_fees` unchanged,
      and the shipment row carries `fees_applied = FALSE` and
      `label_cost = NULL`.
- [ ] Voiding a stub-bought label subtracts nothing and writes no fee note.
- [ ] `POST /:orderId/shipments/:sid/rates` returns which provider produced the
      rates, and the label wizard marks demo rates on the rate cards and warns
      above the confirm block — before the Buy button, not after.
- [ ] Buying a label from a real (ShipSaving) rate still folds its cost into
      `other_fees` exactly as before, and this is covered by a test that drives
      the paid client rather than the stub.
- [ ] A bank-sync pass that fails for a provider emits a `warn` through
      `lib/log.ts` naming the source and the error; a pass that succeeds emits
      an `info` carrying the per-source counts.
- [ ] No `console.*` remains in `banktx/`.

## Out of scope

- Setting `SHIPSAVING_APP_KEY`/`SECRET` or `SHIPPO_API_TOKEN` in production —
  an ops decision, tracked separately.
- Refusing stub purchases outright. Considered and rejected in plan mode: it
  contradicts the documented intent at `shipping/index.ts:23-25` and would
  require an opt-in env flag to keep the test suite's coverage of the flow.
- The dev→main release that carries this to production.

## Notes

The blank `STUB_PDF` and the dead USPS tracking link on a stub label are left
as-is. With the pre-purchase marker in place they are visibly part of a demo,
and neither touches the books.

Plan: `~/.claude/plans/precious-dazzling-cat.md`. The triage report that found
these is at https://claude.ai/code/artifact/a857947f-56fb-4a70-b4d5-b0ec94c6b2d8

A plan review caught that every existing money assertion in
`tests/shipments.test.ts` runs through the stub — the buy fold, the void
reversal, the GREATEST guard and the external-void path. Making stub buys move
no money would have silently deleted all of it, leaving the real fee fold
untested. Hence the paid-provider test seam, which is the bulk of the work here
and the first time that path is genuinely covered.
