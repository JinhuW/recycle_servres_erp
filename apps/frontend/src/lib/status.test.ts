import { describe, it, expect } from 'vitest';
import {
  ORDER_STATUSES, PO_STATUSES, LINE_STATUSES, LIFECYCLE_STATUS, WORKFLOW_STAGES, spineStatus,
  isClosedBook, isCompleted,
} from './status';

describe('stage vocabulary', () => {
  it('Ready to Pay sits between Reviewing and Done, and is a stage, not a line status', () => {
    expect(ORDER_STATUSES).toEqual(['Draft', 'In Transit', 'Reviewing', 'Ready to Pay', 'Done']);
    expect(LIFECYCLE_STATUS.ready_to_pay).toBe('Ready to Pay');
    expect([...LINE_STATUSES]).not.toContain('Ready to Pay');
  });

  it('the book closes at Ready to Pay, but only Done and Sold count as completed', () => {
    expect(isClosedBook('Ready to Pay')).toBe(true);
    expect(isClosedBook('Done')).toBe(true);
    expect(isClosedBook('Sold')).toBe(true);
    expect(isClosedBook('Reviewing')).toBe(false);
    expect(isCompleted('Ready to Pay')).toBe(false);
    expect(isCompleted('Done')).toBe(true);
    expect(isCompleted('Sold')).toBe(true);
  });

  it('Sold is a PO status that shares Done\'s step rather than a stage of its own', () => {
    expect(ORDER_STATUSES).not.toContain('Sold');
    expect(PO_STATUSES).toEqual([...ORDER_STATUSES, 'Sold']);
    expect(LIFECYCLE_STATUS.sold).toBe('Sold');
    expect(WORKFLOW_STAGES.at(-1)).toEqual({ id: 'sold', label: 'Sold' });
    expect(spineStatus('Sold')).toBe('Done');
    for (const s of ORDER_STATUSES) expect(spineStatus(s)).toBe(s);
    expect(ORDER_STATUSES.indexOf(spineStatus('Sold') as typeof ORDER_STATUSES[number])).toBe(4);
  });
});
