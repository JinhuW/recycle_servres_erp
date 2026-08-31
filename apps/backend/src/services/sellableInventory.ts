import type postgres from 'postgres';
import { inventoryLabel, inventorySpec, type InventoryAttrs } from '../lib/inventoryLabel';
import { committedSellStatuses } from '../lib/sellCommitment';

// Inventory lines that can currently be placed on a sell order: status
// Reviewing or Done with units left over after every committed sell order
// (COMMITTED_SELL_STATUSES) takes the quantity it named. A commitment reserves
// units, not the lot: 20 sold out of 100 leaves 80 here, and `availableQty`
// reports the remainder rather than the purchased quantity.
// Lines merely sitting on a rival *draft* are still
// listed at full remaining qty — drafts are proposals, several may name the
// same line — with `draftCount` reporting the contention so the caller can
// flag it. Shared by
// the search_sellable_inventory MCP tool and the GET /sell-orders/sellable
// REST endpoint (the desktop "add inventory to an order" picker) so both run
// the exact same sellability rule — keep the predicate here, not duplicated.

export type SellableItem = {
  inventoryId: string;
  category: string;
  label: string;
  subLabel: string | null;
  partNumber: string | null;
  condition: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  availableQty: number;
  sellPrice: number | null;
  draftCount: number;
};

type SellableRow = InventoryAttrs & {
  id: string;
  part_number: string | null;
  qty: number;
  sell_price: number | null;
  warehouse_id: string | null;
  warehouse_short: string | null;
  draft_count: number;
};

export async function searchSellableInventory(
  sql: postgres.Sql,
  opts: { query?: string | null; warehouseId?: string | null; limit?: number },
): Promise<SellableItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const q = opts.query?.toLowerCase().trim() || null;
  const wh = opts.warehouseId?.trim() || null;
  const rows = await sql<SellableRow[]>`
    SELECT l.id, l.category, l.brand, l.capacity, l.generation, l.type,
           l.classification, l.rank, l.speed, l.interface, l.form_factor,
           l.description, l.part_number, l.condition,
           (l.qty - committed.qty) AS qty,
           l.sell_price::float AS sell_price,
           l.health::float AS health, l.rpm,
           COALESCE(l.warehouse_id, o.warehouse_id) AS warehouse_id,
           w.short AS warehouse_short,
           (SELECT COUNT(DISTINCT sol.sell_order_id)::int
              FROM sell_order_lines sol
              JOIN sell_orders so ON so.id = sol.sell_order_id
             WHERE sol.inventory_id = l.id AND so.status = 'Draft') AS draft_count
    FROM order_lines l
    JOIN orders o ON o.id = l.order_id
    LEFT JOIN warehouses w ON w.id = COALESCE(l.warehouse_id, o.warehouse_id)
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(sol.qty), 0)::int AS qty
        FROM sell_order_lines sol
        JOIN sell_orders so ON so.id = sol.sell_order_id
       WHERE sol.inventory_id = l.id
         AND so.status = ANY(${committedSellStatuses()}::text[])
    ) committed
    WHERE l.status IN ('Reviewing', 'Done')
      AND l.qty > committed.qty
      AND (${q}::text IS NULL
           OR LOWER(COALESCE(l.brand,'')) LIKE '%' || ${q ?? ''} || '%'
           OR LOWER(COALESCE(l.part_number,'')) LIKE '%' || ${q ?? ''} || '%'
           OR LOWER(COALESCE(l.description,'')) LIKE '%' || ${q ?? ''} || '%'
           OR LOWER(l.category) LIKE '%' || ${q ?? ''} || '%')
      AND (${wh}::text IS NULL OR COALESCE(l.warehouse_id, o.warehouse_id) = ${wh})
    ORDER BY l.created_at DESC
    LIMIT ${limit}
  `;
  return rows.map(r => ({
    inventoryId: r.id,
    category: r.category,
    label: inventoryLabel(r) || r.id.slice(0, 8),
    subLabel: inventorySpec(r),
    partNumber: r.part_number,
    condition: r.condition,
    warehouseId: r.warehouse_id,
    warehouseName: r.warehouse_short,
    availableQty: r.qty,
    sellPrice: r.sell_price,
    draftCount: r.draft_count,
  }));
}
