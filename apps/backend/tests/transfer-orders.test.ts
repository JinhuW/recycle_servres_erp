import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';

describe('migration 0028 — transfer_orders schema', () => {
  beforeEach(async () => { await resetDb(); });

  it('creates transfer_orders and order_lines.transfer_order_id', async () => {
    const db = getTestDb();
    const t = await db`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'transfer_orders' AND table_schema = 'public' ORDER BY column_name
    `;
    const cols = t.map((r: { column_name: string }) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'from_warehouse_id', 'to_warehouse_id', 'note',
      'created_by', 'created_at', 'status', 'received_at', 'received_by',
    ]));
    const ol = await db`
      SELECT 1 AS ok FROM information_schema.columns
      WHERE table_name = 'order_lines' AND column_name = 'transfer_order_id' AND table_schema = 'public'
    `;
    expect(ol.length).toBe(1);
  });
});
