// Builds the request for finalizing a purchase order from the review screen.
//
// Three cases:
//   - Editing an existing order (`editingId` set): PATCH that order, updating
//     lines that still carry their DB id, inserting new ones, and deleting the
//     originals the user removed.
//   - Finalizing a new draft (`draftId` set): PATCH the draft, appending the
//     lines that weren't already autosaved.
//   - No order yet: POST the whole thing. The draft row is only created by the
//     first line that can be persisted, so a session whose lines were all
//     held back (incomplete when saved) reaches submit with nothing to PATCH.
//     One atomic create is also the only shape that cannot leave an empty PO
//     behind when the lines turn out to be invalid.
import type { DraftLine } from './types';

export type SubmitMeta = {
  warehouseId: string;
  payment: 'company' | 'self';
  notes: string;
  // No goods total. It is the sum of the lines, and the backend derives it from
  // them on every write that moves them (services/orderGoodsTotal) — a figure
  // sent from here could only ever restate that, and would be taken for a
  // negotiated lot price and pin the column at a value the lines have left.
  otherFees: number;
  otherFeesNote: string | null;
};

export type SubmitState = {
  editingId?: string | null;
  draftId?: string;
  lines: DraftLine[];
  // DB ids of the lines present when an existing order was opened for edit.
  // Used to compute which lines the user removed.
  originalLineIds?: string[];
};

export type OrderSubmitRequest =
  | { kind: 'patch'; url: string; body: Record<string, unknown> }
  | { kind: 'create'; url: string; body: Record<string, unknown> }
  | { kind: 'error'; message: string };

// New rows (and the new-draft path) carry status 'In Transit'.
const toAddLine = (l: DraftLine) => ({
  category: l.category,
  brand: l.brand ?? null,
  capacity: l.capacity ?? null,
  generation: l.generation ?? null,
  type: l.type ?? null,
  classification: l.classification ?? null,
  rank: l.rank ?? null,
  speed: l.speed ?? null,
  interface: l.interface ?? null,
  formFactor: l.formFactor ?? null,
  description: l.description ?? null,
  itemType: l.itemType ?? null,
  partNumber: l.partNumber ?? null,
  serialNumber: l.serialNumber ?? null,
  chipNumber: l.chipNumber ?? null,
  condition: l.condition ?? 'Pulled — Tested',
  qty: Number(l.qty) || 1,
  unitCost: Number(l.unitCost) || 0,
  // The purchaser's projected sell price, set at intake. Omitted here until
  // now, so pricing done on the capture screen was silently discarded.
  sellPrice: l.sellPrice == null ? null : Number(l.sellPrice),
  health: l.health ?? null,
  rpm: l.rpm ?? null,
  status: 'In Transit' as const,
  scanImageId: l.scanImageId ?? null,
  scanConfidence: l.scanConfidence ?? null,
});

// Updates to an existing row deliberately omit `status`: the backend COALESCEs
// it, so leaving it out preserves whatever lifecycle status the line already
// has (Done, etc.) instead of forcing it back to 'In Transit'.
const toUpdateLine = (l: DraftLine) => {
  const { status, ...rest } = toAddLine(l);
  void status;
  return { id: l.id as string, ...rest };
};

export function buildOrderSubmit(
  state: SubmitState,
  meta: SubmitMeta,
): OrderSubmitRequest {
  const metaBody = {
    warehouseId: meta.warehouseId,
    payment: meta.payment,
    notes: meta.notes || null,
    otherFees: meta.otherFees,
    otherFeesNote: meta.otherFeesNote,
  };

  if (state.editingId) {
    const existing = state.lines.filter(l => l.id);
    const added = state.lines.filter(l => !l.id);
    const survivingIds = new Set(existing.map(l => l.id));
    const removed = (state.originalLineIds ?? []).filter(id => !survivingIds.has(id));
    return {
      kind: 'patch',
      url: '/api/orders/' + state.editingId,
      body: {
        ...metaBody,
        ...(existing.length ? { lines: existing.map(toUpdateLine) } : {}),
        ...(added.length ? { addLines: added.map(toAddLine) } : {}),
        ...(removed.length ? { removeLineIds: removed } : {}),
      },
    };
  }

  if (!state.draftId) {
    if (!state.lines.length) {
      return { kind: 'error', message: 'Add at least one item before submitting.' };
    }
    return {
      kind: 'create',
      url: '/api/orders',
      body: { ...metaBody, lines: state.lines.map(toAddLine) },
    };
  }
  // Only send lines that weren't already autosaved to the draft (confirmed
  // lines were written when the user saved each one — avoid double-insert).
  // Lines the user deleted after they autosaved are still in the draft and
  // have to be named, or they ship as stock nobody bought.
  const unconfirmed = state.lines.filter(l => !l._confirmed);
  const survivingIds = new Set(state.lines.filter(l => l.id).map(l => l.id));
  const removed = (state.originalLineIds ?? []).filter(id => !survivingIds.has(id));
  return {
    kind: 'patch',
    url: '/api/orders/' + state.draftId,
    body: {
      ...metaBody,
      ...(unconfirmed.length ? { addLines: unconfirmed.map(toAddLine) } : {}),
      ...(removed.length ? { removeLineIds: removed } : {}),
    },
  };
}
