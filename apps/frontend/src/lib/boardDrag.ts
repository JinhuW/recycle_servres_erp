import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { slotFromRects } from './actions';

// Drag-and-drop for card boards, on Pointer Events rather than the HTML5 drag
// API: that one needs a long-press on an iPad (which gets the desktop shell),
// fights the column's own scrolling and gives no control over the ghost. A
// mouse drags a card from anywhere on it; touch and pen only from its
// `data-drag-handle` (styled `touch-action: none`), so a finger can still
// scroll the board. Columns carry `data-col`, cards `data-card-id`.

export type DropTarget = { col: string; beforeId: string | null };

type Options = {
  onDrop: (cardId: string, target: DropTarget) => void;
  /** A column the card may not go to shows no slot and ignores the drop. */
  canDrop?: (cardId: string, col: string) => boolean;
};

type Live = { id: string; dx: number; dy: number; over: DropTarget | null };
type Start = { id: string; x: number; y: number; el: HTMLElement; pointerId: number; active: boolean };

const THRESHOLD = 6;

function targetAt(x: number, y: number, dragId: string): DropTarget | null {
  const colEl = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-col]');
  if (!colEl?.dataset.col) return null;
  const cards = [...colEl.querySelectorAll<HTMLElement>('[data-card-id]')]
    .filter(c => c.dataset.cardId !== dragId)
    .map(c => { const r = c.getBoundingClientRect(); return { id: c.dataset.cardId!, top: r.top, bottom: r.bottom }; });
  return { col: colEl.dataset.col, beforeId: slotFromRects(cards, y) };
}

export function useBoardDrag(options: Options) {
  const opts = useRef(options);
  opts.current = options;
  const start = useRef<Start | null>(null);
  const swallowClick = useRef(false);
  const [live, setLive] = useState<Live | null>(null);

  useEffect(() => {
    const allowed = (id: string, t: DropTarget | null) =>
      t !== null && (opts.current.canDrop?.(id, t.col) ?? true) ? t : null;
    const end = () => { start.current = null; setLive(null); };

    const move = (e: PointerEvent) => {
      const s = start.current;
      if (!s || e.pointerId !== s.pointerId) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (!s.active) {
        if (Math.hypot(dx, dy) < THRESHOLD) return;
        s.active = true;
        try { s.el.setPointerCapture(e.pointerId); } catch { /* the card left the page */ }
      }
      e.preventDefault();
      setLive({ id: s.id, dx, dy, over: allowed(s.id, targetAt(e.clientX, e.clientY, s.id)) });
    };
    const up = (e: PointerEvent) => {
      const s = start.current;
      if (!s || e.pointerId !== s.pointerId) return;
      const target = s.active ? allowed(s.id, targetAt(e.clientX, e.clientY, s.id)) : null;
      if (s.active) {
        // The click that follows the release would open the card.
        swallowClick.current = true;
        setTimeout(() => { swallowClick.current = false; }, 0);
      }
      end();
      if (target) opts.current.onDrop(s.id, target);
    };
    const cancel = (e: PointerEvent) => { if (start.current?.pointerId === e.pointerId) end(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && start.current?.active) { e.stopPropagation(); end(); }
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
    };
  }, []);

  const cardProps = (id: string) => ({
    'data-card-id': id,
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('select, input, textarea, a[href]')) return;
      if (e.pointerType !== 'mouse' && !target.closest('[data-drag-handle]')) return;
      start.current = { id, x: e.clientX, y: e.clientY, el: e.currentTarget, pointerId: e.pointerId, active: false };
    },
    onClickCapture: (e: MouseEvent) => {
      if (swallowClick.current) { e.preventDefault(); e.stopPropagation(); }
    },
    style: live?.id === id
      ? { transform: `translate(${live.dx}px, ${live.dy}px) rotate(1.5deg)`, pointerEvents: 'none', position: 'relative', zIndex: 50 } as CSSProperties
      : undefined,
  });

  return {
    dragId: live?.id ?? null,
    over: live?.over ?? null,
    cardProps,
    colProps: (col: string) => ({ 'data-col': col }),
  };
}
