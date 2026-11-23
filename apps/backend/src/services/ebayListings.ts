import type postgres from 'postgres';
import type { SqlLike } from '../db';
import { activeEbayStatuses, committedQtySql, ebayRemainingSql } from '../lib/sellCommitment';

// eBay listings as the inventory pages see them. The desk itself is
// routes/ebay.ts.

/** Every listing ever made from a lot, newest first: the lot page's "On eBay" card. */
export async function lotListings(sql: SqlLike, inventoryId: string) {
  const rows = await sql<{
    id: string; status: string; qty: number; remaining: number; list_price: number; spec: string | null;
    title: string | null; ebay_item_id: string | null; ebay_url: string | null; created_at: Date;
  }[]>`
    SELECT el.id, el.status, el.qty, ${ebayRemainingSql(sql, sql`el`)} AS remaining,
           el.list_price::float AS list_price, el.spec, el.title, el.ebay_item_id, el.ebay_url, el.created_at
    FROM ebay_listings el WHERE el.inventory_id = ${inventoryId}
    ORDER BY el.created_at DESC, el.id DESC
  `;
  return rows.map(r => ({
    id: r.id, listingNo: r.id, status: r.status, qty: r.qty, remaining: r.remaining, listPrice: r.list_price,
    spec: r.spec, title: r.title, ebayItemId: r.ebay_item_id, ebayUrl: r.ebay_url, createdAt: r.created_at,
    active: activeEbayStatuses().includes(r.status),
  }));
}

/** Queued or Listed listings on any of these lots: what a lot's deletion must wait for. */
export async function activeListingsOnLines(
  sql: SqlLike, lineIds: readonly string[],
): Promise<{ line_id: string; listing_id: string }[]> {
  if (lineIds.length === 0) return [];
  return sql<{ line_id: string; listing_id: string }[]>`
    SELECT inventory_id AS line_id, id AS listing_id FROM ebay_listings
    WHERE inventory_id = ANY(${[...lineIds]}::uuid[]) AND status = ANY(${activeEbayStatuses()}::text[])
    ORDER BY id
  `;
}

export type EbayLink = {
  listingId: string; listingNo: string; spec: string | null; status: string; remaining: number;
  ebayItemId: string | null; ebayUrl: string | null;
};

/**
 * The non-ended listings of each lot on a page, keyed by lower-cased lot id,
 * in one query. Every id asked for is present, with [] when it has none.
 */
export async function ebayLinksByLine(sql: SqlLike, lineIds: readonly string[]): Promise<Map<string, EbayLink[]>> {
  const out = new Map<string, EbayLink[]>(lineIds.map(id => [id.toLowerCase(), []]));
  if (lineIds.length === 0) return out;
  const rows = await sql<{
    inventory_id: string; id: string; spec: string | null; status: string; remaining: number;
    ebay_item_id: string | null; ebay_url: string | null;
  }[]>`
    SELECT el.inventory_id, el.id, el.spec, el.status, ${ebayRemainingSql(sql, sql`el`)} AS remaining,
           el.ebay_item_id, el.ebay_url
    FROM ebay_listings el
    WHERE el.inventory_id = ANY(${[...lineIds]}::uuid[]) AND el.status <> 'Ended'
    ORDER BY el.created_at, el.id
  `;
  for (const r of rows) {
    out.get(r.inventory_id.toLowerCase())?.push({
      listingId: r.id, listingNo: r.id, spec: r.spec, status: r.status, remaining: r.remaining,
      ebayItemId: r.ebay_item_id, ebayUrl: r.ebay_url,
    });
  }
  return out;
}

/** `?ebay=listed|none`: lots with a non-ended listing, or without one. */
export function ebayFilterFrag(sql: SqlLike, raw: string | undefined): postgres.PendingQuery<postgres.Row[]> {
  if (raw !== 'listed' && raw !== 'none') return sql`TRUE`;
  const exists = sql`EXISTS (SELECT 1 FROM ebay_listings f_el WHERE f_el.inventory_id = l.id AND f_el.status <> 'Ended')`;
  return raw === 'listed' ? exists : sql`NOT ${exists}`;
}

export type LotStock = { onHand: number; heldForEbay: number; heldForSellOrders: number; sellable: number };

/**
 * A lot's units as the reservation rule counts them, so the desk can flag a lot
 * whose numbers don't add up (sellable below 0: more promised than is there).
 * onHand is 0 once the lot is Sold, which keeps its last qty for the record.
 */
export async function lotStock(sql: SqlLike, inventoryId: string): Promise<LotStock | null> {
  const [r] = await sql<{ on_hand: number; held: number; ebay: number }[]>`
    SELECT CASE WHEN l.status = 'Sold' THEN 0 ELSE l.qty END AS on_hand,
           ${committedQtySql(sql, sql`l.id`)} AS held,
           (SELECT COALESCE(SUM(${ebayRemainingSql(sql, sql`s_el`)}), 0)::int FROM ebay_listings s_el
             WHERE s_el.inventory_id = l.id AND s_el.status = ANY(${activeEbayStatuses()}::text[])) AS ebay
    FROM order_lines l WHERE l.id = ${inventoryId}
  `;
  if (!r) return null;
  return { onHand: r.on_hand, heldForEbay: r.ebay, heldForSellOrders: r.held - r.ebay, sellable: r.on_hand - r.held };
}

/**
 * A sell order raised from an eBay sale was Closed: the buyer cancelled or
 * sent it back. Its sales are Dismissed, so their units count against the
 * listing's remainder again — a sold-out listing is Listed once more, and an
 * Ended one stays Ended, which hands the units back to the lot. Runs in the
 * close's transaction, after the sell order's lock; the listing is locked
 * here, as confirming a sale locks it.
 */
export async function releaseEbaySalesTx(
  tx: SqlLike, sellOrderId: string, actorId: string, reason: string,
): Promise<void> {
  const sales = await tx<{ id: string; listing_id: string; qty: number }[]>`
    SELECT id, listing_id, qty FROM ebay_sales
    WHERE sell_order_id = ${sellOrderId} AND status = 'Confirmed'
    ORDER BY listing_id, id
  `;
  for (const s of sales) {
    const [listing] = await tx<{ status: string }[]>`
      SELECT status FROM ebay_listings WHERE id = ${s.listing_id} FOR UPDATE
    `;
    await tx`UPDATE ebay_sales SET status = 'Dismissed' WHERE id = ${s.id}`;
    await tx`
      INSERT INTO ebay_listing_events (listing_id, kind, note, detail, actor_id)
      VALUES (${s.listing_id}, 'sale_dismissed', ${`sell order ${sellOrderId} closed`},
              ${tx.json({ saleId: s.id, qty: s.qty, sellOrderId, closeReason: reason })}, ${actorId})
    `;
    if (listing.status === 'Sold') {
      await tx`
        UPDATE ebay_listings SET status = 'Listed', sold_out_at = NULL, updated_at = NOW()
         WHERE id = ${s.listing_id}
      `;
      await tx`
        INSERT INTO ebay_listing_events (listing_id, kind, from_status, to_status, detail, actor_id)
        VALUES (${s.listing_id}, 'listed', 'Sold', 'Listed', ${tx.json({ saleId: s.id, sellOrderId })}, ${actorId})
      `;
    }
  }
}

/**
 * A Queued listing goes up on eBay: by hand (the operator links the item #)
 * or through the API (publish, which also knows the offer). The caller holds
 * the listing's lock and has checked it is Queued.
 */
export async function markListedTx(
  tx: SqlLike, listingId: string, actorId: string,
  f: { itemId: string; url: string; offerId?: string },
): Promise<void> {
  await tx`
    UPDATE ebay_listings
       SET status = 'Listed', listed_at = NOW(), updated_at = NOW(),
           ebay_item_id = ${f.itemId}, ebay_url = ${f.url},
           ebay_offer_id = COALESCE(${f.offerId ?? null}, ebay_offer_id)
     WHERE id = ${listingId}
  `;
  await tx`
    INSERT INTO ebay_listing_events (listing_id, kind, from_status, to_status, detail, actor_id)
    VALUES (${listingId}, 'listed', 'Queued', 'Listed',
            ${tx.json({ itemId: f.itemId, url: f.url, ...(f.offerId ? { offerId: f.offerId, via: 'api' } : {}) })},
            ${actorId})
  `;
}
