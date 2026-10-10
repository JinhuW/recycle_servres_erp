import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../pages/desktop/settings/dialogs';
import { useT } from './i18n';
import { hasUnsavedChanges, registerHolder } from './leaveRegistry';
import { setLeaveGuard, splitHash } from './route';

// A screen registers while it holds unsaved edits. The browser then asks
// before a reload or tab close drops them, a link, Back or Forward that would
// unmount the screen asks first (lib/route.ts), and so does anything else about
// to throw it away (Escape, Cancel, the layout switch) through confirmDiscard().
// Leaving an edit page used to just leave, and the typing went with it.
//
// `keepsOn` names the routes the screen survives; by default, the one it was
// on when it became dirty.
// Set while a reload the user already agreed to through confirmDiscard() runs,
// so the browser doesn't ask the same question a second time.
let unloadConfirmed = false;

export async function withConfirmedUnload(run: () => void | Promise<void>): Promise<void> {
  unloadConfirmed = true;
  try {
    await run();
  } finally {
    unloadConfirmed = false;
  }
}

export function useUnsavedGuard(dirty: boolean, keepsOn?: (path: string) => boolean): void {
  const keepsOnRef = useRef(keepsOn);
  keepsOnRef.current = keepsOn;
  useEffect(() => {
    if (!dirty) return;
    const here = splitHash(window.location.hash).path || '/';
    const unregister = registerHolder((p) => (keepsOnRef.current ? keepsOnRef.current(p) : p === here));
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (unloadConfirmed) return;
      e.preventDefault();
      // Some browsers still need the legacy field set to show the prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      unregister();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [dirty]);
}

declare global {
  interface Window {
    __confirmDiscard?: () => Promise<boolean>;
  }
}

/**
 * Asks whether to drop unsaved edits; resolves true to go ahead. Resolves true
 * straight away when nothing would be lost going to `nextPath` (or, with no
 * path, when nothing is unsaved), so callers can always await it.
 */
export function confirmDiscard(nextPath?: string): Promise<boolean> {
  if (!hasUnsavedChanges(nextPath)) return Promise.resolve(true);
  if (typeof window.__confirmDiscard === 'function') return window.__confirmDiscard();
  return Promise.resolve(true);
}

setLeaveGuard({ wouldAsk: (p) => hasUnsavedChanges(p), ask: (p) => confirmDiscard(p) });

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
