import { useLayoutEffect, useState, type RefObject } from 'react';

export type ScrollEdges = { atTop: boolean; atBottom: boolean };

// Within this many pixels of an edge counts as at it: a momentum scroll on a
// phone rarely settles on the exact pixel, and a button that stays offered
// for a 2px trip reads as broken.
const SLACK = 24;

export function scrollEdges(
  m: { scrollTop: number; scrollHeight: number; clientHeight: number },
): ScrollEdges {
  return {
    atTop: m.scrollTop <= SLACK,
    atBottom: m.scrollTop + m.clientHeight >= m.scrollHeight - SLACK,
  };
}

// Whether a scroll container sits at its top and bottom, kept current as it
// scrolls and as its content grows or shrinks. The container's own box never
// changes size when content is added, so the content is observed too; it
// must be one element that stays mounted while what it holds changes.
export function useScrollEdges(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ atTop: true, atBottom: true });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const next = scrollEdges(el);
      setEdges(prev => prev.atTop === next.atTop && prev.atBottom === next.atBottom ? prev : next);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (contentRef.current) ro.observe(contentRef.current);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [scrollRef, contentRef]);
  return edges;
}
