// Service-worker registration + update bridge.
//
// vite-plugin-pwa's prompt flow: the SW installs in the background and
// waits in `installing` until the user accepts an update. The update-toast
// component listens for the 'pwa:needRefresh' event and calls
// applyPwaUpdate() when the user clicks. Registration failures surface via
// console.error to avoid the silent-fallback pattern the codebase guards
// against elsewhere.

import { registerSW } from 'virtual:pwa-register';
import { vendorTokenFromPath } from './vendor';

let applyUpdateFn: (() => Promise<void>) | null = null;

export function registerPwa(): void {
  if (!('serviceWorker' in navigator)) return;
  // The vendor portal is its own short-lived URL space; skip SW there.
  if (vendorTokenFromPath(window.location.pathname)) return;

  const updateSW = registerSW({
    onNeedRefresh() {
      applyUpdateFn = () => updateSW(true);
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
