# Schema and supporting backend review TODOs — 2026-10-13

Current worktree review; no production source edits. P2 denotes correctness/security/reliability defects; P3 denotes narrower helper or hardening defects. Security/platform findings, including receipt cleanup SEC-15, are in [security-todo.md](security-todo.md). Domain transaction findings are in [backend-domain-todo.md](backend-domain-todo.md).

## Verified issues

- [x] **SUP-01 · P2 · Recheck supplier ownership inside every mutation.** `apps/backend/src/routes/suppliers.ts:526–559`; analogous read-then-write patterns at `:574–609,613–629`. PATCH reads owner and authorizes before its independent UPDATE, whose WHERE includes only the supplier ID. A manager handing the client to another purchaser between those operations does not revoke the former owner's in-flight write. Notes creation/deletion have the same boundary pattern. **Evidence:** deterministic PostgreSQL reproduction held the supplier row, started a purchaser PATCH, waited for its UPDATE to block, reassigned the owner inside the holding transaction, then released it. PATCH returned 200 and stored the former owner's note under the new owner. **Remediation:** check ownership under the same row lock and transaction as the write; use owner predicates with checked RETURNING for single-statement changes. Make note writes and reassignment share that lock. **Regression:** synchronized reassign versus PATCH/note creation/deletion denies a write authorized only by an obsolete owner, while managers and the current owner still work.

- [x] **SUP-02 · P2 · Use the current supplier name key when a package becomes a PO.** `apps/backend/src/routes/packages.ts:326–334`; `apps/backend/migrations/0154_supplier_name_key_unicode.sql:24–29`. Package conversion still strips all non-ASCII characters for matching, although the database's current `supplier_name_key` preserves Unicode to prevent false merges. Distinct clients “王 RAM” and “李 RAM” both become RAM; entirely Chinese names all become the empty string. Conversion picks the oldest such supplier and assigns another seller's PO to it, corrupting CRM history and follow-up. **Evidence:** integration reproduction created those two clients for one owner, converted a package from 李 RAM, and found its supplier_id referenced 王 RAM. **Remediation:** call `supplier_name_key` for both operands, as adoption/suggestions already do; avoid picking arbitrarily if the same name has genuinely ambiguous records. **Regression:** mixed-script and fully non-Latin names cannot attach to a different client; current ASCII spacing variants retain their intended behavior.

- [x] **SUP-03 · P2 · Filter the CRM before applying its result limit and count the full scoped book.** `apps/backend/src/routes/suppliers.ts:229–247`. The query selects its first 200 (maximum 500) rows, then JS applies follow-up and health filters and calculates counts. A book with many overdue clients can show no “Soon” clients because all of them occur after the pre-filter cap; changing limit changes the counts of the same book. Clients beyond the maximum cannot be reached through this list. **Evidence:** integration reproduction inserted one overdue and one soon client, requested `?limit=1&follow=soon`, and received an empty list and soon=0. **Remediation:** derive/filter follow-up and health before pagination, add a stable cursor/offset, and calculate summary counts against the full owner-scoped population. **Regression:** over-cap books still return matching soon/quiet clients, full counts stay stable across pages, and purchaser ownership remains enforced.

- [ ] **SUP-04 · P2 · Keep append-only protections enabled after a seed failure.** `apps/backend/scripts/seed.mjs:552–560`. Seed disables the inventory and sell-order delete triggers in separate committed statements and enables them only after deletion. A query failure or terminated seed process between the statements permanently leaves a protection disabled; the finally block only closes the pool. This is relevant to local fixtures and to the explicitly allowed destructive seed path. **Evidence:** reproduction installed a synthetic failing inventory DELETE trigger, ran the real seed script on the private worker database, observed its nonzero exit, and read `inventory_events_no_delete.tgenabled = 'D'`. **Remediation:** perform each disable/delete/re-enable sequence in one SQL transaction (DDL is transactional), ideally make the whole replacement seed atomic; do not rely only on finally, which cannot handle process death. **Regression:** injected deletion failure and interrupted seed roll back trigger changes and preserve prior data; successful reseeding still produces append-only tables.

- [ ] **SUP-05 · P3 · Make the shared XLSX sheet-name allocator match Excel's collision rules.** `apps/backend/src/lib/xlsx.ts:34–44`. Suffixing a duplicate 31-character name is truncated back to the same name; the map is case-sensitive; generated suffixes are not reserved. The helper therefore throws for duplicate maximum-length names, RAM/ram, and A/A/A 2 despite promising collision handling. **Evidence:** all three direct builder reproductions threw. Current inventory/PO callers use fixed distinct category names, so this is a confirmed helper defect with limited present user impact, not a demonstrated ordinary export outage. **Remediation:** allocate a case-insensitive unique name, reserve suffix length before truncation, and reserve every final name; reuse the safer `packTabName` allocator. **Regression:** these collision inputs create valid workbooks whose tabs are unique case-insensitively; sanitize edge apostrophes too.

## Assessment and validation

The migration runner uses a ledger, one transaction per migration, advisory serialization and bounded lock retries. Test templates invoke that real runner, which avoids accepting migrations tests replay differently from production. The domain helpers generally centralize pure spreadsheet folding, price parsing, integer-cent proration and review findings. Supplier handover mutations need a shared authorization/locking boundary; package conversion needs the centralized SQL name key. Fixture reset should use transactional trigger changes.

Seven temporary reproduction cases passed against the parent's disposable PostgreSQL 18 instance: Unicode misattribution, post-limit filtering, former-owner write race, three XLSX name collisions and seed failure. The preserved [supporting-domain-repro.test.ts](supporting-domain-repro.test.ts) intentionally asserts defective behavior. Replay from the repository root by copying it to `apps/backend/tests/review-support-repro.test.ts`, setting TEST_DATABASE_URL to a disposable local database and VITEST_MAX_FORKS=1, then running `pnpm --filter recycle-erp-backend exec vitest run tests/review-support-repro.test.ts`; remove the copied file afterward. The usual harness creates and drops private per-run worker databases; do not use an important database server. No real users or external providers were modified.

The first reproduction run had one fixture setup error (an uppercase package source not allowed by the schema); after fixing the synthetic fixture the complete run passed 7/7 in 12.20 seconds. The existing whole backend suite is reported by the parent; it was not rerun here.

## Explicit coverage

**Full tier:** read all runtime/schema logic in every file listed below, including all 172 migrations currently on disk (0001 through 0174, with existing gaps). SQL was inspected for FK/check/trigger behavior, destructive backfills and ordering; migration success is additionally covered by test-template builds. Scripts, the listed supporting routes/services/helpers, all test harness helpers and Vitest config were read in full.

**Generated/static fixture tier:** literal catalog/die-code rows embedded in migrations and deterministic seed fixtures were read and checked for schema/ordering implications. Manufacturer accuracy, historical one-off operational backfill targets and realism of randomized business data were not independently researched. That is distinct from reviewing the executable SQL/generator code fully.

**Broad tier/context only:** existing supplier/package/market/price-import/AI-review/migration tests were located/inspected as supporting context; this is not a claim to have read all 223 backend test files. `routes/sellOrders.ts:1100–1175` was inspected specifically for SEC-15; the domain reviewer owns full-file coverage. Earlier review documents provided context only.

**Delegated assigned scope, completed by domain reviewer:** routes customers/categories/itemTypes/lookups/fxRates/dashboard/activity/notifications/tracker/shippoWebhook/internalTx plus bankTx reads/matches/statistics/rules. See [backend-domain-coverage.md](backend-domain-coverage.md). Parent covered provider/bootstrap/deployment/config files. **Missing assigned files: none.** The broader repository union must include those other reviewers' manifests, rather than interpreting this list alone as whole-repository coverage.

Full tier source/config/harness:
```text
apps/backend/scripts/migrate.mjs
apps/backend/scripts/init-admin.mjs
apps/backend/scripts/seed.mjs
apps/backend/scripts/load-env.mjs
apps/backend/scripts/pg-retry.mjs
apps/backend/src/lib/dbTarget.ts
apps/backend/src/lib/categoryColumns.ts
apps/backend/src/lib/xlsx.ts
apps/backend/src/lib/sellOrderPriceTemplate.ts
apps/backend/src/services/poAiReview.ts
apps/backend/src/services/poReviewChecks.ts
apps/backend/src/services/sellOrderNumbers.ts
apps/backend/src/services/sellOrderPriceImport.ts
apps/backend/src/services/sellOrderPriceAdjust.ts
apps/backend/src/routes/suppliers.ts
apps/backend/src/routes/warehouses.ts
apps/backend/src/routes/packages.ts
apps/backend/src/routes/market.ts
apps/backend/vitest.config.ts
apps/backend/tests/helpers/global-setup.ts
apps/backend/tests/helpers/db.ts
apps/backend/tests/helpers/setup.ts
apps/backend/tests/helpers/pg-urls.ts
apps/backend/tests/helpers/app.ts
apps/backend/tests/helpers/auth.ts
apps/backend/tests/helpers/bankProvider.ts
apps/backend/tests/helpers/fx.ts
apps/backend/tests/helpers/inventory.ts
apps/backend/tests/helpers/sellOrderEvents.ts
apps/backend/tests/helpers/fixtures.ts
```

Full executable-schema tier; embedded lookup/history payloads receive the fixture qualification above:
```text
apps/backend/migrations/0001_init.sql
apps/backend/migrations/0002_desktop.sql
apps/backend/migrations/0003_sell_order_status_meta.sql
apps/backend/migrations/0004_ref_prices_rank.sql
apps/backend/migrations/0005_ref_prices_rank_backfill.sql
apps/backend/migrations/0006_lookup_tables.sql
apps/backend/migrations/0007_disk_health_and_hdd.sql
apps/backend/migrations/0008_user_preferences.sql
apps/backend/migrations/0009_warehouse_details.sql
apps/backend/migrations/0010_inventory_transfer.sql
apps/backend/migrations/0011_fix_lifecycle_default.sql
apps/backend/migrations/0012_audit_lock.sql
apps/backend/migrations/0013_categories.sql
apps/backend/migrations/0014_attachments.sql
apps/backend/migrations/0015_commission.sql
apps/backend/migrations/0016_workspace_settings.sql
apps/backend/migrations/0017_indexes_pagination.sql
apps/backend/migrations/0018_customer_contact_address.sql
apps/backend/migrations/0019_drop_workflow_stages.sql
apps/backend/migrations/0020_warehouse_active.sql
apps/backend/migrations/0021_warehouse_manager_fk.sql
apps/backend/migrations/0022_warehouse_drop_cutoff_sqft.sql
apps/backend/migrations/0023_commission_rate_settings.sql
apps/backend/migrations/0024_category_default_margin_setting.sql
apps/backend/migrations/0025_threshold_settings.sql
apps/backend/migrations/0026_users_last_seen.sql
apps/backend/migrations/0027_ram_type_generation.sql
apps/backend/migrations/0028_transfer_orders.sql
apps/backend/migrations/0029_id_counters.sql
apps/backend/migrations/0030_per_order_commission_rate.sql
apps/backend/migrations/0031_backfill_ram_generation.sql
apps/backend/migrations/0032_login_attempts.sql
apps/backend/migrations/0033_vendor_bidding.sql
apps/backend/migrations/0034_refresh_tokens.sql
apps/backend/migrations/0035_fk_indexes.sql
apps/backend/migrations/0036_drop_sell_orders_discount_pct.sql
apps/backend/migrations/0037_order_events.sql
apps/backend/migrations/0038_audit_trigger_cascade.sql
apps/backend/migrations/0039_vendor_bid_decline_reason.sql
apps/backend/migrations/0040_perf_indexes.sql
apps/backend/migrations/0041_fk_on_delete.sql
apps/backend/migrations/0042_metrics_role.sql
apps/backend/migrations/0043_ram_rank_options.sql
apps/backend/migrations/0044_rename_so_to_po.sql
apps/backend/migrations/0045_orders_archived_at.sql
apps/backend/migrations/0046_oauth.sql
apps/backend/migrations/0047_oauth_pending_consent.sql
apps/backend/migrations/0048_oauth_refresh_tokens_created_at.sql
apps/backend/migrations/0049_sell_orders_archived_at.sql
apps/backend/migrations/0050_sell_order_events.sql
apps/backend/migrations/0051_ref_prices_nullable.sql
apps/backend/migrations/0052_ref_prices_manual_overrides.sql
apps/backend/migrations/0053_sell_order_close.sql
apps/backend/migrations/0054_sell_order_status_meta_closed.sql
apps/backend/migrations/0055_rename_sl_to_so.sql
apps/backend/migrations/0056_multi_currency.sql
apps/backend/migrations/0057_sell_order_close_reasons_to_check.sql
apps/backend/migrations/0058_ram_speed_options.sql
apps/backend/migrations/0059_ram_speed_3600.sql
apps/backend/migrations/0060_seed_missing_catalogs.sql
apps/backend/migrations/0061_label_scans_cf_image_idx.sql
apps/backend/migrations/0062_ssd_brand_mixed.sql
apps/backend/migrations/0063_order_line_serial_number.sql
apps/backend/migrations/0064_vendor_link_optional_customer.sql
apps/backend/migrations/0065_sell_order_currency.sql
apps/backend/migrations/0066_seed_sell_order_statuses.sql
apps/backend/migrations/0067_mcp_sell_order_customer.sql
apps/backend/migrations/0068_order_status_meta.sql
apps/backend/migrations/0069_status_meta_submission.sql
apps/backend/migrations/0070_order_line_chip_number.sql
apps/backend/migrations/0071_ssd_cap_options.sql
apps/backend/migrations/0072_restore_ssd_cap_480.sql
apps/backend/migrations/0073_ssd_cap_sort.sql
apps/backend/migrations/0074_so_payment_received_by.sql
apps/backend/migrations/0075_so_price_adjustment.sql
apps/backend/migrations/0076_backfill_order_created_events.sql
apps/backend/migrations/0077_upload_allowed_mime_spreadsheets.sql
apps/backend/migrations/0078_ssd_cap_1tb.sql
apps/backend/migrations/0079_activity_feed_indexes.sql
apps/backend/migrations/0080_order_other_fees.sql
apps/backend/migrations/0081_oauth_dcr_throttle.sql
apps/backend/migrations/0082_item_types.sql
apps/backend/migrations/0083_order_lines_category_order_idx.sql
apps/backend/migrations/0084_order_line_photos.sql
apps/backend/migrations/0085_ref_prices_canon_part_idx.sql
apps/backend/migrations/0086_sell_price_zero_to_null.sql
apps/backend/migrations/0087_sell_price_positive_check.sql
apps/backend/migrations/0088_order_lines_qty_purchased.sql
apps/backend/migrations/0089_ref_prices_canon_part_idx_delimiter.sql
apps/backend/migrations/0090_backfill_other_item_type.sql
apps/backend/migrations/0091_warehouse_ship_address.sql
apps/backend/migrations/0092_shipments.sql
apps/backend/migrations/0093_shipments_seller_fill.sql
apps/backend/migrations/0094_packages.sql
apps/backend/migrations/0095_shipment_quotes.sql
apps/backend/migrations/0096_chip_number_upper.sql
apps/backend/migrations/0097_user_default_warehouse.sql
apps/backend/migrations/0098_shipments_keyset_and_quote_backfill.sql
apps/backend/migrations/0099_paypal_txn.sql
apps/backend/migrations/0100_bank_transactions.sql
apps/backend/migrations/0101_bank_txn_category.sql
apps/backend/migrations/0102_bank_transfer_rules.sql
apps/backend/migrations/0103_ssd_ai_capture.sql
apps/backend/migrations/0104_bank_txn_transfer_backfill.sql
apps/backend/migrations/0105_match_indexes.sql
apps/backend/migrations/0106_package_source.sql
apps/backend/migrations/0107_match_indexes_sargable.sql
apps/backend/migrations/0108_package_tracking_registered.sql
apps/backend/migrations/0109_warehouse_address_from_ship.sql
apps/backend/migrations/0110_merge_separator_duplicate_parts.sql
apps/backend/migrations/0111_ref_prices_canon_part_idx_separators.sql
apps/backend/migrations/0112_merge_duplicate_parts_per_category.sql
apps/backend/migrations/0113_suppliers.sql
apps/backend/migrations/0114_suppliers_backfill.sql
apps/backend/migrations/0115_po_company_txn_cutoff.sql
apps/backend/migrations/0116_internal_transactions.sql
apps/backend/migrations/0118_bank_txn_disputes.sql
apps/backend/migrations/0119_bank_txn_settlement.sql
apps/backend/migrations/0120_bank_txn_note.sql
apps/backend/migrations/0121_archived_po_lines.sql
apps/backend/migrations/0122_archived_lines_on_pending_transfer.sql
apps/backend/migrations/0123_bank_txn_note_across_pair.sql
apps/backend/migrations/0124_archived_po_lines_on_open_sell_orders.sql
apps/backend/migrations/0125_ram_rank_3ds_options.sql
apps/backend/migrations/0126_po_handoff.sql
apps/backend/migrations/0127_sell_order_lines_inventory_set_null.sql
apps/backend/migrations/0128_po_cash_shot_rule.sql
apps/backend/migrations/0129_po_commission_payment.sql
apps/backend/migrations/0130_po_sold_lifecycle.sql
apps/backend/migrations/0131_po_commission_payment_screenshot_only.sql
apps/backend/migrations/0132_po_commission_rate_default.sql
apps/backend/migrations/0134_mercury_credit_backfill.sql
apps/backend/migrations/0135_bank_ignore_rules.sql
apps/backend/migrations/0136_ignore_unlinked_before_aug_2026.sql
apps/backend/migrations/0137_purchaser_home_warehouses.sql
apps/backend/migrations/0138_web_submissions.sql
apps/backend/migrations/0139_order_box_checks.sql
apps/backend/migrations/0140_box_check_sent_at.sql
apps/backend/migrations/0141_metrics_role_nologin.sql
apps/backend/migrations/0142_drop_vendor_portal_and_attachments.sql
apps/backend/migrations/0143_orders_payment_check.sql
apps/backend/migrations/0144_users_tokens_valid_after.sql
apps/backend/migrations/0145_packages_tracking_status_at.sql
apps/backend/migrations/0146_bank_account_sync_health.sql
apps/backend/migrations/0147_login_attempts_reservations.sql
apps/backend/migrations/0148_po_1339_total_follows_lines.sql
apps/backend/migrations/0149_line_cost_and_total_checks.sql
apps/backend/migrations/0150_sell_orders_done_at.sql
apps/backend/migrations/0151_supplier_name_key.sql
apps/backend/migrations/0152_pair_po_1383_legs.sql
apps/backend/migrations/0153_bank_transactions_currency.sql
apps/backend/migrations/0154_supplier_name_key_unicode.sql
apps/backend/migrations/0155_ip_key_columns.sql
apps/backend/migrations/0156_order_manager.sql
apps/backend/migrations/0157_web_submission_messages.sql
apps/backend/migrations/0158_order_manager_backfill_past_review.sql
apps/backend/migrations/0159_ssd_cap_2tb_ram_class_camm.sql
apps/backend/migrations/0160_order_lines_qty_allow_zero.sql
apps/backend/migrations/0161_po_1483_restore_removed_lines.sql
apps/backend/migrations/0162_order_commission_paid_by.sql
apps/backend/migrations/0163_sell_order_packs.sql
apps/backend/migrations/0164_sell_order_lines_qty_allow_zero.sql
apps/backend/migrations/0165_sell_order_signoffs.sql
apps/backend/migrations/0166_sell_order_packing.sql
apps/backend/migrations/0167_micron_chip_die_code.sql
apps/backend/migrations/0168_micron_chip_die_lookup.sql
apps/backend/migrations/0169_order_line_product_no.sql
apps/backend/migrations/0170_sell_order_line_product_no.sql
apps/backend/migrations/0171_ssd_form_3_5.sql
apps/backend/migrations/0172_po_ai_review.sql
apps/backend/migrations/0173_po_sold_is_a_flag.sql
apps/backend/migrations/0174_orders_sold_lands_as_done.sql
```

## Unverified concerns kept outside TODOs

- `apps/backend/scripts/init-admin.mjs:50–66` uses check-then-insert without an atomic conflict clause; simultaneous first boots may fail one provisioner on the unique email index. No subprocess race reproduction was run, and restart should subsequently find the account.
- `tests/helpers/global-setup.ts:44–45` and `db.ts:28–38` sanitize but do not bound generated database identifiers to PostgreSQL's 63-byte limit despite a contrary comment. Long configured base database names may collapse worker/template/building names or leak teardown databases. Ordinary configured names passed the harness; long-name behavior was not exercised.
- AI review Budget reserves using observed cost estimates, not known provider prices. A call can exceed that estimate, especially the first call. No actual provider overspend or product promise of a strict billing ceiling was established; no external calls were made.

