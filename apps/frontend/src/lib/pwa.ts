// Service-worker registration + update bridge.
//
// PWA is mobile-only by product decision; this module is a no-op on desktop
// and on the vendor portal. vite-plugin-pwa's prompt flow: the SW installs
// in the background and waits in `installing` until the user accepts an
// update. The update-toast component listens for the 'pwa:needRefresh'
// event and calls applyPwaUpdate() when the user clicks. Registration
// failures surface via console.error to avoid the silent-fallback pattern
// the codebase guards against elsewhere.

import { registerSW } from 'virtual:pwa-register';
import { vendorTokenFromPath } from './vendor';

let applyUpdateFn: (() => Promise<void>) | null = null;
let updatePending = false;

// The 'pwa:needRefresh' event is fire-and-forget and the update toast is
// lazy-loaded, so a listener mounted after the event would miss it — with a
// waiting SW left over from a previous session, onNeedRefresh fires almost
// immediately at registration. The toast reads this flag on mount instead.
export function pwaUpdatePending(): boolean {
  return updatePending;
}

export function registerPwa(): void {
  if (!('serviceWorker' in navigator)) return;
  // The vendor portal is its own short-lived URL space; skip SW there.
  if (vendorTokenFromPath(window.location.pathname)) return;
  // Matches the App.tsx PHONE_BREAKPOINT — PWA is mobile-only.
  if (window.innerWidth >= 720) {
    // A SW registered during a narrow-width visit (device emulation, resized
    // window) keeps serving its precached build to desktop loads forever:
    // registerSW never runs here, so no update prompt can ever fire. Drop the
    // registration; the current page stays SW-served, the next load is network.
    void navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) void reg.unregister();
    });
    return;
  }

  const updateSW = registerSW({
    onNeedRefresh() {
      applyUpdateFn = () => updateSW(true);
      updatePending = true;
      window.dispatchEvent(new CustomEvent('pwa:needRefresh'));
    },
    onOfflineReady() {
      window.dispatchEvent(new CustomEvent('pwa:offlineReady'));
    },
    onRegisterError(err) {
      console.error('[pwa] service worker registration failed', err);
    },
  });
}

export async function applyPwaUpdate(): Promise<void> {
  if (applyUpdateFn) await applyUpdateFn();
}
