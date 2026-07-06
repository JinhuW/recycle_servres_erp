import type { TransactionSql } from 'postgres';
import { PART_PREFIX_RE, canonPartNumberJs } from './part-number';
import { autoTrackParts, type TrackablePart } from './marketAutoTrack';
import { appendPriceEvent } from './refPriceEvents';

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

// On sell-order completion, append one market data point per distinct sold
// product (canonical part number). Price is the qty-weighted average of the
// line unit_price, which is already USD (see migration 0065). Runs inside the
// caller's Done tx so it commits with the sale or not at all.
export async function recordSaleDataPoints(
  tx: TransactionSql,
  sellOrderId: string,
  actorUserId: string,
): Promise<{ recorded: number }> {
  const lines = await tx<LineRow[]>`
    SELECT part_number, unit_price::float AS unit_price, qty, category, label, sub_label
    FROM sell_order_lines
    WHERE sell_order_id = ${sellOrderId}
  `;

  const byCanon = new Map<string, Group>();
  for (const l of lines) {
    const raw = (l.part_number ?? '').trim();
    if (!raw) continue;
    const canon = canonPartNumberJs(raw);
    if (!canon) continue;
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

  // Ensure a ref_prices row exists for every sold product.
  const parts: TrackablePart[] = Array.from(byCanon.values()).map(g => ({
    category: g.category, partNumber: g.raw, label: g.label, subLabel: g.subLabel,
  }));
  await autoTrackParts(tx, parts);

  // Map each canonical PN back to its ref_prices id.
  const canons = Array.from(byCanon.keys());
  const idRows = await tx<{ id: string; canon: string }[]>`
    SELECT id,
           UPPER(REGEXP_REPLACE(
             REGEXP_REPLACE(COALESCE(part_number, ''), ${PART_PREFIX_RE}, '', 'i'),
             '[[:space:]]+', '', 'g'
           )) AS canon
    FROM ref_prices
    WHERE UPPER(REGEXP_REPLACE(
             REGEXP_REPLACE(COALESCE(part_number, ''), ${PART_PREFIX_RE}, '', 'i'),
             '[[:space:]]+', '', 'g'
           )) = ANY(${canons}::text[])
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
      source: `sale:${sellOrderId}`,
      note: null,
      actorUserId,
    });
    recorded++;
  }
  return { recorded };
}
