import { useEffect, useRef, useState } from 'react';
import { allocateEscapeOrder, createEscapeStack } from './escapeStack';

// Every open layer registers here and one window listener serves them all, so
// one press closes the top layer only — the page under a dialog stays open.
const stack = createEscapeStack();

// Bubble phase: a control that handles Escape itself (a combobox, an inline
// editor) and stops propagation keeps it from closing the dialog around it.
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') stack.dispatch();
}

// `active = false` removes the layer, so the press reaches the one beneath.
// That is right only for a component that is mounted but hidden; an open
// dialog that is busy must stay active and guard inside its handler, or Escape
// falls through and closes whatever it is covering.
export function useEscapeKey(handler: () => void, active = true): void {
  const handlerRef = useRef(handler);
  useEffect(() => { handlerRef.current = handler; });
  // Allocated at first render: parents render before their children, so the
  // order follows the tree even though child effects run first.
  const [order] = useState(allocateEscapeOrder);

  useEffect(() => {
    if (!active) return;
    const remove = stack.push(order, () => handlerRef.current());
    if (stack.size() === 1) window.addEventListener('keydown', onKey);
    return () => {
      remove();
      if (stack.size() === 0) window.removeEventListener('keydown', onKey);
    };
  }, [active, order]);
}
