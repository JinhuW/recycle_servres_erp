// Which PATCH /api/orders/:id keys are an edit to the order itself, the kind
// that sends a purchaser's submitted PO back to Draft. A note, the supplier,
// the commission rate and the owner are not. The backend gate and the
// editors' "this will cost you the stage" warning read this one list, where
// each used to keep its own and they disagreed.
export const MATERIAL_PATCH_KEYS = [
  'lines', 'addLines', 'removeLineIds',
  'totalCost', 'otherFees', 'otherFeesNote',
  'warehouseId', 'payment', 'paymentMethod', 'paypalTxnId',
  'source', 'handoffMethod', 'handoffBy',
  'trackingNumber', 'carrier',
] as const;

export type MaterialPatchKey = (typeof MATERIAL_PATCH_KEYS)[number];

// The three list keys count only when they carry something: an empty array
// writes nothing.
const LIST_KEYS: ReadonlySet<string> = new Set(['lines', 'addLines', 'removeLineIds']);

export function isMaterialPatch(body: Partial<Record<MaterialPatchKey, unknown>>): boolean {
  return MATERIAL_PATCH_KEYS.some((k) => {
    const v = body[k];
    if (v === undefined) return false;
    return LIST_KEYS.has(k) ? Array.isArray(v) && v.length > 0 : true;
  });
}
