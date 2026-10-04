// Sending a manager's reply on a web submission. The row is written as
// `sending` first and the SMTP round trip happens outside any transaction, so
// a slow mail server never pins a pool connection; the row then settles to
// `sent` or `failed`. A process that dies mid-send leaves `sending`, which the
// API reports as unconfirmed after a while rather than re-sending — the mail
// may well have gone.

import { randomUUID } from 'node:crypto';
import { createTransport, type SendMailOptions } from 'nodemailer';
import type { Sql } from 'postgres';
import type { Env } from '../types';
import { baseSubject, mailboxDomain, mailConfig, mailLog, replySubject, siteBrand, type MailConfig } from './index';

// Well inside the 25 s shutdown window; nodemailer's own defaults (2 min to
// connect, 10 min idle) would outlive the process.
const SMTP_TIMEOUT_MS = 15_000;
const MAX_REFERENCES = 20;

// The raw RFC 822 text of every stub send, newest last, so tests can read the
// headers nodemailer actually wrote. Bounded: a dev stack in stub mode sends
// indefinitely.
export const stubOutbox: string[] = [];
const STUB_OUTBOX_MAX = 50;

async function deliver(cfg: MailConfig, msg: SendMailOptions): Promise<void> {
  if (cfg.mode === 'stub') {
    if (cfg.stubFail) throw new Error('MAIL_STUB=fail: send refused');
    const info = await createTransport({ streamTransport: true, buffer: true, newline: 'unix' }).sendMail(msg);
    stubOutbox.push(String(info.message));
    if (stubOutbox.length > STUB_OUTBOX_MAX) stubOutbox.shift();
    return;
  }
  const port = cfg.smtp.port;
  await createTransport({
    host: cfg.smtp.host,
    port,
    // 465 is implicit TLS; anything else must upgrade or refuse, never fall
    // back to plaintext auth.
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: cfg.user, pass: cfg.password },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  }).sendMail(msg);
}

// The thread's Message-IDs a reply threads onto, newest first. Only ids that
// really went over the wire count: a failed or unconfirmed send was never
// seen by the customer, and a synthetic `imap:` key is not a Message-ID at all.
export async function threadMessageIds(sql: Sql, submissionId: string): Promise<string[]> {
  const rows = await sql<{ message_id: string }[]>`
    SELECT message_id FROM web_submission_messages
    WHERE submission_id = ${submissionId}
      AND status IN ('sent', 'received')
      AND message_id LIKE '<%@%>'
    ORDER BY created_at DESC, id DESC
    LIMIT ${MAX_REFERENCES}
  `;
  return rows.map((r) => r.message_id);
}

export type ReplyOutcome =
  | { kind: 'off' }
  | { kind: 'not_found' }
  | { kind: 'sent' | 'failed'; messageRowId: string };

export async function sendSubmissionReply(
  sql: Sql, env: Env,
  args: { submissionId: string; authorId: string; body: string },
): Promise<ReplyOutcome> {
  const cfg = mailConfig(env);
  if (!cfg) return { kind: 'off' };
  const [sub] = await sql<{ id: string; site: string; kind: string; email: string }[]>`
    SELECT id, site, kind, email FROM web_submissions WHERE id = ${args.submissionId}
  `;
  if (!sub) return { kind: 'not_found' };

  const thread = await threadMessageIds(sql, sub.id);
  const subject = replySubject(baseSubject(sub), thread.length > 0);
  const messageId = `<${randomUUID()}.${sub.id.toLowerCase()}@${mailboxDomain(cfg.user)}>`;
  const inReplyTo = thread[0] ?? null;

  const [row] = await sql<{ id: string }[]>`
    INSERT INTO web_submission_messages
      (submission_id, direction, author_id, from_addr, to_addr, subject, body_text,
       message_id, in_reply_to, status)
    VALUES (${sub.id}, 'out', ${args.authorId}, ${cfg.user}, ${sub.email}, ${subject}, ${args.body},
            ${messageId}, ${inReplyTo}, 'sending')
    RETURNING id
  `;

  try {
    await deliver(cfg, {
      from: { name: siteBrand(sub.site).name, address: cfg.user },
      // An address object, not a string: the intake's email check lets `,`
      // and `<` through, which a string would turn into list syntax.
      to: { name: '', address: sub.email },
      subject,
      text: args.body,
      messageId,
      ...(inReplyTo ? { inReplyTo, references: [...thread].reverse() } : {}),
    });
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    await sql`UPDATE web_submission_messages SET status = 'failed', error = ${error} WHERE id = ${row.id}`;
    mailLog.warn('web submission reply failed', { submissionId: sub.id, error });
    return { kind: 'failed', messageRowId: row.id };
  }

  await sql.begin(async (tx) => {
    await tx`UPDATE web_submission_messages SET status = 'sent' WHERE id = ${row.id}`;
    await tx`
      UPDATE web_submissions SET
        status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END,
        handled_by = ${args.authorId},
        updated_at = NOW()
      WHERE id = ${sub.id}
    `;
  });
  return { kind: 'sent', messageRowId: row.id };
}
