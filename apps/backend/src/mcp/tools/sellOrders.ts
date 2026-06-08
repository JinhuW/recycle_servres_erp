import type postgres from 'postgres';
import { inventoryLabel, inventorySpec, type InventoryAttrs } from '../../lib/inventoryLabel';

export const SELL_ORDER_TOOL_DEFS = [
  {
    name: 'search_sellable_inventory',
    description:
      'Read-only. List inventory lines that can currently be put on a sell order — status Reviewing or Done and ' +
      'not already committed to an open sell order — newest first. Use this to find the inventoryId values that ' +
      'create_sell_order_draft requires. Each row includes: inventoryId (pass this to create_sell_order_draft), ' +
      'category, label and subLabel (the display name the draft will store), partNumber, condition, warehouseId ' +
      'and warehouseName, availableQty (the full sellable quantity of the line), and sellPrice (the price already ' +
      'assigned to the line, in USD — advisory; you still choose each line\'s unitPrice). Filter with query ' +
      '(matches brand / part number / description / category) and warehouseId. Requires the sellorder:read scope.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'case-insensitive match against brand, part number, description, category' },
        warehouseId: { type: 'string', description: 'optional warehouse id filter (e.g. "WH-LA1")' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'max rows to return (1-100, default 20)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_sell_order_draft',
    description:
      'Write. Create a Draft sell order from inventory lines. Every line MUST reference a real sellable line by ' +
      'inventoryId (get them from search_sellable_inventory) plus a qty (>0) and unitPrice (>=0, in the order ' +
      'currency). Descriptive fields (category, label, part number, warehouse, condition) are taken from the ' +
      'referenced inventory line — do not supply them. customerId defaults to the MCP customer when omitted. ' +
      'currency is USD (default) or CNY; unitPrice is the native price and is converted to USD on store. On ' +
      'success returns { id, status, customerId, lineCount, currency }. Errors (insufficient stock, an ' +
      'inventoryId that is unknown or already on an open sell order, an unknown customerId) are returned as the ' +
      'JSON-RPC error message. Requires the sellorder:write scope (a sellorder:read-only token is rejected).',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string', description: 'customer UUID; defaults to the MCP customer if omitted' },
        currency: { type: 'string', enum: ['USD', 'CNY'], default: 'USD', description: 'order currency (default USD)' },
        notes: { type: 'string', maxLength: 2000, description: 'optional order-level note' },
        lines: {
          type: 'array',
          minItems: 1,
          description: 'at least one line; each references a sellable inventory line',
          items: {
            type: 'object',
            properties: {
              inventoryId: { type: 'string', description: 'id from search_sellable_inventory' },
              qty: { type: 'integer', minimum: 1, description: 'quantity to sell (>0, <= availableQty)' },
              unitPrice: { type: 'number', minimum: 0, description: 'price per unit in the order currency (>=0)' },
            },
            required: ['inventoryId', 'qty', 'unitPrice'],
            additionalProperties: false,
          },
        },
      },
      required: ['lines'],
      additionalProperties: false,
    },
  },
] as const;

type SellableRow = InventoryAttrs & {
  id: string;
  part_number: string | null;
  qty: number;
  sell_price: number | null;
  warehouse_id: string | null;
  warehouse_short: string | null;
};

export async function callSearchSellableInventory(
  sql: postgres.Sql,
  args: { query?: string; warehouseId?: string; limit?: number },
) {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const q = args.query?.toLowerCase().trim() || null;
  const wh = args.warehouseId?.trim() || null;
  const rows = await sql<SellableRow[]>`
    SELECT l.id, l.category, l.brand, l.capacity, l.generation, l.type,
           l.classification, l.rank, l.speed, l.interface, l.form_factor,
           l.description, l.part_number, l.condition, l.qty,
           l.sell_price::float AS sell_price,
           l.health::float AS health, l.rpm,
           COALESCE(l.warehouse_id, o.warehouse_id) AS warehouse_id,
           w.short AS warehouse_short
    FROM order_lines l
    JOIN orders o ON o.id = l.order_id
    LEFT JOIN warehouses w ON w.id = COALESCE(l.warehouse_id, o.warehouse_id)
    WHERE l.status IN ('Reviewing', 'Done')
      AND NOT EXISTS (
        SELECT 1 FROM sell_order_lines sol
        JOIN sell_orders so ON so.id = sol.sell_order_id
        WHERE sol.inventory_id = l.id AND so.status NOT IN ('Done', 'Closed')
      )
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
  }));
}

// callCreateSellOrderDraft is implemented in the next task.
export async function callCreateSellOrderDraft(
  _sql: postgres.Sql,
  _args: unknown,
  _ctx: { source: string; actorUserId: string | null },
): Promise<unknown> {
  throw new Error('not implemented');
}
