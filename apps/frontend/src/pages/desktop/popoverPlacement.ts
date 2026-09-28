// Viewport coordinates for a `position: fixed` popover hanging off an anchor.
//
// Fixed, not absolute, because both callers sit inside `.table-scroll`, whose
// `overflow-y: hidden` shears anything past the table's bottom edge. That can't
// be fixed in CSS — `overflow-y: visible` next to `overflow-x: auto` computes
// back to `auto` — so the popover has to leave the scroll container, which
// means placing it by hand.
//
// `placePopover` is pure on purpose: the arithmetic is the part that breaks
// silently, so it stays testable apart from the listeners `useFixedPopover` owns.

import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

export type Align = 'left' | 'right';

interface PlaceArgs {
  /** The anchor's viewport rect — a DOMRect, or anything with these four. */
  anchor: { top: number; bottom: number; left: number; right: number };
  width: number;
  height: number;
  viewport: { width: number; height: number };
  /** Which of the popover's edges lines up with the anchor's matching edge. */
  align: Align;
  gap: number;
}

export function placePopover({
  anchor, width, height, viewport, align, gap,
}: PlaceArgs): { top: number; left: number } {
  const room = viewport.height - anchor.bottom;

  // Below when it fits, above when it doesn't. The `max` matters for a popover
  // taller than the viewport: flipping it would put its top off-screen, and a
  // panel that starts above the fold can't be scrolled back into view — it's
  // fixed, so the page scroll doesn't move it.
  const top = room < height + gap
    ? Math.max(gap, anchor.top - height - gap)
    : anchor.bottom + gap;

  const start = align === 'right' ? anchor.right - width : anchor.left;
  const left = Math.max(gap, Math.min(start, viewport.width - width - gap));

  return { top, left };
}

/**
 * Keeps a fixed popover placed against its anchor while anything scrolls or
 * the window resizes, and closes it on a mousedown outside `panel`.
 */
export function useFixedPopover(
  anchor: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  { width, height, align, gap }: { width: number; height: number; align: Align; gap: number },
  onClose: () => void,
): { top: number; left: number } | null {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const el = anchor.current;
      if (!el) return;
      setPos(placePopover({
        anchor: el.getBoundingClientRect(),
        width,
        height,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        align,
        gap,
      }));
    };
    place();
    // Capture phase so the inner table scroller is heard, not just the page.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor, width, height, align, gap]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [panel, onClose]);

  return pos;
}
