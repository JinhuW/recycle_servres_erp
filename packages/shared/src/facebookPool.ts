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
  'assigned',
] as const;
export type FbPoolEventKind = (typeof FB_POOL_EVENT_KINDS)[number];

/** A proxy is DEAD once more distinct accounts than this have failed on it. */
export const FB_PROXY_DEAD_AFTER = 4;

/** How an account's stint on a worker ended: what it became, 'fleet' for
 *  another worker, 'removed' when it left the pool. Null while it is current. */
export type FbStintOutcome = FbPoolStatus | 'removed';

/** Outcomes that count against the proxy the account was on. */
export const FB_FAILED_OUTCOMES: readonly FbStintOutcome[] = ['problem', 'retired'];

/** One account's time on one worker. `proxyKnown` false: nobody recorded the
 *  proxy (stints from before it was kept); true with a null url: the VM's own IP. */
export type FbWorkerStint = {
  accountNo: number;
  uid: string;
  email: string | null;
  proxyUrl: string | null;
  proxyKnown: boolean;
  startedAt: number;
  endedAt: number | null;
  outcome: FbStintOutcome | null;
};

/** A proxy's failed accounts since its last revive. */
export type FbProxyMark = {
  url: string;
  failed: number;
  dead: boolean;
  deadAt: number | null;
  revivedAt: number | null;
  revivedBy: string | null;
};

/** Login outcomes, as the coordinator's ledger records them, that leave the
 *  worker signed in. Every other finished outcome is a failure; a null one is
 *  an attempt that never reported back. */
export const FB_LOGIN_OK_OUTCOMES = ['restored', 'password_ok', 'watch_ok'] as const;

/** One line of an account's timeline: a login attempt from the coordinator's
 *  ledger, an action from the pool's own ledger, or the account entering the
 *  pool. `detail` on a login is what Facebook showed (checkpoint, 2fa…). */
export type FbTimelineEvent =
  | { kind: 'login'; at: number; worker: string; trigger: string | null; outcome: string | null;
      detail: string | null; url: string | null }
  | { kind: 'pool'; at: number; action: FbPoolEventKind; status: FbPoolStatus; detail: string | null; by: string }
  | { kind: 'added'; at: number; batch: string };

/** `logins` says whether the fleet answered: `not_served` is a console that
 *  predates the login route, `unreachable` one that did not answer for any
 *  worker, `partial` some logins missing: a worker that did not answer, or a
 *  ledger that doesn't reach back to when the account went on it. */
export type FbAccountTimeline = {
  events: FbTimelineEvent[];
  logins: 'ok' | 'partial' | 'not_served' | 'unreachable';
};

/** One pool row without its secrets, for pages that need status and holder.
 *  `cookieUid` is the c_user parsed when the cookie was saved; null without a cookie. */
export type PoolAccountSummary = {
  no: number;
  uid: string;
  email: string;
  note: string;
  status: FbPoolStatus;
  holder: string | null;
  holderId: string | null;
  since: number | null;
  addedAt: number;
  cookieAt: number | null;
  aliveCheckedAt: number | null;
  batch: string;
  hasCookie: boolean;
  cookieUid: string | null;
};

/** Fields whose copy or reveal is worth an audit line. */
export const FB_POOL_SECRET_FIELDS = ['password', 'totp', 'emailPassword', 'cookie', 'token'] as const;
export type FbPoolSecretField = (typeof FB_POOL_SECRET_FIELDS)[number];

export type FbPoolDraft = {
  uid: string;
  password: string;
  totp: string;
  email: string;
  emailPassword: string;
  recovery: string;
  cookie: string;
  token: string;
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
  token: 1000,
  note: 2000,
  holder: 120,
};

export const fbUidValid = (uid: string): boolean => /^\d{10,20}$/.test(uid);

const digits = (value: unknown): string | null =>
  (typeof value === 'string' || typeof value === 'number') && /^\d+$/.test(String(value))
    ? String(value)
    : null;

/**
 * The `c_user` cookie is the account's numeric id; the rest of the cookie is
 * the session. Suppliers hand a cookie over as a header line (`k=v; k=v`) or
 * as the JSON a browser extension exports — a list of `{name, value}` objects
 * or one object keyed by name — so all three are read.
 */
export function cookieUid(cookie: string): string | null {
  const text = cookie.trim();
  if (text.startsWith('[') || text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (Array.isArray(parsed)) {
      const entry = (parsed as { name?: unknown; value?: unknown }[]).find(
        (c) => c && typeof c === 'object' && c.name === 'c_user',
      );
      return digits(entry?.value);
    }
    return digits((parsed as Record<string, unknown> | null)?.c_user);
  }
  return /(?:^|;)\s*c_user\s*=\s*(\d+)\s*(?=;|$)/.exec(text)?.[1] ?? null;
}

/** One named cookie's value from a pool cookie, in any of the forms `cookieUid` reads. */
export function cookieValue(cookie: string, name: string): string | null {
  const text = cookie.trim();
  const plain = (value: unknown) => (typeof value === 'string' && value ? value : null);
  if (text.startsWith('[') || text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (Array.isArray(parsed)) {
      const entry = (parsed as { name?: unknown; value?: unknown }[]).find(
        (c) => c && typeof c === 'object' && c.name === name,
      );
      return plain(entry?.value);
    }
    return plain((parsed as Record<string, unknown> | null)?.[name]);
  }
  for (const part of text.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return plain(part.slice(at + 1).trim());
  }
  return null;
}

/**
 * The base32 setup key behind what was pasted: the key itself without the
 * spaces and dashes authenticator apps print, or the `secret` of an
 * `otpauth://` link — the form the fleet credential form already takes. A
 * link without a secret is returned as typed, so validation refuses it.
 */
export function totpKey(input: string): string {
  const text = input.trim();
  if (/^otpauth:\/\//i.test(text)) {
    const secret = /[?&]secret=([^&#]+)/i.exec(text)?.[1];
    if (!secret) return text;
    try {
      return decodeURIComponent(secret).replace(/[\s=-]/g, '').toUpperCase();
    } catch {
      return text;
    }
  }
  return text.replace(/[\s=-]/g, '').toUpperCase();
}

/** Decodes a base32 TOTP setup key or otpauth link; null when a character is outside the alphabet. */
export function base32Bytes(secret: string): Uint8Array<ArrayBuffer> | null {
  const normalized = totpKey(secret);
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
    totp: totpKey(draft.totp),
    email: draft.email.trim(),
    emailPassword: draft.emailPassword,
    recovery: draft.recovery.trim(),
    cookie: draft.cookie.trim(),
    token: draft.token.trim(),
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
