import { describe, expect, it } from 'vitest';
import {
  activityKey,
  assignWorker,
  base32Bytes,
  cookieHealth,
  cookieUid,
  DAY,
  emptyPoolDraft,
  nextPoolAccount,
  parsePoolImport,
  poolTotp,
  totpKey,
  validatePoolDraft,
  type PoolAccount,
  type PoolStatus,
} from './facebookPool';

const uid = '61560221947310';
// [uid, status, days in pool, cookie age in days or null]
const fixture = (
  rows: [string, PoolStatus, number, number | null][],
  now = Date.now(),
): PoolAccount[] =>
  rows.map(([uid, status, age, cookieDays], i) => ({
    no: i + 1,
    uid,
    password: `pw${i}`,
    totp: 'JBSWY3DPEHPK3PXP',
    email: `a${i}@outlook.example`,
    emailPassword: '',
    recovery: '',
    cookie: cookieDays === null ? '' : `c_user=${uid}; xs=s${i}`,
    cookieAt: cookieDays === null ? null : now - cookieDays * DAY,
    note: '',
    status,
    holder: status === 'taken' ? 'Lina' : null,
    holderId: null,
    since: null,
    addedAt: now - age * DAY,
    batch: 'Batch',
  }));
const SAMPLE = fixture([
  ['61556203481174', 'available', 41, 18],
  ['61557718820365', 'available', 33, 9],
  ['61558841020993', 'available', 30, 25],
  ['61559300174528', 'available', 28, null],
  ['61560014557821', 'available', 21, 4],
  ['61556678013442', 'taken', 44, 6],
]);
const row = `${uid}|demo-password|JBSWY3DPEHPK3PXP|person@outlook.example|mail-password||c_user=${uid}; xs=demo|Aged 2y`;
describe('supplier account import', () => {
  it.each(['|', '\t', '----'])(
    'accepts %s columns with an optional supplier number',
    (delimiter) => {
      const result = parsePoolImport(`13${delimiter}${row.replaceAll('|', delimiter)}`, []);
      expect(result).toHaveLength(1);
      expect(result[0].errors).toEqual([]);
      expect(result[0].draft).toMatchObject({
        uid,
        recovery: '',
        note: 'Aged 2y',
        status: 'available',
      });
    },
  );
  it('rejects existing and repeated UIDs, preserving source line numbers', () => {
    const result = parsePoolImport(
      `\n${row}\n${row}\n61556203481174|pass|||||||`,
      SAMPLE,
    );
    expect(result.map((r) => r.line)).toEqual([2, 3, 4]);
    expect(result[1].errors).toContain('fpRepeated');
    expect(result[2].errors).toContain('fpDuplicate');
  });
  it('rejects invalid credentials while allowing missing optional session data', () => {
    expect(parsePoolImport('not-a-uid||bad8key', [])[0].errors).toEqual([
      'fpInvalidUid',
      'fpPasswordRequired',
      'fpInvalidKey',
    ]);
    const valid = parsePoolImport(`${uid}|password`, [])[0];
    expect(valid.errors).toEqual([]);
    expect(valid.warnings).toEqual(['fpNoKey', 'fpNoCookie']);
  });
  it('flags a cookie bound to a different identity', () => {
    expect(
      parsePoolImport(row.replace(`c_user=${uid}`, 'c_user=61550000000000'), [])[0].warnings,
    ).toContain('fpCookieMismatch');
  });
});
describe('supplier formats', () => {
  it('reads c_user from a header line with loose spacing and from exported JSON', () => {
    expect(cookieUid(`c_user=${uid} ; xs=demo`)).toBe(uid);
    expect(cookieUid(`xs=demo;c_user = ${uid}`)).toBe(uid);
    expect(cookieUid(JSON.stringify([{ name: 'xs', value: 'demo' }, { name: 'c_user', value: uid }]))).toBe(uid);
    expect(cookieUid(JSON.stringify({ xs: 'demo', c_user: uid }))).toBe(uid);
    expect(cookieUid('[not json')).toBeNull();
    expect(cookieUid(JSON.stringify([{ name: 'c_user', value: 'abc' }]))).toBeNull();
  });
  it('accepts an otpauth:// link wherever a setup key goes', async () => {
    const uri = 'otpauth://totp/Facebook:person?secret=jbsw%20y3dp-ehpk3pxp&issuer=Facebook';
    expect(totpKey(uri)).toBe('JBSWY3DPEHPK3PXP');
    expect(totpKey(' jbsw y3dp ehpk 3pxp ')).toBe('JBSWY3DPEHPK3PXP');
    expect(base32Bytes(uri)).not.toBeNull();
    expect(base32Bytes('otpauth://totp/Facebook?issuer=Facebook')).toBeNull();
    expect(parsePoolImport(`${uid}|password|${uri}`, [])[0].draft.totp).toBe('JBSWY3DPEHPK3PXP');
    expect(
      await poolTotp('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000),
    ).toBe('287082');
  });
});
describe('pool allocation and editing', () => {
  it('prefers the oldest account with a fresh matching cookie', () => {
    const accounts = SAMPLE;
    expect(nextPoolAccount(accounts)?.no).toBe(1);
    expect(nextPoolAccount(accounts.filter((a) => a.no !== 1 && a.no !== 2))?.no).toBe(5);
    expect(nextPoolAccount(accounts.map((a) => ({ ...a, status: 'retired' })))).toBeUndefined();
  });
  it('validates the holder and excludes the edited account from duplicate checks', () => {
    const accounts = SAMPLE;
    expect(validatePoolDraft(accounts[0], accounts, 1)).toEqual([]);
    expect(validatePoolDraft(accounts[0], accounts)).toEqual(['fpDuplicate']);
    expect(
      validatePoolDraft({ ...emptyPoolDraft(), uid, password: 'x'.repeat(501) }, []),
    ).toEqual(['fpTooLong']);
    expect(
      validatePoolDraft({ ...emptyPoolDraft(), uid, password: 'pass', status: 'taken' }, []),
    ).toContain('fpHolderRequired');
  });
  it('marks cookies stale after 21 full days and validates c_user as a whole value', () => {
    const now = Date.now(),
      account = fixture([['61556203481174', 'available', 41, 18]], now)[0];
    expect(cookieHealth({ ...account, cookieAt: now - 22 * DAY }, now).kind).toBe('stale');
    expect(cookieHealth({ ...account, cookieAt: null }, now).kind).toBe('unknown');
    expect(
      cookieHealth({ ...account, cookie: `c_user=${account.uid}invalid; xs=demo` }, now).kind,
    ).toBe('missing');
  });
});
describe('activity verbs', () => {
  it('maps the API verb onto the translation key', () => {
    expect(activityKey('took')).toBe('fpLogTook');
    expect(activityKey('imported')).toBe('fpLogImported');
  });
});
describe('live six-digit TOTP', () => {
  // RFC 6238 SHA-1 test vectors, reduced to the UI's six digits.
  const key = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [2000000000, '279037'],
  ])('matches the reference at %s seconds', async (seconds, expected) => {
    expect(await poolTotp(key, Number(seconds) * 1000)).toBe(expected);
  });
  it('does not invent a code for an invalid or missing key', async () => {
    expect(await poolTotp('')).toBeNull();
    expect(await poolTotp('invalid8key')).toBeNull();
  });
});

describe('assignWorker', () => {
  it('makes the account Fleet, held by the worker', () => {
    expect(assignWorker({ ...emptyPoolDraft(), holder: 'Ann' }, 'denver-1')).toMatchObject({
      status: 'fleet',
      holder: 'denver-1',
    });
  });
  it('puts a fleet account back on the rack when no worker is picked', () => {
    const draft = { ...emptyPoolDraft(), status: 'fleet' as const, holder: 'denver-1' };
    expect(assignWorker(draft, null)).toMatchObject({ status: 'available', holder: null });
  });
  it('leaves a purchaser-held account alone when no worker is picked', () => {
    const draft = { ...emptyPoolDraft(), status: 'taken' as const, holder: 'Ann' };
    expect(assignWorker(draft, null)).toBe(draft);
  });
});
