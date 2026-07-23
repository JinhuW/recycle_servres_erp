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
  'Sold':       'muted',
  'Mixed':      'muted',
  'Pending':    'warn',
  'Received':   'pos',
};

export const statusTone = (s: string) => TONE[s] ?? 'info';
// "Done" is the terminal state — line is locked from further edits.
export const isCompleted = (s: string) => s === 'Done';

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
