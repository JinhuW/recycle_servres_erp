// Service-worker registration + update bridge.
//
// vite-plugin-pwa's prompt flow: the SW installs in the background and
// waits in `installing` until the user accepts an update. The update-toast
// component listens for the 'pwa:needRefresh' event and calls
// applyPwaUpdate() when the user clicks.

import { registerSW } from 'virtual:pwa-register';

let applyUpdateFn: (() => Promise<void>) | null = null;

export function registerPwa(): void {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  // The vendor portal is its own short-lived URL space; skip SW there.
  if (window.location.pathname.startsWith('/v/')) return;

  const updateSW = registerSW({
    onNeedRefresh() {
      applyUpdateFn = async () => {
        await updateSW(true); // reload after the new SW activates
      };
      window.dispatchEvent(new CustomEvent('pwa:needRefresh'));
    },
    onOfflineReady() {
      window.dispatchEvent(new CustomEvent('pwa:offlineReady'));
    },
  });
}

export function applyPwaUpdate(): Promise<void> | void {
  if (applyUpdateFn) return applyUpdateFn();
}
