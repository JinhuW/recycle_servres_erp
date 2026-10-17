import { describe, expect, it } from 'vitest';
import {
  cookieHealth,
  createPoolSample,
  DAY,
  emptyPoolDraft,
  nextPoolAccount,
  parsePoolImport,
  poolTotp,
  validatePoolDraft,
} from './facebookPool';

const uid = '61560221947310';
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
      createPoolSample().accounts,
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
describe('pool allocation and editing', () => {
  it('prefers the oldest account with a fresh matching cookie', () => {
    const accounts = createPoolSample().accounts;
    expect(nextPoolAccount(accounts)?.no).toBe(1);
    expect(nextPoolAccount(accounts.filter((a) => a.no !== 1 && a.no !== 2))?.no).toBe(5);
    expect(nextPoolAccount(accounts.map((a) => ({ ...a, status: 'retired' })))).toBeUndefined();
  });
  it('validates the holder and excludes the edited account from duplicate checks', () => {
    const accounts = createPoolSample().accounts;
    expect(validatePoolDraft(accounts[0], accounts, 1)).toEqual([]);
    expect(
      validatePoolDraft({ ...emptyPoolDraft(), uid, password: 'pass', status: 'taken' }, []),
    ).toContain('fpHolderRequired');
  });
  it('marks cookies stale after 21 full days and validates c_user as a whole value', () => {
    const now = Date.now(),
      account = createPoolSample(now).accounts[0];
    expect(cookieHealth({ ...account, cookieAt: now - 22 * DAY }, now).kind).toBe('stale');
    expect(cookieHealth({ ...account, cookieAt: null }, now).kind).toBe('unknown');
    expect(
      cookieHealth({ ...account, cookie: `c_user=${account.uid}invalid; xs=demo` }, now).kind,
    ).toBe('missing');
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
