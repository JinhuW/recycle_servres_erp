import { describe, it, expect } from 'vitest';
import {
  ORDER_STATUSES, LINE_STATUSES, LIFECYCLE_STATUS, WORKFLOW_STAGES,
  isClosedBook, isCompleted,
} from './status';

describe('stage vocabulary', () => {
  it('Ready to Pay sits between Reviewing and Done, and is a stage, not a line status', () => {
    expect(ORDER_STATUSES).toEqual(['Draft', 'In Transit', 'Reviewing', 'Ready to Pay', 'Done']);
    expect(LIFECYCLE_STATUS.ready_to_pay).toBe('Ready to Pay');
    expect([...LINE_STATUSES]).not.toContain('Ready to Pay');
  });

  it('the book closes at Ready to Pay, but only Done counts as completed', () => {
    expect(isClosedBook('Ready to Pay')).toBe(true);
    expect(isClosedBook('Done')).toBe(true);
    expect(isClosedBook('Reviewing')).toBe(false);
    expect(isCompleted('Ready to Pay')).toBe(false);
    expect(isCompleted('Done')).toBe(true);
  });

  it('Sold is a flag beside the stage, not a stage', () => {
    expect(ORDER_STATUSES).not.toContain('Sold');
    expect(WORKFLOW_STAGES.map(s => s.label)).toEqual(ORDER_STATUSES);
    expect(LIFECYCLE_STATUS.sold).toBeUndefined();
  });
});
