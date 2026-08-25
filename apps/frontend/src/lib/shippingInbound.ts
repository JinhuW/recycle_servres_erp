import type { InboundRow } from './shippingList';

// Pure grouping behind the mobile shipping screen. The desktop table filters a
// flat ledger by status; the phone regroups the same rows by what the user
// should do about them: act, wait, or nothing. Kept out of the component so
// the classification and ordering rules are testable.

/** The one thing a card can ask of the user, or null when it's just news. */
export type InboundAction =
  | { kind: 'create-po' }
  | { kind: 'complete-po'; orderId: string }
  | { kind: 'reshare-link'; orderId: string; sid: string; token: string }
  | { kind: 'buy-desktop' }
  | { kind: 'finish-desktop' }
  | null;

export function inboundAction(row: InboundRow, manager = false): InboundAction {
  if (row.kind === 'package') {
    if (row.pkg.orderId) return null;
    // Tracking isn't wired to a live carrier feed yet, so a package can stall
    // before "delivered". Managers may mint the PO at any status (the server
    // holds the same line); purchasers still wait for delivery. Grouping stays
    // manager-blind — an undelivered package is still "moving", the early CTA
    // just rides along on its card.
    return row.pkg.status === 'delivered' || manager ? { kind: 'create-po' } : null;
  }
  const s = row.shipment;
  if (s.status === 'delivered') {
    return row.order.lifecycle !== 'done' ? { kind: 'complete-po', orderId: row.order.id } : null;
  }
  if (s.status === 'draft' || s.status === 'quoted') {
    // Buying happens on desktop; the phone's job is the honest handoff.
    if (s.complete) return { kind: 'buy-desktop' };
    if (s.sellerToken) return { kind: 'reshare-link', orderId: row.order.id, sid: s.id, token: s.sellerToken };
    return { kind: 'finish-desktop' };
  }
  return null;
}

export type InboundGroups = {
  needs: InboundRow[];
  moving: InboundRow[];
  arrived: InboundRow[];
  voided: InboundRow[];
};

const status = (r: InboundRow) => (r.kind === 'package' ? r.pkg.status : r.shipment.status);
const createdAt = (r: InboundRow) => (r.kind === 'package' ? r.pkg.createdAt : r.shipment.createdAt);
const eta = (r: InboundRow) => (r.kind === 'package' ? r.pkg.trackingEta : r.shipment.trackingEta);

// Within Needs You, problems outrank arrivals, arrivals outrank desktop handoffs.
const NEEDS_RANK: Record<string, number> = {
  'exception': 0, 'create-po': 1, 'complete-po': 2, 'buy-desktop': 3, 'reshare-link': 4, 'finish-desktop': 5,
};

function needsRank(r: InboundRow): number {
  if (status(r) === 'exception') return NEEDS_RANK['exception'];
  const a = inboundAction(r);
  return a ? NEEDS_RANK[a.kind] : 9;
}

export function groupInbound(rows: InboundRow[]): InboundGroups {
  const g: InboundGroups = { needs: [], moving: [], arrived: [], voided: [] };
  for (const r of rows) {
    const s = status(r);
    if (s === 'voided') g.voided.push(r);
    else if (s === 'exception' || inboundAction(r) !== null) g.needs.push(r);
    else if (s === 'in_transit' || s === 'purchased') g.moving.push(r);
    else g.arrived.push(r);
  }
  const newestFirst = (a: InboundRow, b: InboundRow) => createdAt(b).localeCompare(createdAt(a));
  g.needs.sort((a, b) => (needsRank(a) - needsRank(b)) || newestFirst(a, b));
  // Soonest arrival first — that's what a glance is asking. Unknown ETAs sink.
  g.moving.sort((a, b) => {
    const ea = eta(a), eb = eta(b);
    if (ea && eb && ea !== eb) return ea.localeCompare(eb);
    if (!ea !== !eb) return ea ? -1 : 1;
    return newestFirst(a, b);
  });
  g.arrived.sort(newestFirst);
  g.voided.sort(newestFirst);
  return g;
}

/** Live counts for the home-screen card. */
export function inboundSummary(rows: InboundRow[]): { moving: number; needs: number } {
  const g = groupInbound(rows);
  return { moving: g.moving.length, needs: g.needs.length };
}

/** 0-based position on the 4-step journey strip (created → label → moving → here).
 *  An exception sits at the moving step; the strip's tone carries the alarm. */
export function journeyPos(row: InboundRow): number {
  switch (status(row)) {
    case 'purchased': return 1;
    case 'in_transit':
    case 'exception': return 2;
    case 'delivered': return 3;
    default: return 0;
  }
}
