import { describe, it, expect } from 'vitest';
import { derivePoPermissions } from './poPermissions';

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
