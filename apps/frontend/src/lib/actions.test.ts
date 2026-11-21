import { describe, expect, it } from 'vitest';
import type { ActionItem, ActionStatus } from '@recycle-erp/shared';
import { applyOrder, linkPath, moveCard, pollIsFresh, slotFromRects, toColumns } from './actions';
import { matchActionCard, pathToDesktopView } from './route';

const card = (id: string, status: ActionStatus, position: number, extra: Partial<ActionItem> = {}): ActionItem => ({
  id, title: id, description: null, status, position, priority: 'normal', dueDate: null,
  assignee: null, createdBy: null, link: null, noteCount: 0,
  completedAt: status === 'done' ? '2026-11-01T00:00:00Z' : null,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', canRemove: true, ...extra,
});
const ids = (items: ActionItem[], s: ActionStatus) => toColumns(items)[s].map(i => i.id);
const board = [card('a', 'todo', 0), card('b', 'todo', 1), card('c', 'todo', 2), card('d', 'done', 0)];

describe('toColumns', () => {
  it('groups by column and orders by position', () => {
    const cols = toColumns([card('x', 'todo', 2), card('y', 'todo', 0), card('z', 'blocked', 0)]);
    expect(cols.todo.map(i => i.id)).toEqual(['y', 'x']);
    expect(cols.blocked.map(i => i.id)).toEqual(['z']);
    expect(cols.in_progress).toEqual([]);
  });
});

describe('moveCard', () => {
  it('reorders inside a column', () => {
    const next = moveCard(board, 'c', 'todo', 'a');
    expect(ids(next, 'todo')).toEqual(['c', 'a', 'b']);
    expect(toColumns(next).todo.map(i => i.position)).toEqual([0, 1, 2]);
  });

  it('moves across columns, to the bottom without a beforeId', () => {
    const next = moveCard(board, 'a', 'done', null);
    expect(ids(next, 'todo')).toEqual(['b', 'c']);
    expect(ids(next, 'done')).toEqual(['d', 'a']);
    expect(toColumns(next).todo.map(i => i.position)).toEqual([0, 1]);
  });

  it('lands at the bottom when beforeId is not in the column', () => {
    expect(ids(moveCard(board, 'a', 'done', 'gone'), 'done')).toEqual(['d', 'a']);
  });

  it('stamps completion on entering Done and clears it on leaving', () => {
    const done = moveCard(board, 'a', 'done', null).find(i => i.id === 'a')!;
    expect(done.completedAt).not.toBeNull();
    const back = moveCard(board, 'd', 'blocked', null).find(i => i.id === 'd')!;
    expect(back.completedAt).toBeNull();
    // Reordering inside Done keeps the original stamp.
    const kept = moveCard(board, 'd', 'done', null).find(i => i.id === 'd')!;
    expect(kept.completedAt).toBe('2026-11-01T00:00:00Z');
  });

  it('leaves the board alone for an unknown card', () => {
    expect(moveCard(board, 'nope', 'done', null)).toEqual(board);
  });
});

describe('applyOrder', () => {
  it('takes the server order for the columns it names', () => {
    const next = applyOrder(board, { todo: ['c', 'b'], done: ['a', 'd'] });
    expect(ids(next, 'todo')).toEqual(['c', 'b']);
    expect(ids(next, 'done')).toEqual(['a', 'd']);
  });

  it('keeps the same object for a card that did not move', () => {
    const next = applyOrder(board, { done: ['d'] });
    expect(next[3]).toBe(board[3]);
  });
});

describe('slotFromRects', () => {
  const rects = [{ id: 'a', top: 0, bottom: 40 }, { id: 'b', top: 50, bottom: 90 }];
  it('drops above the first card whose middle is below the pointer', () => {
    expect(slotFromRects(rects, 10)).toBe('a');
    expect(slotFromRects(rects, 30)).toBe('b');
    expect(slotFromRects(rects, 80)).toBeNull();
    expect(slotFromRects([], 10)).toBeNull();
  });
});

describe('pollIsFresh', () => {
  it('drops a poll that started before the last change or lands mid-drag', () => {
    expect(pollIsFresh(200, 100, false)).toBe(true);
    expect(pollIsFresh(100, 200, false)).toBe(false);
    expect(pollIsFresh(200, 100, true)).toBe(false);
  });
});

describe('links and routes', () => {
  it('maps each record type to its page', () => {
    expect(linkPath({ type: 'po', id: 'PO-1' })).toBe('/purchase-orders/PO-1');
    expect(linkPath({ type: 'ws', id: 'WS-9' })).toBe('/leads/website/WS-9');
    expect(linkPath({ type: 'lot', id: null })).toBeNull();
  });

  it('routes the board, its archive and a card to the Actions view', () => {
    expect(pathToDesktopView('/actions')).toBe('actions');
    expect(pathToDesktopView('/actions/archive')).toBe('actions');
    expect(pathToDesktopView('/actions/TK-1001')).toBe('actions');
    expect(matchActionCard('/actions/TK-1001')).toBe('TK-1001');
    expect(matchActionCard('/actions/archive')).toBeNull();
  });
});
