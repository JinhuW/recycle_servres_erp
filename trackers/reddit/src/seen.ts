// Who saw the buyer alerts of the last day, for the ERP's Reddit ▸ Seen tab.
// Read receipts exist only for alerts the user account sent (see
// userSender.ts), so each alert says how it went out and the page can tell
// "nobody saw it" from "no way to know".

import type {Sql} from './db.ts';
import {USER_SENDER_STALE_S} from './loops/notify.ts';

export const SEEN_HOURS = 24;

export interface SeenAlert {
  chatId: string;
  messageId: number;
  redditId: string;
  subreddit: string;
  title: string;
  url: string;
  sentAt: string;
  sentAs: 'bot' | 'user';
  readers: Array<{userId: string; readAt: string}>;
}

export interface SeenPerson {
  userId: string;
  name: string;
  username: string | null;
  /** Alerts in the window this person read. */
  seen: number;
  lastReadAt: string | null;
  /** Still in a buyer chat; false for a reader who has since left. */
  member: boolean;
}

export interface Seen {
  generatedAt: string;
  since: string;
  /** The api's user session is sending alerts right now. */
  userSenderLive: boolean;
  alerts: SeenAlert[];
  people: SeenPerson[];
}

export async function seen(sql: Sql, chatIds: string[]): Promise<Seen> {
  // The database's clock, which stamped sent_at, not this host's.
  const [{now}] = await sql<[{now: Date}]>`SELECT NOW() AS now`;
  const since = new Date(now.getTime() - SEEN_HOURS * 3600_000);

  const alerts = await sql<Array<{
    chat_id: string;
    message_id: string;
    reddit_id: string;
    subreddit: string;
    title: string;
    url: string;
    sent_at: Date;
    sent_as: 'bot' | 'user';
    readers: Array<{userId: string; readAt: string}>;
  }>>`
    SELECT a.chat_id, a.message_id::text, a.reddit_id, p.subreddit, p.title, p.url, a.sent_at, a.sent_as,
           COALESCE((SELECT json_agg(json_build_object('userId', r.user_id, 'readAt', r.read_at) ORDER BY r.read_at)
                       FROM message_reads r
                      WHERE r.chat_id = a.chat_id AND r.message_id = a.message_id), '[]') AS readers
      FROM alert_messages a
      JOIN posts p USING (reddit_id)
     WHERE a.audience = 'buyers' AND a.sent_at >= ${since}
     ORDER BY a.sent_at DESC`;

  // Everyone in a buyer chat, plus anyone who read an alert and has since
  // left. A reader the roster never saw falls back to the name their
  // reactions carried.
  const people = await sql<Array<{
    user_id: string;
    name: string | null;
    username: string | null;
    seen: number;
    last_read_at: Date | null;
    member: boolean;
  }>>`
    WITH reads AS (
      SELECT r.user_id, count(*)::int AS seen, max(r.read_at) AS last_read_at
        FROM message_reads r
        JOIN alert_messages a USING (chat_id, message_id)
       WHERE a.audience = 'buyers' AND a.sent_at >= ${since}
       GROUP BY r.user_id
    ), roster AS (
      SELECT DISTINCT ON (user_id) user_id, name, username
        FROM chat_members
       WHERE chat_id = ANY(${chatIds}::text[]) AND left_at IS NULL
       ORDER BY user_id, updated_at DESC
    )
    SELECT u.user_id,
           COALESCE(ro.name, cm.name,
                    (SELECT reactor_name FROM message_reactions mr
                      WHERE mr.reactor = u.user_id AND reactor_name IS NOT NULL
                      ORDER BY updated_at DESC LIMIT 1)) AS name,
           COALESCE(ro.username, cm.username) AS username,
           COALESCE(rd.seen, 0) AS seen, rd.last_read_at,
           ro.user_id IS NOT NULL AS member
      FROM (SELECT user_id FROM roster UNION SELECT user_id FROM reads) u
      LEFT JOIN roster ro USING (user_id)
      LEFT JOIN reads rd USING (user_id)
      LEFT JOIN LATERAL (SELECT name, username FROM chat_members c
                          WHERE c.user_id = u.user_id ORDER BY updated_at DESC LIMIT 1) cm ON TRUE
     ORDER BY COALESCE(rd.seen, 0) DESC, rd.last_read_at DESC NULLS LAST, name`;

  const [state] = await sql<Array<{live: boolean}>>`
    SELECT COALESCE(user_sender_at > NOW() - make_interval(secs => ${USER_SENDER_STALE_S}), false) AS live
      FROM telegram_state`;

  return {
    generatedAt: now.toISOString(),
    since: since.toISOString(),
    userSenderLive: state?.live ?? false,
    alerts: alerts.map((a) => ({
      chatId: a.chat_id,
      messageId: Number(a.message_id),
      redditId: a.reddit_id,
      subreddit: a.subreddit,
      title: a.title,
      url: a.url,
      sentAt: a.sent_at.toISOString(),
      sentAs: a.sent_as,
      readers: a.readers.map((r) => ({userId: r.userId, readAt: new Date(r.readAt).toISOString()})),
    })),
    people: people.map((p) => ({
      userId: p.user_id,
      name: p.name ?? p.user_id,
      username: p.username,
      seen: p.seen,
      lastReadAt: p.last_read_at?.toISOString() ?? null,
      member: p.member,
    })),
  };
}
