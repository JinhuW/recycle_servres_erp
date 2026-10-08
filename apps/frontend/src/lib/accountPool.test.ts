import { describe, it, expect } from 'vitest';
import {
  buildAccountWrite, draftFrom, filterAccounts, isValidAccountId, isValidImapPort, mailboxNeedsPassword,
  type AccountDraft,
} from './accountPool';
import type { PoolAccount } from './coordinator';

const account = (over: Partial<PoolAccount>): PoolAccount => ({
  account_id: 'fb-1',
  worker_id: 'ne-1',
  fb_username: 'ops@example.com',
  region: 'northeast',
  vnc_url: null,
  allow_password_login: false,
  proxy_configured: false,
  secrets: {
    password: true, email: true, email_password: true, totp_secret: true, imap_host: false, imap_port: false,
  },
  created_at: null,
  updated_at: null,
  ...over,
});

const edit = (original: PoolAccount, change: (d: AccountDraft) => void): AccountDraft => {
  const draft = draftFrom(original);
  change(draft);
  return draft;
};

describe('buildAccountWrite', () => {
  it('sends nothing for an untouched edit', () => {
    const a = account({});
    expect(buildAccountWrite(draftFrom(a), a)).toEqual({});
    const sparse = account({ fb_username: null, region: null, worker_id: null });
    expect(buildAccountWrite(draftFrom(sparse), sparse)).toEqual({});
  });

  it('starts every secret blank, whatever is stored', () => {
    const d = draftFrom(account({}));
    expect(Object.values(d.secrets).every(v => v === '')).toBe(true);
    expect(Object.values(d.clear).every(v => !v)).toBe(true);
  });

  it('sends only the fields that changed, trimmed', () => {
    const a = account({});
    expect(buildAccountWrite(edit(a, d => { d.region = '  southeast '; }), a)).toEqual({ region: 'southeast' });
    // Whitespace around an unchanged value is not a change.
    expect(buildAccountWrite(edit(a, d => { d.fb_username = ' ops@example.com '; }), a)).toEqual({});
  });

  it('turns an emptied worker into an un-assign and an emptied field into a clear', () => {
    const a = account({});
    expect(buildAccountWrite(edit(a, d => { d.worker_id = ''; d.fb_username = ' '; }), a))
      .toEqual({ worker_id: null, fb_username: null });
  });

  it('keeps a blank secret, clears a cleared one, and sends a typed one', () => {
    const a = account({});
    const write = buildAccountWrite(edit(a, d => {
      d.secrets.password = ' pass phrase ';
      d.secrets.totp_secret = '   ';
      d.clear.email = true;
      d.secrets.email = 'typed then cleared';
      d.secrets.imap_host = ' imap.example.com ';
    }), a);
    expect(write).toEqual({
      secrets: { password: 'pass phrase', email: null, imap_host: 'imap.example.com' },
    });
  });

  it('carries the account id on a create and leaves blank fields out', () => {
    const draft = draftFrom(null);
    draft.account_id = ' 100089 ';
    draft.worker_id = 'ne-2';
    draft.secrets.password = 'pw';
    expect(buildAccountWrite(draft, null)).toEqual({
      account_id: '100089', worker_id: 'ne-2', secrets: { password: 'pw' },
    });
  });
});

describe('mailboxNeedsPassword', () => {
  it('asks for the mailbox password whenever the mailbox changes', () => {
    expect(mailboxNeedsPassword({ secrets: { email: 'new@example.com' } })).toBe(true);
    expect(mailboxNeedsPassword({ secrets: { imap_port: '993', email_password: null } })).toBe(true);
    expect(mailboxNeedsPassword({ secrets: { imap_port: '993', email_password: 'pw' } })).toBe(false);
  });

  it('lets a mailbox setting be cleared on its own', () => {
    expect(mailboxNeedsPassword({ secrets: { imap_host: null } })).toBe(false);
    expect(mailboxNeedsPassword({ secrets: { email: null, email_password: null, imap_port: null } })).toBe(false);
  });

  it('leaves writes that do not touch the mailbox alone', () => {
    expect(mailboxNeedsPassword({})).toBe(false);
    expect(mailboxNeedsPassword({ region: 'x', secrets: { password: 'pw', totp_secret: null } })).toBe(false);
    expect(mailboxNeedsPassword({ secrets: { email_password: 'pw' } })).toBe(false);
  });
});

describe('validation', () => {
  it('follows the coordinator’s id rule', () => {
    for (const ok of ['fb-1', '100089', 'ops@example.com', 'a.b_c-d', 'x'.repeat(128)]) {
      expect(isValidAccountId(ok), ok).toBe(true);
    }
    for (const bad of ['', '-lead', '.lead', 'has space', 'a/b', '../x', 'x'.repeat(129)]) {
      expect(isValidAccountId(bad), bad).toBe(false);
    }
  });

  it('takes a port from 1 to 65535', () => {
    expect(['1', '993', '65535'].every(isValidImapPort)).toBe(true);
    expect(['0', '65536', '99999', '-1', '9 93', 'imap', ''].some(isValidImapPort)).toBe(false);
  });
});

describe('filterAccounts', () => {
  const list = [
    account({ account_id: 'fb-1', worker_id: 'ne-1', region: 'northeast' }),
    account({ account_id: 'fb-2', worker_id: null, fb_username: 'spare@example.com', region: null }),
    account({ account_id: 'fb-3', worker_id: 'se-1', fb_username: null, region: 'southeast' }),
  ];
  const ids = (xs: PoolAccount[]) => xs.map(a => a.account_id);

  it('splits assigned accounts from the pool', () => {
    expect(ids(filterAccounts(list, '', 'all'))).toEqual(['fb-1', 'fb-2', 'fb-3']);
    expect(ids(filterAccounts(list, '', 'assigned'))).toEqual(['fb-1', 'fb-3']);
    expect(ids(filterAccounts(list, '', 'pool'))).toEqual(['fb-2']);
  });

  it('searches id, login, worker and region', () => {
    expect(ids(filterAccounts(list, 'SPARE', 'all'))).toEqual(['fb-2']);
    expect(ids(filterAccounts(list, 'se-1', 'all'))).toEqual(['fb-3']);
    expect(ids(filterAccounts(list, 'east fb-1', 'all'))).toEqual(['fb-1']);
    expect(ids(filterAccounts(list, 'southeast', 'pool'))).toEqual([]);
  });
});
