// Lightweight helper used by route handlers to enqueue a notification.
// The `tx` parameter is the postgres-js transaction handle yielded by
// `sql.begin(async (tx) => …)` — passing it (rather than a fresh sql client)
// keeps the notify INSERT inside the caller's transaction so we don't notify
// for events that ultimately roll back.

import type { Sql, TransactionSql } from 'postgres';

// Accept either the top-level `sql` client or a transaction handle from
// `sql.begin(async (tx) => …)`. Both expose the same template-tag call shape,
// but their TS types differ. Routes pass `tx` to keep the INSERT inside their
// outer transaction.
type SqlLike = Sql | TransactionSql;

export type NotifyInput = {
  userId: string;
  kind: string;
  tone?: 'info' | 'warn' | 'pos';
  icon?: string;
  title: string;
  body?: string;          // optional; defaults to '' since the column is NOT NULL
};

export async function notify(tx: SqlLike, n: NotifyInput): Promise<void> {
  await tx`
    INSERT INTO notifications (user_id, kind, tone, icon, title, body, unread)
    VALUES (${n.userId}, ${n.kind}, ${n.tone ?? 'info'},
            ${n.icon ?? 'bell'}, ${n.title}, ${n.body ?? ''}, TRUE)
  `;
}

export async function notifyManagers(tx: SqlLike, n: Omit<NotifyInput, 'userId'>): Promise<void> {
  const mgrs = await tx<{ id: string }[]>`
    SELECT id FROM users WHERE role = 'manager' AND COALESCE(active, true)
  `;
  for (const m of mgrs) await notify(tx, { ...n, userId: m.id });
}
