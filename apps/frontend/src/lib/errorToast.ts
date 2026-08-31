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

import { ApiError, rawFetch } from './api';

declare global {
  interface Window {
    __showToast?: (msg: string, tone?: 'success' | 'error' | 'warn') => void;
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

// A nudge, not a failure: nothing was attempted and nothing was lost, so it
// clears itself instead of taking a click. Errors still go to the dialog.
export function showWarnToast(msg: string): void {
  if (typeof window !== 'undefined' && typeof window.__showToast === 'function') {
    window.__showToast(msg, 'warn');
  } else {
    console.warn('[warn]', msg);
  }
}

// Reporting budget for one page load. A component that throws on every render
// would otherwise post as fast as it can paint, and the code that would throttle
// it is the code that just proved it was broken.
const REPORT_CAP = 5;
let reported = 0;
const seen = new Set<string>();

export function _resetErrorReportingForTests(): void {
  reported = 0;
  seen.clear();
}

/**
 * Send a browser-side failure to the backend so it lands in the operator's log.
 *
 * Fire-and-forget by construction: `rawFetch` returns the raw Response and never
 * throws on a non-2xx, so this cannot re-enter handleFetchError and loop. The
 * only rejection left is the network itself, and that is swallowed — a failure
 * to report a failure is not worth a second dialog.
 */
export function reportClientError(report: {
  message: string;
  kind: 'fetch' | 'render';
  stack?: string;
  componentStack?: string;
  path?: string;
  method?: string;
  status?: number;
  requestId?: string;
}): void {
  if (typeof window === 'undefined') return;
  if (reported >= REPORT_CAP) return;

  // One report per distinct problem — a retry loop on one broken endpoint is
  // one fact, not fifty.
  const key = `${report.kind}:${report.message}:${report.path ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  reported++;

  void rawFetch('POST', '/api/client-errors', {
    ...report,
    href: window.location.href,
    userAgent: navigator.userAgent,
  }).catch(() => { /* the network is already the problem */ });
}

export function handleFetchError(err: unknown): void {
  console.error(err);

  const api = err instanceof ApiError ? err : null;
  const raw = err instanceof Error ? err.message : '';

  reportClientError({
    kind: 'fetch',
    message: raw || String(err),
    stack: err instanceof Error ? err.stack : undefined,
    path: api?.path,
    method: api?.method,
    status: api?.status,
    requestId: api?.requestId,
  });

  const fallback = (typeof window !== 'undefined' && window.__genericErrorMessage)
    || 'Something went wrong. Please try again.';
  // The dialog's title is already "Something went wrong", so falling back to
  // the generic sentence printed the same thing twice and told the user
  // nothing. Anything we actually know beats repeating the headline.
  const msg = raw || fallback;

  // The reference the user can quote and we can grep. Only shown when the
  // backend answered — a request that never landed has no id to give.
  const details: string[] = [];
  if (api?.requestId) {
    const where = api.path ? `${api.method ?? 'GET'} ${api.path}` : 'request';
    details.push(`${where} · ${api.status} · ${api.requestId}`);
  }

  showErrorDialog(msg, details.length ? details : undefined);
}
