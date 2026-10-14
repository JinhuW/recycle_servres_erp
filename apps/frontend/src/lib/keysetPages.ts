export type KeysetPage<T> = { items: T[]; nextCursor: string | null };

export type KeysetPageMeta = { first: boolean; done: boolean };

// Walks a keyset-paginated endpoint to its end, handing each page over as it
// lands so the caller can render the first one before the rest arrive.
// `onPage` returning false stops the walk: a filter change mid-stream must
// stop the fetching, not just the rendering, or every chip click leaves the
// superseded stream pulling pages nobody will see. The walk ends only where
// the server says so — a page cap used to cut a real list at 25 pages (5,000
// POs at the lists' 200) and report it complete. A cursor already followed
// is a server loop; the walk ends there and still reports `done`, so a
// loading indicator can't get stuck. A reply with no `nextCursor` at all is
// the end too: a backend that predates paging sends `{ items }`, and following
// `undefined` refetched page 1 and appended it twice.
export async function forEachKeysetPage<T>(
  fetchPage: (cursor: string | null) => Promise<KeysetPage<T>>,
  onPage: (items: T[], meta: KeysetPageMeta) => boolean | void,
): Promise<void> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; ; page++) {
    const { items, nextCursor } = await fetchPage(cursor);
    const done = nextCursor == null || seen.has(nextCursor);
    if (onPage(items, { first: page === 0, done }) === false || done) return;
    seen.add(nextCursor);
    cursor = nextCursor;
  }
}
