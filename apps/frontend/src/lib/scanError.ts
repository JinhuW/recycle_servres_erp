// What to tell someone whose scan just failed.
//
// A 4xx is something they can fix where they are standing — wrong file type,
// image too large — and the backend already names which, so its message is the
// useful one. Anything else (5xx, a timeout, the network) means the recognition
// service itself is down or misconfigured: retaking the photo cannot help, so
// name the escalation rather than echo a backend string nobody outside the team
// can act on.

import { ApiError } from './api';

export function isAiServiceFailure(e: unknown): boolean {
  return !(e instanceof ApiError) || e.status < 400 || e.status >= 500;
}

export function scanErrorMessage(e: unknown, t: (key: string) => string): string {
  if (!isAiServiceFailure(e)) return (e as ApiError).message;
  // The technical detail stays in the console, where support can ask for it.
  console.error('[scan] AI recognition failed', e);
  return t('aiUnavailable');
}
