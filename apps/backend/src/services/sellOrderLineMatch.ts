// Match before/after sell-order line sets to classify into added/removed/edited.
//
// PATCH /api/sell-orders/:id replaces lines wholesale (DELETE + INSERT), so we
// cannot rely on row ids. Inventory-backed lines match by inventory_id, as a
// multiset: an order may name one lot more than once (two conditions, two
// prices), and the n-th occurrence before pairs with the n-th after — keyed
// on one entry per lot, the second occurrence overwrote the first and an edit
// to it was never reported. Manual lines (no inventory_id) match by
// deep-equal tuple across LINE_FIELDS_SO — if an exact tuple exists in both
// sets, the line is unchanged; otherwise it's an add or a remove. Manual lines
// never produce line_edited events because they have no stable identity.

import { diff, LINE_FIELDS_SO, type AuditChange } from './sellOrderAudit';

export type SOLineSnap = {
  inventory_id: string | null;
  qty: number;
  unit_price: number;
  condition: string | null;
  category: string;
  label: string;
  sub_label: string | null;
  part_number: string | null;
  warehouse_id: string | null;
};

export type LineDiff = {
  added: SOLineSnap[];
  removed: SOLineSnap[];
  edited: Array<{ inventoryId: string; changes: AuditChange[]; snapshot: SOLineSnap }>;
};

function tupleKey(l: SOLineSnap): string {
  return JSON.stringify([l.qty, l.unit_price, l.condition, l.category,
    l.label, l.sub_label, l.part_number, l.warehouse_id]);
}

export function diffSellOrderLines(before: SOLineSnap[], after: SOLineSnap[]): LineDiff {
  const beforeInv = new Map<string, SOLineSnap[]>();
  const afterInv  = new Map<string, SOLineSnap[]>();
  const beforeManual: SOLineSnap[] = [];
  const afterManual:  SOLineSnap[] = [];

  const push = (m: Map<string, SOLineSnap[]>, l: SOLineSnap) => {
    const k = l.inventory_id!.toLowerCase();
    const bucket = m.get(k);
    if (bucket) bucket.push(l); else m.set(k, [l]);
  };
  for (const l of before) {
    if (l.inventory_id) push(beforeInv, l);
    else beforeManual.push(l);
  }
  for (const l of after) {
    if (l.inventory_id) push(afterInv, l);
    else afterManual.push(l);
  }

  const added: SOLineSnap[] = [];
  const removed: SOLineSnap[] = [];
  const edited: LineDiff['edited'] = [];

  // Inventory-backed: occurrence n before pairs with occurrence n after; the
  // leftovers on either side are removed or added.
  for (const [invId, olds] of beforeInv) {
    const news = afterInv.get(invId) ?? [];
    const n = Math.min(olds.length, news.length);
    for (let i = 0; i < n; i++) {
      const changes = diff(olds[i] as unknown as Record<string, unknown>,
                          news[i] as unknown as Record<string, unknown>,
                          LINE_FIELDS_SO);
      if (changes.length > 0) edited.push({ inventoryId: olds[i].inventory_id!, changes, snapshot: news[i] });
    }
    for (const l of olds.slice(n)) removed.push(l);
    for (const l of news.slice(n)) added.push(l);
  }
  for (const [invId, news] of afterInv) {
    if (!beforeInv.has(invId)) for (const l of news) added.push(l);
  }

  // Manual: deep-equal tuple match. Multi-set semantics so duplicates
  // (two identical manual lines on the same order) are handled correctly.
  const beforeBuckets = new Map<string, SOLineSnap[]>();
  for (const l of beforeManual) {
    const k = tupleKey(l);
    const bucket = beforeBuckets.get(k);
    if (bucket) bucket.push(l); else beforeBuckets.set(k, [l]);
  }
  for (const l of afterManual) {
    const k = tupleKey(l);
    const bucket = beforeBuckets.get(k);
    if (bucket && bucket.length > 0) { bucket.pop(); continue; }
    added.push(l);
  }
  for (const bucket of beforeBuckets.values()) {
    for (const l of bucket) removed.push(l);
  }

  return { added, removed, edited };
}
