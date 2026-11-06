import type { TransactionSql } from 'postgres';
import type { SqlLike } from '../db';
import { canonPartCol, canonPartNumberJs } from './part-number';
import { autoTrackParts, type TrackablePart } from './marketAutoTrack';
import { appendPriceEvent, retractPriceEvents, type WithdrawnPrice } from './refPriceEvents';

type LineRow = {
  part_number: string | null;
  unit_price: number;
  qty: number;
  category: string;
  label: string;
  sub_label: string | null;
};

type Group = {
  raw: string;
  category: string;
  label: string;
  subLabel: string | null;
  priceQty: number; // Σ unit_price·qty
  qty: number;      // Σ qty
};

type RecordOptions = {
  source: string;
  // Lines to record, by canonical part number. Absent = every line.
  only?: Set<string>;
  // Lines to leave out, by canonical part number.
  except?: Set<string>;
  // Share of the order's price the Market records. A line saved at 0 is no
  // market price, so it neither counts toward the average nor makes a reading.
  percent?: number;
};

// One market data point per distinct product (canonical part number) on a
// sell order. Price is the qty-weighted average of the line unit_price, which
// is already USD (see migration 0065). Runs inside the caller's tx so it
// commits with the write that triggered it or not at all.
async function recordSellOrderDataPoints(
  tx: TransactionSql,
  sellOrderId: string,
  actorUserId: string,
  opts: RecordOptions,
): Promise<{ recorded: number }> {
  const lines = await tx<LineRow[]>`
    SELECT part_number, unit_price::float AS unit_price, qty, category, label, sub_label
    FROM sell_order_lines
    WHERE sell_order_id = ${sellOrderId}
  `;

  const byCanon = new Map<string, Group>();
  for (const l of lines) {
    // A line held at 0 sold nothing and was priced for nothing.
    if (l.qty === 0) continue;
    if (opts.percent !== undefined && l.unit_price <= 0) continue;
    const raw = (l.part_number ?? '').trim();
    if (!raw) continue;
    const canon = canonPartNumberJs(raw);
    if (!canon) continue;
    if (opts.only && !opts.only.has(canon)) continue;
    if (opts.except?.has(canon)) continue;
    const g = byCanon.get(canon);
    if (g) {
      g.priceQty += l.unit_price * l.qty;
      g.qty += l.qty;
    } else {
      byCanon.set(canon, {
        raw, category: l.category, label: l.label, subLabel: l.sub_label,
        priceQty: l.unit_price * l.qty, qty: l.qty,
      });
    }
  }
  const priceOf = (g: Group) => +((g.priceQty / g.qty) * (opts.percent ?? 100) / 100).toFixed(2);
  if (opts.percent !== undefined) {
    for (const [canon, g] of byCanon) if (priceOf(g) <= 0) byCanon.delete(canon);
  }
  if (byCanon.size === 0) return { recorded: 0 };

  // Ensure a ref_prices row exists for every product being recorded.
  const parts: TrackablePart[] = Array.from(byCanon.values()).map(g => ({
    category: g.category, partNumber: g.raw, label: g.label, subLabel: g.subLabel,
  }));
  await autoTrackParts(tx, parts);

  // Map each canonical PN back to its ref_prices id.
  const canons = Array.from(byCanon.keys());
  const idRows = await tx<{ id: string; canon: string }[]>`
    SELECT id, ${canonPartCol(tx, tx`part_number`)} AS canon
    FROM ref_prices
    WHERE ${canonPartCol(tx, tx`part_number`)} = ANY(${canons}::text[])
  `;
  const idByCanon = new Map<string, string>();
  for (const r of idRows) if (!idByCanon.has(r.canon)) idByCanon.set(r.canon, r.id);

  let recorded = 0;
  for (const [canon, g] of byCanon) {
    const refPriceId = idByCanon.get(canon);
    if (!refPriceId) continue; // autoTrackParts guarantees a row; defensive only
    await appendPriceEvent(tx, {
      refPriceId,
      price: priceOf(g),
      source: opts.source,
      note: null,
      actorUserId,
    });
    recorded++;
  }
  return { recorded };
}

// On sell-order completion: a sold product gets a data point at its sale price,
// unless the manager already synced it. That price is the one they chose for
// the Market, so the sale leaves it standing. Runs inside the caller's Done tx.
export async function recordSaleDataPoints(
  tx: TransactionSql,
  sellOrderId: string,
  actorUserId: string,
): Promise<{ recorded: number }> {
  return recordSellOrderDataPoints(tx, sellOrderId, actorUserId, {
    source: `sale:${sellOrderId}`,
    except: new Set(await syncedBidParts(tx, sellOrderId)),
  });
}

// A sale reopened from Done was not a sale after all, so its data points go
// with it; Done again records them afresh.
export async function retractSaleDataPoints(
  tx: TransactionSql,
  sellOrderId: string,
): Promise<WithdrawnPrice[]> {
  return retractPriceEvents(tx, `sale:${sellOrderId}`);
}

// The manager's Sync to Market: the customer's quote is a market signal weeks
// before the deal closes, at the share of it the manager chooses. The percent
// is deliberately not recorded on the reading: the Market shows a plain price.
// Reads the saved USD values. A later sync of the same part replaces this
// order's reading of it, even when the part now comes to nothing, and readings
// of parts the order no longer prices go too: the dialog can't list those.
export async function syncMarketPrices(
  tx: TransactionSql,
  sellOrderId: string,
  actorUserId: string,
  partNumbers: string[],
  percent: number,
): Promise<{ recorded: number }> {
  await retractUnpricedBids(tx, sellOrderId);
  const only = new Set<string>();
  for (const p of partNumbers) {
    const canon = canonPartNumberJs(p);
    if (canon) only.add(canon);
  }
  if (only.size === 0) return { recorded: 0 };
  const source = bidSource(sellOrderId);
  const earlier = await tx<{ id: string }[]>`
    SELECT id FROM ref_prices
    WHERE ${canonPartCol(tx, tx`part_number`)} = ANY(${[...only]}::text[])
  `;
  if (earlier.length) await retractPriceEvents(tx, source, earlier.map(r => r.id));
  return recordSellOrderDataPoints(tx, sellOrderId, actorUserId, {
    source,
    only,
    percent,
  });
}

const bidSource = (sellOrderId: string) => `bid:${sellOrderId}`;

// The canonical part numbers this order's Sync to Market holds a reading for.
export async function syncedBidParts(sql: SqlLike, sellOrderId: string): Promise<string[]> {
  const rows = await sql<{ part_number: string }[]>`
    SELECT DISTINCT rp.part_number
    FROM ref_price_events e JOIN ref_prices rp ON rp.id = e.ref_price_id
    WHERE e.source = ${bidSource(sellOrderId)}
  `;
  return [...new Set(rows.map(r => canonPartNumberJs(r.part_number)))];
}

// A quote stands only while the order still prices the part. Called wherever
// that can have stopped being true unseen: a line save, a sync, and Done, which
// would otherwise leave a reading for something that never sold.
export async function retractUnpricedBids(
  tx: TransactionSql,
  sellOrderId: string,
): Promise<WithdrawnPrice[]> {
  const source = bidSource(sellOrderId);
  const held = await tx<{ id: string; part_number: string }[]>`
    SELECT DISTINCT rp.id, rp.part_number
    FROM ref_price_events e JOIN ref_prices rp ON rp.id = e.ref_price_id
    WHERE e.source = ${source}
  `;
  if (held.length === 0) return [];
  const lines = await tx<{ part_number: string | null }[]>`
    SELECT part_number FROM sell_order_lines
    WHERE sell_order_id = ${sellOrderId} AND qty > 0 AND unit_price > 0
  `;
  const priced = new Set(lines.map(l => canonPartNumberJs((l.part_number ?? '').trim())));
  const gone = held.filter(r => !priced.has(canonPartNumberJs(r.part_number))).map(r => r.id);
  return gone.length ? retractPriceEvents(tx, source, gone) : [];
}

// A sell order closed without a sale was never the customer's price, so its
// bids leave the Market board with it.
export async function retractBidDataPoints(
  tx: TransactionSql,
  sellOrderId: string,
): Promise<WithdrawnPrice[]> {
  return retractPriceEvents(tx, bidSource(sellOrderId));
}
