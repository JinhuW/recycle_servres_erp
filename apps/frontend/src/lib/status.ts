// Per-line status helpers. The order lifecycle is a fixed set — it's pinned by
// the schema convention on order_lines.status / orders.lifecycle, so it lives
// here as a static constant rather than a manager-editable table.
//
//   Draft (purchaser is preparing) → In Transit → Reviewing → Ready to Pay
//   (review finished, commission owed) → Done (commission paid).

import type { Warehouse } from './types';

export type OrderStatus = 'Draft' | 'In Transit' | 'Reviewing' | 'Ready to Pay' | 'Done';

export const ORDER_STATUSES: OrderStatus[] = ['Draft', 'In Transit', 'Reviewing', 'Ready to Pay', 'Done'];

// What a *line* can be. Ready to Pay is a PO stage only: its lines read Done,
// because the stock and sellable buckets key on line status and review has
// finished. Offering it as a line status would drop the line out of stock.
export const LINE_STATUSES = ['Draft', 'In Transit', 'Reviewing', 'Done'] as const;

// Canonical order lifecycle. `id` is the slug stored in orders.lifecycle;
// colour comes from statusTone(label) so the stage filter and the Status
// column can never drift apart.
export type WorkflowStage = {
  id: string;
  label: OrderStatus;
};

export const WORKFLOW_STAGES: WorkflowStage[] = [
  { id: 'draft',        label: 'Draft' },
  { id: 'in_transit',   label: 'In Transit' },
  { id: 'reviewing',    label: 'Reviewing' },
  { id: 'ready_to_pay', label: 'Ready to Pay' },
  { id: 'done',         label: 'Done' },
];

// lifecycle slug → stage label. `order.status` can collapse to 'Mixed' when a
// still-open order's lines disagree, so screens derive the stage from the
// authoritative lifecycle and fall back to the string only for unknown slugs.
export const LIFECYCLE_STATUS: Record<string, string> = Object.fromEntries(
  WORKFLOW_STAGES.map(s => [s.id, s.label]),
);

const TONE: Record<string, 'info' | 'warn' | 'pos' | 'accent' | 'muted'> = {
  'Draft':        'muted',
  'In Transit':   'info',
  'Reviewing':    'warn',
  'Ready to Pay': 'accent',
  'Done':         'pos',
  'Sold':         'muted',
  'Archived':     'muted',
  'Mixed':        'muted',
  'Pending':      'warn',
  'Received':     'pos',
};

export const statusTone = (s: string) => TONE[s] ?? 'info';
// "Done" is the terminal state — the "hide Done" filters and the view/edit
// icon key on it. A Ready to Pay order is still on the manager's plate.
export const isCompleted = (s: string) => s === 'Done';
// The book closes when the review does: from Ready to Pay on, lines, costs
// and ownership are read-only for everyone (managers keep the stage moves).
export const isClosedBook = (s: string) => s === 'Ready to Pay' || s === 'Done';

// Stages only the PO's warehouse manager may take the order into. Mirrors
// WAREHOUSE_MANAGER_GATED in the backend's services/orderAdvance.ts.
export const WAREHOUSE_MANAGER_GATED: OrderStatus[] = ['Reviewing', 'Ready to Pay'];

/**
 * The stages a manager who is not `warehouse`'s manager may NOT pick while the
 * order sits at `savedStatus`: everything from the next gated stage on, since
 * a jump past it crosses it too. Empty when the warehouse has no manager, when
 * the list has not loaded (the backend still refuses), when the user is that
 * manager, or once the order is already past the last gate.
 */
export function warehouseGateLockedStatuses(
  savedStatus: string, warehouse: Warehouse | undefined, userId: string | undefined,
): OrderStatus[] {
  const mgr = warehouse?.managerUserId;
  if (!mgr || mgr === userId) return [];
  const from = ORDER_STATUSES.indexOf(savedStatus as OrderStatus);
  const gates = WAREHOUSE_MANAGER_GATED.map(s => ORDER_STATUSES.indexOf(s)).filter(g => g > from);
  return gates.length ? ORDER_STATUSES.slice(Math.min(...gates)) : [];
}

// Keep in sync with backend ai.ts CONFIDENCE_FLOOR. Lowered from 0.6 → 0.5
// alongside the prompt rubric recalibration in ai/prompts.ts so that clean
// scans with one inferred field don't trip the amber "please verify" banner.
export const AI_CONFIDENCE_FLOOR = 0.5;
// Below this we treat the extraction as "couldn't read the label" — fields are
// still shown (a rough draft beats an empty form) but the banner is escalated
// from amber "please verify" to red "re-shoot or enter manually". Lowered
// 0.3 → 0.25 in tandem with the verify floor; with the new rubric the model
// only reaches the 0.25-0.3 band when the label is genuinely illegible.
export const AI_UNREADABLE_FLOOR = 0.25;
