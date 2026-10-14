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

  it('stops on a cursor it has already followed, marking that page done', async () => {
    const { fetchPage, calls } = endpoint({
      first: { items: [1], nextCursor: 'loop' },
      loop: { items: [1], nextCursor: 'loop' },
    });
    const onPage = vi.fn();
    await forEachKeysetPage(fetchPage, onPage);
    expect(calls).toEqual([null, 'loop']);
    expect(onPage).toHaveBeenCalledTimes(2);
    expect(onPage.mock.calls[1][1]).toEqual({ first: false, done: true });
  });

  // An older backend answers `{ items }` with no cursor field at all.
  it('ends the walk on a reply that omits nextCursor', async () => {
    const fetchPage = vi.fn(async () => ({ items: [1, 2] }) as unknown as Page);
    const onPage = vi.fn();
    await forEachKeysetPage(fetchPage, onPage);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledWith([1, 2], { first: true, done: true });
  });

  // A page cap once ended a real list at 25 pages and called it complete.
  it('follows a long list to its real end', async () => {
    const pages: Record<string, Page> = {};
    for (let i = 0; i < 40; i++) {
      pages[i === 0 ? 'first' : `c${i}`] = { items: [i], nextCursor: i === 39 ? null : `c${i + 1}` };
    }
    const { fetchPage, calls } = endpoint(pages);
    const onPage = vi.fn();
    await forEachKeysetPage(fetchPage, onPage);
    expect(calls).toHaveLength(40);
    expect(onPage).toHaveBeenCalledTimes(40);
    expect(onPage.mock.calls[39][1]).toEqual({ first: false, done: true });
    expect(onPage.mock.calls[38][1]).toEqual({ first: false, done: false });
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
