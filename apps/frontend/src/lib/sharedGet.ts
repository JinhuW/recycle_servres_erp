// One fetch per URL for the Monitors ▸ Facebook pages. The tab, the tab bar's
// counts and the page chrome each read the same fleet, coordinator and pool
// URLs on mount and on aligned poll ticks; without this every caller paid
// for its own copy, and the coordinator's answer takes seconds to build.

import { api } from './api';

// Long enough to cover callers that start in the same render or on the same
// poll tick, short enough that a poll never reads an answer from its own
// previous tick.
export const SHARED_GET_MS = 2_000;

type Entry = { promise: Promise<unknown>; settledAt: number | null };

export type GetDedupe = {
  get: <T>(path: string) => Promise<T>;
  /** Drops every remembered answer: the next read of any URL goes out. */
  forget: () => void;
};

/**
 * A GET that shares one request between callers: while a read of `path` is in
 * flight, or for `windowMs` after it answered, the same promise comes back.
 * A failure is never remembered, so the next caller tries again.
 */
export function createGetDedupe(
  fetchGet: (path: string) => Promise<unknown>,
  windowMs: number = SHARED_GET_MS,
  clock: () => number = Date.now,
): GetDedupe {
  const entries = new Map<string, Entry>();
  return {
    get<T>(path: string): Promise<T> {
      const known = entries.get(path);
      if (known && (known.settledAt === null || clock() - known.settledAt < windowMs)) return known.promise as Promise<T>;
      const entry: Entry = { promise: Promise.resolve(), settledAt: null };
      entry.promise = fetchGet(path).then(
        value => {
          if (entries.get(path) === entry) entry.settledAt = clock();
          return value;
        },
        err => {
          if (entries.get(path) === entry) entries.delete(path);
          throw err;
        },
      );
      entries.set(path, entry);
      return entry.promise as Promise<T>;
    },
    forget: () => entries.clear(),
  };
}

const dedupe = createGetDedupe(path => api.get<unknown>(path));

/** Every read after this goes out again; tests that count requests start here. */
export const forgetSharedGets = (): void => dedupe.forget();

// A write changes what the next read must show, and the page re-reads right
// after it: that read has to go out, not come back from before the write.
const writing = <T,>(p: Promise<T>): Promise<T> => p.finally(dedupe.forget);

/** `api` with deduped GETs; its writes forget every remembered answer. */
export const sharedApi = {
  get: <T,>(path: string) => dedupe.get<T>(path),
  post: <T,>(path: string, body: unknown) => writing(api.post<T>(path, body)),
  put: <T,>(path: string, body: unknown) => writing(api.put<T>(path, body)),
  patch: <T,>(path: string, body: unknown) => writing(api.patch<T>(path, body)),
  delete: <T,>(path: string) => writing(api.delete<T>(path)),
};
