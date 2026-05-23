import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { appendPriceEvent } from '../src/lib/refPriceEvents';

describe('appendPriceEvent', () => {
  let refPriceId: string;
  let userId: string;
  beforeAll(async () => {
    await resetDb();
    const sql = getTestDb();
    refPriceId = (await sql<{ id: string }[]>`SELECT id FROM ref_prices ORDER BY id LIMIT 1`)[0].id;
    userId = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active ORDER BY id LIMIT 1`)[0].id;
  });

  it('inserts an event and updates ref_prices.last_price* atomically', async () => {
    const sql = getTestDb();
    const ev = await sql.begin(async (tx) =>
      appendPriceEvent(tx, {
        refPriceId,
        price: 42.5,
        source: 'manual:test@x.io',
        note: 'broker quote',
        actorUserId: userId,
      }),
    );
    expect(ev.price).toBe(42.5);
    expect(ev.source).toBe('manual:test@x.io');

    const rp = (await sql<{ last_price: number; last_price_source: string; last_price_at: Date }[]>`
      SELECT last_price::float AS last_price, last_price_source, last_price_at
      FROM ref_prices WHERE id = ${refPriceId}
    `)[0];
    expect(rp.last_price).toBe(42.5);
    expect(rp.last_price_source).toBe('manual:test@x.io');
    expect(rp.last_price_at).toBeInstanceOf(Date);

    const evRow = (await sql<{ price: number; note: string | null; actor_user_id: string | null }[]>`
      SELECT price::float AS price, note, actor_user_id
      FROM ref_price_events
      WHERE ref_price_id = ${refPriceId}
      ORDER BY created_at DESC LIMIT 1
    `)[0];
    expect(evRow.price).toBe(42.5);
    expect(evRow.note).toBe('broker quote');
    expect(evRow.actor_user_id).toBe(userId);
  });

  it('a second call appends another event and bumps last_price', async () => {
    const sql = getTestDb();
    await sql.begin(async (tx) =>
      appendPriceEvent(tx, {
        refPriceId,
        price: 99.99,
        source: 'scraper:test',
        note: null,
        actorUserId: null,
      }),
    );
    const rp = (await sql<{ last_price: number; last_price_source: string }[]>`
      SELECT last_price::float AS last_price, last_price_source
      FROM ref_prices WHERE id = ${refPriceId}
    `)[0];
    expect(rp.last_price).toBe(99.99);
    expect(rp.last_price_source).toBe('scraper:test');

    const count = (await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM ref_price_events WHERE ref_price_id = ${refPriceId}
    `)[0].c;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('rolls back ref_prices.last_price* when the caller transaction throws', async () => {
    const sql = getTestDb();
    const before = (await sql<{ last_price: number | null; last_price_source: string | null; c: number }[]>`
      SELECT (SELECT last_price::float FROM ref_prices WHERE id = ${refPriceId}) AS last_price,
             (SELECT last_price_source FROM ref_prices WHERE id = ${refPriceId}) AS last_price_source,
             (SELECT COUNT(*)::int FROM ref_price_events WHERE ref_price_id = ${refPriceId}) AS c
    `)[0];

    await expect(sql.begin(async (tx) => {
      await appendPriceEvent(tx, {
        refPriceId, price: 1.23, source: 'rollback:test', note: null, actorUserId: null,
      });
      throw new Error('caller-error');
    })).rejects.toThrow('caller-error');

    const after = (await sql<{ last_price: number | null; last_price_source: string | null; c: number }[]>`
      SELECT (SELECT last_price::float FROM ref_prices WHERE id = ${refPriceId}) AS last_price,
             (SELECT last_price_source FROM ref_prices WHERE id = ${refPriceId}) AS last_price_source,
             (SELECT COUNT(*)::int FROM ref_price_events WHERE ref_price_id = ${refPriceId}) AS c
    `)[0];

    expect(after.last_price).toBe(before.last_price);
    expect(after.last_price_source).toBe(before.last_price_source);
    expect(after.c).toBe(before.c);
  });
});
