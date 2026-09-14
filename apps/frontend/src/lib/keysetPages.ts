export type KeysetPage<T> = { items: T[]; nextCursor: string | null };

export type KeysetPageMeta = { first: boolean; done: boolean };

// Walks a keyset-paginated endpoint to its end, handing each page over as it
// lands so the caller can render the first one before the rest arrive.
// `onPage` returning false stops the walk: a filter change mid-stream must
// stop the fetching, not just the rendering, or every chip click leaves the
// superseded stream pulling pages nobody will see. `maxPages` only bounds a
// runaway cursor (a server bug), never a real list — the page it cuts at is
// still reported as `done` so a loading indicator can't get stuck.
export async function forEachKeysetPage<T>(
  fetchPage: (cursor: string | null) => Promise<KeysetPage<T>>,
  onPage: (items: T[], meta: KeysetPageMeta) => boolean | void,
  maxPages = 25,
): Promise<void> {
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const { items, nextCursor } = await fetchPage(cursor);
    const done = nextCursor === null || page === maxPages - 1;
    if (onPage(items, { first: page === 0, done }) === false || done) return;
    cursor = nextCursor;
  }
}
