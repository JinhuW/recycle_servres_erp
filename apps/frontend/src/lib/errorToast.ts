/**
 * Centralized error-surfacing helpers.
 *
 * The shell components (DesktopApp, MobileApp) register `window.__showToast`
 * on mount; any module can call it through these helpers without being
 * directly coupled to a React tree. Falls back to console.error when no
 * shell is mounted (tests, SSR, errors during initial render).
 *
 * Usage:
 *   api.get(...).then(...).catch(handleFetchError)   // fetch failures
 *   showErrorToast('Could not parse total cost')      // validation errors
 */

declare global {
  interface Window {
    __showToast?: (msg: string, tone?: 'success' | 'error') => void;
  }
}

export function showErrorToast(msg: string): void {
  if (typeof window !== 'undefined' && typeof window.__showToast === 'function') {
    window.__showToast(msg, 'error');
  } else {
    console.error('[toast]', msg);
  }
}

export function handleFetchError(err: unknown): void {
  console.error(err);

  const msg =
    err instanceof Error ? err.message : 'Something went wrong. Please try again.';

  if (typeof window !== 'undefined' && typeof window.__showToast === 'function') {
    window.__showToast(msg, 'error');
  }
}
