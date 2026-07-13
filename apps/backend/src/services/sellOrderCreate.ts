import type postgres from 'postgres';
import type { Sql } from 'postgres';
import { nextHumanId } from '../lib/id-seq';
import { writeSellOrderEvent } from './sellOrderAudit';
import {
  convertToUsd, getLatestRateToUsd, type SupportedCurrency,
} from '../lib/fx';

export type SellLine = { inventoryId?: string | null; qty: number };

// Validate every inventory-backed line of a sell order. MUST run inside the
// caller's transaction: each source row is locked FOR UPDATE so a concurrent
// sell order cannot pass the same qty/sellability check and oversell (TOCTOU).
// Also enforces the one-active-sell-order-per-line invariant. `excludeOrderId`
// is the sell order being edited (so a PATCH may keep its own already-committed
// lines); null for a brand-new order. Returns a human error string, or null
// when every line is sellable.
export async function validateSellLines(
  tx: postgres.TransactionSql,
  lines: SellLine[],
  excludeOrderId: string | null,
): Promise<string | null> {
  const demand = new Map<string, number>();
  for (const l of lines) {
    if (!l.inventoryId) continue; // manual line — nothing to reserve
    demand.set(l.inventoryId, (demand.get(l.inventoryId) ?? 0) + l.qty);
  }
  for (const [inventoryId, qty] of demand) {
    const inv = (await tx<{ qty: number; status: string }[]>`
      SELECT qty, status FROM order_lines WHERE id = ${inventoryId} LIMIT 1 FOR UPDATE
    `)[0];
    if (!inv) return `inventory line ${inventoryId} not found`;
    if (inv.status !== 'Reviewing' && inv.status !== 'Done')
      return `inventory line not sellable (status=${inv.status})`;
    if (qty > inv.qty) return `qty ${qty} exceeds inventory available ${inv.qty}`;
    const conflict = (await tx<{ so_id: string; label: string; part_number: string | null }[]>`
      SELECT so.id AS so_id, sol.label, sol.part_number
      FROM sell_order_lines sol
      JOIN sell_orders so ON so.id = sol.sell_order_id
      WHERE sol.inventory_id = ${inventoryId}
        AND so.status NOT IN ('Done', 'Closed')
        AND (${excludeOrderId}::text IS NULL OR so.id <> ${excludeOrderId}::text)
      LIMIT 1
    `)[0];
    if (conflict) {
      const name = conflict.part_number
        ? `${conflict.label} (${conflict.part_number})`
        : conflict.label;
      return `${name} is already on sell order ${conflict.so_id}`;
    }
  }
  return null;
}

export type DraftLineInput = {
  inventoryId?: string | null;
  category: string;
  label: string;
  subLabel?: string | null;
  partNumber?: string | null;
  qty: number;
  unitPrice: number;            // NATIVE currency
  warehouseId?: string | null;
  condition?: string | null;
};

export type CreateDraftInput = {
  customerId: string;
  currency: SupportedCurrency;
  notes?: string | null;
  paymentReceivedBy?: string | null;
  lines: DraftLineInput[];
  actorUserId: string | null;   // null for client_credentials MCP clients
  source: string;               // 'manager' | `mcp:<clientId>`
};

export type CreateDraftResult =
  | { ok: true; id: string; customerId: string; lineCount: number; currency: SupportedCurrency }
  | { ok: false; error: string };

// Shared draft-creation path used by POST /api/sell-orders and the
// create_sell_order_draft MCP tool. Resolves the FX snapshot BEFORE opening the
// transaction (getLatestRateToUsd may do an outbound fetch on a cold cache;
// holding the id-counter + inventory locks across it would serialize all
// sell-order creation). Allocates the id, lock-validates lines, inserts the
// header + lines + a 'created' audit event, all atomically.
export async function createSellOrderDraft(
  sql: Sql,
  input: CreateDraftInput,
): Promise<CreateDraftResult> {
  const isNonUsd = input.currency !== 'USD';
  const fx = await getLatestRateToUsd(sql, input.currency);

  let nextId!: string;
  let outcome: CreateDraftResult = { ok: true, id: '', customerId: input.customerId, lineCount: input.lines.length, currency: input.currency };

  await sql.begin(async (tx) => {
    nextId = await nextHumanId(tx, 'SO', 'SO');
    const err = await validateSellLines(tx, input.lines, null);
    if (err) { outcome = { ok: false, error: err }; return; } // roll back — nothing written
    await tx`
      INSERT INTO sell_orders (id, customer_id, status, notes, created_by,
                               payment_received_by, currency_code, fx_rate_to_usd, fx_source)
      VALUES (${nextId}, ${input.customerId}, 'Draft', ${input.notes ?? null}, ${input.actorUserId},
              ${input.paymentReceivedBy ?? null}, ${input.currency}, ${fx.rate}, ${fx.source})
    `;
    for (let i = 0; i < input.lines.length; i++) {
      const l = input.lines[i];
      const unitPriceUsd = isNonUsd ? convertToUsd(l.unitPrice, fx.rate) : l.unitPrice;
      await tx`
        INSERT INTO sell_order_lines
          (sell_order_id, inventory_id, category, label, sub_label, part_number,
           qty, unit_price, warehouse_id, condition, position,
           source_currency, source_unit_price, source_fx_rate_to_usd)
        VALUES
          (${nextId}, ${l.inventoryId ?? null}, ${l.category}, ${l.label},
           ${l.subLabel ?? null}, ${l.partNumber ?? null},
           ${l.qty}, ${unitPriceUsd},
           ${l.warehouseId ?? null}, ${l.condition ?? null}, ${i},
           ${isNonUsd ? input.currency : null},
           ${isNonUsd ? l.unitPrice : null},
           ${isNonUsd ? fx.rate : null})
      `;
    }
    await writeSellOrderEvent(tx, nextId, input.actorUserId, 'created', {
      source: input.source,
      status: 'Draft',
      lineCount: input.lines.length,
      customerId: input.customerId,
      currency: input.currency,
      fxRateToUsd: fx.rate,
      fxSource: fx.source,
    });
  });

  if (!outcome.ok) return outcome;
  return { ok: true, id: nextId, customerId: input.customerId, lineCount: input.lines.length, currency: input.currency };
}
