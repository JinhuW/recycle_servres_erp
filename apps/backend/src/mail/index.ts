// The shared company mailbox behind the web-submission conversation: replies
// go out over SMTP (send.ts), the customer's answers come back over IMAP
// (inbox.ts). One mailbox for every manager, credentials in env only.
//
// Dark until MAIL_USER and MAIL_PASSWORD are both set — the page then keeps
// its mailto link. MAIL_STUB sends against nodemailer's capture transport so
// the thread can be exercised locally without a real box; it never polls.

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
};

const STUB_ADDRESS = 'replies@example.test';

export function mailConfig(env: Env): MailConfig | null {
  const stub = env.MAIL_STUB === '1' || env.MAIL_STUB === 'fail';
  if (!stub && (!env.MAIL_USER || !env.MAIL_PASSWORD)) return null;
  return {
    mode: stub ? 'stub' : 'smtp',
    user: env.MAIL_USER || STUB_ADDRESS,
    password: env.MAIL_PASSWORD ?? '',
    smtp: { host: env.MAIL_SMTP_HOST || 'smtp.larksuite.com', port: Number(env.MAIL_SMTP_PORT) || 465 },
    imap: { host: env.MAIL_IMAP_HOST || 'imap.larksuite.com', port: Number(env.MAIL_IMAP_PORT) || 993 },
    stubFail: env.MAIL_STUB === 'fail',
  };
}

// What /api/health reports, alongside describeShipping: a box whose password
// was never set looks healthy from outside and simply never sends. Modes only.
export function describeMail(env: Env): { mail: MailMode } {
  return { mail: mailConfig(env)?.mode ?? 'off' };
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
