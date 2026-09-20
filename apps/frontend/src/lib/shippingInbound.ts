import type { InboundRow } from './shippingList';

// Pure grouping behind the mobile shipping screen. The desktop table filters a
// flat ledger by status; the phone regroups the same rows by what the user
// should do about them: act, wait, or nothing. Kept out of the component so
// the classification and ordering rules are testable.

/** The one thing a card can ask of the user, or null when it's just news. */
export type InboundAction = { kind: 'create-po' } | null;

/** A package can grow its PO: delivered normally, any status for a manager —
 *  a carrier can go quiet or a number can be unregistrable, so a package can
 *  still stall before "delivered" and the server holds the same line. Shared
 *  with the desktop table, which presents it as a CTA rather than a card. */
export function canCreatePo(
  pkg: { orderId: string | null; status: string }, manager: boolean,
): boolean {
  return !pkg.orderId && (pkg.status === 'delivered' || manager);
}

export function inboundAction(row: InboundRow, manager = false): InboundAction {
  // Grouping stays manager-blind — an undelivered package is still "moving",
  // the early manager CTA just rides along on its card.
  return canCreatePo(row.pkg, manager) ? { kind: 'create-po' } : null;
}

export type InboundGroups = {
  needs: InboundRow[];
  moving: InboundRow[];
  arrived: InboundRow[];
};

const status = (r: InboundRow) => r.pkg.status;
const createdAt = (r: InboundRow) => r.pkg.createdAt;
const eta = (r: InboundRow) => r.pkg.trackingEta;

// Within Needs You, problems outrank arrivals.
function needsRank(r: InboundRow): number {
  if (status(r) === 'exception') return 0;
  return inboundAction(r) ? 1 : 9;
}

export function groupInbound(rows: InboundRow[]): InboundGroups {
  const g: InboundGroups = { needs: [], moving: [], arrived: [] };
  for (const r of rows) {
    const s = status(r);
    if (s === 'exception' || inboundAction(r) !== null) g.needs.push(r);
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
  return g;
}

/** Live counts for a loaded row set. The home-screen card doesn't call this —
 *  it reads GET /api/packages/inbound-counts, whose SQL buckets mirror
 *  groupInbound above; a membership change here must be mirrored there
 *  (backend tests/packages-inbound-counts.test.ts pins the truth table). */
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
