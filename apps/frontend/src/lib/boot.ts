// Reader for the speculative fetches the boot script starts before the entry
// bundle has parsed (see ../../vite-plugin-boot.ts). In dev, and on the vendor
// and seller portals, there is no boot script and every caller falls through to
// its normal api.get.

declare global {
  interface Window {
    __boot?: Record<string, Promise<unknown> | undefined>;
  }
}

/**
 * The prefetched body for `url`, or null if there wasn't one — no boot script,
 * a network failure, or a non-OK response, which is most often the 401 of an
 * expired access cookie. Null means "fetch it properly": the api.ts path
 * refreshes and retries, which the raw boot fetch deliberately does not.
 *
 * One-shot. A second call re-fetches rather than replaying boot data, so a
 * remount after a login gets the new user rather than the logged-out 401.
 */
export async function takeBoot<T>(url: string): Promise<T | null> {
  if (typeof window === 'undefined') return null;
  const pending = window.__boot?.[url];
  if (!pending) return null;
  delete window.__boot![url];
  return (await pending) as T | null;
}
