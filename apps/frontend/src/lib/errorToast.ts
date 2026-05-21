/**
 * Centralized fetch-error handler.
 *
 * Usage:  api.get(...).then(...).catch(handleFetchError)
 *
 * - Always logs to console.error so DevTools capture it.
 * - Emits a CustomEvent so any shell component (DesktopApp, MobileApp) can
 *   surface a toast without being directly coupled to this module.
 * - If a host page registers `window.__showToast`, that function is called
 *   directly (optional progressive-enhancement).
 */

declare global {
  interface Window {
    __showToast?: (msg: string, tone?: string) => void;
  }
}

export function handleFetchError(err: unknown): void {
  console.error(err);

  const msg =
    err instanceof Error ? err.message : 'Something went wrong. Please try again.';

  // Emit a CustomEvent — listeners in DesktopApp/MobileApp can pick this up.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('app:error', { detail: { message: msg } }),
    );

    // Progressive enhancement: if the host registered a direct toast hook, call it.
    if (typeof window.__showToast === 'function') {
      window.__showToast(msg, 'error');
    }
  }
}
