import { useEffect } from 'react';

// Shared Escape-to-close listener. Replaces the ~8x duplicated effect that
// attached a window keydown handler firing an onClose/onCancel callback.
//
// Semantics preserved from the call sites it replaces:
//  - listener is attached to `window` and removed on cleanup
//  - handler fires only on `key === 'Escape'`
//  - when `active` is false the listener is not attached at all, so the
//    handler can never fire (mirrors the `if (cond) return;` guard sites)
export function useEscapeKey(handler: () => void, active = true): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handler();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handler, active]);
}
