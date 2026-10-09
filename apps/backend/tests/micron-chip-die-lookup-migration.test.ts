import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';

const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../migrations/0168_micron_chip_die_lookup.sql'),
  'utf8',
);

const LINE = {
  category: 'RAM', brand: 'Micron', capacity: '32GB', type: 'Server', generation: 'DDR4',
  classification: 'RDIMM', rank: '2Rx4', speed: '2666', condition: 'Pulled — Tested', qty: 1, unitCost: 10,
};

// Rows as they sit in prod before 0168: brand, part number and chip set by SQL,
// behind the API's back, so raw spellings the API would normalise can be planted.
type Raw = { category?: string; brand: string; part: string; chip: string | null };
const RAW: Raw[] = [
  { brand: 'Micron', part: 'MTA36ASF4G72PZ-2G6E1QG', chip: 'na' },           // 0 sheet part, junk → VPS
  { brand: ' micron ', part: 'mta36asf4g72pz 2g6e1qg', chip: null },        // 1 same key, other spelling → VPS
  { brand: 'Micron', part: 'MTA36ASF4G72PZ-2G6E1QG', chip: ' WFH ' },       // 2 a 3-letter code stays
  { brand: 'Micron', part: 'MTA36ASF4G72PZ-2G6E1QG', chip: 'vpp' },         // 3 a 3-letter code stays
  { brand: 'Samsung', part: 'MTA36ASF4G72PZ-2G6E1QG', chip: 'NA' },         // 4 other brand stays
  { category: 'SSD', brand: 'Micron', part: 'MTA36ASF4G72PZ-2G6E1QG', chip: 'NA' }, // 5 non-RAM stays
  { brand: 'Micron', part: 'MTA16ATF2G64HZ-2G3B1', chip: 'NA' },            // 6 skipped conflict stays
  { brand: 'Micron', part: 'ZZTEST-NOT-ON-SHEET', chip: 'NA' },             // 7 not on the sheet stays
  { brand: 'Micron', part: 'MTA36ASF4G72PZ-2G3B1IK', chip: 'TBG' },         // 8 misread → TBJ
  { brand: 'Kingston', part: 'KSM26RD4/32MEI', chip: 'TBG' },               // 9 misread on another brand stays
];

async function seedRaw(): Promise<string> {
  const { token } = await loginAs(MARCUS);
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      paypalTxnId: 'TESTPAYTXN0000001', category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
      lines: RAW.map((_, i) => ({ ...LINE, partNumber: `CHIP-LOOKUP-${i}` })),
    },
  });
  expect(r.status).toBe(201);
  const sql = getTestDb();
  for (const [i, row] of RAW.entries()) {
    await sql`UPDATE order_lines
                 SET category = ${row.category ?? 'RAM'}, brand = ${row.brand},
                     part_number = ${row.part}, chip_number = ${row.chip}
               WHERE order_id = ${r.body.id} AND part_number = ${`CHIP-LOOKUP-${i}`}`;
  }
  return r.body.id;
}

describe('0168: Micron Chip # from the die-code lookup', () => {
  beforeEach(async () => { await resetDb(); });

  it('fills junk and blank chips on sheet parts and leaves everything else alone', async () => {
    const id = await seedRaw();
    await getTestDb().unsafe(migration);
    const got = (await getTestDb()<{ part_number: string; brand: string; category: string; chip_number: string | null }[]>`
      SELECT part_number, brand, category, chip_number FROM order_lines WHERE order_id = ${id}
      ORDER BY part_number, brand, category, chip_number NULLS FIRST
    `).map(r => `${r.category}|${r.brand}|${r.part_number}|${r.chip_number}`);
    expect(got.sort()).toEqual([
      'RAM|Micron|MTA36ASF4G72PZ-2G6E1QG|VPS',
      'RAM| micron |mta36asf4g72pz 2g6e1qg|VPS',
      'RAM|Micron|MTA36ASF4G72PZ-2G6E1QG| WFH ',
      'RAM|Micron|MTA36ASF4G72PZ-2G6E1QG|vpp',
      'RAM|Samsung|MTA36ASF4G72PZ-2G6E1QG|NA',
      'SSD|Micron|MTA36ASF4G72PZ-2G6E1QG|NA',
      'RAM|Micron|MTA16ATF2G64HZ-2G3B1|NA',
      'RAM|Micron|ZZTEST-NOT-ON-SHEET|NA',
      'RAM|Micron|MTA36ASF4G72PZ-2G3B1IK|TBJ',
      'RAM|Kingston|KSM26RD4/32MEI|TBG',
    ].sort());
  });

  it('is a no-op the second time', async () => {
    await seedRaw();
    const sql = getTestDb();
    await sql.unsafe(migration);
    const snapshot = await sql`SELECT id, chip_number FROM order_lines ORDER BY id`;
    await sql.unsafe(migration);
    expect(await sql`SELECT id, chip_number FROM order_lines ORDER BY id`).toEqual(snapshot);
  });

  it('carries one 3-letter die per part key, and none for the skipped parts', () => {
    const rows = [...migration.matchAll(/\('([A-Z0-9]+)', '([^']*)'\)/g)].map(m => ({ key: m[1], die: m[2] }));
    expect(rows).toHaveLength(104);
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length);
    for (const r of rows) expect(r.die).toMatch(/^[A-Z]{3}$/);
    const keys = new Set(rows.map(r => r.key));
    for (const skipped of ['MTA16ATF2G64HZ2G3B1', 'CT16G4DFD824AM16FE', 'MTA8ATF1G64AZ2G6E1',
      'MTC8C1084S1SC56BD1', 'MTC8C1084S1SC56BD1NF', 'MTA16ATF2G64HZ3G2J1', 'NA']) {
      expect(keys.has(skipped)).toBe(false);
    }
  });
});
