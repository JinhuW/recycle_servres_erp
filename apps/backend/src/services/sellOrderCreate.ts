import type postgres from 'postgres';
import type { Sql } from 'postgres';
import { nextHumanId } from '../lib/id-seq';
import { committedClaimsByLine, isSellableLineStatus } from '../lib/sellCommitment';
import { writeSellOrderEvent } from './sellOrderAudit';
import {
  convertToUsd, getLatestRateToUsd, type SupportedCurrency,
} from '../lib/fx';

export type SellLine = { inventoryId?: string | null; qty: number };

// Validate every inventory-backed line of a sell order. MUST run inside the
// caller's transaction: each source row is locked FOR UPDATE so a concurrent
// sell order cannot pass the same qty/sellability check and oversell (TOCTOU).
// `excludeOrderId` is the sell order being edited (so a PATCH may keep its own
// already-committed lines); null for a brand-new order. Returns a human error
// string, or null when every line is sellable.
//
// Also nets out the units other sell orders have already committed
// (COMMITTED_SELL_STATUSES — Draft rivals are allowed, they're only proposals).
// A commitment reserves the quantity it named, not the whole lot, so 20 sold
// out of 100 still leaves 80 for the next order; only demand past the
// remainder is refused.
export async function validateSellLines(
  tx: postgres.TransactionSql,
  lines: SellLine[],
  excludeOrderId: string | null,
): Promise<string | null> {
  const demand = new Map<string, number>();
  for (const l of lines) {
    // A manual line reserves nothing, and neither does one held at 0 — which
    // is how a line whose lot has since gone stays on the order with its #.
    if (!l.inventoryId || l.qty === 0) continue;
    demand.set(l.inventoryId, (demand.get(l.inventoryId) ?? 0) + l.qty);
  }
  if (demand.size === 0) return null;
  // One statement, in id order: two orders naming the same lines in a
  // different order would otherwise each hold one row while waiting on the
  // other's, and Postgres would abort one of them as a deadlock.
  const ids = [...demand.keys()].sort();
  const locked = await tx<{
    id: string; order_id: string; product_no: number; qty: number; status: string; archived_at: string | null;
  }[]>`
    SELECT l.id, l.order_id, l.product_no, l.qty, l.status, o.archived_at
    FROM order_lines l JOIN orders o ON o.id = l.order_id
    WHERE l.id = ANY(${ids}::uuid[])
    ORDER BY l.id
    FOR UPDATE OF l
  `;
  const byId = new Map(locked.map(r => [r.id.toLowerCase(), r]));
  // Read after the locks, so no rival can commit units in between.
  const claims = await committedClaimsByLine(tx, ids, { excludeOrderId });
  for (const [inventoryId, qty] of demand) {
    const inv = byId.get(inventoryId.toLowerCase());
    if (!inv) return `inventory line ${inventoryId} not found`;
    // Named the way the PO page and the sell order show it.
    const ref = `${inv.order_id} #${inv.product_no}`;
    if (!isSellableLineStatus(inv.status))
      return `${ref} is not sellable (status=${inv.status})`;
    if (inv.archived_at !== null) return `${ref} is on an archived order`;
    if (qty > inv.qty) return `qty ${qty} exceeds inventory available ${inv.qty} on ${ref}`;
    const claim = claims.get(inventoryId.toLowerCase());
    const remaining = inv.qty - (claim?.qty ?? 0);
    if (claim && qty > remaining) {
      const name = claim.partNumber
        ? `${claim.label} (${claim.partNumber})`
        : claim.label ?? inventoryId;
      return `qty ${qty} exceeds the ${remaining} left of ${name}`
        + ` — ${claim.qty} already committed to sell order ${claim.sellOrderId}`;
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

// One sell_order_lines INSERT, shared by createSellOrderDraft and the sell-order
// routes so the column list lives in one place. Callers pass the already
// USD-converted unit price plus the source-currency snapshot (all null for USD).
export interface SellOrderLineInsert {
  inventoryId: string | null;
  category: string;
  label: string;
  subLabel: string | null;
  partNumber: string | null;
  qty: number;
  unitPriceUsd: number;
  warehouseId: string | null;
  condition: string | null;
  position: number;
  sourceCurrency: string | null;
  sourceUnitPrice: number | null;
  sourceFxRate: number | null;
  // Which save past Draft added the line (sell_order_lines.append_batch), or
  // null for a line numbered with the order's sorted set.
  appendBatch: number | null;
}

export async function insertSellOrderLine(
  tx: postgres.TransactionSql,
  sellOrderId: string,
  line: SellOrderLineInsert,
): Promise<void> {
  await tx`
    INSERT INTO sell_order_lines
      (sell_order_id, inventory_id, category, label, sub_label, part_number,
       qty, unit_price, warehouse_id, condition, position,
       source_currency, source_unit_price, source_fx_rate_to_usd, append_batch)
    VALUES
      (${sellOrderId}, ${line.inventoryId}, ${line.category}, ${line.label},
       ${line.subLabel}, ${line.partNumber},
       ${line.qty}, ${line.unitPriceUsd},
       ${line.warehouseId}, ${line.condition}, ${line.position},
       ${line.sourceCurrency}, ${line.sourceUnitPrice}, ${line.sourceFxRate},
       ${line.appendBatch})
  `;
}

// Shared draft-creation path used by POST /api/sell-orders and the
// create_sell_order_draft MCP tool. Resolves the FX snapshot BEFORE opening the
// transaction (getLatestRateToUsd may do an outbound fetch on a cold cache;
// holding the id-counter + inventory locks across it would serialize all
// sell-order creation). Lock-validates lines, then allocates the id, inserts
// the header + lines + a 'created' audit event, all atomically.
export async function createSellOrderDraft(
  sql: Sql,
  input: CreateDraftInput,
): Promise<CreateDraftResult> {
  const isNonUsd = input.currency !== 'USD';
  const fx = await getLatestRateToUsd(sql, input.currency);

  let nextId!: string;
  let outcome: CreateDraftResult = { ok: true, id: '', customerId: input.customerId, lineCount: input.lines.length, currency: input.currency };

  await sql.begin(async (tx) => {
    // Validated before the id is drawn: returning here commits the tx, so a
    // counter bumped first would stay bumped and every refused create would
    // leave a hole in the SO numbering.
    const err = await validateSellLines(tx, input.lines, null);
    if (err) { outcome = { ok: false, error: err }; return; }
    nextId = await nextHumanId(tx, 'SO', 'SO');
    await tx`
      INSERT INTO sell_orders (id, customer_id, status, notes, created_by,
                               payment_received_by, currency_code, fx_rate_to_usd, fx_source)
      VALUES (${nextId}, ${input.customerId}, 'Draft', ${input.notes ?? null}, ${input.actorUserId},
              ${input.paymentReceivedBy ?? null}, ${input.currency}, ${fx.rate}, ${fx.source})
    `;
    for (let i = 0; i < input.lines.length; i++) {
      const l = input.lines[i];
      const unitPriceUsd = isNonUsd ? convertToUsd(l.unitPrice, fx.rate) : l.unitPrice;
      await insertSellOrderLine(tx, nextId, {
        inventoryId: l.inventoryId ?? null,
        category: l.category,
        label: l.label,
        subLabel: l.subLabel ?? null,
        partNumber: l.partNumber ?? null,
        qty: l.qty,
        unitPriceUsd,
        warehouseId: l.warehouseId ?? null,
        condition: l.condition ?? null,
        position: i,
        sourceCurrency: isNonUsd ? input.currency : null,
        sourceUnitPrice: isNonUsd ? l.unitPrice : null,
        sourceFxRate: isNonUsd ? fx.rate : null,
        appendBatch: null,
      });
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
