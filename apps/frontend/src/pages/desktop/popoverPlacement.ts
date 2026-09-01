// Viewport coordinates for a `position: fixed` popover hanging off an anchor.
//
// Fixed, not absolute, because both callers sit inside `.table-scroll`, whose
// `overflow-y: hidden` shears anything past the table's bottom edge. That can't
// be fixed in CSS — `overflow-y: visible` next to `overflow-x: auto` computes
// back to `auto` — so the popover has to leave the scroll container, which
// means placing it by hand.
//
// Pure on purpose: the callers own the rect and the listeners, this owns only
// the arithmetic, and the arithmetic is the part that breaks silently.

export type Align = 'left' | 'right';

export interface PlaceArgs {
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
