import type { Sql, TransactionSql } from 'postgres';

type SqlLike = Sql | TransactionSql;

// Atomically allocate the next human-friendly id (e.g. SO-1289). The single
// `UPDATE ... RETURNING` takes a row lock on the counter, so concurrent
// creates can never read the same value and collide on the primary key — the
// failure mode of the old `MAX(id)+1` scheme. Pass a transaction handle to
// keep the allocation in the caller's transaction, or the plain client to
// allocate independently (gaps on rollback are fine, same as a sequence).
export async function nextHumanId(
  sql: SqlLike,
  name: 'SO' | 'SL' | 'TO',
  prefix: string,
): Promise<string> {
  const rows = await sql<{ value: number }[]>`
    UPDATE id_counters SET value = value + 1 WHERE name = ${name} RETURNING value
  `;
  return `${prefix}-${rows[0].value}`;
}
