// Frontend-only account types, supplier validation and demo fixtures.
// A future API can supply the same snapshot. Never persist login secrets.
export const POOL_STATUSES = ['available', 'taken', 'fleet', 'problem', 'retired'] as const;
export type PoolStatus = (typeof POOL_STATUSES)[number];
export const POOL_LIMIT = 2;
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
export type PoolDraft = Pick<
  PoolAccount,
  | 'uid'
  | 'password'
  | 'totp'
  | 'email'
  | 'emailPassword'
  | 'recovery'
  | 'cookie'
  | 'note'
  | 'status'
  | 'holder'
>;
export type PoolActivity = {
  at: number;
  who: string;
  action: string;
  accountNo?: number;
  detail?: string;
  status: PoolStatus;
};
export type PoolSnapshot = { accounts: PoolAccount[]; activity: PoolActivity[]; nextNo: number };
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
export const cookieUid = (cookie: string) =>
  /(?:^|;\s*)c_user=(\d+)(?=;|$)/.exec(cookie)?.[1] ?? null;
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
export function base32Bytes(secret: string): Uint8Array<ArrayBuffer> | null {
  const normalized = secret.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0,
    value = 0;
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
  const errors: string[] = [];
  if (!/^\d{10,20}$/.test(draft.uid)) errors.push('fpInvalidUid');
  if (accounts.some((a) => a.uid === draft.uid && a.no !== no)) errors.push('fpDuplicate');
  if (!draft.password.trim()) errors.push('fpPasswordRequired');
  if (draft.totp && !base32Bytes(draft.totp)) errors.push('fpInvalidKey');
  if (['taken', 'fleet'].includes(draft.status) && !draft.holder?.trim())
    errors.push('fpHolderRequired');
  return errors;
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
      totp: totp.replace(/\s/g, '').toUpperCase(),
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
export function createPoolSample(now = Date.now()): PoolSnapshot {
  const rows: [string, string, PoolStatus, string | null, string, number, number | null][] = [
    [
      '61556203481174',
      'mark.dalton.4417',
      'available',
      null,
      'US IP aged 2y, Marketplace on',
      41,
      18,
    ],
    ['61557718820365', 'reneeholt.biz', 'available', null, 'Aged 3y, friends 120+', 33, 9],
    ['61558841020993', 'jtorres.parts', 'available', null, 'Marketplace on', 30, 25],
    ['61559300174528', 'g.whitfield72', 'available', null, '', 28, null],
    ['61560014557821', 'sam.okafor.dev', 'available', null, 'Profile photo set', 21, 4],
    ['61556678013442', 'linh.pham.home', 'taken', 'Lina', 'Aged 2y', 44, 6],
    ['61557290361105', 'b.castillo.88', 'taken', 'Kevin', 'Marketplace on', 39, 11],
    [
      '61555902218837',
      'denver.racks',
      'fleet',
      'denver-1',
      'Monitor worker, Mountain region',
      90,
      3,
    ],
    ['61556112740096', 'ne.serverbuy', 'fleet', 'ne-1', 'Monitor worker, Northeast', 88, 7],
    ['61558003316650', 'harper.lane.21', 'problem', 'Kevin', 'Checkpoint: photo ID asked', 35, 14],
    ['61559917004213', 'v.morales.tx', 'problem', null, 'Password rejected on first login', 26, 26],
    ['61554480119387', 'oldstock.acct', 'retired', null, 'Disabled 2026-09-30', 120, 60],
  ];
  return {
    nextNo: 13,
    accounts: rows.map(([uid, name, status, holder, note, age, cookieDays], i) => ({
      no: i + 1,
      uid,
      password: `DemoOnly!${i + 1}Sample`,
      totp: 'JBSWY3DPEHPK3PX' + 'PQRSTUVWXYZ2'[i],
      email: `${name}@outlook.example`,
      emailPassword: `DemoMail!${i + 1}Sample`,
      recovery: `${name.split('.')[0]}.rec@mail.example`,
      cookie:
        cookieDays === null
          ? ''
          : `c_user=${i === 10 ? '61550000000000' : uid}; xs=demo-session-${i + 1}; datr=demo`,
      cookieAt: cookieDays === null ? null : now - cookieDays * DAY,
      note,
      status,
      holder,
      holderId: holder ? `sample-${holder}` : null,
      since: holder ? now - (i === 5 ? 3 * 3_600_000 : 26 * 3_600_000) : null,
      addedAt: now - age * DAY,
      batch: age > 60 ? 'Batch 2026-07' : age > 32 ? 'Batch 2026-09-08' : 'Batch 2026-09-22',
    })),
    activity: [
      { at: now - 3 * 3_600_000, who: 'Lina', action: 'fpLogTook', accountNo: 6, status: 'taken' },
      {
        at: now - 7 * 3_600_000,
        who: 'Manager',
        action: 'fpLogImported',
        detail: '5 · Batch 2026-09-22',
        status: 'available',
      },
      {
        at: now - 26 * 3_600_000,
        who: 'Kevin',
        action: 'fpLogTook',
        accountNo: 7,
        status: 'taken',
      },
      {
        at: now - 2 * DAY,
        who: 'Kevin',
        action: 'fpLogReported',
        accountNo: 10,
        status: 'problem',
      },
      {
        at: now - 3 * DAY,
        who: 'Manager',
        action: 'fpLogRetired',
        accountNo: 12,
        status: 'retired',
      },
    ],
  };
}
