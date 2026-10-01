import type { OrderLine } from '../../../lib/types';
import type { Line } from './line';

// A PO line being edited in the drawer: the shared `Line` plus the original DB
// id (when the line came from the server) and a dirty marker so the PATCH can
// be scoped to what changed.
export type EditLine = Line & { _id?: string; _dirty?: boolean };

export function orderLineToEditLine(l: OrderLine): EditLine {
  return {
    _cid:           crypto.randomUUID(),
    _id:            l.id,
    category:       l.category,
    photos:         l.photos ?? [],
    brand:          l.brand ?? undefined,
    capacity:       l.capacity ?? undefined,
    type:           l.type ?? undefined,
    generation:     l.generation ?? undefined,
    classification: l.classification ?? undefined,
    rank:           l.rank ?? undefined,
    speed:          l.speed ?? undefined,
    interface:      l.interface ?? undefined,
    formFactor:     l.formFactor ?? undefined,
    description:    l.description ?? undefined,
    itemType:      l.itemType ?? undefined,
    partNumber:     l.partNumber ?? undefined,
    serialNumber:   l.serialNumber ?? undefined,
    chipNumber:     l.chipNumber ?? undefined,
    condition:      l.condition,
    qty:            l.qty,
    // An unpriced line (purchaser raised it, manager prices it at Reviewing)
    // opens the drawer blank rather than with a 0 to clear first.
    unitCost:       l.unitCost || '',
    sellPrice:      l.sellPrice ?? undefined,
    scanImageId:    l.scanImageId ?? undefined,
    scanImageUrl:   l.scanImageUrl ?? undefined,
    health:         l.health,
    rpm:            l.rpm,
  };
}

export function editLineToPatch(l: EditLine, status?: string) {
  const sp = l.sellPrice;
  return {
    id:             l._id!,
    status,
    // Sent so a recategorisation made in the drawer survives Save. Without it
    // the backend keeps the stored category and silently drops the change.
    category:       l.category,
    sellPrice:      sp == null || sp === '' ? null : Number(sp),
    qty:            Number(l.qty) || 0,
    unitCost:       Number(l.unitCost) || 0,
    brand:          l.brand ?? null,
    capacity:       l.capacity ?? null,
    type:           l.type ?? null,
    generation:     l.generation ?? null,
    classification: l.classification ?? null,
    rank:           l.rank ?? null,
    speed:          l.speed ?? null,
    interface:      l.interface ?? null,
    formFactor:     l.formFactor ?? null,
    description:    l.description ?? null,
    itemType:      l.itemType ?? null,
    partNumber:     l.partNumber ?? null,
    serialNumber:   l.serialNumber ?? null,
    chipNumber:     l.chipNumber ?? null,
    condition:      l.condition,
    health:         l.health ?? null,
    rpm:            l.rpm ?? null,
    // A scan performed in the drawer must survive Save; null keeps the stored
    // value (the backend applies these with COALESCE, like every field here).
    scanImageId:    l.scanImageId ?? null,
    scanConfidence: l.scanConfidence ?? null,
  };
}
