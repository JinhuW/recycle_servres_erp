import { describe, expect, it } from 'vitest';
import { TelegramError, TelegramUpload } from '../src/lib/telegramBot';
import { userAccountCaller, type TelegramUserClient, type UserMessage } from '../src/lib/telegramUser';

// The account mode answers the hub's Bot API calls from a user session. These
// pin the translation; the hub's own behaviour is covered by fb-chat.test.ts.

function fake(history: UserMessage[]) {
  const calls: Array<[string, unknown[]]> = [];
  let activity: () => void = () => {};
  const client: TelegramUserClient = {
    async history(afterId, limit) {
      calls.push(['history', [afterId, limit]]);
      return afterId === 0 ? history.slice(-1) : history.filter((m) => m.id > afterId);
    },
    async send(text, opts) { calls.push(['send', [text, opts]]); return 900; },
    async sendPhotoUrl(url, caption, topicId) { calls.push(['photo', [url, caption, topicId]]); return 901; },
    async sendPhotos(files, caption, topicId) {
      calls.push(['photos', [files.map((f) => f.bytes.toString()), caption, topicId]]);
      return files.map((_, i) => 910 + i);
    },
    async createTopic(title) { calls.push(['createTopic', [title]]); return 77; },
    async renameTopic(topicId, title) { calls.push(['renameTopic', [topicId, title]]); },
    async react(messageId, emoji) { calls.push(['react', [messageId, emoji]]); },
    async download(messageId) { calls.push(['download', [messageId]]); return Buffer.from(`bytes of ${messageId}`); },
    onActivity(listener) { activity = listener; },
  };
  return { client, calls, ping: () => activity() };
}

const later = () => Math.floor(Date.now() / 1000) + 60;
const msg = (id: number, over: Partial<UserMessage> = {}): UserMessage => ({
  id, date: later(), topicId: 12, out: false, fromId: '7', firstName: 'Jin', text: `m${id}`, ...over,
});

describe('userAccountCaller', () => {
  it('posts to another chat the account is in when chat_id names one', async () => {
    const { client, calls } = fake([]);
    const call = userAccountCaller(client, '-1001234');
    await call('sendMessage', { chat_id: '-1009999', text: 'lead' });
    await call('sendMessage', { chat_id: '-1001234', text: 'group' });
    expect(calls).toEqual([
      ['send', ['lead', { topicId: undefined, replyToId: undefined, chatId: '-1009999' }]],
      ['send', ['group', { topicId: undefined, replyToId: undefined, chatId: undefined }]],
    ]);
  });

  it('places the cursor on the first read without treating history as replies', async () => {
    const { client } = fake([msg(40), msg(41)]);
    const call = userAccountCaller(client, '-1001234');
    const updates = await call<Array<{ update_id: number; message: { from?: unknown } }>>('getUpdates', { offset: 0, limit: 50 });
    expect(updates.map((u) => u.update_id)).toEqual([41]);
    expect(updates[0]!.message.from).toBeUndefined();
  });

  it('reads replies after the cursor as Bot API updates, and marks its own posts as a bot', async () => {
    const { client, calls } = fake([msg(41), msg(42, { out: true, fromId: '5', date: 1 }), msg(43, { topicId: null })]);
    const call = userAccountCaller(client, '-1001234');
    const updates = await call<Array<{ update_id: number; message: Record<string, unknown> }>>('getUpdates', { offset: 42, limit: 50 });
    expect(calls[0]).toEqual(['history', [41, 50]]);
    expect(updates.map((u) => u.update_id)).toEqual([42, 43]);
    expect(updates[0]!.message).toMatchObject({
      message_id: 42, message_thread_id: 12, is_topic_message: true, chat: { id: -1001234 },
      from: { id: 5, is_bot: true }, text: 'm42',
    });
    expect(updates[1]!.message).toMatchObject({ is_topic_message: false, from: { id: 7, is_bot: false, first_name: 'Jin' } });
  });

  it('relays a reply typed from the account itself, never a post the hub made', async () => {
    const history = [
      msg(900, { out: true, fromId: '5', text: '👤 Jinhu Wang: How much for DDR4' }),
      msg(950, { out: true, fromId: '5', text: '↩️ You: sorry' }),
      msg(951, { out: true, fromId: '5', text: 'nope' }),
      msg(952, { out: true, fromId: '5', text: 'typed before the session started', date: 1 }),
    ];
    const { client } = fake(history);
    const call = userAccountCaller(client, '-1001234');
    // 900 by id; 950 by text, as when Telegram's answer named no id.
    await call('sendMessage', { chat_id: '-1001234', message_thread_id: 12, text: '👤 Jinhu Wang: How much for DDR4' });
    client.send = async () => 0;
    await call('sendMessage', { chat_id: '-1001234', message_thread_id: 12, text: '↩️ You: sorry' });
    const updates = await call<Array<{ update_id: number; message: { from: { is_bot: boolean } } }>>('getUpdates', { offset: 900, limit: 50 });
    expect(updates.map((u) => [u.update_id, u.message.from.is_bot])).toEqual([[900, true], [950, true], [951, false], [952, true]]);
  });

  it('reads history only when something happened, or after the catch-up interval', async () => {
    const { client, calls, ping } = fake([msg(41)]);
    const call = userAccountCaller(client, '-1001234');
    await call('getUpdates', { offset: 42 });
    await call('getUpdates', { offset: 42 });
    expect(calls.filter(([name]) => name === 'history')).toHaveLength(1);
    ping();
    await call('getUpdates', { offset: 42 });
    expect(calls.filter(([name]) => name === 'history')).toHaveLength(2);
  });

  it('posts, replies, creates and renames topics, and reacts', async () => {
    const { client, calls } = fake([]);
    const call = userAccountCaller(client, '-1001234');
    expect(await call('createForumTopic', { chat_id: '-1001234', name: 'Kane · Aurora' })).toEqual({ message_thread_id: 77 });
    await call('editForumTopic', { chat_id: '-1001234', message_thread_id: 77, name: 'Kane Bryant · Aurora' });
    await call('sendMessage', { chat_id: '-1001234', message_thread_id: 77, text: 'hello' });
    await call('sendMessage', { chat_id: '-1001234', message_thread_id: 77, text: 'failed', reply_parameters: { message_id: 55 } });
    await call('sendMessage', { chat_id: '-1001234', text: 'alert' });
    await call('sendPhoto', { chat_id: '-1001234', message_thread_id: 77, photo: 'https://x/a.jpg', caption: 'look' });
    await call('setMessageReaction', { chat_id: '-1001234', message_id: 55, reaction: [{ type: 'emoji', emoji: '👍' }] });
    expect(calls).toEqual([
      ['createTopic', ['Kane · Aurora']],
      ['renameTopic', [77, 'Kane Bryant · Aurora']],
      ['send', ['hello', { topicId: 77, replyToId: undefined }]],
      ['send', ['failed', { topicId: 77, replyToId: 55 }]],
      ['send', ['alert', { topicId: undefined, replyToId: undefined }]],
      ['photo', ['https://x/a.jpg', 'look', 77]],
      ['react', [55, '👍']],
    ]);
  });

  it('uploads photos given as bytes, alone or as an album, and knows them as its own posts', async () => {
    const { client, calls } = fake([
      msg(910, { out: true, fromId: '5', text: '👤 Kane: look' }),
      msg(911, { out: true, fromId: '5', text: '' }),
      msg(912, { out: true, fromId: '5', text: '' }),
    ]);
    const call = userAccountCaller(client, '-1001234');
    const file = (s: string) => new TelegramUpload(Buffer.from(s), 'image/jpeg', 'photo.jpg');
    expect(await call('sendPhoto', { chat_id: '-1001234', message_thread_id: 77, photo: file('a'), caption: 'one' }))
      .toEqual({ message_id: 910 });
    expect(await call('sendMediaGroup', {
      chat_id: '-1001234', message_thread_id: 77,
      media: [{ type: 'photo', media: file('b'), caption: '👤 Kane: look' }, { type: 'photo', media: file('c') }, { type: 'photo', media: file('d') }],
    })).toEqual([{ message_id: 910 }, { message_id: 911 }, { message_id: 912 }]);
    expect(calls).toEqual([
      ['photos', [['a'], 'one', 77]],
      ['photos', [['b', 'c', 'd'], '👤 Kane: look', 77]],
    ]);
    await expect(call('sendMediaGroup', { chat_id: '-1001234', media: [{ type: 'photo', media: 'https://x/a.jpg' }] }))
      .rejects.toThrow(/uploaded files/);
    const updates = await call<Array<{ message: { from: { is_bot: boolean } } }>>('getUpdates', { offset: 910, limit: 50 });
    expect(updates.map((u) => u.message.from.is_bot)).toEqual([true, true, true]);
  });

  it('reports photos and files as the Bot API does, with the caption, and downloads them by message id', async () => {
    const { client, calls } = fake([
      msg(50, { text: 'see', media: { kind: 'photo', mime: 'image/jpeg', width: 1280, height: 960, bytes: 2000 }, groupedId: '9' }),
      msg(51, { text: '', media: { kind: 'document', mime: 'image/png', bytes: 300 }, groupedId: '9' }),
      msg(52, { text: 'a clip', media: { kind: 'other' } }),
      msg(53, { text: 'https://example.com' }),
    ]);
    const call = userAccountCaller(client, '-1001234');
    const updates = await call<Array<{ message: Record<string, unknown> }>>('getUpdates', { offset: 50, limit: 50 });
    expect(updates.map((u) => u.message)).toMatchObject([
      { caption: 'see', media_group_id: '9', photo: [{ file_id: '50', width: 1280, height: 960, file_size: 2000 }] },
      { document: { file_id: '51', mime_type: 'image/png', file_size: 300 }, media_group_id: '9' },
      { caption: 'a clip' },
      { text: 'https://example.com' },
    ]);
    expect(updates.map((u) => [u.message.text, u.message.photo ?? u.message.document ?? null]).slice(2))
      .toEqual([[undefined, null], ['https://example.com', null]]);
    const got = await call<{ bytes: Buffer }>('downloadFile', { file_id: '50' });
    expect(got.bytes.toString()).toBe('bytes of 50');
    expect(calls.at(-1)).toEqual(['download', [50]]);
  });

  it('refuses a call it has no equivalent for', async () => {
    const call = userAccountCaller(fake([]).client, '-1001234');
    await expect(call('deleteWebhook', {})).rejects.toThrow(/no user-account equivalent/);
    expect(TelegramError).toBeDefined();
  });
});
