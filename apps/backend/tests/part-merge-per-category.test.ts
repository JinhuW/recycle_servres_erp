// 0110 merged catalogue rows that were the same part spelled with different
// separators, but it grouped by canonical part number alone and skipped any
// group whose rows disagreed on category — so one unrelated row in another
// category kept a pair of real duplicates apart. 0112 partitions by
// (canon, category) and finishes the job.
//
// Both migrations run against an empty schema when a worker builds its template
// database, so by the time fixtures exist they have already executed and are a
// silent no-op in the normal suite. Rather than duplicate the SQL here, this
// replays the real migration files over data it has just inserted.
//
// Each file gets its own `unsafe()` call on purpose: with no bind arguments
// postgres.js sends it over the simple query protocol as one implicit
// transaction, so the `ON COMMIT DROP` temp tables both files declare are gone
// before the next replay. Run them in a single transaction and they collide.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, getTestDb } from './helpers/db';

const migration = (name: string) =>
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', name),
    'utf8',
  );

const MERGE_BY_CANON = migration('0110_merge_separator_duplicate_parts.sql');
const MERGE_PER_CATEGORY = migration('0112_merge_duplicate_parts_per_category.sql');

// Fixtures are isolated by canonical part number, not by id: the seed's own
// ref_prices rows are in the cloned template, and a collision would happen on
// the canon, not the primary key.
const RAM_HYPHEN = 'MRG-A-1';
const RAM_USCORE = 'MRG-A_1';
const SSD_PLAIN = 'MRG-A1';

type RefRow = {
  id: string; part_number: string; category: string;
  last_price: string | null; history: unknown[];
};

async function seedRef(
  id: string, partNumber: string, category: string,
  opts: { lastPrice?: number; lastPriceAt?: string; history?: unknown[] } = {},
) {
  const db = getTestDb();
  await db`
    INSERT INTO ref_prices (id, category, label, part_number,
                            last_price, last_price_at, history, updated_at)
    VALUES (${id}, ${category}, ${'merge ' + id}, ${partNumber},
            ${opts.lastPrice ?? null}, ${opts.lastPriceAt ?? null},
            ${db.json(opts.history ?? [])}, NOW())
  `;
}

const readRefs = async (): Promise<RefRow[]> => {
  const db = getTestDb();
  return db<RefRow[]>`
    SELECT id, part_number, category, last_price, history
    FROM ref_prices WHERE part_number LIKE 'MRG-%' ORDER BY id
  `;
};

describe('0112 merges duplicate part numbers per category', () => {
  beforeEach(async () => {
    await resetDb();
    // Two RAM spellings of one part, plus an SSD row that canonicalises the
    // same way and is a genuinely different product.
    await seedRef('rp-ram-hyphen', RAM_HYPHEN, 'RAM', {
      lastPrice: 40, lastPriceAt: '2026-01-01T00:00:00Z', history: [{ p: 40 }],
    });
    await seedRef('rp-ram-uscore', RAM_USCORE, 'RAM', {
      lastPrice: 55, lastPriceAt: '2026-02-01T00:00:00Z', history: [{ p: 55 }],
    });
    await seedRef('rp-ssd-plain', SSD_PLAIN, 'SSD', { lastPrice: 900 });
  });

  it('0110 leaves the RAM duplicates split when another category shares the key', async () => {
    const db = getTestDb();
    await db.unsafe(MERGE_BY_CANON);

    const rows = await readRefs();
    expect(rows.map(r => r.id)).toEqual(['rp-ram-hyphen', 'rp-ram-uscore', 'rp-ssd-plain']);
  });

  it('merges the same-category duplicates and leaves the other category alone', async () => {
    const db = getTestDb();
    await db.unsafe(MERGE_BY_CANON);
    await db.unsafe(MERGE_PER_CATEGORY);

    const rows = await readRefs();
    expect(rows.length, 'one RAM row and one SSD row survive').toBe(2);

    const ram = rows.filter(r => r.category === 'RAM');
    expect(ram.length).toBe(1);
    // No whitespace in either spelling, neither is used by a line, so the tie
    // falls to the more recently updated row and then the alphabetical one.
    expect(ram[0].part_number).toMatch(/^MRG-A[-_]1$/);
    // The winner takes the group's freshest reading and both histories.
    expect(Number(ram[0].last_price)).toBe(55);
    expect(ram[0].history).toHaveLength(2);

    const ssd = rows.filter(r => r.category === 'SSD');
    expect(ssd.length, 'the SSD row is a different product').toBe(1);
    expect(ssd[0].id).toBe('rp-ssd-plain');
    expect(Number(ssd[0].last_price)).toBe(900);
  });

  it('re-spells only the lines in the category it merged', async () => {
    const db = getTestDb();
    const [user] = await db<{ id: string }[]>`
      SELECT id FROM users WHERE email = 'marcus@recycleservers.io'
    `;
    await db`
      INSERT INTO orders (id, user_id, category) VALUES ('PO-MRG', ${user.id}, 'RAM')
    `;
    // Same spelling as a RAM loser, but an SSD line — a different product that
    // the RAM merge has no business rewriting.
    await db`
      INSERT INTO order_lines (order_id, category, part_number, qty, unit_cost)
      VALUES ('PO-MRG', 'RAM', ${RAM_USCORE}, 1, 10),
             ('PO-MRG', 'SSD', ${RAM_USCORE}, 1, 10)
    `;

    await db.unsafe(MERGE_BY_CANON);
    await db.unsafe(MERGE_PER_CATEGORY);

    const [ram] = await db<{ part_number: string }[]>`
      SELECT part_number FROM order_lines WHERE order_id = 'PO-MRG' AND category = 'RAM'
    `;
    const [ssd] = await db<{ part_number: string }[]>`
      SELECT part_number FROM order_lines WHERE order_id = 'PO-MRG' AND category = 'SSD'
    `;

    const [winner] = await db<{ part_number: string }[]>`
      SELECT part_number FROM ref_prices WHERE part_number LIKE 'MRG-%' AND category = 'RAM'
    `;
    expect(ram.part_number, 'the RAM line follows its merged row').toBe(winner.part_number);
    expect(ssd.part_number, 'the SSD line is untouched').toBe(RAM_USCORE);
  });

  it('is safe to run twice', async () => {
    const db = getTestDb();
    await db.unsafe(MERGE_BY_CANON);
    await db.unsafe(MERGE_PER_CATEGORY);
    const before = await readRefs();
    await db.unsafe(MERGE_PER_CATEGORY);
    const after = await readRefs();
    expect(after).toEqual(before);
  });
});
