// The shared company mailbox behind the web-submission conversation: replies
// go out over SMTP (send.ts), the customer's answers come back over IMAP
// (inbox.ts). One mailbox for every manager, credentials in env only.
//
// Dark until MAIL_USER and MAIL_PASSWORD are both set — the page then keeps
// its mailto link. MAIL_STUB sends against nodemailer's capture transport so
// the thread can be exercised locally without a real box; it never polls.
//
// MAIL_ALLOW_TO turns a server into a test sender: it mails only the listed
// addresses (or domains) and refuses everyone else. Dev's database is a
// nightly copy of prod, so every submission there is a real customer — any
// Railway environment other than production keeps mail off unless the list
// is set, however the variables got there (re-forking dev from prod copies
// service variables).

import type { Env } from '../types';
import { log } from '../lib/log';

export const mailLog = log.child({ module: 'mail' });

export type MailMode = 'smtp' | 'stub' | 'off';

export type MailConfig = {
  mode: 'smtp' | 'stub';
  // The mailbox address: the From address and the SMTP/IMAP login.
  user: string;
  password: string;
  smtp: { host: string; port: number };
  imap: { host: string; port: number };
  // MAIL_STUB=fail: every send throws, for the failed-send path.
  stubFail: boolean;
  // MAIL_ALLOW_TO, lowercased: addresses, or domains (`@x.com` / `x.com`).
  // null means anyone.
  allowTo: string[] | null;
};

const STUB_ADDRESS = 'replies@example.test';

export function parseAllowTo(raw: string | undefined): string[] | null {
  const entries = (raw ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return entries.length > 0 ? entries : null;
}

// Why mail is off on a server that has a mailbox configured, if it is.
export type MailBlock = 'non_production_without_allow_list';

export function mailGate(env: Env): { config: MailConfig | null; blocked: MailBlock | null } {
  const stub = env.MAIL_STUB === '1' || env.MAIL_STUB === 'fail';
  if (!stub && (!env.MAIL_USER || !env.MAIL_PASSWORD)) return { config: null, blocked: null };
  const allowTo = parseAllowTo(env.MAIL_ALLOW_TO);
  // A Railway environment that can't be named counts as not production: the
  // safe side of this mistake is no mail. Stub never delivers, so it's exempt.
  const onRailway = Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_ID);
  const railwayName = env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT;
  if (!stub && onRailway && railwayName !== 'production' && !allowTo) {
    return { config: null, blocked: 'non_production_without_allow_list' };
  }
  return {
    config: {
      mode: stub ? 'stub' : 'smtp',
      user: env.MAIL_USER || STUB_ADDRESS,
      password: env.MAIL_PASSWORD ?? '',
      smtp: { host: env.MAIL_SMTP_HOST || 'smtp.larksuite.com', port: Number(env.MAIL_SMTP_PORT) || 465 },
      imap: { host: env.MAIL_IMAP_HOST || 'imap.larksuite.com', port: Number(env.MAIL_IMAP_PORT) || 993 },
      stubFail: env.MAIL_STUB === 'fail',
      allowTo,
    },
    blocked: null,
  };
}

export function mailConfig(env: Env): MailConfig | null {
  return mailGate(env).config;
}

export function recipientAllowed(cfg: MailConfig, email: string): boolean {
  if (!cfg.allowTo) return true;
  const address = email.trim().toLowerCase();
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return cfg.allowTo.some((entry) => (entry.includes('@') && !entry.startsWith('@')
    ? entry === address
    : entry.replace(/^@/, '') === domain));
}

// What /api/health reports, alongside describeShipping: a box whose password
// was never set looks healthy from outside and simply never sends. Modes only,
// plus whether a test-recipient list narrows who it sends to.
export function describeMail(env: Env): { mail: MailMode; mailRestricted: boolean } {
  const cfg = mailConfig(env);
  return { mail: cfg?.mode ?? 'off', mailRestricted: Boolean(cfg?.allowTo) };
}

// Sellers know ram4cash.com, not Recycle Servers; a quote came through
// recycleservers.com. Same mailbox either way.
const BRAND: Record<string, { name: string; label: string }> = {
  ram4cash: { name: 'ram4cash', label: 'ram4cash.com' },
  recycleservers: { name: 'Recycle Servers', label: 'Recycle Servers' },
};

export function siteBrand(site: string): { name: string; label: string } {
  return Object.hasOwn(BRAND, site) ? BRAND[site] : BRAND.recycleservers;
}

// Carries the WS id on purpose: a reply whose client dropped our threading
// headers still finds its submission by subject (match.ts).
export function baseSubject(sub: { id: string; site: string; kind: string }): string {
  const what = sub.kind === 'sell_lot' ? 'sell request' : 'quote request';
  return `Your ${what} ${sub.id} · ${siteBrand(sub.site).label}`;
}

// A thread that already holds a message that really went over the wire is
// answered with `Re:`; the first message carries the bare subject.
export function replySubject(base: string, threaded: boolean): string {
  return threaded ? `Re: ${base}` : base;
}

export function mailboxDomain(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : 'localhost';
}
