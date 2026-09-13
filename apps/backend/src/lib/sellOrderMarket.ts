import type { TransactionSql } from 'postgres';
import { canonPartCol, canonPartNumberJs } from './part-number';
import { autoTrackParts, type TrackablePart } from './marketAutoTrack';
import { appendPriceEvent } from './refPriceEvents';
import { normCondition } from '../services/sellOrderPriceImport';

export type BidPart = { partNumber: string; condition: string | null };

type LineRow = {
  part_number: string | null;
  condition: string | null;
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
  // Lines to record, by `canon|normCondition` key; a key with an empty
  // condition admits every line of that part. Absent = every line.
  only?: Set<string>;
};

const lineKey = (canon: string, condition: string | null | undefined) =>
  `${canon}|${normCondition(condition)}`;

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
    SELECT part_number, condition, unit_price::float AS unit_price, qty, category, label, sub_label
    FROM sell_order_lines
    WHERE sell_order_id = ${sellOrderId}
  `;

  const byCanon = new Map<string, Group>();
  for (const l of lines) {
    const raw = (l.part_number ?? '').trim();
    if (!raw) continue;
    const canon = canonPartNumberJs(raw);
    if (!canon) continue;
    if (opts.only && !opts.only.has(lineKey(canon, null)) && !opts.only.has(lineKey(canon, l.condition))) continue;
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
    const price = +(g.priceQty / g.qty).toFixed(2);
    await appendPriceEvent(tx, {
      refPriceId,
      price,
      source: opts.source,
      note: null,
      actorUserId,
    });
    recorded++;
  }
  return { recorded };
}

// On sell-order completion: a completed sale is the most authoritative price
// signal we have, so every sold product gets a data point. Runs inside the
// caller's Done tx.
export async function recordSaleDataPoints(
  tx: TransactionSql,
  sellOrderId: string,
  actorUserId: string,
): Promise<{ recorded: number }> {
  return recordSellOrderDataPoints(tx, sellOrderId, actorUserId, {
    source: `sale:${sellOrderId}`,
  });
}

// On a line save whose prices came from a confirmed vendor price import: the
// customer's accepted quote is a market signal weeks before the deal closes.
// `parts` are the products the manager confirmed in the preview, each a
// (part, condition) the way the sheet prices them — the order's other lines,
// the same part in a condition the sheet did not price included, keep
// whatever price they had and are not a bid. Runs inside the save's tx, after
// the lines are rewritten, so it reads the saved USD values.
export async function recordBidDataPoints(
  tx: TransactionSql,
  sellOrderId: string,
  actorUserId: string,
  parts: BidPart[],
): Promise<{ recorded: number }> {
  const only = new Set<string>();
  for (const p of parts) {
    const canon = canonPartNumberJs(p.partNumber);
    if (canon) only.add(lineKey(canon, p.condition));
  }
  if (only.size === 0) return { recorded: 0 };
  return recordSellOrderDataPoints(tx, sellOrderId, actorUserId, {
    source: `bid:${sellOrderId}`,
    only,
  });
}
