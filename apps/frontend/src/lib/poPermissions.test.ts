import { describe, it, expect } from 'vitest';
import { ApiError } from './api';
import { asksManagerTakeover, derivePoPermissions, readManagerChanged } from './poPermissions';

const order = (o: Partial<{ lifecycle: string; archivedAt: string | null; userId: string; everSubmitted: boolean }>) => ({
  lifecycle: 'draft', status: 'Draft', archivedAt: null, userId: 'owner', everSubmitted: false, ...o,
});

describe('derivePoPermissions', () => {
  it('lets the owner edit and delete a fresh draft, with no revert warning', () => {
    const p = derivePoPermissions({ isPurchaser: true, userId: 'owner', order: order({}) });
    expect(p).toMatchObject({ canEditOrder: true, canDelete: true, revertOnSave: false, canAnnotate: true, canReopen: false });
  });

  it('warns a purchaser that editing a submitted PO costs the stage', () => {
    const p = derivePoPermissions({ isPurchaser: true, userId: 'owner', order: order({ lifecycle: 'reviewing', everSubmitted: true }) });
    expect(p).toMatchObject({ canEditOrder: true, revertOnSave: true, canDelete: false });
  });

  it('locks a closed book, keeps a manager the stage moves', () => {
    const pur = derivePoPermissions({ isPurchaser: true, userId: 'owner', order: order({ lifecycle: 'ready_to_pay' }) });
    expect(pur).toMatchObject({ orderLocked: true, canEditOrder: false, canAnnotate: false, canReopen: false });
    const mgr = derivePoPermissions({ isPurchaser: false, userId: 'mgr', order: order({ lifecycle: 'done' }) });
    expect(mgr).toMatchObject({ orderLocked: true, canReopen: true, isOwnerOrManager: true });
  });

  it('locks an archived order and offers no reopen', () => {
    const p = derivePoPermissions({ isPurchaser: false, userId: 'mgr', order: order({ lifecycle: 'done', archivedAt: '2026-10-01' }) });
    expect(p).toMatchObject({ isArchived: true, orderLocked: true, canReopen: false });
  });

  it("gives a purchaser no annotation rights on someone else's PO", () => {
    const p = derivePoPermissions({ isPurchaser: true, userId: 'other', order: order({ lifecycle: 'reviewing' }) });
    expect(p).toMatchObject({ isOwnerOrManager: false, canAnnotate: false });
  });
});

describe('asksManagerTakeover', () => {
  const mgr = { id: 'mgr', role: 'manager' };

  it('asks a manager moving an order someone else manages', () => {
    expect(asksManagerTakeover({ id: 'other' }, mgr)).toBe(true);
  });

  it('does not ask the order\'s own manager, about an unmanaged order, or a purchaser', () => {
    expect(asksManagerTakeover({ id: 'mgr' }, mgr)).toBe(false);
    expect(asksManagerTakeover(null, mgr)).toBe(false);
    expect(asksManagerTakeover(undefined, mgr)).toBe(false);
    expect(asksManagerTakeover({ id: 'other' }, { id: 'pur', role: 'purchaser' })).toBe(false);
    expect(asksManagerTakeover({ id: 'other' }, null)).toBe(false);
  });
});

describe('readManagerChanged', () => {
  const refusal = (manager: unknown) =>
    new ApiError(409, 'x', {}, { error: 'x', code: 'managerChanged', manager });

  it('reads the manager the server named, or that there is none now', () => {
    expect(readManagerChanged(refusal({ id: 'a', name: 'Alex' }))).toEqual({ id: 'a', name: 'Alex' });
    expect(readManagerChanged(refusal(null))).toBeNull();
  });

  it('leaves every other failure alone', () => {
    expect(readManagerChanged(new ApiError(409, 'x', {}, { code: 'stageMoved', lifecycle: 'draft' }))).toBeUndefined();
    expect(readManagerChanged(new ApiError(400, 'x', {}, { code: 'managerChanged', manager: null }))).toBeUndefined();
    expect(readManagerChanged(refusal({ id: 'a' }))).toBeUndefined();
    expect(readManagerChanged(new Error('network'))).toBeUndefined();
  });
});
