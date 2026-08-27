// What to tell someone whose scan just failed.
//
// A 4xx is something they can fix where they are standing — wrong file type,
// image too large, too many scans in a minute — and the backend already names
// which, so its message is the useful one. Anything else (5xx, a timeout, the
// network) means the scan pipeline itself is down or misconfigured: retaking
// the photo cannot help, so name the escalation rather than echo a backend
// string nobody outside the team can act on.

import { ApiError } from './api';

export function isAiServiceFailure(e: unknown): boolean {
  return !(e instanceof ApiError) || e.status >= 500;
}

// Either an i18n key to translate, or a message the backend already wrote.
// Callers that hold `t` use scanErrorMessage; the ones that store the failure
// and render it later (useAddPackageForm) keep this shape so the key stays a
// key and both shells render it with one line instead of a copied ternary.
export type ScanErrorBanner = { key: string } | { text: string };

export function scanErrorBanner(e: unknown): ScanErrorBanner {
  if (!isAiServiceFailure(e)) return { text: (e as ApiError).message };
  // The technical detail stays in the console, where support can ask for it.
  console.error('[scan] scan pipeline failed', e);
  return { key: 'aiUnavailable' };
}

export function scanErrorMessage(e: unknown, t: (key: string) => string): string {
  const banner = scanErrorBanner(e);
  return 'text' in banner ? banner.text : t(banner.key);
}
