// Pulls who read each recent buyer alert the user account sent, and who is in
// the buyer chats, for the Seen tab. Telegram keeps no read history past
// 7 days and exposes none for bot messages, so this asks again on every pass
// and keeps what it got: a reader stays recorded after the window closes.

import type {Sql} from '../db.ts';
import type {Logger} from '../logger.ts';
import type {SettingsStore} from '../settings.ts';
import type {UserClient} from '../userSender.ts';

/** Reads keep arriving for days, but the Seen tab looks at one day. */
export const READS_LOOKBACK_HOURS = 48;

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
      await refreshMembers(sql, chatId, (await user.members(chatId)).filter((m) => m.userId !== user.selfId));
    } catch (e) {
      logger.info('could not list chat members', {chatId, error: errorText(e)});
    }
  }

  const messages = await sql<Array<{chat_id: string; message_id: string}>>`
    SELECT chat_id, message_id::text
      FROM alert_messages
     WHERE sent_as = 'user'
       AND audience = 'buyers'
       AND sent_at > NOW() - make_interval(hours => ${READS_LOOKBACK_HOURS})`;

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
    await tx`
      UPDATE chat_members SET left_at = NOW(), updated_at = NOW()
       WHERE chat_id = ${chatId} AND left_at IS NULL
         AND user_id <> ALL(${members.map((m) => m.userId)}::text[])`;
  });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
