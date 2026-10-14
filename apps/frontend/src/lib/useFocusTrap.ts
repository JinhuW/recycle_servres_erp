import { useEffect, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(', ');

// The dialogs that are open, innermost last: only the top one answers Tab,
// so a nested dialog (rendered as a sibling of its parent's panel, not a
// child) is not pulled back into the parent.
const open: symbol[] = [];

// Keeps Tab and Shift+Tab inside `ref` while `active`. The shared Modal set
// aria-modal and moved focus in, but nothing kept it there: a keyboard user
// tabbed out onto the page behind the dialog and could trigger navigation
// and actions while it stayed open. Document-level, so an overlay that is
// not a Modal needs one line and a ref.
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return;
    const id = Symbol('focus-trap');
    open.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || open[open.length - 1] !== id) return;
      const root = ref.current;
      if (!root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) { e.preventDefault(); root.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (!(current instanceof HTMLElement) || !root.contains(current)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && current === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const at = open.indexOf(id);
      if (at >= 0) open.splice(at, 1);
    };
  }, [ref, active]);
}
