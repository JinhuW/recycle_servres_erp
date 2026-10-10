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
}: PlaceArgs): { top: number; left: number; maxHeight?: number } {
  // The room each side offers the panel itself, gaps already taken off.
  const below = viewport.height - anchor.bottom - gap;
  const above = anchor.top - 2 * gap;

  // Below when it fits, above when that fits instead. When neither does, the
  // roomier side, capped to it: pinned to the viewport's top instead, a tall
  // panel would cover its own anchor, and one that starts above the fold can't
  // be scrolled back into view — it's fixed, so the page scroll doesn't move it.
  let top: number;
  let maxHeight: number | undefined;
  if (height <= below) {
    top = anchor.bottom + gap;
  } else if (height <= above) {
    top = anchor.top - height - gap;
  } else if (below >= above) {
    top = anchor.bottom + gap;
    maxHeight = Math.max(0, below);
  } else {
    top = gap;
    maxHeight = above;
  }

  const start = align === 'right' ? anchor.right - width : anchor.left;
  const left = Math.max(gap, Math.min(start, viewport.width - width - gap));

  return { top, left, maxHeight };
}

export interface PopoverPos {
  top: number;
  left: number;
  maxHeight?: number;
  /** The anchor is scrolled out of sight or covered — the scroller's clip
   *  edge, a sticky header — so the panel would float beside nothing. */
  hidden: boolean;
}

function samePos(a: PopoverPos | null, b: PopoverPos): boolean {
  return !!a && a.top === b.top && a.left === b.left
    && a.maxHeight === b.maxHeight && a.hidden === b.hidden;
}

/**
 * Keeps a fixed popover placed against its anchor, and closes it on a
 * mousedown outside both. The anchor counts as inside: closing on a toggle's
 * mousedown would let its click open a fresh panel straight back up.
 *
 * The panel is measured, not declared — placed above its anchor by a guessed
 * height, a short panel floats well clear of it.  Placement re-runs every
 * frame while open, because an anchor also moves on layout changes (rows
 * filtered out above it, columns re-sized by a page load) that fire no scroll
 * or resize event.
 */
export function useFixedPopover(
  anchor: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  { align, gap }: { align: Align; gap: number },
  onClose: () => void,
): PopoverPos | null {
  const [pos, setPos] = useState<PopoverPos | null>(null);

  useLayoutEffect(() => {
    let last: PopoverPos | null = null;
    let frame = 0;
    const place = () => {
      const el = anchor.current;
      const box = panel.current;
      if (!el || !box) return;
      const rect = el.getBoundingClientRect();
      const next = placePopover({
        anchor: rect,
        width: box.offsetWidth,
        // Not offsetHeight: that is capped by the last placement's maxHeight,
        // and the uncapped height is what decides the next one.
        height: box.scrollHeight,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        align,
        gap,
      });
      const hit = document.elementFromPoint(
        (rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
      const placed = { ...next, hidden: !hit || !(el.contains(hit) || box.contains(hit)) };
      if (!samePos(last, placed)) setPos(last = placed);
    };
    const loop = () => {
      place();
      frame = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(frame);
  }, [anchor, panel, align, gap]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [anchor, panel, onClose]);

  return pos;
}
