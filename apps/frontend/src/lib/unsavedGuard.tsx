import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../pages/desktop/settings/dialogs';
import { useT } from './i18n';

// Screens holding edits nobody has saved. A screen registers while it is
// dirty. The browser then asks before a reload or tab close drops the edits,
// and anything about to throw the screen away (Escape, Cancel, Back, the
// layout switch) asks first through confirmDiscard(). Leaving an edit page used
// to just leave, and the typing went with it.
const holders = new Set<symbol>();

export function useUnsavedGuard(dirty: boolean): void {
  const key = useRef(Symbol('unsaved'));
  useEffect(() => {
    const k = key.current;
    if (!dirty) {
      holders.delete(k);
      return;
    }
    holders.add(k);
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Some browsers still need the legacy field set to show the prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      holders.delete(k);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [dirty]);
}

export function hasUnsavedChanges(): boolean {
  return holders.size > 0;
}

declare global {
  interface Window {
    __confirmDiscard?: () => Promise<boolean>;
  }
}

/**
 * Asks whether to drop unsaved edits; resolves true to go ahead. Resolves true
 * straight away when nothing is unsaved, so callers can always await it.
 */
export function confirmDiscard(): Promise<boolean> {
  if (!hasUnsavedChanges()) return Promise.resolve(true);
  if (typeof window.__confirmDiscard === 'function') return window.__confirmDiscard();
  return Promise.resolve(true);
}

// Mounted once at the root, beside both shells, so either can ask.
export function DiscardConfirmHost() {
  const { t } = useT();
  const [pending, setPending] = useState<((ok: boolean) => void) | null>(null);
  useEffect(() => {
    window.__confirmDiscard = () => new Promise<boolean>((resolve) => setPending(() => resolve));
    return () => { delete window.__confirmDiscard; };
  }, []);
  if (!pending) return null;
  const answer = (ok: boolean) => { pending(ok); setPending(null); };
  return (
    <ConfirmDialog
      title={t('unsavedTitle')}
      message={t('unsavedMsg')}
      confirmLabel={t('unsavedDiscard')}
      danger
      onCancel={() => answer(false)}
      onConfirm={() => answer(true)}
    />
  );
}
