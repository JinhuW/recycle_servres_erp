# Backend domain review coverage

Review date: 2026-10-13. Existing historical review documents were not used as evidence of current defects. “Full read” means every implementation section was inspected; it does not mean every behavior was dynamically tested. Review considered permissions, API inputs, lifecycle rules, financial queries, locks, audit effects, and relevant schema constraints.

## Full file reads completed by the domain agent

All paths in this section are relative to `apps/backend/src/`.

- Purchase-order routes, including all GET/export/evidence/check/AI-review/shared helpers: `routes/orders/index.ts`, `create.ts`, `patch.ts`, `lifecycle.ts`, `list.ts`, `detail.ts`, `spreadsheet.ts`, `refusal.ts`, `shared.ts`, `evidence.ts`, `checks.ts`, and `aiReview.ts`.
- Entire sales router (1–1902), including list/stats/detail/sellable/export, price template/packing list/import preview, save/status/price adjustment, notes/attachments, archive/sign-off/events: `routes/sellOrders.ts`.
- Entire inventory router (1–2157), including listing/stats/analysis, product grouping/facets/selection, export/events/detail, mutation, and transfer creation/receive/reopen/discard: `routes/inventory.ts`.
- Entire manual bank router (1–1030), including list/by-order/stats, candidate reads/suggestions, ignore-rule CRUD/preview, transfer-rule mutation, link/unlink/pair/unpair/ignore/assign/note: `routes/bankTx.ts`. Read-query ranking and reconciliation fragments were also fully read in `banktx/match.ts` (1–571) and `banktx/ignoreRules.ts`. Sync internals/providers remain root's scope.
- Other complete routers: `routes/sellOrderPack.ts`, `internalTx.ts`, `categories.ts`, `itemTypes.ts`, `customers.ts`, `lookups.ts`, `fxRates.ts`, `notifications.ts`, `tracker.ts`, `shippoWebhook.ts`, `activity.ts`, and `dashboard.ts`.
- PO services: `services/orderAdvance.ts`, `orderHandoff.ts`, `orderLocks.ts`, `orderDraft.ts`, `orderCategory.ts`, `orderGoodsTotal.ts`, `orderSold.ts`, `orderTxnRule.ts`, `orderAudit.ts`, `auditDiff.ts`, and `poRealized.ts`.
- SO/reporting services: `services/sellOrderCreate.ts`, `sellableInventory.ts`, `sellOrderSignoff.ts`, `sellOrderAudit.ts`, `sellOrderLineMatch.ts`, `sellOrderPriceAdjust.ts`, and `contributions.ts`.
- Domain helpers: `lib/fx.ts`, `po-cost.ts`, `sellCommitment.ts`, `market.ts`, `marketAutoTrack.ts`, `marketWrite.ts`, `refPriceEvents.ts`, `sellOrderMarket.ts`, `orderInput.ts`, `reporting-window.ts`, `id-seq.ts`, `part-number.ts`, `poLineNo.ts`, `inventoryLabel.ts`, and `linePhotos.ts`.

## Focused reads and cross-agent handoff

- Package and market mutation/financial helpers received a focused pass in `routes/packages.ts` and `routes/market.ts`; the security agent owns their remaining full-file sweep. Do not infer a full-file domain-agent read from this focused coverage.
- Schema constraints were traced for the findings, including migrations `0065_sell_order_currency`, `0100_bank_transactions`, `0116_internal_transactions`, and `0127_sell_order_lines_inventory_set_null`, plus bank-state CHECK additions. Complete migration/script integrity coverage belongs to the security agent.
- The security agent owns full `routes/suppliers.ts`, `routes/warehouses.ts`, supporting `services/poAiReview.ts`, `poReviewChecks.ts`, `supplierCrm.ts`, `members.ts`, `sellOrderNumbers.ts`, `sellOrderPriceImport.ts`, and `lib/sellOrderPriceTemplate.ts`, `categoryColumns.ts`, `xlsx.ts`; root is reconciling their completed coverage ledger.
- Root owns integrations/providers, automatic bank sync/pairing, deployment/tooling, and other non-domain utility code.

The domain agent's final requested PO/SO/bank remainder has no unread sections. Cross-agent items above are ownership handoffs, not claims of completion by this agent; root must verify the other ledgers before describing whole-repository coverage.

## Runtime evidence

- Nine targeted defect reproductions passed together using the repository's migrations/seed/Hono app/test helpers on isolated PostgreSQL 18: **1 file passed, 9 tests passed, 21.01 seconds**. Source is preserved in `backend-domain-reproductions.ts`, with replay instructions. The temporary `apps/backend/tests/review-domain-repro.test.ts` was removed after verification, so these assertions are excluded from ordinary CI.
- Original stock-lock-order tests were read when assessing the archive/Done interleaving gap. The root full suite's tier1 partial-sale assertion failure was investigated separately: `vitest run tests/tier1-data-integrity.test.ts -t 'subtracts the sold qty'` passed 1 test, skipped 11, 12.16 seconds. The test incorrectly conflates partial and full sellout for randomized seed quantities; it is reported as a test defect, not a production inventory defect.
- Runtime checks establish the particular scenarios in the TODOs; untested paths are not asserted correct. No production code was changed.
