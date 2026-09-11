import { describe, it, expect } from 'vitest';
import { ApiError } from './api';
import { readArchiveConflict } from './archiveConflict';

const conflictBody = {
  error: 'Lines in this order are on open sell orders.',
  code: 'committedLines',
  sellOrders: [
    { id: 'SO-4001', status: 'Draft', lineCount: 1, lines: [{ solId: 'sol-1', inventoryId: 'a', label: 'Samsung 32GB', qty: 2 }] },
    { id: 'SO-4002', status: 'Shipped', lineCount: 3, lines: [{ solId: 'sol-2', inventoryId: 'b', label: 'Micron 16GB', qty: 1 }] },
  ],
};

describe('readArchiveConflict', () => {
  it('reads the sell orders off the committed-lines 409', () => {
    const c = readArchiveConflict(new ApiError(409, conflictBody.error, {}, conflictBody));
    expect(c?.sellOrders.map(s => s.id)).toEqual(['SO-4001', 'SO-4002']);
    expect(c?.sellOrders[1].status).toBe('Shipped');
    expect(c?.sellOrders[0].lines).toEqual([{ solId: 'sol-1', inventoryId: 'a', label: 'Samsung 32GB', qty: 2 }]);
  });

  // A sell order may name one lot twice; the two entries must stay apart even
  // when an older backend sends no solId.
  it('keys lines by the sell-order line, falling back to position', () => {
    const body = {
      code: 'committedLines',
      sellOrders: [{ id: 'SO-1', status: 'Draft', lineCount: 2, lines: [
        { inventoryId: 'a', label: 'x', qty: 1 }, { inventoryId: 'a', label: 'x', qty: 2 },
      ] }],
    };
    const c = readArchiveConflict(new ApiError(409, 'x', {}, body));
    expect(c?.sellOrders[0].lines.map(l => l.solId)).toEqual(['0', '1']);
  });

  it('marks a sell order emptied only when every line it holds is being removed', () => {
    const c = readArchiveConflict(new ApiError(409, 'x', {}, conflictBody));
    expect(c?.sellOrders.map(s => s.emptied)).toEqual([true, false]);
  });

  // The archive endpoint has two other 409s; neither is a question.
  it('ignores a 409 without the code, and any other status', () => {
    expect(readArchiveConflict(new ApiError(409, 'Order is already archived', {}, { error: 'x' }))).toBeNull();
    expect(readArchiveConflict(new ApiError(409, 'transfer', {}, { error: 'x', offendingLineIds: ['a'] }))).toBeNull();
    expect(readArchiveConflict(new ApiError(403, 'Forbidden', {}, conflictBody))).toBeNull();
    expect(readArchiveConflict(new TypeError('Failed to fetch'))).toBeNull();
  });

  it('drops malformed entries instead of rendering them', () => {
    const body = { code: 'committedLines', sellOrders: [{ id: 42, lines: [] }, { id: 'SO-1', lines: 'no' }] };
    expect(readArchiveConflict(new ApiError(409, 'x', {}, body))).toBeNull();
  });
});
