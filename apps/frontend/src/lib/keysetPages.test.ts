import { describe, it, expect, vi } from 'vitest';
import { forEachKeysetPage } from './keysetPages';

type Page = { items: number[]; nextCursor: string | null };

// A fake endpoint: `pages[cursor]` is what the server returns for that cursor,
// with `null` standing in for the first request.
function endpoint(pages: Record<string, Page>) {
  const calls: (string | null)[] = [];
  const fetchPage = vi.fn(async (cursor: string | null) => {
    calls.push(cursor);
    return pages[cursor ?? 'first'];
  });
  return { fetchPage, calls };
}

describe('forEachKeysetPage', () => {
  it('hands over a single page as both first and done', async () => {
    const { fetchPage, calls } = endpoint({ first: { items: [1, 2], nextCursor: null } });
    const onPage = vi.fn();
    await forEachKeysetPage(fetchPage, onPage);
    expect(calls).toEqual([null]);
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledWith([1, 2], { first: true, done: true });
  });

  it('follows each nextCursor in order and flags only the ends', async () => {
    const { fetchPage, calls } = endpoint({
      first: { items: [1], nextCursor: 'c1' },
      c1: { items: [2], nextCursor: 'c2' },
      c2: { items: [3], nextCursor: null },
    });
    const onPage = vi.fn();
    await forEachKeysetPage(fetchPage, onPage);
    expect(calls).toEqual([null, 'c1', 'c2']);
    expect(onPage.mock.calls).toEqual([
      [[1], { first: true, done: false }],
      [[2], { first: false, done: false }],
      [[3], { first: false, done: true }],
    ]);
  });

  it('stops at maxPages on a cursor that never ends, marking that page done', async () => {
    const { fetchPage, calls } = endpoint({
      first: { items: [1], nextCursor: 'loop' },
      loop: { items: [1], nextCursor: 'loop' },
    });
    const onPage = vi.fn();
    await forEachKeysetPage(fetchPage, onPage, 3);
    expect(calls).toEqual([null, 'loop', 'loop']);
    expect(onPage).toHaveBeenCalledTimes(3);
    expect(onPage.mock.calls[2][1]).toEqual({ first: false, done: true });
  });

  it('stops fetching when onPage returns false', async () => {
    const { fetchPage, calls } = endpoint({
      first: { items: [1], nextCursor: 'c1' },
      c1: { items: [2], nextCursor: null },
    });
    const onPage = vi.fn(() => false);
    await forEachKeysetPage(fetchPage, onPage);
    expect(calls).toEqual([null]);
    expect(onPage).toHaveBeenCalledTimes(1);
  });

  it('rejects when a page fetch rejects, without handing that page over', async () => {
    const fetchPage = vi.fn(async (cursor: string | null) => {
      if (cursor === null) return { items: [1], nextCursor: 'c1' };
      throw new Error('boom');
    });
    const onPage = vi.fn();
    await expect(forEachKeysetPage(fetchPage, onPage)).rejects.toThrow('boom');
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledWith([1], { first: true, done: false });
  });
});
