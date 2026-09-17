import { useLayoutEffect, useState, type RefObject } from 'react';

// The rendered width of an element, kept current by a ResizeObserver. The SVG
// charts scale their coordinate space to it so text never stretches the way a
// `preserveAspectRatio="none"` viewBox would.
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
