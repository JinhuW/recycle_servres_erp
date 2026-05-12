import { useEffect, useState, type RefObject } from 'react';

/**
 * Returns true once the scroll container has been scrolled past `threshold`px.
 * Used by mobile page headers to toggle the `.ph-header.scrolled` treatment.
 */
export function usePhScrolled(ref: RefObject<HTMLElement | null>, threshold = 4): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => setScrolled(el.scrollTop > threshold);
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); };
  }, [ref, threshold]);
  return scrolled;
}
