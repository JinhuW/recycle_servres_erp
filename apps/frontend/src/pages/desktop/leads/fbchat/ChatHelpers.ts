import {
  fbChatConfigValue,
  type FbChatConfigPage, type FbChatMessageRow, type FbChatMessageSource,
} from '@recycle-erp/shared';

// What the Chats tab works out from the rows it is given. No React here, so
// each rule has a test beside it (ChatHelpers.test.ts).

/** A reply the page has sent but the server has not answered for yet. */
export type ChatPendingReply = { key: number; body: string; at: string };

export type ChatTimelineItem =
  | { kind: 'history' }
  | { kind: 'day'; at: string }
  | { kind: 'message'; message: FbChatMessageRow; /** The last of a run of bubbles from the same side. */ endsRun: boolean };

/** The calendar day in the viewer's own time zone, as a number that sorts. */
function localDay(iso: string): number {
  const d = new Date(iso);
  return d.getFullYear() * 10_000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** How many calendar days before `nowMs` the time falls: 0 today, 1 yesterday. */
export function chatDaysAgo(iso: string, nowMs: number): number {
  const d = new Date(iso);
  const n = new Date(nowMs);
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((dayStart(n) - dayStart(d)) / 86_400_000);
}

/**
 * The conversation as the pane draws it: the bubbles in the order given, a
 * note above history read in bulk, and a separator where a new day starts.
 */
export function chatTimeline(messages: readonly FbChatMessageRow[]): ChatTimelineItem[] {
  const items: ChatTimelineItem[] = [];
  let day = 0;
  let history = false;
  for (const message of messages) {
    if (message.backfill) {
      // A backfilled row's created_at is when the history was read, not when
      // the message was sent, so these get one note and no day of their own.
      if (!history) items.push({ kind: 'history' });
      history = true;
    } else {
      const d = localDay(message.created_at);
      // Only forward: a reply still waiting sorts after newer messages while
      // carrying an older time, and must not open a second "Yesterday".
      if (d > day) {
        items.push({ kind: 'day', at: message.created_at });
        day = d;
      }
    }
    items.push({ kind: 'message', message, endsRun: true });
  }
  for (let i = 0; i < items.length - 1; i++) {
    const item = items[i]!;
    const next = items[i + 1]!;
    if (item.kind === 'message' && next.kind === 'message' && next.message.direction === item.message.direction) {
      item.endsRun = false;
    }
  }
  return items;
}

/**
 * The rows to draw: what the server last answered, then replies it accepted
 * that the answer on screen is too old to hold, then replies still on their
 * way to the server. Without the middle part a reply would vanish for one
 * poll whenever a read that started before the send lands after it.
 */
export function chatMergeMessages(
  polled: readonly FbChatMessageRow[],
  accepted: readonly FbChatMessageRow[],
  pending: readonly ChatPendingReply[],
): FbChatMessageRow[] {
  const have = new Set(polled.map(m => m.id));
  return [
    ...polled,
    ...accepted.filter(m => !have.has(m.id)),
    ...pending.map(p => chatPendingRow(p)),
  ];
}

/** A stand-in row for a reply the server has not stored yet. Its id is negative so it can never match a real one. */
export function chatPendingRow(p: ChatPendingReply): FbChatMessageRow {
  return {
    id: -p.key, seq: null, direction: 'out', source: 'erp', body: p.body, images: [],
    backfill: false, fb_sent_label: null, send_state: 'queued', error: null, typing_ms: null,
    tg_user_name: null, erp_user_id: null, author_name: null, created_at: p.at, sent_at: null,
  };
}

/** True when the server would take a retry of this row (POST /messages/:id/retry). */
export function chatCanRetry(m: Pick<FbChatMessageRow, 'id' | 'direction' | 'seq' | 'send_state'>): boolean {
  return m.id > 0 && m.direction === 'out' && m.seq === null && (m.send_state === 'failed' || m.send_state === 'uncertain');
}

/** The CSS suffix for where a reply was typed. */
export const CHAT_SOURCE_CLASS: Record<FbChatMessageSource, 'fb' | 'tg' | 'erp'> = {
  facebook: 'fb', telegram: 'tg', erp: 'erp',
};

export function chatFirstName(name: string | null): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

export type ChatPacing = { pace: number; gapSec: number };

/**
 * How the account types a reply, from its effective settings. Null until both
 * values are known: the composer then says nothing rather than guess.
 */
export function chatPacing(config: Pick<FbChatConfigPage, 'fields' | 'entries'> | null, accountId: number): ChatPacing | null {
  if (!config) return null;
  const pace = fbChatConfigValue(config, 'typingPace', accountId);
  const gapSec = fbChatConfigValue(config, 'minSendIntervalSec', accountId);
  return typeof pace === 'number' && typeof gapSec === 'number' ? { pace, gapSec } : null;
}
