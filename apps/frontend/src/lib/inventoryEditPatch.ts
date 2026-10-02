// Spec fields the inventory editor's Details tab edits. Held as '' rather than
// null in the draft — a <select>'s clear option is value="", so a nullable
// column round-tripping through the form is a string either way.
export const SPEC_FIELDS = [
  'brand', 'capacity', 'generation', 'type', 'classification',
  'rank', 'speed', 'interface', 'formFactor', 'description',
] as const;
export type SpecField = typeof SPEC_FIELDS[number];

export type InventoryEditDraft = {
  partNumber: string;
  condition: string;
  qty: string;
  unitCost: string;
  sellPrice: string;
  status: string;
  health: string;
  rpm: string;
} & Record<SpecField, string>;

/**
 * The PATCH /api/inventory/:id body for an editor save: only the keys that
 * moved. The route reads a present key as an edit, so an unchanged qty or unit
 * cost tripped the closed-book 409 and an unchanged status the open-sell-order
 * 409 — sending the whole form refused every save on a reviewed PO.
 */
export function inventoryEditPatch(
  initial: InventoryEditDraft,
  draft: InventoryEditDraft,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const moved = (f: keyof InventoryEditDraft) => draft[f] !== initial[f];
  const blankToNull = (v: string) => (v === '' ? null : Number(v));

  // A key that is absent means "leave alone" and a present null means
  // "clear" — the route's spec, sell price, health and rpm sentinels.
  for (const f of SPEC_FIELDS) {
    if (moved(f)) patch[f] = draft[f] === '' ? null : draft[f];
  }
  if (moved('status')) patch.status = draft.status;
  if (moved('sellPrice')) patch.sellPrice = blankToNull(draft.sellPrice);
  // The closed-book pair compares as numbers: "2" retyped as "2.0" is no edit,
  // and as one it would 409 on a reviewed PO.
  if (Number(draft.unitCost) !== Number(initial.unitCost)) patch.unitCost = Number(draft.unitCost) || 0;
  if (Number(draft.qty) !== Number(initial.qty)) patch.qty = Number(draft.qty) || 0;
  if (moved('condition')) patch.condition = draft.condition;
  // The route COALESCEs part number, so null is "no change" — a blanked part
  // number does not clear it, as before.
  if (moved('partNumber')) patch.partNumber = draft.partNumber || null;
  if (moved('health')) patch.health = blankToNull(draft.health);
  if (moved('rpm')) patch.rpm = blankToNull(draft.rpm);
  return patch;
}
