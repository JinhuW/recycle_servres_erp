// Per-line status helpers. The order lifecycle is a fixed set — it's pinned by
// the schema convention on order_lines.status / orders.lifecycle, so it lives
// here as a static constant rather than a manager-editable table.
//
//   Draft (purchaser is preparing) → In Transit → Reviewing → Done.

export type OrderStatus = 'Draft' | 'In Transit' | 'Reviewing' | 'Done';

export const ORDER_STATUSES: OrderStatus[] = ['Draft', 'In Transit', 'Reviewing', 'Done'];

// Canonical order lifecycle. `id` is the slug stored in orders.lifecycle;
// `tone` keys map into DesktopOrders' TONE_VAR for the pipeline cards.
export type WorkflowStage = {
  id: string;
  label: OrderStatus;
  short: string;
  tone: 'muted' | 'info' | 'accent' | 'pos';
  icon: string;
};

export const WORKFLOW_STAGES: WorkflowStage[] = [
  { id: 'draft',      label: 'Draft',      short: 'Draft',   tone: 'muted',  icon: 'edit' },
  { id: 'in_transit', label: 'In Transit', short: 'Transit', tone: 'info',   icon: 'truck' },
  { id: 'reviewing',  label: 'Reviewing',  short: 'Review',  tone: 'accent', icon: 'eye' },
  { id: 'done',       label: 'Done',       short: 'Done',    tone: 'pos',    icon: 'check' },
];

const TONE: Record<string, 'info' | 'warn' | 'pos' | 'accent' | 'muted'> = {
  'Draft':      'muted',
  'In Transit': 'info',
  'Reviewing':  'warn',
  'Done':       'pos',
  'Mixed':      'muted',
};

export const statusTone = (s: string) => TONE[s] ?? 'info';
// "Done" is the terminal state — line is locked from further edits.
export const isCompleted = (s: string) => s === 'Done';
// A line can be added to a sell order once it's been reviewed (priced) or
// completed. Draft / In Transit items aren't ready to sell yet.
export const isSellable = (s: string) => s === 'Reviewing' || s === 'Done';

// Keep in sync with backend ai.ts CONFIDENCE_FLOOR.
export const AI_CONFIDENCE_FLOOR = 0.6;
