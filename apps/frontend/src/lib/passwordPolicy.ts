// Client-side password-change rules, shared by the desktop Account panel and
// the mobile password sheet so the two shells can't drift. Mirrors the backend
// (apps/backend/src/routes/me.ts): MIN_PASSWORD_LEN, new must differ from
// current, confirm must match. Confirmation is client-only — the API takes
// only the current + new pair.
import { MIN_PASSWORD_LEN } from '@recycle-erp/shared';
import { ApiError } from './api';

export { MIN_PASSWORD_LEN };

export type PasswordChangeFlags = {
  newTooShort: boolean;
  sameAsCurrent: boolean;
  confirmMismatch: boolean;
  canSubmit: boolean;
};

export function validatePasswordChange(
  current: string,
  next: string,
  confirm: string,
): PasswordChangeFlags {
  return {
    newTooShort: next.length > 0 && next.length < MIN_PASSWORD_LEN,
    sameAsCurrent: next.length > 0 && current.length > 0 && next === current,
    confirmMismatch: confirm.length > 0 && confirm !== next,
    canSubmit:
      current.length > 0 &&
      next.length >= MIN_PASSWORD_LEN &&
      next === confirm &&
      next !== current,
  };
}

// Maps a failed POST /api/me/password to its i18n key. 403 = wrong current
// password (the JWT is still valid), 429 = throttled, else generic.
export function passwordChangeErrorKey(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return 'pwErrorWrongCurrent';
  if (err instanceof ApiError && err.status === 429) return 'pwErrorTooManyAttempts';
  return 'pwErrorGeneric';
}
