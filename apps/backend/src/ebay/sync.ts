// Pulls the connected account's eBay orders and turns the ones that belong to
// the desk's listings into Detected sales for the operator to confirm. It
// never confirms anything and never raises a sell order: that stays a
// person's call (routes/ebay.ts → confirmSaleTx).
//
// One run is one transaction under an advisory lock, so the interval and a
// manager's "Sync now" (or a second instance) never run side by side: the
// orders are read, the sales written and the cursor advanced together, and a
// failed run leaves the cursor where it was for a clean retry.

import { getDb, type SqlLike } from '../db';
import { log } from '../lib/log';
import type { Env } from '../types';
import { ebayConfigured } from './config';
import { allowSlowEbayTx, ebayFailure, isUnavailable, openEbay } from './connection';
import { matchOrders, type ListingLookup, type SaleCandidate } from './match';
import type { FetchFn } from './oauth';

const ebayLog = log.child({ module: 'ebay-sync' });

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SYNC_INTERVAL_MS = 10 * MINUTE_MS;
// eBay stamps lastModifiedDate on its side; an order modified just before a
// run can surface in the API a little later, so each run re-reads this much
// behind its cursor. The unique (order, line item) key makes the re-read free.
const OVERLAP_MS = 60 * MINUTE_MS;
// How far back the first run after connecting looks.
const FIRST_RUN_LOOKBACK_MS = 30 * DAY_MS;
// A listing that sold out or ended this recently can still receive an order
// (bought just before it came down), so the sync still matches against it.
const RECENT_LISTING_MS = 60 * DAY_MS;
const MAX_FLAGS = 50;
export const EBAY_SYNC_LOCK = 'ebay-sync';

/** A sale already confirmed whose eBay order was cancelled since: a manager decides what to undo. */
export type SyncFlag = {
  saleId: string; listingId: string; ebayOrderId: string; sellOrderId: string | null;
  reason: 'cancelled_after_confirm'; seenAt: string;
};

export type EbaySyncResult = {
  skipped?: 'busy' | 'not_connected' | 'not_configured';
  from?: string;
  to?: string;
  ordersSeen: number;
  matched: number;
  newSales: number;
  updatedSales: number;
  linkedManual: number;
  dismissed: number;
  flags: SyncFlag[];
};

const empty = (skipped?: EbaySyncResult['skipped']): EbaySyncResult => ({
  ...(skipped ? { skipped } : {}),
  ordersSeen: 0, matched: 0, newSales: 0, updatedSales: 0, linkedManual: 0, dismissed: 0, flags: [],
});

async function listingLookup(tx: SqlLike, now: Date): Promise<ListingLookup> {
  const rows = await tx<{ id: string; ebay_sku: string; ebay_item_id: string | null }[]>`
    SELECT id, ebay_sku, ebay_item_id FROM ebay_listings
    WHERE status = 'Listed'
       OR (status IN ('Sold', 'Ended')
           AND COALESCE(sold_out_at, ended_at) > ${new Date(now.getTime() - RECENT_LISTING_MS)})
  `;
  return {
    bySku: new Map(rows.map((r) => [r.ebay_sku, r.id])),
    byItemId: new Map(rows.filter((r) => r.ebay_item_id).map((r) => [r.ebay_item_id!, r.id])),
  };
}

async function event(
  tx: SqlLike, listingId: string, kind: 'sale_detected' | 'sale_dismissed', note: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  await tx`
    INSERT INTO ebay_listing_events (listing_id, kind, note, detail, actor_id)
    VALUES (${listingId}, ${kind}, ${note}, ${tx.json({ ...detail, via: 'sync' } as never)}, NULL)
  `;
}

// Writes one candidate. The caller holds its listing's lock, the order
// confirmSaleTx takes them in (listing, then sale).
async function applyCandidate(tx: SqlLike, c: SaleCandidate, out: EbaySyncResult, now: Date): Promise<void> {
  const [existing] = await tx<{ id: string; status: string; sell_order_id: string | null }[]>`
    SELECT id, status, sell_order_id FROM ebay_sales
    WHERE ebay_order_id = ${c.ebayOrderId} AND ebay_line_item_id = ${c.ebayLineItemId}
    FOR UPDATE
  `;
  if (c.cancelled) {
    if (existing?.status === 'Detected') {
      await tx`UPDATE ebay_sales SET status = 'Dismissed' WHERE id = ${existing.id}`;
      await event(tx, c.listingId, 'sale_dismissed', 'cancelled on eBay',
        { saleId: existing.id, qty: c.qty, ebayOrderId: c.ebayOrderId });
      out.dismissed++;
    } else if (existing?.status === 'Confirmed') {
      out.flags.push({
        saleId: existing.id, listingId: c.listingId, ebayOrderId: c.ebayOrderId,
        sellOrderId: existing.sell_order_id, reason: 'cancelled_after_confirm', seenAt: now.toISOString(),
      });
    }
    return;
  }
  if (existing) {
    if (existing.status !== 'Detected') return;
    // Fees often appear only once the buyer has paid.
    const updated = await tx`
      UPDATE ebay_sales SET qty = ${c.qty}, unit_price = ${c.unitPrice}, fees = ${c.fees}, buyer = ${c.buyer || null}
      WHERE id = ${existing.id}
        AND (qty, unit_price, fees, buyer)
            IS DISTINCT FROM (${c.qty}::int, ${c.unitPrice}::numeric, ${c.fees}::numeric, ${c.buyer || null}::text)
    `;
    out.updatedSales += updated.count;
    return;
  }
  // The operator may have marked this sale by hand with its order number
  // before the sync saw it: that row is the sale, so it takes the line item
  // rather than a second, Detected copy being raised.
  const [manual] = await tx<{ id: string }[]>`
    SELECT id FROM ebay_sales
    WHERE listing_id = ${c.listingId} AND ebay_order_id = ${c.ebayOrderId}
      AND ebay_line_item_id IS NULL AND status <> 'Dismissed'
    ORDER BY created_at LIMIT 1 FOR UPDATE
  `;
  if (manual) {
    await tx`UPDATE ebay_sales SET ebay_line_item_id = ${c.ebayLineItemId} WHERE id = ${manual.id}`;
    out.linkedManual++;
    return;
  }
  const [inserted] = await tx<{ id: string }[]>`
    INSERT INTO ebay_sales (listing_id, qty, unit_price, fees, ebay_order_id, ebay_line_item_id, buyer, sold_at, status)
    VALUES (${c.listingId}, ${c.qty}, ${c.unitPrice}, ${c.fees}, ${c.ebayOrderId}, ${c.ebayLineItemId},
            ${c.buyer || null}, ${c.soldAt}, 'Detected')
    ON CONFLICT (ebay_order_id, ebay_line_item_id) WHERE ebay_line_item_id IS NOT NULL DO NOTHING
    RETURNING id
  `;
  if (!inserted) return;
  await event(tx, c.listingId, 'sale_detected', null, {
    saleId: inserted.id, qty: c.qty, unitPrice: c.unitPrice, ebayOrderId: c.ebayOrderId,
  });
  out.newSales++;
}

/**
 * Flags from earlier runs whose sale is still Confirmed stay on the card
 * until a manager deals with it (closing the sell order dismisses the sale).
 */
async function carriedFlags(tx: SqlLike, previous: unknown): Promise<SyncFlag[]> {
  const prev = (previous as { flags?: SyncFlag[] } | null)?.flags ?? [];
  if (!prev.length) return [];
  const still = await tx<{ id: string }[]>`
    SELECT id FROM ebay_sales WHERE id = ANY(${prev.map((f) => f.saleId)}::uuid[]) AND status = 'Confirmed'
  `;
  const ids = new Set(still.map((r) => r.id));
  return prev.filter((f) => ids.has(f.saleId));
}

export type SyncOptions = { fetch?: FetchFn; now?: () => Date };

/** One sync run. Skips (without error) when another run holds the lock or nothing is connected. */
export async function syncEbayOrders(env: Env, opts: SyncOptions = {}): Promise<EbaySyncResult> {
  if (!ebayConfigured(env)) return empty('not_configured');
  const sql = getDb(env);
  const now = (opts.now ?? (() => new Date()))();
  try {
    return await sql.begin(async (tx) => {
      const [{ ok }] = await tx<{ ok: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${EBAY_SYNC_LOCK}, 0)) AS ok
      `;
      if (!ok) return empty('busy');
      const ctx = await openEbay(env, tx, opts.fetch);
      if (isUnavailable(ctx)) return empty('not_connected');
      await allowSlowEbayTx(tx);

      const out = empty();
      const base = ctx.conn.sync_cursor ?? new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS);
      const from = new Date(base.getTime() - OVERLAP_MS);
      out.from = from.toISOString();
      out.to = now.toISOString();

      const orders = [];
      for await (const o of ctx.client.iterateOrdersSince(from)) orders.push(o);
      out.ordersSeen = orders.length;
      const candidates = matchOrders(orders, await listingLookup(tx, now))
        .sort((a, b) => a.listingId.localeCompare(b.listingId)
          || a.ebayOrderId.localeCompare(b.ebayOrderId) || a.ebayLineItemId.localeCompare(b.ebayLineItemId));
      out.matched = candidates.length;

      let locked: string | null = null;
      for (const c of candidates) {
        if (c.listingId !== locked) {
          await tx`SELECT 1 FROM ebay_listings WHERE id = ${c.listingId} FOR UPDATE`;
          locked = c.listingId;
        }
        await applyCandidate(tx, c, out, now);
      }

      const seen = new Set(out.flags.map((f) => f.saleId));
      out.flags = [...out.flags, ...(await carriedFlags(tx, ctx.conn.last_result)).filter((f) => !seen.has(f.saleId))]
        .slice(0, MAX_FLAGS);
      await tx`
        UPDATE ebay_connection
           SET sync_cursor = ${now}, last_sync_at = ${now}, last_error = NULL,
               last_result = ${tx.json(out as never)}, updated_at = NOW()
         WHERE id = 1
      `;
      return out;
    });
  } catch (e) {
    // The run rolled back; the cursor stays and the card shows eBay's words.
    const message = ebayFailure(e)?.body.error ?? (e instanceof Error ? e.message : String(e));
    await sql`
      UPDATE ebay_connection SET last_sync_at = ${now}, last_error = ${message}, updated_at = NOW() WHERE id = 1
    `.catch(() => undefined);
    throw e;
  }
}

export function reportEbaySync(result: EbaySyncResult): void {
  if (result.skipped) return;
  const { flags, ...counts } = result;
  ebayLog.info('sync pass', { ...counts, flags: flags.length });
  // Carried flags were reported when first seen.
  const fresh = flags.filter((f) => f.seenAt === result.to);
  if (fresh.length) ebayLog.warn('confirmed eBay sales cancelled on eBay', { saleIds: fresh.map((f) => f.saleId) });
}

/** Every 10 minutes while eBay is configured; a run with no connection is a no-op. */
export function startEbaySyncLoop(env: Env): { stop: () => void } {
  if (!ebayConfigured(env)) return { stop: () => {} };
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      reportEbaySync(await syncEbayOrders(env));
    } catch (err) {
      ebayLog.warn('sync pass failed', { error: err instanceof Error ? err.message : String(err) });
    }
  };
  void tick();
  const handle = setInterval(tick, SYNC_INTERVAL_MS);
  handle.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}
