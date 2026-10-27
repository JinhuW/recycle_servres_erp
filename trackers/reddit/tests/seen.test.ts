// Read receipts for the Seen tab: alerts go out as the user account with the
// bot behind it, workers stand down while that account is live, and the reads
// loop and /api/seen turn Telegram's read lists into who saw what.

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import type {AlertSender} from '../src/alerts.ts';
import {insertNewPosts} from '../src/claims.ts';
import {createLogger} from '../src/logger.ts';
import {acquireUserSender, notifyOnce, releaseUserSender, renewUserSender} from '../src/loops/notify.ts';
import {readsOnce} from '../src/loops/reads.ts';
import {seen} from '../src/seen.ts';
import {SettingsStore} from '../src/settings.ts';
import type {AlertContent, SendReport} from '../src/telegram.ts';
import {createUserFirstSender, type ChatMember, type ReadReceipt, type UserClient} from '../src/userSender.ts';
import {createTestDb, type TestDb} from './helpers/db.ts';

let db: TestDb;
const logger = createLogger('test', 'error');

beforeAll(async () => {
  db = await createTestDb('seen');
}, 60_000);

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.sql`DELETE FROM chat_members`;
  await db.sql`DELETE FROM posts`;
  await db.sql`UPDATE settings SET value = '["chat-1"]'::jsonb WHERE key = 'telegram_chat_ids'`;
  await db.sql`UPDATE settings SET value = '[]'::jsonb WHERE key = 'telegram_dev_chat_ids'`;
  await db.sql`UPDATE telegram_state SET user_sender_owner = NULL, user_sender_at = NULL`;
});

async function seedTarget(redditId: string): Promise<void> {
  await insertNewPosts(db.sql, [{
    redditId,
    subreddit: 'homelabsales',
    title: `[FS] lot ${redditId}`,
    selftext: '',
    author: 'seller',
    flair: null,
    url: `https://www.reddit.com/r/homelabsales/comments/${redditId}/`,
    postedAt: new Date(),
  }]);
  await db.sql`UPDATE posts SET status = 'target', is_target = TRUE WHERE reddit_id = ${redditId}`;
}

class FakeUser implements UserClient {
  readonly selfId = '1';
  sent: Array<{chatId: string; html: string}> = [];
  failChats = new Set<string>();
  receipts = new Map<number, ReadReceipt[]>();
  roster: ChatMember[] = [];
  rosterComplete = true;
  private nextId = 100;

  async sendHtml(chatId: string, html: string): Promise<number> {
    if (this.failChats.has(chatId)) throw new Error('CHAT_WRITE_FORBIDDEN');
    this.sent.push({chatId, html});
    return this.nextId++;
  }
  async readers(_chatId: string, messageId: number): Promise<ReadReceipt[]> {
    const r = this.receipts.get(messageId);
    if (!r) throw new Error('MSG_TOO_OLD');
    return r;
  }
  async members(_chatId: string): Promise<{members: ChatMember[]; complete: boolean}> {
    return {members: this.roster, complete: this.rosterComplete};
  }
  async disconnect(): Promise<void> {}
}

function fakeBot(): AlertSender & {sent: string[][]} {
  let nextId = 500;
  const sent: string[][] = [];
  return {
    transport: 'telegram',
    requiresRecipients: true,
    sent,
    async send(chatIds: string[], _alert: AlertContent): Promise<SendReport> {
      sent.push(chatIds);
      return {delivered: chatIds, sent: chatIds.map((chatId) => ({chatId, messageId: nextId++})), failed: []};
    },
    async sendReview(): Promise<SendReport> {
      return {delivered: [], sent: [], failed: []};
    },
  };
}

function deps(alerts: AlertSender, extra: {deferToUserSender?: boolean} = {}) {
  return {sql: db.sql, workerId: 'w', alerts, settings: new SettingsStore(db.sql, 0), logger, ...extra};
}

describe('user-first alerts', () => {
  it('sends as the user account and records the message as user-sent', async () => {
    await seedTarget('t3_a');
    const user = new FakeUser();
    const bot = fakeBot();

    await notifyOnce(deps(createUserFirstSender(user, bot)));

    expect(user.sent).toHaveLength(1);
    expect(bot.sent).toHaveLength(0);
    const rows = await db.sql`SELECT message_id::int, sent_as FROM alert_messages WHERE reddit_id = 't3_a'`;
    expect(rows).toEqual([{message_id: 100, sent_as: 'user'}]);
  });

  it('falls back to the bot for a chat the user account cannot reach', async () => {
    await db.sql`UPDATE settings SET value = '["chat-1","chat-2"]'::jsonb WHERE key = 'telegram_chat_ids'`;
    await seedTarget('t3_b');
    const user = new FakeUser();
    user.failChats.add('chat-2');
    const bot = fakeBot();

    await notifyOnce(deps(createUserFirstSender(user, bot)));

    expect(bot.sent).toEqual([['chat-2']]);
    const rows = await db.sql`
      SELECT chat_id, sent_as FROM alert_messages WHERE reddit_id = 't3_b' ORDER BY chat_id`;
    expect(rows).toEqual([{chat_id: 'chat-1', sent_as: 'user'}, {chat_id: 'chat-2', sent_as: 'bot'}]);
    const [post] = await db.sql`SELECT status FROM posts WHERE reddit_id = 't3_b'`;
    expect(post!['status']).toBe('notified');
  });

  it('keeps workers off buyer alerts while the user sender is live, and lets them back after', async () => {
    await seedTarget('t3_c');
    const bot = fakeBot();

    expect(await acquireUserSender(db.sql, 'api-a')).toBe(true);
    expect(await notifyOnce(deps(bot, {deferToUserSender: true}))).toBe(false);
    expect(bot.sent).toHaveLength(0);

    await db.sql`UPDATE telegram_state SET user_sender_at = NOW() - interval '10 minutes'`;
    expect(await notifyOnce(deps(bot, {deferToUserSender: true}))).toBe(true);
    expect(bot.sent).toHaveLength(1);
  });

  it('sends to a basic group through the bot, so reactions match its message ids', async () => {
    await db.sql`UPDATE settings SET value = '["-100123","-456"]'::jsonb WHERE key = 'telegram_chat_ids'`;
    await seedTarget('t3_h');
    const user = new FakeUser();
    const bot = fakeBot();

    const report = await createUserFirstSender(user, bot).send(['-100123', '-456'], {
      subreddit: 'homelabsales', summary: 's', price: null, url: 'u', title: 't',
    });

    expect(user.sent.map((m) => m.chatId)).toEqual(['-100123']);
    expect(bot.sent).toEqual([['-456']]);
    expect(report.fellBack).toBeUndefined();
  });
});

describe('user session hold', () => {
  it('lets one api hold the session until it lets go or goes stale', async () => {
    expect(await acquireUserSender(db.sql, 'old')).toBe(true);
    expect(await acquireUserSender(db.sql, 'new')).toBe(false);
    expect(await renewUserSender(db.sql, 'new')).toBe(false);

    await releaseUserSender(db.sql, 'old');
    expect(await acquireUserSender(db.sql, 'new')).toBe(true);

    // The outgoing api letting go late leaves the new hold alone.
    await releaseUserSender(db.sql, 'old');
    expect(await renewUserSender(db.sql, 'new')).toBe(true);

    await db.sql`UPDATE telegram_state SET user_sender_at = NOW() - interval '10 minutes'`;
    expect(await acquireUserSender(db.sql, 'old')).toBe(true);
    expect(await renewUserSender(db.sql, 'new')).toBe(false);
  });
});

describe('reads and /api/seen', () => {
  it('records readers of user-sent alerts and lists who saw what', async () => {
    await seedTarget('t3_d');
    await seedTarget('t3_e');
    const user = new FakeUser();
    await notifyOnce(deps(createUserFirstSender(user, fakeBot())));
    // Two alerts, ids 100 and 101 in claim order.
    const ids = (await db.sql<Array<{message_id: number}>>`
      SELECT message_id::int FROM alert_messages ORDER BY message_id`).map((r) => r.message_id);
    user.receipts.set(ids[0]!, [
      {userId: '1', readAt: new Date()}, // the sender itself
      {userId: '7', readAt: new Date(Date.now() - 60_000)},
      {userId: '8', readAt: new Date()},
    ]);
    user.receipts.set(ids[1]!, [{userId: '7', readAt: new Date()}]);
    user.roster = [
      {userId: '7', name: 'Ana', username: 'ana'},
      {userId: '8', name: 'Bo', username: null},
      {userId: '9', name: 'Cy', username: 'cy'},
    ];

    await readsOnce({sql: db.sql, user, settings: new SettingsStore(db.sql, 0), logger});
    // A second pass adds nothing new.
    await readsOnce({sql: db.sql, user, settings: new SettingsStore(db.sql, 0), logger});

    const result = await seen(db.sql, ['chat-1']);
    expect(result.alerts).toHaveLength(2);
    expect(result.alerts.every((a) => a.sentAs === 'user')).toBe(true);
    const readersOf = (id: number) => result.alerts.find((a) => a.messageId === id)!.readers.map((r) => r.userId);
    expect(readersOf(ids[0]!).sort()).toEqual(['7', '8']);
    expect(readersOf(ids[1]!)).toEqual(['7']);
    expect(result.people.map((p) => [p.name, p.seen, p.reachable, p.member])).toEqual([
      ['Ana', 2, 2, true],
      ['Bo', 1, 2, true],
      ['Cy', 0, 2, true],
    ]);
    expect(result.alerts.map((a) => a.members)).toEqual([3, 3]);
  });

  it('marks someone who left the chat, and keeps what they read', async () => {
    await seedTarget('t3_f');
    const user = new FakeUser();
    await notifyOnce(deps(createUserFirstSender(user, fakeBot())));
    const [msg] = await db.sql<Array<{message_id: number}>>`SELECT message_id::int FROM alert_messages`;
    user.receipts.set(msg!.message_id, [{userId: '7', readAt: new Date()}]);
    user.roster = [{userId: '7', name: 'Ana', username: 'ana'}];
    await readsOnce({sql: db.sql, user, settings: new SettingsStore(db.sql, 0), logger});

    user.roster = [];
    await readsOnce({sql: db.sql, user, settings: new SettingsStore(db.sql, 0), logger});

    const result = await seen(db.sql, ['chat-1']);
    expect(result.people).toEqual([
      expect.objectContaining({userId: '7', name: 'Ana', seen: 1, member: false}),
    ]);
  });

  it('keeps the roster when Telegram lists only part of it', async () => {
    const user = new FakeUser();
    user.roster = [{userId: '7', name: 'Ana', username: 'ana'}, {userId: '8', name: 'Bo', username: null}];
    await readsOnce({sql: db.sql, user, settings: new SettingsStore(db.sql, 0), logger});

    user.roster = [];
    user.rosterComplete = false;
    await readsOnce({sql: db.sql, user, settings: new SettingsStore(db.sql, 0), logger});

    expect((await seen(db.sql, ['chat-1'])).people.map((p) => [p.userId, p.member])).toEqual([
      ['7', true], ['8', true],
    ]);
  });

  it('counts each person against their own chat, and stops asking once everyone read', async () => {
    await db.sql`UPDATE settings SET value = '["chat-1","chat-2"]'::jsonb WHERE key = 'telegram_chat_ids'`;
    await seedTarget('t3_i');
    const user = new FakeUser();
    // Ana is only in chat-1, Bo only in chat-2.
    user.members = async (chatId: string) => ({
      members: chatId === 'chat-1' ? [{userId: '7', name: 'Ana', username: null}] : [{userId: '8', name: 'Bo', username: null}],
      complete: true,
    });
    await notifyOnce(deps(createUserFirstSender(user, fakeBot())));
    const msgs = await db.sql<Array<{chat_id: string; message_id: number}>>`
      SELECT chat_id, message_id::int FROM alert_messages ORDER BY chat_id`;
    user.receipts.set(msgs[0]!.message_id, [{userId: '7', readAt: new Date()}]);
    user.receipts.set(msgs[1]!.message_id, [{userId: '8', readAt: new Date()}]);
    await readsOnce({sql: db.sql, user, settings: new SettingsStore(db.sql, 0), logger});

    const result = await seen(db.sql, ['chat-1', 'chat-2']);
    expect(result.people.map((p) => [p.name, p.seen, p.reachable])).toEqual([['Ana', 1, 1], ['Bo', 1, 1]]);
    expect(result.alerts.map((a) => [a.readers.length, a.members])).toEqual([[1, 1], [1, 1]]);

    let asked = 0;
    user.readers = async () => { asked++; return []; };
    await readsOnce({sql: db.sql, user, settings: new SettingsStore(db.sql, 0), logger});
    expect(asked).toBe(0);
  });

  it('leaves alerts outside the last 24 hours out', async () => {
    await seedTarget('t3_g');
    await notifyOnce(deps(createUserFirstSender(new FakeUser(), fakeBot())));
    await db.sql`UPDATE alert_messages SET sent_at = NOW() - interval '25 hours'`;

    expect((await seen(db.sql, ['chat-1'])).alerts).toEqual([]);
  });
});
