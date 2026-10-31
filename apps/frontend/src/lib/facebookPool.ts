// The pool page's view helpers and its API client. The rules both the page
// and the API apply (statuses, limit, draft validation) live in
// @recycle-erp/shared. Never persist login secrets in the browser.
import {
  FB_LOGIN_OK_OUTCOMES,
  FB_POOL_LIMIT,
  FB_POOL_STATUSES,
  base32Bytes,
  cookieUid,
  totpKey,
  validateFbPoolDraft,
  type FbAccountTimeline,
  type FbPoolDraft,
  type FbPoolEventKind,
  type FbPoolSecretField,
  type FbPoolStatus,
  type FbProxyMark,
  type FbReportReason,
  type FbTimelineEvent,
  type FbWorkerStint,
} from '@recycle-erp/shared';
import { ApiError } from './api';
import { sharedApi as api } from './sharedGet';

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
  token: string;
  note: string;
  status: PoolStatus;
  holder: string | null;
  holderId: string | null;
  since: number | null;
  addedAt: number;
  cookieAt: number | null;
  /** Who last saved the cookie: a fleet worker's id or a manager's name. */
  cookieBy: string | null;
  aliveCheckedAt: number | null;
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
  token: '',
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
/**
 * What a stored session holds. A worker uploads the browser's whole storage
 * state (`{cookies, origins}`), which also restores the site storage Facebook
 * keeps its device in; a pasted cookie is cookies alone.
 */
export function sessionContents(cookie: string): { cookies: number; origins: number } | null {
  const text = cookie.trim();
  if (!text) return null;
  if (text.startsWith('[') || text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (Array.isArray(parsed)) return { cookies: parsed.length, origins: 0 };
    const state = parsed as { cookies?: unknown; origins?: unknown } | null;
    if (state && Array.isArray(state.cookies)) {
      return { cookies: state.cookies.length, origins: Array.isArray(state.origins) ? state.origins.length : 0 };
    }
    return state && typeof state === 'object' ? { cookies: Object.keys(state).length, origins: 0 } : null;
  }
  return { cookies: text.split(';').filter((part) => part.indexOf('=') > 0).length, origins: 0 };
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
  storedCookie?: string,
): string[] {
  return validateFbPoolDraft(
    draft,
    new Set(accounts.filter((a) => a.no !== no).map((a) => a.uid)),
    undefined,
    storedCookie,
  );
}
type ImportField =
  | 'uid'
  | 'password'
  | 'totp'
  | 'email'
  | 'emailPassword'
  | 'recovery'
  | 'cookie'
  | 'token'
  | 'note'
  | 'seq';

// Column headers a supplier sheet carries, English or Chinese, mapped to the
// draft field each fills. Matched after normalising a cell: lower-cased, any
// parenthetical (账号（UID）) and anything after a slash (2FA/验证码) dropped,
// spacing removed — so only the stem is listed.
const IMPORT_HEADERS: Record<string, ImportField> = {
  '#': 'seq', no: 'seq', num: 'seq', index: 'seq', 序号: 'seq', 序號: 'seq',
  uid: 'uid', account: 'uid', username: 'uid', user: 'uid', 账号: 'uid', 帐号: 'uid', 用户名: 'uid', 用户: 'uid',
  password: 'password', pass: 'password', pwd: 'password', 密码: 'password', 密碼: 'password',
  totp: 'totp', '2fa': 'totp', otp: 'totp', key: 'totp', secret: 'totp', 验证码: 'totp', 驗證碼: 'totp', 密钥: 'totp', 二次验证: 'totp',
  emailpassword: 'emailPassword', mailpassword: 'emailPassword', 邮箱密码: 'emailPassword', 郵箱密碼: 'emailPassword',
  email: 'email', mail: 'email', 邮箱: 'email', 郵箱: 'email', 邮件: 'email',
  recovery: 'recovery', recoveryemail: 'recovery', 辅助邮箱: 'recovery', 恢复邮箱: 'recovery', 备用邮箱: 'recovery',
  cookie: 'cookie', cookies: 'cookie',
  token: 'token', accesstoken: 'token', 令牌: 'token', 访问令牌: 'token', 訪問令牌: 'token',
  note: 'note', notes: 'note', remark: 'note', 备注: 'note', 備註: 'note', 说明: 'note',
};

function importHeaderField(cell: string): ImportField | null {
  const key = cell
    .trim()
    .toLowerCase()
    .replace(/[（(][^)）]*[)）]/g, '')
    .split(/[/／]/)[0]
    .replace(/[\s_-]/g, '');
  return IMPORT_HEADERS[key] ?? null;
}

// A comma row with double-quoted fields — what a spreadsheet exports, and the
// one format whose values (a cookie, a note) routinely contain the delimiter.
function splitCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

type ImportDelimiter = '\t' | '----' | '|' | ',' | '';

function importDelimiter(line: string): ImportDelimiter {
  for (const d of ['\t', '----', '|', ','] as const) if (line.includes(d)) return d;
  return '';
}

function splitImportRow(line: string, delimiter = importDelimiter(line)): string[] {
  if (delimiter === ',') return splitCsvRow(line);
  if (!delimiter) return [line.trim()];
  return line.split(delimiter).map((c) => c.trim());
}

// Two headers can name one field. A second password column after the e-mail
// is the mailbox's (账号,密码,邮箱,密码); any other repeat is ambiguous, so the
// column maps to nothing and its rows are refused rather than letting the
// later column overwrite the earlier one.
function resolveImportHeader(cells: (ImportField | null)[]): (ImportField | 'repeat' | null)[] {
  const taken = new Set<ImportField>();
  return cells.map((cell) => {
    let field = cell;
    if (!field || field === 'note' || field === 'seq') return field;
    if (
      field === 'password' &&
      taken.has('password') &&
      taken.has('email') &&
      !cells.includes('emailPassword')
    ) {
      field = 'emailPassword';
    }
    if (taken.has(field)) return 'repeat';
    taken.add(field);
    return field;
  });
}

export function parsePoolImport(text: string, accounts: readonly PoolAccount[]) {
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  // A sheet pasted with its header row (any column order, including the
  // 令牌/token and cookie-before-email layouts) maps columns by name; anything
  // else is read positionally, as before.
  const headerLine = lines.findIndex((l) => l.trim());
  const header = headerLine >= 0 ? splitImportRow(lines[headerLine]).map(importHeaderField) : [];
  const byHeader = header.filter(Boolean).length >= 2 ? resolveImportHeader(header) : null;
  // A header fixes the delimiter for the whole sheet: judged per row, a quoted
  // CSV cell holding a | or ---- would split its row on that instead.
  const sheetDelimiter = byHeader ? importDelimiter(lines[headerLine]) : undefined;

  return lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    if (byHeader && index === headerLine) return [];
    const cols = splitImportRow(line, sheetDelimiter);

    let draft: PoolDraft;
    let repeatedColumn = false;
    if (byHeader) {
      draft = { ...emptyPoolDraft() };
      byHeader.forEach((field, i) => {
        if (!field || field === 'seq') return;
        const value = (cols[i] ?? '').trim();
        if (field === 'repeat') {
          if (value) repeatedColumn = true;
          return;
        }
        if (field === 'note') draft.note = draft.note ? `${draft.note} ${value}` : value;
        else if (field === 'totp') draft.totp = totpKey(value);
        else draft[field] = value;
      });
    } else {
      let c = cols;
      if (/^\d{1,6}$/.test(c[0]) && /^\d{10,20}$/.test(c[1] ?? '')) c = c.slice(1);
      const [
        uid = '',
        password = '',
        totp = '',
        email = '',
        emailPassword = '',
        recovery = '',
        cookie = '',
        ...rest
      ] = c;
      // The token column took the place the note used to have, so rows in
      // that older layout still arrive; anything there that is not a token is
      // their note.
      const token = rest[0] === '' || /^EAA/i.test(rest[0] ?? '') ? (rest.shift() ?? '') : '';
      draft = {
        ...emptyPoolDraft(),
        uid,
        password,
        totp: totpKey(totp),
        email,
        emailPassword,
        recovery,
        cookie,
        token,
        note: rest.join(' ').trim(),
      };
    }

    const errors = validatePoolDraft(draft, accounts);
    if (repeatedColumn) errors.push('fpRepeatedColumn');
    if (seen.has(draft.uid)) errors.push('fpRepeated');
    seen.add(draft.uid);
    const warnings: string[] = [];
    if (!draft.totp) warnings.push('fpNoKey');
    if (!draft.cookie) warnings.push('fpNoCookie');
    else if (!cookieUid(draft.cookie)) warnings.push('fpCookieMissing');
    else if (cookieUid(draft.cookie) !== draft.uid) warnings.push('fpCookieMismatch');
    if (draft.token && !/^EAA/i.test(draft.token)) warnings.push('fpTokenMalformed');
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
/** One pool row without its secrets, as GET /api/facebook-pool/summary lists it. */
export type PoolAccountSummary = {
  no: number; uid: string | null; email: string | null; note: string;
  status: PoolStatus; holder: string | null; holderId: string | null;
  since: number | null; addedAt: number; cookieAt: number | null;
  aliveCheckedAt: number | null; batch: string | null;
  hasCookie: boolean; cookieUid: string | null;
};

/** A snapshot row as its summary, for a backend that has no summary route yet. */
export const poolAccountSummary = (a: PoolAccount): PoolAccountSummary => ({
  no: a.no, uid: a.uid || null, email: a.email || null, note: a.note, status: a.status, holder: a.holder,
  holderId: a.holderId, since: a.since, addedAt: a.addedAt, cookieAt: a.cookieAt, aliveCheckedAt: a.aliveCheckedAt,
  batch: a.batch || null, hasCookie: !!a.cookie, cookieUid: a.cookie ? cookieUid(a.cookie) : null,
});

// Every write answers with the whole pool, so the page replaces its snapshot.
const BASE = '/api/facebook-pool';
export const poolApi = {
  snapshot: () => api.get<PoolSnapshot>(BASE),
  // Status, holder and uid without unsealing a secret: what the fleet pages
  // need. A backend that predates the route answers 404; the snapshot then
  // stands in, at its old cost.
  summary: () => api.get<{ accounts: PoolAccountSummary[] }>(`${BASE}/summary`).catch(err => {
    if (err instanceof ApiError && err.status === 404) {
      return api.get<PoolSnapshot>(BASE).then(s => ({ accounts: s.accounts.map(poolAccountSummary) }));
    }
    throw err;
  }),
  take: (no: number) => api.post<PoolSnapshot>(`${BASE}/${no}/take`, {}),
  giveBack: (no: number) => api.post<PoolSnapshot>(`${BASE}/${no}/return`, {}),
  report: (no: number, reason: FbReportReason, note: string) =>
    api.post<PoolSnapshot>(`${BASE}/${no}/report`, { reason, note }),
  event: (no: number, kind: 'copied' | 'revealed', field: FbPoolSecretField) =>
    api.post<{ ok: true }>(`${BASE}/${no}/events`, { kind, field }),
  create: (draft: PoolDraft, batch: string) => api.post<PoolSnapshot>(BASE, { draft, batch }),
  update: (no: number, draft: PoolDraft) => api.put<PoolSnapshot>(`${BASE}/${no}`, { draft }),
  // The login goes to the worker server-side; nothing secret comes back.
  // `account` is the worker's existing vault account, when it has one;
  // `previous` is where the account the worker holds now goes, if it holds one.
  assign: (no: number, worker: string, account?: string, previous?: PreviousFate) =>
    api.post<PoolSnapshot>(`${BASE}/${no}/assign`, { worker, account, previous }),
  retire: (no: number) => api.post<PoolSnapshot>(`${BASE}/${no}/retire`, {}),
  remove: (no: number) => api.delete<PoolSnapshot>(`${BASE}/${no}`),
  importRows: (batch: string, rows: PoolDraft[]) =>
    api.post<PoolSnapshot>(`${BASE}/import`, { batch, rows }),
  // Manager-only: proxies with failed accounts, and one worker's accounts.
  proxies: () => api.get<{ proxies: FbProxyMark[] }>(`${BASE}/proxies`),
  reviveProxy: (url: string) => api.post<{ proxies: FbProxyMark[] }>(`${BASE}/proxies/revive`, { url }),
  workerAccounts: (worker: string) =>
    api.get<{ stints: FbWorkerStint[] }>(`${BASE}/workers/${encodeURIComponent(worker)}/accounts`),
  timeline: (no: number) => api.get<FbAccountTimeline>(`${BASE}/${no}/timeline`),
};

export type { FbAccountTimeline, FbProxyMark, FbTimelineEvent, FbWorkerStint };

/** A timeline line: one event, or a run of identical logins. */
export type TimelineLine = FbTimelineEvent & { count: number; since: number };

/** Consecutive logins with the same worker, trigger, outcome and detail read
 *  as one line with a count, from `since` to `at`: a worker that fails at
 *  every restart is one line per streak, not one per restart. Expects the
 *  events newest first, as the API sends them. */
export function groupTimeline(events: readonly FbTimelineEvent[]): TimelineLine[] {
  const out: TimelineLine[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (last?.kind === 'login' && e.kind === 'login' && last.worker === e.worker
        && last.trigger === e.trigger && last.outcome === e.outcome && last.detail === e.detail) {
      last.count += 1;
      last.since = e.at;
      continue;
    }
    out.push({ ...e, count: 1, since: e.at });
  }
  return out;
}

export type LoginTone = 'ok' | 'warn' | 'fail' | 'pending';

/** A checkpoint is a human's job rather than a dead end, so it is amber. */
export function loginTone(outcome: string | null): LoginTone {
  if (outcome === null) return 'pending';
  if ((FB_LOGIN_OK_OUTCOMES as readonly string[]).includes(outcome)) return 'ok';
  return outcome === 'challenge' ? 'warn' : 'fail';
}

/** Finished logins that signed in, and those that did not. */
export function loginCounts(events: readonly FbTimelineEvent[]): { ok: number; failed: number } {
  let ok = 0;
  let failed = 0;
  for (const e of events) {
    if (e.kind !== 'login' || e.outcome === null) continue;
    if (loginTone(e.outcome) === 'ok') ok += 1;
    else failed += 1;
  }
  return { ok, failed };
}

/** The mark on the proxy a worker dials now; none when nothing failed on it
 *  since its last revive, or it has no proxy. */
export function proxyMarkFor(
  marks: readonly FbProxyMark[] | null,
  worker: { proxy?: { url: string | null } | null },
): FbProxyMark | undefined {
  const url = worker.proxy?.url;
  return url ? marks?.find((m) => m.url === url) : undefined;
}

/** Where the account a worker held goes when another is sent to it. */
export const PREVIOUS_FATES = ['available', 'problem', 'retired'] as const;
export type PreviousFate = (typeof PREVIOUS_FATES)[number];

/** The pool account a fleet worker holds now, if it came from the pool. */
export function heldByWorker(accounts: readonly PoolAccount[], workerId: string): PoolAccount | undefined {
  const id = workerId.toLowerCase();
  return accounts.find((a) => a.status === 'fleet' && a.holder?.toLowerCase() === id);
}

/**
 * The spares a worker can sign in with — available and holding a password —
 * fresh cookies first, then oldest first, filtered by #, uid, e-mail or batch.
 */
export function installCandidates(accounts: readonly PoolAccount[], query: string): PoolAccount[] {
  const q = query.trim().toLowerCase();
  return accounts
    .filter((a) => a.status === 'available' && a.password)
    .filter((a) => !q || [a.uid, a.email, a.batch, `#${a.no}`].some((s) => s.toLowerCase().includes(q)))
    .sort(
      (a, b) =>
        Number(cookieHealth(b).kind === 'fresh') - Number(cookieHealth(a).kind === 'fresh') ||
        a.addedAt - b.addedAt,
    );
}
