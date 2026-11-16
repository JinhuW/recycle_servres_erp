import type { OrderSummary, Role } from './types';
import { WORKFLOW_STAGES } from './status';

// The purchase order board: POs in one column per stage. A card dropped one
// stage forward starts the step the PO page runs for that move, so the board
// skips no check. Anything else stays on the PO page.

export type PoStage = 'draft' | 'in_transit' | 'reviewing' | 'ready_to_pay' | 'done';

export type PoDrop =
  /** Draft → In Transit: the hand-off form, on the PO page. */
  | 'handoff'
  /** In Transit → Reviewing: an advance from here, after the takeover question. */
  | 'advance'
  /** Reviewing → Ready to Pay: the box check. */
  | 'boxCheck'
  /** Ready to Pay → Done: the commission evidence step, on the PO page. */
  | 'done';

const NEXT: Record<string, { to: PoStage; step: PoDrop }> = {
  draft: { to: 'in_transit', step: 'handoff' },
  in_transit: { to: 'reviewing', step: 'advance' },
  reviewing: { to: 'ready_to_pay', step: 'boxCheck' },
  ready_to_pay: { to: 'done', step: 'done' },
};

/**
 * What dropping `o` on the `to` column does, or null when the board does not
 * offer that move: back moves, jumps, archived POs, and any move but its own
 * Draft's hand-off for a purchaser (the server refuses those too).
 */
export function poDropAction(
  o: Pick<OrderSummary, 'lifecycle' | 'userId' | 'archivedAt'>,
  to: string,
  viewer: { id: string; role: Role },
): PoDrop | null {
  if (o.archivedAt) return null;
  const next = NEXT[o.lifecycle];
  if (!next || next.to !== to) return null;
  if (viewer.role === 'manager') return next.step;
  return next.step === 'handoff' && o.userId === viewer.id ? 'handoff' : null;
}

/**
 * The board's columns, oldest in stage first. Done is always there to drop
 * on, but its cards show only when asked for, as the list prunes them.
 */
export function poColumns<T extends Pick<OrderSummary, 'lifecycle' | 'createdAt' | 'stageSince'>>(
  orders: readonly T[], withDone: boolean,
): { stage: PoStage; label: string; orders: T[]; folded: boolean }[] {
  const since = (o: T) => o.stageSince ?? o.createdAt;
  return WORKFLOW_STAGES.map(s => {
    const folded = s.id === 'done' && !withDone;
    return {
      stage: s.id as PoStage,
      label: s.label,
      folded,
      orders: folded ? [] : orders.filter(o => (o.lifecycle || 'draft') === s.id).sort((a, b) => since(a).localeCompare(since(b))),
    };
  });
}

/** The PO page with a drop's step opened on arrival. */
export function poStepPath(id: string, step: 'handoff' | 'done'): string {
  return `/purchase-orders/${encodeURIComponent(id)}?step=${step}`;
}
