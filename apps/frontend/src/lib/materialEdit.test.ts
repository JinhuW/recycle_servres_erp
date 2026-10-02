import { describe, it, expect } from 'vitest';
import { isMaterialPatch, MATERIAL_PATCH_KEYS } from '@recycle-erp/shared';

describe('isMaterialPatch', () => {
  it('reads a note, the supplier, the owner and the commission as not material', () => {
    expect(isMaterialPatch({} as never)).toBe(false);
    expect(isMaterialPatch({ notes: 'x', supplierId: 's', commissionRate: 0.5, onBehalfOfUserId: 'u' } as never)).toBe(false);
  });

  it('reads every listed key as material, and the list keys only when non-empty', () => {
    for (const k of MATERIAL_PATCH_KEYS) {
      const v = k === 'lines' || k === 'addLines' || k === 'removeLineIds' ? [{}] : null;
      expect(isMaterialPatch({ [k]: v } as never), k).toBe(true);
    }
    expect(isMaterialPatch({ lines: [], addLines: [], removeLineIds: [] })).toBe(false);
  });
});
