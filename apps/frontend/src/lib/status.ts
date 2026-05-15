// Per-line status helpers. The list is sourced from workflow_stages at app
// boot (see lib/lookups.ts); the tone map below stays in code because it's
// presentation, not data.
//
//   Draft (purchaser is preparing) → In Transit → Reviewing → Done.

import { orderStatuses, type OrderStatus } from './lookups';

export const ORDER_STATUSES = orderStatuses;
export type { OrderStatus };

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
