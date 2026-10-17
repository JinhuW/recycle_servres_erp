// Facebook account pool: the rules both the pool API and the pool page apply.
// The UI validates as the manager types; the API validates again on write, so
// the two must agree on what a well-formed account is. Error codes are the
// page's translation keys, so a refusal from either side reads the same.

export const FB_POOL_STATUSES = ['available', 'taken', 'fleet', 'problem', 'retired'] as const;
export type FbPoolStatus = (typeof FB_POOL_STATUSES)[number];

/** Statuses that name who has the account: a purchaser, a worker, or whoever reported it. */
export const FB_POOL_HOLDER_STATUSES: readonly FbPoolStatus[] = ['taken', 'fleet', 'problem'];

/** How many accounts one purchaser may hold at once. */
export const FB_POOL_LIMIT = 2;

export const FB_REPORT_REASONS = ['checkpoint', 'wrong_password', 'bad_code', 'disabled'] as const;
export type FbReportReason = (typeof FB_REPORT_REASONS)[number];

export const FB_POOL_EVENT_KINDS = [
  'added',
  'edited',
  'imported',
  'took',
  'returned',
  'reported',
  'retired',
  'removed',
  'copied',
  'revealed',
] as const;
export type FbPoolEventKind = (typeof FB_POOL_EVENT_KINDS)[number];

/** Fields whose copy or reveal is worth an audit line. */
export const FB_POOL_SECRET_FIELDS = ['password', 'totp', 'emailPassword', 'cookie'] as const;
export type FbPoolSecretField = (typeof FB_POOL_SECRET_FIELDS)[number];

export type FbPoolDraft = {
  uid: string;
  password: string;
  totp: string;
  email: string;
  emailPassword: string;
  recovery: string;
  cookie: string;
  note: string;
  status: FbPoolStatus;
  holder: string | null;
};

export const FB_POOL_FIELD_MAX: Record<Exclude<keyof FbPoolDraft, 'status'>, number> = {
  uid: 20,
  password: 500,
  totp: 200,
  email: 320,
  emailPassword: 500,
  recovery: 320,
  cookie: 8000,
  note: 2000,
  holder: 120,
};

export const fbUidValid = (uid: string): boolean => /^\d{10,20}$/.test(uid);

/** The `c_user` cookie is the account's numeric id; the rest of the cookie is the session. */
export const cookieUid = (cookie: string): string | null =>
  /(?:^|;\s*)c_user=(\d+)(?=;|$)/.exec(cookie)?.[1] ?? null;

/** Decodes a base32 TOTP setup key; null when a character is outside the alphabet. */
export function base32Bytes(secret: string): Uint8Array<ArrayBuffer> | null {
  const normalized = secret.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    const n = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);
    if (n < 0) return null;
    value = ((value << 5) | n) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return bytes.length ? new Uint8Array(bytes) : null;
}

export function normalizeFbPoolDraft(draft: FbPoolDraft): FbPoolDraft {
  const holder = draft.holder?.trim() || null;
  return {
    uid: draft.uid.trim(),
    password: draft.password,
    totp: draft.totp.replace(/\s/g, '').toUpperCase(),
    email: draft.email.trim(),
    emailPassword: draft.emailPassword,
    recovery: draft.recovery.trim(),
    cookie: draft.cookie.trim(),
    note: draft.note.trim(),
    status: draft.status,
    holder: FB_POOL_HOLDER_STATUSES.includes(draft.status) ? holder : null,
  };
}

/**
 * Validation codes for a normalized draft. `existingUids` holds every other
 * account's uid; pass `selfUid` when editing so the account doesn't collide
 * with itself.
 */
export function validateFbPoolDraft(
  draft: FbPoolDraft,
  existingUids: ReadonlySet<string>,
  selfUid?: string,
): string[] {
  const errors: string[] = [];
  if (!fbUidValid(draft.uid)) errors.push('fpInvalidUid');
  if (existingUids.has(draft.uid) && draft.uid !== selfUid) errors.push('fpDuplicate');
  if (!draft.password.trim()) errors.push('fpPasswordRequired');
  if (draft.totp && !base32Bytes(draft.totp)) errors.push('fpInvalidKey');
  if (['taken', 'fleet'].includes(draft.status) && !draft.holder?.trim())
    errors.push('fpHolderRequired');
  if (
    (Object.keys(FB_POOL_FIELD_MAX) as (keyof typeof FB_POOL_FIELD_MAX)[]).some(
      (field) => (draft[field] ?? '').length > FB_POOL_FIELD_MAX[field],
    )
  )
    errors.push('fpTooLong');
  return errors;
}
