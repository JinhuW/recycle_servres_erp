import { describe, it, expect, beforeEach } from 'vitest';
import { simpleParser } from 'mailparser';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { mailConfig, type MailConfig } from '../src/mail';
import { stubOutbox } from '../src/mail/send';
import { matchSubmission, type InboundHeader, type MatchLookups } from '../src/mail/match';
import { runInboxTick, toInboundHeader, type InboxClient } from '../src/mail/inbox';

const BOX = 'sales@recycleservers.com';
const STUB = { MAIL_STUB: '1', MAIL_USER: BOX };

let wsSeq = 5000;
async function insertSubmission(opts: { site?: string; kind?: string; email?: string; status?: string } = {}) {
  const id = `WS-${++wsSeq}`;
  await getTestDb()`
    INSERT INTO web_submissions (id, site, kind, email, status, payload, updated_at)
    VALUES (${id}, ${opts.site ?? 'ram4cash'}, ${opts.kind ?? 'sell_lot'}, ${opts.email ?? 'seller@example.com'},
            ${opts.status ?? 'new'}, '{}'::jsonb, NOW() - interval '10 days')
  `;
  return id;
}

type Msg = {
  id: string; direction: string; from: string; to: string; subject: string; body: string;
  status: string; error: string | null; author: { id: string } | null; attachmentNames: string[];
};
type Thread = { messages: Msg[]; mail: { mode: string; address: string | null } };
type Sent = { message: Msg; submission: { status: string; handledBy: { id: string } | null } };

// The subject carries a `·`, so nodemailer RFC 2047-encodes it on the wire.
async function subjectOf(raw: string): Promise<string | undefined> {
  return (await simpleParser(raw)).subject;
}

function header(raw: string, name: string): string | undefined {
  const unfolded = raw.split('\n\n')[0].replace(/\n[ \t]+/g, ' ');
  return unfolded.split('\n').find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ':'))?.slice(name.length + 1).trim();
}

describe('web submission email thread — routes', () => {
  beforeEach(async () => { await resetDb(); });

  it('is dark without credentials: the thread reads off and sending 503s', async () => {
    const id = await insertSubmission();
    const { token } = await loginAs(ALEX);
    const t = await api<Thread>('GET', `/api/web-submissions/${id}/messages`, { token });
    expect(t.status).toBe(200);
    expect(t.body).toEqual({ messages: [], mail: { mode: 'off', address: null } });
    const s = await api('POST', `/api/web-submissions/${id}/messages`, { token, body: { body: 'Hi' } });
    expect(s.status).toBe(503);
    expect((await api('GET', '/api/health')).body).toMatchObject({ providers: { mail: 'off' } });
  });

  it('sends a ram4cash reply from the box, records it, and moves new to contacted', async () => {
    const id = await insertSubmission({ email: 'seller@example.com' });
    const { token, user } = await loginAs(ALEX);
    const r = await api<Sent>('POST', `/api/web-submissions/${id}/messages`, { token, env: STUB, body: { body: '  We can pay $40 each.  ' } });
    expect(r.status).toBe(201);
    expect(r.body.message).toMatchObject({
      direction: 'out', from: BOX, to: 'seller@example.com', status: 'sent',
      body: 'We can pay $40 each.', subject: `Your sell request ${id} · ram4cash.com`, author: { id: user.id },
    });
    expect(r.body.submission).toMatchObject({ status: 'contacted', handledBy: { id: user.id } });

    const raw = stubOutbox[stubOutbox.length - 1];
    expect(header(raw, 'From')).toBe(`ram4cash <${BOX}>`);
    expect(header(raw, 'To')).toBe('seller@example.com');
    expect(await subjectOf(raw)).toBe(`Your sell request ${id} · ram4cash.com`);
    expect(header(raw, 'Message-ID')).toMatch(new RegExp(`^<[0-9a-f-]{36}\\.${id.toLowerCase()}@recycleservers\\.com>$`));
    expect(header(raw, 'In-Reply-To')).toBeUndefined();

    const [row] = await getTestDb()`SELECT message_id FROM web_submission_messages WHERE id = ${r.body.message.id}`;
    expect(row.message_id).toBe(header(raw, 'Message-ID'));

    const t = await api<Thread>('GET', `/api/web-submissions/${id}/messages`, { token, env: STUB });
    expect(t.body.mail).toEqual({ mode: 'stub', address: BOX });
    expect(t.body.messages.map((m) => m.id)).toEqual([r.body.message.id]);
    expect((await api('GET', '/api/health', { env: STUB })).body).toMatchObject({ providers: { mail: 'stub' } });
  });

  it('threads a follow-up onto what was really exchanged', async () => {
    const id = await insertSubmission();
    const { token } = await loginAs(ALEX);
    const first = await api<Sent>('POST', `/api/web-submissions/${id}/messages`, { token, env: STUB, body: { body: 'Offer' } });
    const firstId = header(stubOutbox[stubOutbox.length - 1], 'Message-ID')!;
    const sql = getTestDb();
    await sql`
      INSERT INTO web_submission_messages (submission_id, direction, from_addr, to_addr, subject, body_text, message_id, status, created_at)
      VALUES (${id}, 'in', 'seller@example.com', ${BOX}, 're', 'ok', '<cust-1@mail.example>', 'received', NOW() + interval '1 second'),
             (${id}, 'out', ${BOX}, 'seller@example.com', 'x', 'lost', '<never@sent.example>', 'failed', NOW() + interval '2 seconds'),
             (${id}, 'in', 'seller@example.com', ${BOX}, 'x', 'no id', 'imap:1:9', 'received', NOW() + interval '3 seconds')
    `;
    const second = await api<Sent>('POST', `/api/web-submissions/${id}/messages`, { token, env: STUB, body: { body: 'Deal' } });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const raw = stubOutbox[stubOutbox.length - 1];
    expect(await subjectOf(raw)).toBe(`Re: Your sell request ${id} · ram4cash.com`);
    expect(header(raw, 'In-Reply-To')).toBe('<cust-1@mail.example>');
    expect(header(raw, 'References')).toBe(`${firstId} <cust-1@mail.example>`);
  });

  it('brands a recycleservers quote as Recycle Servers', async () => {
    const id = await insertSubmission({ site: 'recycleservers', kind: 'quote', email: 'ops@acme.example' });
    const { token } = await loginAs(ALEX);
    const r = await api<Sent>('POST', `/api/web-submissions/${id}/messages`, { token, env: STUB, body: { body: 'Quote attached below' } });
    expect(r.status).toBe(201);
    const raw = stubOutbox[stubOutbox.length - 1];
    expect(header(raw, 'From')).toBe(`Recycle Servers <${BOX}>`);
    expect(await subjectOf(raw)).toBe(`Your quote request ${id} · Recycle Servers`);
  });

  it('records a failed send and leaves the triage status alone', async () => {
    const id = await insertSubmission();
    const { token } = await loginAs(ALEX);
    const r = await api<{ error: string; message: Msg }>('POST', `/api/web-submissions/${id}/messages`, {
      token, env: { MAIL_STUB: 'fail' }, body: { body: 'Offer' },
    });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('send_failed');
    expect(r.body.message).toMatchObject({ status: 'failed', error: expect.stringMatching(/send refused/) });
    const [w] = await getTestDb()`SELECT status, handled_by FROM web_submissions WHERE id = ${id}`;
    expect(w).toEqual({ status: 'new', handled_by: null });
  });

  it('validates the body, the caller and the id', async () => {
    const id = await insertSubmission();
    const { token } = await loginAs(ALEX);
    const post = (body: unknown, t = token) => api('POST', `/api/web-submissions/${id}/messages`, { token: t, env: STUB, body });
    expect((await post({ body: '   ' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ body: 'x'.repeat(10_001) })).status).toBe(400);
    expect((await api('POST', '/api/web-submissions/WS-1/messages', { token, env: STUB, body: { body: 'hi' } })).status).toBe(404);
    expect((await api('GET', '/api/web-submissions/WS-1/messages', { token })).status).toBe(404);
    const purchaser = await loginAs(MARCUS);
    expect((await post({ body: 'hi' }, purchaser.token)).status).toBe(403);
    expect((await api('GET', `/api/web-submissions/${id}/messages`, { token: purchaser.token })).status).toBe(403);
  });

  it('reports a send that never settled as unconfirmed', async () => {
    const id = await insertSubmission();
    await getTestDb()`
      INSERT INTO web_submission_messages (submission_id, direction, from_addr, to_addr, subject, body_text, message_id, status, created_at)
      VALUES (${id}, 'out', ${BOX}, 'seller@example.com', 's', 'b', '<old@x>', 'sending', NOW() - interval '5 minutes'),
             (${id}, 'out', ${BOX}, 'seller@example.com', 's', 'b', '<new@x>', 'sending', NOW())
    `;
    const { token } = await loginAs(ALEX);
    const t = await api<Thread>('GET', `/api/web-submissions/${id}/messages`, { token });
    expect(t.body.messages.map((m) => m.status)).toEqual(['unconfirmed', 'sending']);
  });
});

function hdr(over: Partial<InboundHeader>): InboundHeader {
  return {
    uid: 1, size: 100, messageId: '<m@x>', inReplyTo: null, references: [], from: 'seller@example.com',
    fromName: null, subject: '', authResults: [], ...over,
  };
}

describe('matchSubmission', () => {
  const lookups: MatchLookups = {
    byMessageId: new Map([['<ours@recycleservers.com>', 'WS-1001']]),
    emailById: new Map([['WS-1002', 'seller@example.com']]),
    ownAddress: BOX,
  };

  it('follows the thread headers first, whoever sent it', () => {
    expect(matchSubmission(hdr({ inReplyTo: '<ours@recycleservers.com>', from: 'someone@else.example' }), lookups))
      .toEqual({ submissionId: 'WS-1001', via: 'thread' });
    expect(matchSubmission(hdr({ references: ['<zzz@x>', '<ours@recycleservers.com>'] }), lookups))
      .toEqual({ submissionId: 'WS-1001', via: 'thread' });
  });

  it('accepts a subject tag only from the submission address', () => {
    expect(matchSubmission(hdr({ subject: 'Re: your sell request ws-1002' }), lookups))
      .toEqual({ submissionId: 'WS-1002', via: 'subject' });
    expect(matchSubmission(hdr({ subject: 'Re: WS-1002', from: 'mallory@evil.example' }), lookups)).toBeNull();
    expect(matchSubmission(hdr({ subject: 'Re: WS-9999' }), lookups)).toBeNull();
  });

  it('never lets a DMARC failure in by subject, wherever the server put its verdict', () => {
    const forged = { subject: 'Re: WS-1002' };
    expect(matchSubmission(hdr({ ...forged, authResults: ['mx.larksuite.com; dmarc=fail'] }), lookups)).toBeNull();
    expect(matchSubmission(hdr({ ...forged, authResults: ['attacker; dmarc=pass', 'mx.larksuite.com; dmarc=fail'] }), lookups)).toBeNull();
    expect(matchSubmission(hdr({ ...forged, authResults: ['mx.larksuite.com; dmarc=pass'] }), lookups))
      .toEqual({ submissionId: 'WS-1002', via: 'subject' });
  });

  it('reads one sender and every Authentication-Results header off the fetch', () => {
    const fetched = (from: { address: string }[]) => toInboundHeader({
      seq: 1, uid: 9, size: 10,
      envelope: { subject: 'Re: WS-1002', messageId: 'abc@x', inReplyTo: '<ours@recycleservers.com>', from },
      headers: Buffer.from('References: <a@x>\r\n <b@x>\r\nAuthentication-Results: one; dmarc=pass\r\nAuthentication-Results: two;\r\n dmarc=fail\r\n'),
    });
    const one = fetched([{ address: 'Seller@Example.com' }]);
    expect(one).toMatchObject({
      uid: 9, from: 'seller@example.com', messageId: '<abc@x>', references: ['<a@x>', '<b@x>'],
      authResults: ['one; dmarc=pass', 'two; dmarc=fail'],
    });
    // Two addresses in From: whichever one a check reads, the other may be the sender.
    const two = fetched([{ address: 'seller@example.com' }, { address: 'mallory@evil.example' }]);
    expect(two.from).toBeNull();
    expect(matchSubmission(two, lookups)).toBeNull();
  });

  it('ignores the box itself and mail with no sender', () => {
    expect(matchSubmission(hdr({ inReplyTo: '<ours@recycleservers.com>', from: BOX }), lookups)).toBeNull();
    expect(matchSubmission(hdr({ inReplyTo: '<ours@recycleservers.com>', from: null }), lookups)).toBeNull();
    expect(matchSubmission(hdr({ subject: 'hello' }), lookups)).toBeNull();
  });
});

type FakeMail = { uid: number; header: Partial<InboundHeader>; raw?: string };

// IMAP as runInboxTick sees it. `N:*` really does answer with the newest
// message even when it's below N, so uidsAfter reproduces that.
class FakeInbox implements InboxClient {
  sourceCalls: number[] = [];
  failSource = new Set<number>();
  constructor(public mail: FakeMail[], public uidValidity = 7, public uidNext = 100) {}
  async open() { return { uidValidity: BigInt(this.uidValidity), uidNext: this.uidNext }; }
  async uidsAfter(uid: number) {
    const all = this.mail.map((m) => m.uid).sort((a, b) => a - b);
    const above = all.filter((u) => u > uid);
    return above.length > 0 ? above : all.slice(-1);
  }
  async headers(uids: number[]) {
    return this.mail.filter((m) => uids.includes(m.uid)).map((m) => hdr({ uid: m.uid, ...m.header }));
  }
  async source(uid: number) {
    this.sourceCalls.push(uid);
    if (this.failSource.has(uid)) throw new Error('connection reset');
    const m = this.mail.find((x) => x.uid === uid);
    return m?.raw ? Buffer.from(m.raw) : null;
  }
  async close() {}
}

function rawMail(o: { from?: string; subject?: string; body?: string; html?: string; attachments?: string }): string {
  const head = [`From: ${o.from ?? 'Seller <seller@example.com>'}`, `To: ${BOX}`, `Subject: ${o.subject ?? 'Re: offer'}`, 'MIME-Version: 1.0'];
  if (o.html) return [...head, 'Content-Type: text/html; charset=utf-8', '', o.html].join('\r\n');
  if (!o.attachments) return [...head, 'Content-Type: text/plain; charset=utf-8', '', o.body ?? 'Sounds good'].join('\r\n');
  return [...head, 'Content-Type: multipart/mixed; boundary="M"', '',
    '--M', 'Content-Type: multipart/related; boundary="R"', '',
    '--R', 'Content-Type: text/html; charset=utf-8', '', `<p>${o.body ?? 'See photos'}</p><img src="cid:logo">`,
    '--R', 'Content-Type: image/png', 'Content-ID: <logo>', 'Content-Disposition: inline; filename="logo.png"',
    'Content-Transfer-Encoding: base64', '', 'iVBORw0KGgo=',
    '--R--',
    '--M', 'Content-Type: image/jpeg; name="label.jpg"', 'Content-Disposition: attachment; filename="label.jpg"',
    'Content-Transfer-Encoding: base64', '', '/9j/4AAQ',
    '--M--', ''].join('\r\n');
}

describe('runInboxTick', () => {
  let cfg: MailConfig;
  beforeEach(async () => {
    await resetDb();
    cfg = mailConfig({ ...testEnv, MAIL_USER: BOX, MAIL_PASSWORD: 'pw' })!;
  });

  const state = async () => (await getTestDb()`
    SELECT uid_validity::int AS v, last_uid::int AS last FROM mail_sync_state WHERE account = ${BOX}
  `)[0];
  const replies = async (id: string) => getTestDb()`
    SELECT direction, from_addr, body_text, status, dmarc, attachment_names, in_reply_to
    FROM web_submission_messages WHERE submission_id = ${id} AND direction = 'in' ORDER BY created_at
  `;
  // One row per manager; counting one manager's is counting replies.
  const replyNotices = async () => Number((await getTestDb()`
    SELECT count(*) FROM notifications n JOIN users u ON u.id = n.user_id
    WHERE u.email = ${ALEX} AND n.kind = 'web_submission' AND n.title LIKE 'Reply on %'
  `)[0].count);

  it('starts from the current end of the box on first sight', async () => {
    const box = new FakeInbox([{ uid: 98, header: { subject: 'old' } }], 7, 99);
    expect(await runInboxTick(getTestDb(), cfg, box, new Map())).toEqual({ scanned: 0, stored: 0 });
    expect(await state()).toEqual({ v: 7, last: 98 });
    expect(box.sourceCalls).toEqual([]);
  });

  it('stores a reply to our message, notifies, and never downloads unrelated mail', async () => {
    const id = await insertSubmission();
    const sql = getTestDb();
    await sql`
      INSERT INTO web_submission_messages (submission_id, direction, from_addr, to_addr, subject, message_id, status)
      VALUES (${id}, 'out', ${BOX}, 'seller@example.com', 's', '<ours.1@recycleservers.com>', 'sent')
    `;
    await sql`INSERT INTO mail_sync_state (account, mailbox, uid_validity, last_uid) VALUES (${BOX}, 'INBOX', 7, 10)`;
    const box = new FakeInbox([
      { uid: 10, header: { subject: 'already seen' } },
      { uid: 11, header: { subject: 'Invoice from a vendor', from: 'billing@vendor.example' } },
      {
        uid: 12,
        header: {
          messageId: '<reply-1@mail.example>', inReplyTo: '<ours.1@recycleservers.com>', fromName: 'Sam Seller',
          // Thread-matched mail is kept even on a fail, with the warning; a
          // forged pass stacked above the server's verdict doesn't hide it.
          authResults: ['forged.example; dmarc=pass', 'mx.larksuite.com; spf=pass; dmarc=FAIL header.from=example.com'],
        },
        raw: rawMail({ body: 'Photos attached', attachments: 'yes' }),
      },
    ]);
    const r = await runInboxTick(sql, cfg, box, new Map());
    expect(r).toEqual({ scanned: 2, stored: 1 });
    expect(box.sourceCalls).toEqual([12]);
    expect(await replies(id)).toEqual([{
      direction: 'in', from_addr: 'seller@example.com', body_text: 'Photos attached', status: 'received',
      dmarc: 'fail', attachment_names: ['label.jpg'], in_reply_to: '<ours.1@recycleservers.com>',
    }]);
    expect(await replyNotices()).toBe(1);
    const [w] = await sql`SELECT updated_at > NOW() - interval '1 minute' AS bumped FROM web_submissions WHERE id = ${id}`;
    expect(w.bumped).toBe(true);
    expect((await state()).last).toBe(12);

    // The same message seen again (a second instance, a reset watermark) is one row.
    await sql`UPDATE mail_sync_state SET last_uid = 10`;
    await runInboxTick(sql, cfg, box, new Map());
    expect(await replies(id)).toHaveLength(1);
    expect(await replyNotices()).toBe(1);
  });

  it('matches on subject only from the submission address, and turns HTML into text', async () => {
    const id = await insertSubmission({ email: 'Seller@Example.com' });
    const sql = getTestDb();
    await sql`INSERT INTO mail_sync_state (account, mailbox, uid_validity, last_uid) VALUES (${BOX}, 'INBOX', 7, 0)`;
    const box = new FakeInbox([
      { uid: 1, header: { messageId: '<a@x>', subject: `Re: your sell request ${id}` }, raw: rawMail({ html: '<p>Is <b>$40</b> firm?</p>' }) },
      { uid: 2, header: { messageId: '<b@x>', subject: `Re: ${id}`, from: 'mallory@evil.example' }, raw: rawMail({}) },
    ]);
    await runInboxTick(sql, cfg, box, new Map());
    expect((await replies(id)).map((m) => m.body_text)).toEqual(['Is $40 firm?']);
    expect(box.sourceCalls).toEqual([1]);
  });

  it('keeps a spam submission quiet', async () => {
    const id = await insertSubmission({ status: 'spam' });
    const sql = getTestDb();
    await sql`INSERT INTO mail_sync_state (account, mailbox, uid_validity, last_uid) VALUES (${BOX}, 'INBOX', 7, 0)`;
    const box = new FakeInbox([{ uid: 1, header: { subject: `Re: ${id}` }, raw: rawMail({}) }]);
    await runInboxTick(sql, cfg, box, new Map());
    expect(await replies(id)).toHaveLength(1);
    expect(await replyNotices()).toBe(0);
    const [w] = await sql`SELECT updated_at < NOW() - interval '1 day' AS untouched FROM web_submissions WHERE id = ${id}`;
    expect(w.untouched).toBe(true);
  });

  it('restarts from the end when the server renumbers the folder', async () => {
    const sql = getTestDb();
    await sql`INSERT INTO mail_sync_state (account, mailbox, uid_validity, last_uid) VALUES (${BOX}, 'INBOX', 7, 500)`;
    const box = new FakeInbox([{ uid: 3, header: {} }], 8, 4);
    expect(await runInboxTick(sql, cfg, box, new Map())).toEqual({ scanned: 0, stored: 0 });
    expect(await state()).toEqual({ v: 8, last: 3 });
  });

  it('retries a failing message a few times, then skips it', async () => {
    const id = await insertSubmission();
    const sql = getTestDb();
    await sql`INSERT INTO mail_sync_state (account, mailbox, uid_validity, last_uid) VALUES (${BOX}, 'INBOX', 7, 0)`;
    const box = new FakeInbox([
      { uid: 1, header: { messageId: '<one@x>', subject: `Re: ${id}` }, raw: rawMail({ body: 'first' }) },
      { uid: 2, header: { messageId: '<two@x>', subject: `Re: ${id}` }, raw: rawMail({ body: 'second' }) },
    ]);
    box.failSource.add(1);
    const strikes = new Map<number, number>();
    for (let i = 0; i < 4; i++) {
      await runInboxTick(sql, cfg, box, strikes);
      expect((await state()).last).toBe(0);
    }
    await runInboxTick(sql, cfg, box, strikes);
    expect((await state()).last).toBe(2);
    expect((await replies(id)).map((m) => m.body_text)).toEqual(['second']);
  });
});
