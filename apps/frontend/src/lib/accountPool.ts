// Pure helpers behind the Account Pool page: the edit dialog's draft, the
// write it amounts to, the coordinator's rules mirrored so Save can say no
// before the server does, and the list filter. Kept out of the component so
// they can be unit-tested without React.

import {
  SECRET_FIELDS,
  type AccountCreate,
  type AccountWrite,
  type PoolAccount,
  type SecretField,
} from './coordinator';
import { matchesTerms, queryTerms } from './fleetView';

export type PoolSeg = 'all' | 'assigned' | 'pool';

// The coordinator's rule for an account id; worker ids follow it too.
const ID_RULE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

export const isValidAccountId = (s: string): boolean => ID_RULE.test(s);

export function isValidImapPort(s: string): boolean {
  if (!/^\d{1,5}$/.test(s)) return false;
  const port = Number(s);
  return port >= 1 && port <= 65535;
}

// What the dialog holds. A stored secret never reaches the browser, so every
// secret starts blank and blank means "keep"; `clear` marks stored ones to
// remove.
export type AccountDraft = {
  account_id: string;
  fb_username: string;
  worker_id: string;
  region: string;
  secrets: Record<SecretField, string>;
  clear: Record<SecretField, boolean>;
};

const PLAIN_FIELDS = ['fb_username', 'worker_id', 'region'] as const;

export function draftFrom(account: PoolAccount | null): AccountDraft {
  return {
    account_id: account?.account_id ?? '',
    fb_username: account?.fb_username ?? '',
    worker_id: account?.worker_id ?? '',
    region: account?.region ?? '',
    secrets: Object.fromEntries(SECRET_FIELDS.map(f => [f, ''])) as Record<SecretField, string>,
    clear: Object.fromEntries(SECRET_FIELDS.map(f => [f, false])) as Record<SecretField, boolean>,
  };
}

/**
 * The write a draft amounts to: only what changed. An emptied field becomes
 * null (for the worker: back to the pool), a blank secret is left out so the
 * stored one is kept, a cleared secret is null. A create carries the id.
 */
export function buildAccountWrite(draft: AccountDraft, original: null): AccountCreate;
export function buildAccountWrite(draft: AccountDraft, original: PoolAccount): AccountWrite;
export function buildAccountWrite(draft: AccountDraft, original: PoolAccount | null): AccountWrite | AccountCreate {
  const write: AccountWrite = {};
  for (const field of PLAIN_FIELDS) {
    const value = draft[field].trim();
    if (value === (original?.[field] ?? '')) continue;
    write[field] = value === '' ? null : value;
  }

  const secrets: Partial<Record<SecretField, string | null>> = {};
  for (const field of SECRET_FIELDS) {
    if (draft.clear[field]) {
      secrets[field] = null;
      continue;
    }
    // Trimmed like the vault CLI's prompts: a value with a space around it was
    // pasted with one.
    const typed = draft.secrets[field].trim();
    if (typed === '') continue;
    secrets[field] = typed;
  }
  if (Object.keys(secrets).length > 0) write.secrets = secrets;

  return original ? write : { account_id: draft.account_id.trim(), ...write };
}

// The coordinator refuses a write that sets a new mailbox address, IMAP host or
// port without re-sending the mailbox password in it, so a changed host can
// never receive the stored one. Clearing them points nowhere new, so it is
// allowed on its own.
const MAILBOX_FIELDS: readonly SecretField[] = ['email', 'imap_host', 'imap_port'];

export function mailboxNeedsPassword(write: AccountWrite): boolean {
  const secrets = write.secrets ?? {};
  return MAILBOX_FIELDS.some(f => typeof secrets[f] === 'string') && typeof secrets.email_password !== 'string';
}

export function filterAccounts(list: readonly PoolAccount[], query: string, seg: PoolSeg): PoolAccount[] {
  const terms = queryTerms(query);
  return list.filter(a =>
    (seg === 'all' || (seg === 'assigned') === (a.worker_id !== null))
    && matchesTerms([a.account_id, a.fb_username, a.worker_id, a.region].filter(Boolean).join(' '), terms));
}
