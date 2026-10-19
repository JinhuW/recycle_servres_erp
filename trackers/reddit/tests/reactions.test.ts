// The reaction consumer against real Postgres with a stubbed Telegram. These
// prove the lead signal is trustworthy: every reaction change lands, the
// current state follows add/change/remove, and the cursor neither replays nor
// skips across restarts.

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {createLogger} from '../src/logger.ts';
import {reactionsOnce, type ReactionsDeps, type TelegramUpdate} from '../src/loops/reactions.ts';
import {SettingsStore} from '../src/settings.ts';
import {createTestDb, type TestDb} from './helpers/db.ts';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb('reactions');
}, 60_000);

afterAll(async () => {
  await db.drop();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const BUYERS = '-1003943525487';
const DEV = '-1009000000001';

beforeEach(async () => {
  await db.sql`DELETE FROM reaction_events`;
  await db.sql`DELETE FROM message_reactions`;
  await db.sql`DELETE FROM message_reaction_counts`;
  await db.sql`UPDATE telegram_state SET next_offset = 0`;
  await db.sql`UPDATE settings SET value = ${db.sql.json([BUYERS])} WHERE key = 'telegram_chat_ids'`;
  await db.sql`UPDATE settings SET value = ${db.sql.json([DEV])}
                WHERE key = 'telegram_dev_chat_ids'`;
});

function deps(logger = createLogger('api-1', 'error')): ReactionsDeps {
  return {sql: db.sql, botToken: 'bot-token', settings: new SettingsStore(db.sql, 0), logger};
}

/** Serves each batch to one getUpdates call, then empty long polls. */
function stubUpdates(...batches: TelegramUpdate[][]) {
  const spy = vi.fn().mockImplementation(async () => new Response(
    JSON.stringify({ok: true, result: batches.shift() ?? []}),
    {status: 200},
  ));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function reaction(
  updateId: number,
  emoji: string[],
  overrides: Partial<NonNullable<TelegramUpdate['message_reaction']>> = {},
): TelegramUpdate {
  return {
    update_id: updateId,
    message_reaction: {
      chat: {id: Number(BUYERS), type: 'supergroup'},
      message_id: 501,
      user: {id: 7001, is_bot: false, first_name: 'Ana', last_name: 'Buyer'},
      date: 1_790_000_000 + updateId,
      old_reaction: [],
      new_reaction: emoji.map((e) => ({type: 'emoji', emoji: e})),
      ...overrides,
    },
  };
}

async function currentEmoji(chatId = BUYERS, messageId = 501): Promise<Record<string, unknown>> {
  const rows = await db.sql<Array<{reactor: string; emoji: string[]}>>`
    SELECT reactor, emoji FROM message_reactions
     WHERE chat_id = ${chatId} AND message_id = ${messageId}`;
  return Object.fromEntries(rows.map((r) => [r.reactor, r.emoji]));
}

async function nextOffset(): Promise<number> {
  const [row] = await db.sql<Array<{next_offset: string}>>`
    SELECT next_offset::text FROM telegram_state`;
  return Number(row?.next_offset);
}

describe('reactionsOnce', () => {
  it('asks Telegram for reaction updates from the stored cursor', async () => {
    await db.sql`UPDATE telegram_state SET next_offset = 42`;
    const spy = stubUpdates([]);

    expect(await reactionsOnce(deps())).toBe(false);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botbot-token/getUpdates');
    const body = JSON.parse(init.body as string);
    expect(body.offset).toBe(42);
    expect(body.allowed_updates).toEqual(
      ['message_reaction', 'message_reaction_count', 'my_chat_member'],
    );
  });

  it('follows a group reaction as it is added, changed and removed', async () => {
    stubUpdates([reaction(10, ['👍'])], [reaction(11, ['🔥'])], [reaction(12, [])]);

    await reactionsOnce(deps());
    expect(await currentEmoji()).toEqual({'7001': ['👍']});
    await reactionsOnce(deps());
    expect(await currentEmoji()).toEqual({'7001': ['🔥']});
    await reactionsOnce(deps());
    // Removal empties the state but keeps the row, and every change is logged.
    expect(await currentEmoji()).toEqual({'7001': []});

    const [events] = await db.sql<Array<{n: number}>>`
      SELECT COUNT(*)::int AS n FROM reaction_events`;
    expect(events?.n).toBe(3);
    const [row] = await db.sql<Array<{reactor_name: string; first_reacted_at: Date}>>`
      SELECT reactor_name, first_reacted_at FROM message_reactions`;
    expect(row?.reactor_name).toBe('Ana Buyer');
    expect(row?.first_reacted_at).toEqual(new Date((1_790_000_000 + 10) * 1000));
  });

  it('keeps an anonymous admin reaction and ignores a bot', async () => {
    stubUpdates([
      reaction(20, ['👍'], {user: undefined, actor_chat: {id: Number(BUYERS), title: 'Alerts'}}),
      reaction(21, ['👍'], {user: {id: 9001, is_bot: true}}),
    ]);

    await reactionsOnce(deps());

    expect(await currentEmoji()).toEqual({[`chat:${BUYERS}`]: ['👍']});
  });

  it('records the anonymous totals a channel reports', async () => {
    stubUpdates([{
      update_id: 30,
      message_reaction_count: {
        chat: {id: Number(DEV), type: 'channel'},
        message_id: 77,
        date: 1_790_000_030,
        reactions: [
          {type: {type: 'emoji', emoji: '👍'}, total_count: 2},
          {type: {type: 'paid'}, total_count: 1},
        ],
      },
    }]);

    await reactionsOnce(deps());

    const [row] = await db.sql<Array<{counts: Record<string, number>}>>`
      SELECT counts FROM message_reaction_counts WHERE chat_id = ${DEV} AND message_id = 77`;
    expect(row?.counts).toEqual({'👍': 2, 'paid': 1});
  });

  it('records nothing from a chat it was not configured for, but still moves past it', async () => {
    stubUpdates([reaction(40, ['👍'], {chat: {id: -100555, type: 'supergroup'}})]);

    expect(await reactionsOnce(deps())).toBe(true);

    const [row] = await db.sql<Array<{n: number}>>`SELECT COUNT(*)::int AS n FROM reaction_events`;
    expect(row?.n).toBe(0);
    expect(await nextOffset()).toBe(41);
  });

  it('logs the chat the bot was just added to, which is how a dev channel id surfaces', async () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const logger = {...createLogger('api-1', 'error'), event: (name: string, fields: Record<string, unknown>) => {
      events.push([name, fields]);
    }};
    stubUpdates([{
      update_id: 50,
      my_chat_member: {
        chat: {id: -1009000000002, type: 'channel', title: 'Reddit alerts (dev)'},
        new_chat_member: {status: 'administrator'},
      },
    }]);

    await reactionsOnce(deps(logger));

    expect(events).toEqual([['telegram_chat_member', {
      chatId: '-1009000000002',
      chatType: 'channel',
      chatTitle: 'Reddit alerts (dev)',
      status: 'administrator',
    }]]);
  });

  it('resumes after a restart without replaying what it already stored', async () => {
    stubUpdates([reaction(60, ['👍']), reaction(61, ['👍'], {user: {id: 7002}})]);
    await reactionsOnce(deps());
    expect(await nextOffset()).toBe(62);

    // A replay of an update it already stored — e.g. a crash before the
    // cursor moved — leaves one event, not two.
    stubUpdates([reaction(61, ['👍'], {user: {id: 7002}})]);
    await reactionsOnce(deps());

    const [row] = await db.sql<Array<{n: number}>>`SELECT COUNT(*)::int AS n FROM reaction_events`;
    expect(row?.n).toBe(2);
  });

  it('leaves the cursor alone when Telegram refuses the poll', async () => {
    await db.sql`UPDATE telegram_state SET next_offset = 70`;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ok: false, description: 'Conflict: terminated by other getUpdates request'}),
      {status: 409},
    )));

    expect(await reactionsOnce(deps())).toBe(false);
    expect(await nextOffset()).toBe(70);
  });

  it('treats a network failure as an empty poll', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));

    expect(await reactionsOnce(deps())).toBe(false);
    expect(await nextOffset()).toBe(0);
  });
});
