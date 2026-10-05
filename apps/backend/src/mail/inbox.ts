// Pulling customer replies out of the shared mailbox's INBOX.
//
// The box is read-only to us: EXAMINE, and every fetch is BODY.PEEK, so what
// staff see as unread in Lark stays unread. New mail is found by UID past a
// stored watermark; each message is matched on its headers alone
// (match.ts) and only a match is downloaded, so the company's other mail never
// leaves the server.
//
// No lock between instances: the unique message_id makes a double insert a
// no-op and the watermark only moves forward, so a deploy overlap is harmless.

import { htmlToText } from 'html-to-text';
import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Sql } from 'postgres';
import type { Env } from '../types';
import { notifyManagers } from '../lib/notify';
import { mailGate, mailLog, type MailConfig } from './index';
import {
  dmarcVerdict, matchSubmission, normalizeMessageId, parseReferences, threadIds,
  type InboundHeader, type MatchLookups,
} from './match';

const MAILBOX = 'INBOX';
// Two minutes, not one: every tick is a fresh login, and a box that logs in
// 1,440 times a day is what login-anomaly protection is for.
const POLL_INTERVAL_MS = 2 * 60 * 1000;
const MAX_PER_TICK = 200;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_BODY_CHARS = 100_000;
const MAX_STRIKES = 5;
// A part embedded in the HTML and this small is a signature logo, not
// something the customer meant to send.
const INLINE_LOGO_BYTES = 30_000;
const IMAP_TIMEOUT_MS = 15_000;

export type MailboxStatus = { uidValidity: bigint | number | string; uidNext: number };

// The slice of an IMAP session the tick needs; tests drive it with a fake.
export interface InboxClient {
  open(): Promise<MailboxStatus>;
  // UIDs strictly above `uid`, ascending.
  uidsAfter(uid: number): Promise<number[]>;
  headers(uids: number[]): Promise<InboundHeader[]>;
  source(uid: number): Promise<Buffer | null>;
  close(): Promise<void>;
}

// Unfolded header lines by lowercased name, in message order.
export function parseHeaderBlock(raw: Buffer | string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!raw) return out;
  const unfolded = String(raw).replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const list = out.get(name) ?? [];
    list.push(line.slice(colon + 1).trim());
    out.set(name, list);
  }
  return out;
}

export function toInboundHeader(m: FetchMessageObject): InboundHeader {
  const env = m.envelope;
  const from = env?.from?.length === 1 ? env.from[0] : undefined;
  const hdr = parseHeaderBlock(m.headers);
  return {
    uid: m.uid,
    size: m.size ?? 0,
    messageId: normalizeMessageId(env?.messageId),
    inReplyTo: normalizeMessageId(env?.inReplyTo),
    references: parseReferences(hdr.get('references')?.join(' ')),
    from: from?.address ? from.address.trim().toLowerCase() : null,
    fromName: from?.name?.trim() || null,
    subject: env?.subject ?? '',
    authResults: hdr.get('authentication-results') ?? [],
  };
}

export function imapClient(cfg: MailConfig): InboxClient & { abort(): void } {
  const client = new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: cfg.imap.port === 993,
    auth: { user: cfg.user, pass: cfg.password },
    // Its own logger writes JSON to stdout for every command.
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: IMAP_TIMEOUT_MS,
    greetingTimeout: IMAP_TIMEOUT_MS,
    socketTimeout: 60_000,
  });
  // An EventEmitter 'error' with no listener throws and takes the process
  // down; socket faults can land between ticks, after logout.
  client.on('error', (err: unknown) => mailLog.warn('imap connection error', err instanceof Error ? err : { error: String(err) }));
  return {
    async open() {
      await client.connect();
      const box = await client.mailboxOpen(MAILBOX, { readOnly: true });
      return { uidValidity: box.uidValidity, uidNext: box.uidNext };
    },
    async uidsAfter(uid) {
      // `N:*` always answers with at least the newest message, even below N.
      const found = await client.search({ uid: `${uid + 1}:*` }, { uid: true });
      return (found || []).filter((u) => u > uid).sort((a, b) => a - b);
    },
    async headers(uids) {
      if (uids.length === 0) return [];
      const out: InboundHeader[] = [];
      const query = { uid: true, envelope: true, size: true, headers: ['references', 'authentication-results'] };
      for await (const m of client.fetch(uids.join(','), query, { uid: true })) out.push(toInboundHeader(m));
      return out;
    },
    async source(uid) {
      const m = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      return m ? m.source ?? null : null;
    },
    async close() {
      try { await client.logout(); } catch { client.close(); }
    },
    abort() { client.close(); },
  };
}

export type ParsedInbound = { body: string; attachmentNames: string[] };

export async function parseInbound(raw: Buffer | string): Promise<ParsedInbound> {
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  // mailparser derives `text` from HTML only when the whole message is HTML;
  // inside multipart/related (Outlook, Apple Mail with a logo) it leaves it
  // unset. The HTML itself is never kept: the page renders text only.
  const text = parsed.text
    ?? (typeof parsed.html === 'string' ? htmlToText(parsed.html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] }) : '');
  const body = text.replace(/\r\n/g, '\n').trim().slice(0, MAX_BODY_CHARS);
  const attachmentNames = parsed.attachments
    .filter((a) => !(a.related && a.size < INLINE_LOGO_BYTES))
    .map((a) => a.filename || a.contentType)
    .slice(0, 50);
  return { body, attachmentNames };
}

async function loadLookups(sql: Sql, headers: InboundHeader[], ownAddress: string): Promise<MatchLookups> {
  const ids = [...new Set(headers.flatMap(threadIds))];
  // Only ids we generated: an inbound message's own Message-ID was chosen by
  // its sender, so it must never stand in for ours.
  const known = ids.length === 0 ? [] : await sql<{ message_id: string; submission_id: string }[]>`
    SELECT message_id, submission_id FROM web_submission_messages
    WHERE direction = 'out' AND message_id = ANY(${ids}::text[])
  `;
  return { byMessageId: new Map(known.map((r) => [r.message_id, r.submission_id])), ownAddress };
}

// Returns whether a new row was written.
async function storeInbound(
  sql: Sql, client: InboxClient, h: InboundHeader, submissionId: string, uidValidity: string, ownAddress: string,
): Promise<boolean> {
  const messageId = h.messageId ?? `imap:${uidValidity}:${h.uid}`;
  const [seen] = await sql`SELECT 1 FROM web_submission_messages WHERE message_id = ${messageId}`;
  if (seen) return false;

  // Too large to pull: the thread still shows that the customer wrote.
  let parsed: ParsedInbound = { body: '', attachmentNames: [] };
  if (h.size <= MAX_SOURCE_BYTES) {
    const raw = await client.source(h.uid);
    if (raw) parsed = await parseInbound(raw);
  }

  return sql.begin(async (tx) => {
    // Through the submission row: one purged since the match inserts nothing.
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO web_submission_messages
        (submission_id, direction, from_addr, to_addr, subject, body_text, message_id, in_reply_to,
         status, dmarc, attachment_names)
      SELECT ws.id, 'in', ${h.from}, ${ownAddress}, ${h.subject}, ${parsed.body}, ${messageId}, ${h.inReplyTo},
             'received', ${dmarcVerdict(h.authResults)}, ${parsed.attachmentNames}::text[]
      FROM web_submissions ws WHERE ws.id = ${submissionId}
      ON CONFLICT (message_id) DO NOTHING
      RETURNING id
    `;
    if (!row) return false;
    // Spam stays quiet and keeps its purge clock: a spammer who keeps replying
    // must not keep the row alive or ping every manager.
    const [live] = await tx`
      UPDATE web_submissions SET updated_at = NOW()
      WHERE id = ${submissionId} AND status <> 'spam'
      RETURNING id
    `;
    if (live) {
      const who = (h.fromName ? `${h.fromName} <${h.from}>` : h.from ?? '').slice(0, 80);
      await notifyManagers(tx, {
        kind: 'web_submission',
        tone: 'info',
        icon: 'mail',
        title: `Reply on ${submissionId} · ${who}`,
        body: parsed.body.slice(0, 140),
      });
    }
    return true;
  });
}

export type TickResult = { scanned: number; stored: number };

// One pass over the box. `strikes` survives between ticks: a message that
// keeps failing is retried a few times, then skipped so it can't wedge the
// watermark forever.
export async function runInboxTick(
  sql: Sql, cfg: MailConfig, client: InboxClient,
  strikes: Map<number, number>, isStopped: () => boolean = () => false,
): Promise<TickResult> {
  const account = cfg.user.toLowerCase();
  const box = await client.open();
  const uidValidity = String(box.uidValidity);
  const [state] = await sql<{ uid_validity: string; last_uid: string }[]>`
    SELECT uid_validity::text, last_uid::text FROM mail_sync_state
    WHERE account = ${account} AND mailbox = ${MAILBOX}
  `;
  // First sight of the box, or the server renumbered it: start from now.
  // Nothing before this point was sent from the ERP, so there is nothing
  // earlier to thread.
  if (!state || state.uid_validity !== uidValidity) {
    await sql`
      INSERT INTO mail_sync_state (account, mailbox, uid_validity, last_uid)
      VALUES (${account}, ${MAILBOX}, ${uidValidity}, ${Math.max(0, box.uidNext - 1)})
      ON CONFLICT (account, mailbox) DO UPDATE SET
        uid_validity = EXCLUDED.uid_validity, last_uid = EXCLUDED.last_uid, synced_at = NOW()
    `;
    return { scanned: 0, stored: 0 };
  }

  const last = Number(state.last_uid);
  const uids = (await client.uidsAfter(last)).slice(0, MAX_PER_TICK);
  const headers = (await client.headers(uids)).filter((h) => h.uid > last).sort((a, b) => a.uid - b.uid);
  const lookups = headers.length > 0 ? await loadLookups(sql, headers, account) : null;

  let upTo = last;
  let stored = 0;
  for (const h of headers) {
    if (isStopped()) break;
    try {
      const match = matchSubmission(h, lookups!);
      if (match && await storeInbound(sql, client, h, match.submissionId, uidValidity, account)) stored++;
      strikes.delete(h.uid);
    } catch (err) {
      const n = (strikes.get(h.uid) ?? 0) + 1;
      if (n < MAX_STRIKES) {
        strikes.set(h.uid, n);
        mailLog.child({ uid: h.uid, attempt: n }).warn('inbound message failed, retrying next poll', err);
        break;
      }
      strikes.delete(h.uid);
      mailLog.child({ uid: h.uid }).error('inbound message skipped after repeated failures', err);
    }
    upTo = h.uid;
  }
  await sql`
    UPDATE mail_sync_state SET last_uid = GREATEST(last_uid, ${upTo}), synced_at = NOW()
    WHERE account = ${account} AND mailbox = ${MAILBOX}
  `;
  return { scanned: headers.length, stored };
}

export function startMailInboxLoop(sql: Sql, env: Env): { stop(): void } {
  const { config: cfg, blocked } = mailGate(env);
  // Otherwise the variables would sit there looking ignored.
  if (blocked) {
    mailLog.warn('mail is off: MAIL_USER/MAIL_PASSWORD are set on a non-production Railway environment without MAIL_ALLOW_TO', {
      environment: env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || null,
    });
  }
  if (cfg?.mode !== 'smtp') return { stop: () => {} };

  let stopped = false;
  let running = false;
  let live: ReturnType<typeof imapClient> | null = null;
  // A wrong password fails every poll; say so once, and once more on recovery.
  let failing = false;
  const strikes = new Map<number, number>();
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const client = imapClient(cfg);
    live = client;
    try {
      const r = await runInboxTick(sql, cfg, client, strikes, () => stopped);
      if (failing) mailLog.info('inbox poll recovered');
      failing = false;
      if (r.stored > 0) mailLog.info('web submission replies received', r);
    } catch (err) {
      if (!failing) mailLog.warn('inbox poll failed', err);
      failing = true;
    } finally {
      live = null;
      await client.close();
      running = false;
    }
  };
  const kick = setTimeout(tick, 0);
  kick.unref?.();
  const handle = setInterval(tick, POLL_INTERVAL_MS);
  handle.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(kick);
      clearInterval(handle);
      // An IMAP fetch in flight would otherwise hold the drain open.
      live?.abort();
    },
  };
}
