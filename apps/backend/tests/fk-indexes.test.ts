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
    ]) {
      expect(have.has(idx), `missing index ${idx}`).toBe(true);
    }
  });
});
