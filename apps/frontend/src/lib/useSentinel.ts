import { useEffect, type RefObject } from 'react';

/**
 * Calls `onHit` whenever `ref`'s element intersects `root` (the viewport when
 * omitted), inflated by `rootMargin`. The observer is re-armed whenever
 * `onHit` changes identity, so a caller whose loader closes over the current
 * cursor gets a fresh observer per page — the same element already sitting in
 * view fires again for the next one.
 */
export function useSentinel(
  ref: RefObject<Element | null>,
  onHit: () => void,
  active: boolean,
  { root, rootMargin }: { root?: RefObject<Element | null>; rootMargin: string },
): void {
  useEffect(() => {
    const el = ref.current;
    const rootEl = root ? root.current : null;
    if (!el || (root && !rootEl) || !active) return;
    const io = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) onHit(); },
      { root: rootEl, rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, root, rootMargin, onHit, active]);
}
