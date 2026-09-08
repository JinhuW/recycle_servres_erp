import { describe, it, expect } from 'vitest';
import {
  ORDER_STATUSES, LINE_STATUSES, LIFECYCLE_STATUS, isClosedBook, isCompleted,
  warehouseGateLockedStatuses,
} from './status';
import type { Warehouse } from './types';

const wh = (managerUserId: string | null): Warehouse =>
  ({ id: 'WH-BOS', name: 'Boston', short: 'BOS', region: 'US-East', managerUserId }) as Warehouse;

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
});

describe('warehouseGateLockedStatuses', () => {
  it('locks nothing without an assigned manager, or for that manager', () => {
    expect(warehouseGateLockedStatuses('In Transit', undefined, 'u1')).toEqual([]);
    expect(warehouseGateLockedStatuses('In Transit', wh(null), 'u1')).toEqual([]);
    expect(warehouseGateLockedStatuses('In Transit', wh('u1'), 'u1')).toEqual([]);
  });

  it('holds another manager off the next gate and everything past it', () => {
    expect(warehouseGateLockedStatuses('Draft', wh('u1'), 'u2')).toEqual(['Reviewing', 'Ready to Pay', 'Done']);
    expect(warehouseGateLockedStatuses('In Transit', wh('u1'), 'u2')).toEqual(['Reviewing', 'Ready to Pay', 'Done']);
    expect(warehouseGateLockedStatuses('Reviewing', wh('u1'), 'u2')).toEqual(['Ready to Pay', 'Done']);
  });

  it('opens up once the order is past the last gate, so Done and the reopens are anyone\'s', () => {
    expect(warehouseGateLockedStatuses('Ready to Pay', wh('u1'), 'u2')).toEqual([]);
    expect(warehouseGateLockedStatuses('Done', wh('u1'), 'u2')).toEqual([]);
  });
});
