// Match before/after sell-order line sets to classify into added/removed/edited.
//
// PATCH /api/sell-orders/:id replaces lines wholesale (DELETE + INSERT), so we
// cannot rely on row ids. Inventory-backed lines match by inventory_id (1:1 by
// the one-active-SO-per-line invariant). Manual lines (no inventory_id) match
// by deep-equal tuple across LINE_FIELDS_SO — if an exact tuple exists in both
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
  const beforeInv = new Map<string, SOLineSnap>();
  const afterInv  = new Map<string, SOLineSnap>();
  const beforeManual: SOLineSnap[] = [];
  const afterManual:  SOLineSnap[] = [];

  for (const l of before) {
    if (l.inventory_id) beforeInv.set(l.inventory_id, l);
    else beforeManual.push(l);
  }
  for (const l of after) {
    if (l.inventory_id) afterInv.set(l.inventory_id, l);
    else afterManual.push(l);
  }

  const added: SOLineSnap[] = [];
  const removed: SOLineSnap[] = [];
  const edited: LineDiff['edited'] = [];

  // Inventory-backed: 3-way split by inventory_id.
  for (const [invId, oldLine] of beforeInv) {
    const newLine = afterInv.get(invId);
    if (!newLine) { removed.push(oldLine); continue; }
    const changes = diff(oldLine as unknown as Record<string, unknown>,
                        newLine as unknown as Record<string, unknown>,
                        LINE_FIELDS_SO);
    if (changes.length > 0) edited.push({ inventoryId: invId, changes, snapshot: newLine });
  }
  for (const [invId, newLine] of afterInv) {
    if (!beforeInv.has(invId)) added.push(newLine);
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
