import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * In-memory (per page load) cache for list-page UI state so that returning
 * from a detail/edit page lands you exactly where you were.
 *
 * The desktop shell unmounts a list when you open an order / PO / inventory
 * item (the edit page is rendered in its place), so component state would
 * otherwise reset. This survives that unmount/remount cycle without touching
 * the URL or localStorage — it's deliberately ephemeral (a full reload starts
 * fresh, which is the expected "clean slate" behaviour).
 */
const mem = new Map<string, unknown>();

/** `useState` whose value is remembered under `key` across unmount/remount. */
export function usePersisted<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [val, setVal] = useState<T>(() => (mem.has(key) ? (mem.get(key) as T) : initial));
  useEffect(() => { mem.set(key, val); }, [key, val]);
  return [val, setVal];
}

/**
 * Remembers the scrollTop of a scroll container under `key`. Returns a
 * callback ref to put on the scrolling element. Restoration is deferred until
 * `ready` is true (i.e. the list rows have actually rendered) so the saved
 * offset isn't clamped against a still-empty/skeleton container.
 */
export function useScrollMemory(key: string, ready: boolean): (el: HTMLElement | null) => void {
  const sk = key + ':scroll';
  const elRef = useRef<HTMLElement | null>(null);
  const restored = useRef(false);

  const setRef = (el: HTMLElement | null) => {
    if (elRef.current === el) return;
    elRef.current = el;
    if (el) {
      el.addEventListener(
        'scroll',
        () => { mem.set(sk, el.scrollTop); },
        { passive: true },
      );
    }
  };

  useLayoutEffect(() => {
    if (restored.current || !ready) return;
    const el = elRef.current;
    const y = mem.get(sk);
    if (el && typeof y === 'number') {
      el.scrollTop = y;
      restored.current = true;
    }
  }, [ready, sk]);

  return setRef;
}
