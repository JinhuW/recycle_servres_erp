/**
 * Centralized error-surfacing helpers.
 *
 * Errors are shown in a blocking dialog, never a corner toast — a validation
 * message that fades after 2.6s is a message the user has to guess at. The
 * shell components (DesktopApp, MobileApp) register `window.__showErrorDialog`
 * (errors) and `window.__showToast` (success) on mount; any module can call
 * these helpers without being directly coupled to a React tree. Falls back to
 * console.error when no shell is mounted (tests, SSR, errors during initial
 * render).
 *
 * Usage:
 *   api.get(...).then(...).catch(handleFetchError)   // fetch failures
 *   showErrorDialog('Could not parse total cost')     // validation errors
 *   showErrorDialog(msg, ['Line 2: …', 'Line 4: …'])  // with per-item detail
 *
 * The LangProvider (lib/i18n.tsx) sets `__genericErrorMessage` to the
 * translated fallback so non-React modules surface localised text when an
 * error doesn't carry its own message.
 */

declare global {
  interface Window {
    __showToast?: (msg: string, tone?: 'success' | 'error') => void;
    __showErrorDialog?: (msg: string, details?: string[], title?: string) => void;
    __genericErrorMessage?: string;
  }
}

export function showErrorDialog(msg: string, details?: string[], title?: string): void {
  if (typeof window !== 'undefined' && typeof window.__showErrorDialog === 'function') {
    window.__showErrorDialog(msg, details, title);
  } else {
    console.error('[error]', msg, details ?? '');
  }
}

export function handleFetchError(err: unknown): void {
  console.error(err);

  const fallback = (typeof window !== 'undefined' && window.__genericErrorMessage)
    || 'Something went wrong. Please try again.';
  const msg = err instanceof Error ? err.message : fallback;

  showErrorDialog(msg);
}
