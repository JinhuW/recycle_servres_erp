import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';

// Unindexed FK / join columns force sequential scans on parent deletes and on
// the sell-order ↔ inventory joins (validateSellLines, the committed-line
// guard, reopen, transfer-orders list). These must have btree indexes.
describe('FK / join column indexes', () => {
  beforeAll(async () => { await resetDb(); });

  it('btree indexes exist on the hot FK/join columns', async () => {
    const db = getTestDb();
    const rows = await db<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `;
    const have = new Set(rows.map(r => r.indexname));
    for (const idx of [
      'sell_orders_created_by_idx',
      'sell_order_lines_inventory_idx',
      'transfer_orders_created_by_idx',
      'transfer_orders_received_by_idx',
      'order_lines_scan_image_idx',
      'order_lines_category_order_idx',
      'order_line_photos_line_idx',
      'order_line_photos_order_idx',
      'order_line_photos_uploaded_by_idx',
      'packages_order_id_idx',
      'packages_created_by_idx',
      'shipments_created_at_id_idx',
      'fb_pool_accounts_holder_user_id_idx',
      'fb_pool_accounts_created_by_idx',
      'fb_pool_events_actor_id_idx',
      'accounting_entries_manager_book_idx',
      'accounting_entries_order_id_idx',
      'accounting_entries_sell_order_id_idx',
      'accounting_entries_after_sales_id_idx',
      'accounting_entries_created_by_idx',
      'accounting_entries_voided_by_idx',
      'accounting_entry_events_entry_idx',
      'accounting_entry_events_actor_id_idx',
    ]) {
      expect(have.has(idx), `missing index ${idx}`).toBe(true);
    }
  });
});
