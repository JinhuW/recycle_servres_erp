// Pulls who read each recent buyer alert the user account sent, and who is in
// the buyer chats, for the Seen tab. Telegram keeps no read history past
// 7 days and exposes none for bot messages, so this asks again on every pass
// and keeps what it got: a reader stays recorded after the window closes.

import type {Sql} from '../db.ts';
import type {Logger} from '../logger.ts';
import type {SettingsStore} from '../settings.ts';
import {SEEN_HOURS} from '../seen.ts';
import type {UserClient} from '../userSender.ts';

export interface ReadsDeps {
  sql: Sql;
  user: UserClient;
  settings: SettingsStore;
  logger: Logger;
}

export async function readsOnce(deps: ReadsDeps): Promise<boolean> {
  const {sql, user, logger} = deps;

  for (const chatId of (await deps.settings.get()).telegramChatIds) {
    try {
      const {members, complete} = await user.members(chatId);
      await refreshMembers(sql, chatId, members.filter((m) => m.userId !== user.selfId), complete);
      if (!complete) logger.info('chat lists only part of its members; nobody marked as left', {chatId});
    } catch (e) {
      logger.info('could not list chat members', {chatId, error: errorText(e)});
    }
  }

  // One request per alert on a user account, so only the alerts the Seen tab
  // shows, and not one everybody in its chat has already read.
  const messages = await sql<Array<{chat_id: string; message_id: string}>>`
    SELECT a.chat_id, a.message_id::text
      FROM alert_messages a
     WHERE a.sent_as = 'user'
       AND a.audience = 'buyers'
       AND a.sent_at > NOW() - make_interval(hours => ${SEEN_HOURS})
       AND (EXISTS (SELECT 1 FROM chat_members m
                     WHERE m.chat_id = a.chat_id AND m.left_at IS NULL
                       AND NOT EXISTS (SELECT 1 FROM message_reads r
                                        WHERE r.chat_id = a.chat_id AND r.message_id = a.message_id
                                          AND r.user_id = m.user_id))
            -- No roster (it could not be listed): no way to know who is left.
            OR NOT EXISTS (SELECT 1 FROM chat_members m
                            WHERE m.chat_id = a.chat_id AND m.left_at IS NULL))`;

  for (const m of messages) {
    let receipts;
    try {
      receipts = await user.readers(m.chat_id, Number(m.message_id));
    } catch (e) {
      // A chat past 100 members or a message past 7 days answers with an
      // error rather than an empty list; neither is worth paging about.
      logger.info('could not read receipts', {chatId: m.chat_id, messageId: m.message_id, error: errorText(e)});
      continue;
    }
    const others = receipts.filter((r) => r.userId !== user.selfId);
    if (others.length === 0) continue;
    await sql`
      INSERT INTO message_reads (chat_id, message_id, user_id, read_at)
      SELECT ${m.chat_id}, ${m.message_id}::bigint, r.user_id, r.read_at
        FROM unnest(${others.map((r) => r.userId)}::text[],
                    ${others.map((r) => r.readAt.toISOString())}::timestamptz[]) AS r(user_id, read_at)
      ON CONFLICT (chat_id, message_id, user_id) DO NOTHING`;
  }

  return false;
}

async function refreshMembers(
  sql: Sql,
  chatId: string,
  members: ReadonlyArray<{userId: string; name: string; username: string | null}>,
  complete: boolean,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO chat_members (chat_id, user_id, name, username)
      SELECT ${chatId}, m.user_id, m.name, NULLIF(m.username, '')
        FROM unnest(${members.map((m) => m.userId)}::text[],
                    ${members.map((m) => m.name)}::text[],
                    ${members.map((m) => m.username ?? '')}::text[]) AS m(user_id, name, username)
      ON CONFLICT (chat_id, user_id) DO UPDATE
        SET name = EXCLUDED.name, username = EXCLUDED.username,
            left_at = NULL, updated_at = NOW()`;
    if (!complete) return;
    await tx`
      UPDATE chat_members SET left_at = NOW(), updated_at = NOW()
       WHERE chat_id = ${chatId} AND left_at IS NULL
         AND user_id <> ALL(${members.map((m) => m.userId)}::text[])`;
  });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
