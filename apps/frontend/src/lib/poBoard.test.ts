import { describe, expect, it } from 'vitest';
import { poColumns, poDropAction, poStepPath } from './poBoard';

const po = (lifecycle: string, extra: Record<string, unknown> = {}) =>
  ({ lifecycle, userId: 'u1', archivedAt: null, ...extra });
const manager = { id: 'm1', role: 'manager' as const };
const owner = { id: 'u1', role: 'purchaser' as const };
const other = { id: 'u2', role: 'purchaser' as const };

describe('poDropAction', () => {
  it('maps each one-stage-forward drop to its step for a manager', () => {
    expect(poDropAction(po('draft'), 'in_transit', manager)).toBe('handoff');
    expect(poDropAction(po('in_transit'), 'reviewing', manager)).toBe('advance');
    expect(poDropAction(po('reviewing'), 'ready_to_pay', manager)).toBe('boxCheck');
    expect(poDropAction(po('ready_to_pay'), 'done', manager)).toBe('done');
  });

  it('refuses back moves, jumps, same-column drops and archived POs', () => {
    expect(poDropAction(po('reviewing'), 'in_transit', manager)).toBeNull();
    expect(poDropAction(po('draft'), 'reviewing', manager)).toBeNull();
    expect(poDropAction(po('draft'), 'draft', manager)).toBeNull();
    expect(poDropAction(po('done'), 'ready_to_pay', manager)).toBeNull();
    expect(poDropAction(po('draft', { archivedAt: '2026-11-01' }), 'in_transit', manager)).toBeNull();
  });

  it('lets a purchaser hand off only their own Draft', () => {
    expect(poDropAction(po('draft'), 'in_transit', owner)).toBe('handoff');
    expect(poDropAction(po('draft'), 'in_transit', other)).toBeNull();
    expect(poDropAction(po('in_transit'), 'reviewing', owner)).toBeNull();
  });
});

describe('poColumns', () => {
  const orders = [
    { id: 'a', lifecycle: 'draft', createdAt: '2026-11-03', stageSince: '2026-11-05' },
    { id: 'b', lifecycle: 'draft', createdAt: '2026-11-01' },
    { id: 'c', lifecycle: 'done', createdAt: '2026-10-01', stageSince: '2026-10-09' },
    { id: 'd', lifecycle: '', createdAt: '2026-11-04' },
  ];
  it('puts the oldest in stage first and reads a blank stage as Draft', () => {
    const cols = poColumns(orders, false);
    expect(cols.map(c => c.stage)).toEqual(['draft', 'in_transit', 'reviewing', 'ready_to_pay', 'done']);
    expect(cols[0].orders.map(o => o.id)).toEqual(['b', 'd', 'a']);
  });
  it('keeps Done as a drop target, its cards shown only when asked', () => {
    expect(poColumns(orders, false).at(-1)).toMatchObject({ stage: 'done', folded: true, orders: [] });
    expect(poColumns(orders, true).at(-1)?.orders.map(o => o.id)).toEqual(['c']);
  });
});

it('builds the PO page path that opens a step', () => {
  expect(poStepPath('PO-1', 'handoff')).toBe('/purchase-orders/PO-1?step=handoff');
});
