// Builds the request for finalizing a purchase order from the review screen.
//
// There are two cases, and BOTH are a PATCH — submitting from review must
// never create a new order:
//   - Editing an existing order (`editingId` set): PATCH that order, updating
//     lines that still carry their DB id, inserting new ones, and deleting the
//     originals the user removed.
//   - Finalizing a new draft (`draftId` set): PATCH the draft, appending the
//     lines that weren't already autosaved.
import type { Category, DraftLine } from './types';

export type SubmitMeta = {
  warehouseId: string;
  payment: 'company' | 'self';
  notes: string;
  totalCost: number;
};

export type SubmitState = {
  editingId?: string | null;
  draftId?: string;
  category: Category;
  lines: DraftLine[];
  // DB ids of the lines present when an existing order was opened for edit.
  // Used to compute which lines the user removed.
  originalLineIds?: string[];
};

export type OrderSubmitRequest =
  | { kind: 'patch'; url: string; body: Record<string, unknown> }
  | { kind: 'error'; message: string };

// New rows (and the new-draft path) carry status 'In Transit'.
const toAddLine = (l: DraftLine) => ({
  category: l.category,
  brand: l.brand ?? null,
  capacity: l.capacity ?? null,
  type: l.type ?? null,
  classification: l.classification ?? null,
  rank: l.rank ?? null,
  speed: l.speed ?? null,
  interface: l.interface ?? null,
  formFactor: l.formFactor ?? null,
  description: l.description ?? null,
  partNumber: l.partNumber ?? null,
  condition: l.condition ?? 'Pulled — Tested',
  qty: Number(l.qty) || 1,
  unitCost: Number(l.unitCost) || 0,
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
    totalCost: meta.totalCost,
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
    return { kind: 'error', message: 'No draft order — please cancel and retry.' };
  }
  // Only send lines that weren't already autosaved to the draft (confirmed
  // lines were written when the user saved each one — avoid double-insert).
  const unconfirmed = state.lines.filter(l => !l._confirmed);
  return {
    kind: 'patch',
    url: '/api/orders/' + state.draftId,
    body: {
      ...metaBody,
      ...(unconfirmed.length ? { addLines: unconfirmed.map(toAddLine) } : {}),
    },
  };
}
