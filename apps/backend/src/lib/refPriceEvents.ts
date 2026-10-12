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

/**
 * The same write for a whole price list: one INSERT and one UPDATE, so the
 * caller's row locks are held for two statements rather than two per price.
 * Every row gets the same source, note and actor. Returns how many it wrote.
 */
export async function appendPriceEvents(
  tx: postgres.TransactionSql,
  prices: ReadonlyMap<string, number>,
  meta: Omit<AppendPriceEventArgs, 'refPriceId' | 'price'>,
): Promise<number> {
  if (prices.size === 0) return 0;
  const ids = [...prices.keys()];
  const values = ids.map((id) => prices.get(id)!);
  const rows = await tx`
    WITH ev AS (
      INSERT INTO ref_price_events (ref_price_id, price, source, note, actor_user_id)
      SELECT v.id, v.price, ${meta.source}, ${meta.note}, ${meta.actorUserId}::uuid
      FROM unnest(${ids}::text[], ${values}::numeric[]) AS v(id, price)
      RETURNING ref_price_id, price, created_at
    )
    UPDATE ref_prices rp
       SET last_price        = ev.price,
           last_price_at     = ev.created_at,
           last_price_source = ${meta.source},
           updated_at        = NOW()
      FROM ev
     WHERE rp.id = ev.ref_price_id
    RETURNING rp.id
  `;
  return rows.length;
}
