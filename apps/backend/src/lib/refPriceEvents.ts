import type postgres from 'postgres';

// Single write path for any change to ref_prices.last_price. Inserts the
// event then updates the denormalised columns on ref_prices inside the
// caller's sql.begin so both rows commit or neither does.

export type AppendPriceEventArgs = {
  refPriceId: string;
  price: number;
  source: string;
  note: string | null;
  actorUserId: string | null;
};

export type AppendedPriceEvent = {
  id: string;
  price: number;
  source: string;
  note: string | null;
  createdAt: Date;
};

export async function appendPriceEvent(
  tx: postgres.TransactionSql,
  args: AppendPriceEventArgs,
): Promise<AppendedPriceEvent> {
  const ev = (await tx<{ id: string; price: number; source: string; note: string | null; created_at: Date }[]>`
    INSERT INTO ref_price_events (ref_price_id, price, source, note, actor_user_id)
    VALUES (${args.refPriceId}, ${args.price}, ${args.source}, ${args.note}, ${args.actorUserId})
    RETURNING id::text AS id, price::float AS price, source, note, created_at
  `)[0];

  await tx`
    UPDATE ref_prices
       SET last_price        = ${args.price},
           last_price_at     = ${ev.created_at},
           last_price_source = ${args.source},
           updated_at        = NOW()
     WHERE id = ${args.refPriceId}
  `;

  return {
    id: ev.id,
    price: ev.price,
    source: ev.source,
    note: ev.note,
    createdAt: ev.created_at,
  };
}
