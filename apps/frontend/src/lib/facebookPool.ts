// The pool page's view helpers and its API client. The rules both the page
// and the API apply (statuses, limit, draft validation) live in
// @recycle-erp/shared. Never persist login secrets in the browser.
import {
  FB_POOL_LIMIT,
  FB_POOL_STATUSES,
  base32Bytes,
  cookieUid,
  totpKey,
  validateFbPoolDraft,
  type FbPoolDraft,
  type FbPoolEventKind,
  type FbPoolSecretField,
  type FbPoolStatus,
  type FbReportReason,
} from '@recycle-erp/shared';
import { api } from './api';

export { base32Bytes, cookieUid, totpKey };
export const POOL_STATUSES = FB_POOL_STATUSES;
export const POOL_LIMIT = FB_POOL_LIMIT;
export type PoolStatus = FbPoolStatus;
export type PoolDraft = FbPoolDraft;
export const DAY = 86_400_000;
export type PoolAccount = {
  no: number;
  uid: string;
  password: string;
  totp: string;
  email: string;
  emailPassword: string;
  recovery: string;
  cookie: string;
  note: string;
  status: PoolStatus;
  holder: string | null;
  holderId: string | null;
  since: number | null;
  addedAt: number;
  cookieAt: number | null;
  batch: string;
};
export type PoolActivity = {
  at: number;
  who: string;
  action: FbPoolEventKind;
  accountNo?: number;
  detail?: string;
  status: PoolStatus;
};
export type PoolSnapshot = { accounts: PoolAccount[]; activity: PoolActivity[] };
/** The translation key for an activity verb: `took` → `fpLogTook`. */
export const activityKey = (action: string) => `fpLog${action[0].toUpperCase()}${action.slice(1)}`;
export const REPORT_REASON_KEYS: Record<FbReportReason, string> = {
  checkpoint: 'fpCheckpoint',
  wrong_password: 'fpWrongPassword',
  bad_code: 'fpBadCode',
  disabled: 'fpDisabled',
};
export const emptyPoolDraft = (): PoolDraft => ({
  uid: '',
  password: '',
  totp: '',
  email: '',
  emailPassword: '',
  recovery: '',
  cookie: '',
  note: '',
  status: 'available',
  holder: null,
});
/**
 * A fleet account's holder is the worker using it, so picking the worker is
 * what makes the account Fleet; picking none puts a fleet account back on the
 * rack and leaves any other status alone.
 */
export function assignWorker(draft: PoolDraft, workerId: string | null): PoolDraft {
  if (workerId) return { ...draft, status: 'fleet', holder: workerId };
  return draft.status === 'fleet' ? { ...draft, status: 'available', holder: null } : draft;
}
export function cookieHealth(
  a: Pick<PoolAccount, 'uid' | 'cookie' | 'cookieAt'>,
  now = Date.now(),
) {
  if (!a.cookie) return { kind: 'none', days: 0 } as const;
  const uid = cookieUid(a.cookie);
  if (!uid) return { kind: 'missing', days: 0 } as const;
  if (uid !== a.uid) return { kind: 'mismatch', days: 0 } as const;
  const days = a.cookieAt === null ? null : Math.max(0, Math.floor((now - a.cookieAt) / DAY));
  if (days === null) return { kind: 'unknown', days: 0 } as const;
  return { kind: days > 21 ? 'stale' : 'fresh', days } as const;
}
export async function poolTotp(secret: string, now = Date.now()): Promise<string | null> {
  const bytes = base32Bytes(secret);
  if (!bytes) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      bytes,
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign'],
    );
    const counter = Math.floor(now / 30_000);
    const buffer = new ArrayBuffer(8),
      view = new DataView(buffer);
    view.setUint32(0, Math.floor(counter / 2 ** 32));
    view.setUint32(4, counter >>> 0);
    const hash = new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer));
    const offset = hash[19] & 15;
    const code =
      ((hash[offset] & 127) * 2 ** 24 +
        (hash[offset + 1] << 16) +
        (hash[offset + 2] << 8) +
        hash[offset + 3]) %
      1e6;
    return String(code).padStart(6, '0');
  } catch {
    return null;
  }
}
export function validatePoolDraft(
  draft: PoolDraft,
  accounts: readonly PoolAccount[],
  no?: number,
): string[] {
  return validateFbPoolDraft(
    draft,
    new Set(accounts.filter((a) => a.no !== no).map((a) => a.uid)),
  );
}
export function parsePoolImport(text: string, accounts: readonly PoolAccount[]) {
  const seen = new Set<string>();
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    let cols = line
      .split(line.includes('\t') ? '\t' : line.includes('----') ? '----' : '|')
      .map((c) => c.trim());
    if (/^\d{1,6}$/.test(cols[0]) && /^\d{10,20}$/.test(cols[1] ?? '')) cols = cols.slice(1);
    const [
      uid = '',
      password = '',
      totp = '',
      email = '',
      emailPassword = '',
      recovery = '',
      cookie = '',
      ...notes
    ] = cols;
    const draft: PoolDraft = {
      ...emptyPoolDraft(),
      uid,
      password,
      totp: totpKey(totp),
      email,
      emailPassword,
      recovery,
      cookie,
      note: notes.join(' '),
    };
    const errors = validatePoolDraft(draft, accounts);
    if (seen.has(uid)) errors.push('fpRepeated');
    seen.add(uid);
    const warnings: string[] = [];
    if (!totp) warnings.push('fpNoKey');
    if (!cookie) warnings.push('fpNoCookie');
    else if (!cookieUid(cookie)) warnings.push('fpCookieMissing');
    else if (cookieUid(cookie) !== uid) warnings.push('fpCookieMismatch');
    return [{ line: index + 1, draft, errors, warnings }];
  });
}
export function nextPoolAccount(accounts: readonly PoolAccount[]) {
  return accounts
    .filter((a) => a.status === 'available')
    .sort(
      (a, b) =>
        Number(cookieHealth(b).kind === 'fresh') - Number(cookieHealth(a).kind === 'fresh') ||
        a.addedAt - b.addedAt,
    )[0];
}
// Every write answers with the whole pool, so the page replaces its snapshot.
const BASE = '/api/facebook-pool';
export const poolApi = {
  snapshot: () => api.get<PoolSnapshot>(BASE),
  take: (no: number) => api.post<PoolSnapshot>(`${BASE}/${no}/take`, {}),
  giveBack: (no: number) => api.post<PoolSnapshot>(`${BASE}/${no}/return`, {}),
  report: (no: number, reason: FbReportReason, note: string) =>
    api.post<PoolSnapshot>(`${BASE}/${no}/report`, { reason, note }),
  event: (no: number, kind: 'copied' | 'revealed', field: FbPoolSecretField) =>
    api.post<{ ok: true }>(`${BASE}/${no}/events`, { kind, field }),
  create: (draft: PoolDraft, batch: string) => api.post<PoolSnapshot>(BASE, { draft, batch }),
  update: (no: number, draft: PoolDraft) => api.put<PoolSnapshot>(`${BASE}/${no}`, { draft }),
  // The login goes to the worker server-side; nothing secret comes back.
  // `account` is the worker's existing vault account, when it has one.
  assign: (no: number, worker: string, account?: string) =>
    api.post<PoolSnapshot>(`${BASE}/${no}/assign`, { worker, account }),
  retire: (no: number) => api.post<PoolSnapshot>(`${BASE}/${no}/retire`, {}),
  remove: (no: number) => api.delete<PoolSnapshot>(`${BASE}/${no}`),
  importRows: (batch: string, rows: PoolDraft[]) =>
    api.post<PoolSnapshot>(`${BASE}/import`, { batch, rows }),
};
