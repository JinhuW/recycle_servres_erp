// Per-line status helpers. Matches the desktop bundle's ORDER_STATUSES:
//   Draft (purchaser is preparing) → In Transit → Reviewing → Done.

export const ORDER_STATUSES = ['Draft', 'In Transit', 'Reviewing', 'Done'] as const;

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

// Workflow lifecycle (separate from per-line status) — fetched from
// /api/workflow at runtime; kept in sync with the seed.
