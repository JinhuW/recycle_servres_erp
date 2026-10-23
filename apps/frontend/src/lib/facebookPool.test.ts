import { describe, expect, it } from 'vitest';
import { cookieValue } from '@recycle-erp/shared';
import {
  activityKey,
  assignWorker,
  base32Bytes,
  cookieHealth,
  cookieUid,
  DAY,
  emptyPoolDraft,
  groupTimeline,
  heldByWorker,
  installCandidates,
  loginCounts,
  loginTone,
  nextPoolAccount,
  parsePoolImport,
  poolTotp,
  proxyMarkFor,
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
    aliveCheckedAt: null,
    token: '',
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
const row = `${uid}|demo-password|JBSWY3DPEHPK3PXP|person@outlook.example|mail-password||c_user=${uid}; xs=demo|EAAtoken|Aged 2y`;
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
        token: 'EAAtoken',
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
  it('reads the older layout, with the note right after the cookie, as a note', () => {
    const older = `${uid}|password|JBSWY3DPEHPK3PXP|a@b.example|mp||c_user=${uid}; xs=demo|Aged 2y, Marketplace on`;
    const [r] = parsePoolImport(older, []);
    expect(r.draft).toMatchObject({ token: '', note: 'Aged 2y, Marketplace on' });
    expect(r.warnings).not.toContain('fpTokenMalformed');
    const blank = `${uid}|password|JBSWY3DPEHPK3PXP|a@b.example|mp||c_user=${uid}; xs=demo||Aged 2y`;
    expect(parsePoolImport(blank, [])[0].draft).toMatchObject({ token: '', note: 'Aged 2y' });
  });
});
describe('supplier order sheet with a header row', () => {
  // The vendor layout: comma CSV, cookie and token before the e-mail, no
  // recovery column, Chinese headers — none of which the positional reader
  // could take.
  const sheet = [
    '序号,账号（UID）,密码,2FA/验证码,Cookie,令牌,邮箱,邮箱密码',
    `1,${uid},DemoOnly!13,JBSWY3DPEHPK3PXP,"c_user=${uid}; xs=demo",EAADemoToken,nora@outlook.example,MailPw!1`,
  ].join('\n');

  it('maps columns by name and skips the header row', () => {
    const result = parsePoolImport(sheet, []);
    expect(result).toHaveLength(1);
    expect(result[0].line).toBe(2); // the header is line 1
    expect(result[0].errors).toEqual([]);
    expect(result[0].draft).toMatchObject({
      uid,
      password: 'DemoOnly!13',
      totp: 'JBSWY3DPEHPK3PXP',
      email: 'nora@outlook.example',
      emailPassword: 'MailPw!1',
      recovery: '',
      cookie: `c_user=${uid}; xs=demo`,
      token: 'EAADemoToken',
    });
    expect(result[0].warnings).toEqual([]);
  });

  it('reads English headers in any order, comma-quoted', () => {
    const csv = [
      'Token,UID,Password,Cookie,2FA,Email,Notes',
      `EAAx,${uid},pw,"c_user=${uid}; xs=s",JBSWY3DPEHPK3PXP,x@y.example,"aged, trusted"`,
    ].join('\n');
    const [r] = parsePoolImport(csv, []);
    expect(r.draft).toMatchObject({ uid, token: 'EAAx', note: 'aged, trusted' });
    expect(r.errors).toEqual([]);
  });

  it('reads a second password column after the e-mail as the mailbox password', () => {
    const csv = ['账号,密码,邮箱,密码', `${uid},FbPw,nora@outlook.example,MailPw`].join('\n');
    const [r] = parsePoolImport(csv, []);
    expect(r.draft).toMatchObject({ password: 'FbPw', email: 'nora@outlook.example', emailPassword: 'MailPw' });
    expect(r.errors).toEqual([]);
  });

  it('refuses rows when two columns name one field instead of keeping either', () => {
    const csv = ['UID,Password,Pass', `${uid},first,second`, `61556203481174,only,`].join('\n');
    const [twice, once] = parsePoolImport(csv, []);
    expect(twice.errors).toContain('fpRepeatedColumn');
    expect(twice.draft.password).toBe('first');
    expect(once.errors).toEqual([]);
  });

  it('splits every row on the header\'s delimiter, whatever its cells hold', () => {
    const csv = [
      'UID,Password,Cookie,Notes',
      `${uid},pw,"c_user=${uid}; xs=s","aged | trusted ---- old"`,
    ].join('\n');
    const [r] = parsePoolImport(csv, []);
    expect(r.draft).toMatchObject({ uid, password: 'pw', note: 'aged | trusted ---- old' });
    expect(r.errors).toEqual([]);
  });

  it('still warns on a bad token and a mismatched cookie under a header', () => {
    const csv = [
      'UID,Password,Cookie,Token',
      `${uid},pw,"c_user=61550000000000; xs=s",nope`,
    ].join('\n');
    const [r] = parsePoolImport(csv, []);
    expect(r.warnings).toEqual(expect.arrayContaining(['fpCookieMismatch', 'fpTokenMalformed']));
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
  it('reads one named cookie, such as the device id, from the same formats', () => {
    expect(cookieValue(`c_user=${uid}; xs=s; datr=7tOa=x`, 'datr')).toBe('7tOa=x');
    expect(cookieValue(JSON.stringify([{ name: 'sb', value: 'b' }]), 'sb')).toBe('b');
    expect(cookieValue(JSON.stringify({ datr: 'd' }), 'datr')).toBe('d');
    expect(cookieValue('xs=s; mydatr=no', 'datr')).toBeNull();
    expect(cookieValue('[not json', 'datr')).toBeNull();
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

describe('account timeline', () => {
  const login = (at: number, outcome: string | null, over: Record<string, unknown> = {}) =>
    ({ kind: 'login' as const, at, worker: 'ne-1', trigger: 'boot', outcome, detail: null, url: null, ...over });
  const assigned = { kind: 'pool' as const, at: 10, action: 'assigned' as const, status: 'fleet' as const, detail: 'ne-1', by: 'Alex' };

  it('folds a run of identical logins into one line with its count and start', () => {
    const lines = groupTimeline([
      login(90, 'restored', { trigger: 'cookie-restore' }),
      login(80, 'failed'), login(70, 'failed'), login(60, 'failed'),
      login(50, 'failed', { worker: 'va-1' }),
      login(40, 'failed'),
      assigned,
      login(5, 'failed'),
    ]);
    expect(lines.map((l) => [l.kind, l.at, l.since, l.count])).toEqual([
      ['login', 90, 90, 1], ['login', 80, 60, 3], ['login', 50, 50, 1], ['login', 40, 40, 1],
      ['pool', 10, 10, 1], ['login', 5, 5, 1],
    ]);
  });

  it('keeps a checkpoint apart from a plain failure, and counts finished logins', () => {
    expect(groupTimeline([login(2, 'challenge', { detail: 'checkpoint' }), login(1, 'challenge', { detail: '2fa' })])).toHaveLength(2);
    expect(['restored', 'password_ok', 'watch_ok', 'challenge', 'locked', 'failed', 'timed_out', null].map(loginTone))
      .toEqual(['ok', 'ok', 'ok', 'warn', 'fail', 'fail', 'fail', 'pending']);
    expect(loginCounts([login(4, 'restored'), login(3, 'failed'), login(2, 'challenge'), login(1, null), assigned]))
      .toEqual({ ok: 1, failed: 2 });
  });
});

describe('proxyMarkFor', () => {
  const dead = { url: 'http://gw:10001', failed: 5, dead: true, deadAt: 1, revivedAt: null, revivedBy: null };
  it('finds the mark on the proxy the worker dials now', () => {
    expect(proxyMarkFor([dead], { proxy: { url: 'http://gw:10001' } })).toBe(dead);
    expect(proxyMarkFor([dead], { proxy: { url: 'http://gw:10002' } })).toBeUndefined();
  });
  it('has none for the VM\'s own IP, an older facade, or marks not loaded', () => {
    expect(proxyMarkFor([dead], { proxy: { url: null } })).toBeUndefined();
    expect(proxyMarkFor([dead], {})).toBeUndefined();
    expect(proxyMarkFor(null, { proxy: { url: 'http://gw:10001' } })).toBeUndefined();
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

describe('sending a spare to a worker', () => {
  it('offers only available accounts with a password, fresh cookies first, then oldest', () => {
    expect(installCandidates(SAMPLE, '').map((a) => a.no)).toEqual([1, 2, 5, 3, 4]);
    const noPassword = SAMPLE.map((a) => (a.no === 2 ? { ...a, password: '' } : a));
    expect(installCandidates(noPassword, '').map((a) => a.no)).toEqual([1, 5, 3, 4]);
  });

  it('filters by number, uid, e-mail or batch', () => {
    expect(installCandidates(SAMPLE, '#3').map((a) => a.no)).toEqual([3]);
    expect(installCandidates(SAMPLE, '61560014').map((a) => a.no)).toEqual([5]);
    expect(installCandidates(SAMPLE, 'A1@OUTLOOK').map((a) => a.no)).toEqual([2]);
    expect(installCandidates(SAMPLE, 'nope')).toEqual([]);
  });

  it('finds the account a worker holds, ignoring case and other statuses', () => {
    const pool = SAMPLE.map((a) =>
      a.no === 2 ? { ...a, status: 'fleet' as const, holder: 'homelab-1' }
      : a.no === 3 ? { ...a, status: 'problem' as const, holder: 'homelab-1' } : a);
    expect(heldByWorker(pool, 'HOMELAB-1')?.no).toBe(2);
    expect(heldByWorker(pool, 'ne-1')).toBeUndefined();
  });
});
