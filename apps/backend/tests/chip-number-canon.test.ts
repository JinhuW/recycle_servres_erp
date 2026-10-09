// Micron's Chip # is the 3-letter die code the price list buckets by (VPP,
// TBH, …), not the whole two-line marking a purchaser reads off the chip —
// `8KE75 D9VPP` is a date code over the FBGA code, and the date code made every
// line's chip unique.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chipMarkingCanon } from '@recycle-erp/shared';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';

const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../migrations/0167_micron_chip_die_code.sql'),
  'utf8',
);

// Spellings seen on prod Micron lines, with what each should store.
const MICRON: Array<[string, string]> = [
  ['8KE75 D9VPP', 'VPP'],
  ['8KE75D9VPP', 'VPP'],
  ['0NJ45D9WSM', 'WSM'],
  ['2EF75D8CJV', 'CJV'],
  ['0DJ75C9BJR', 'BJR'],
  ['M-BRE75D9VPP', 'VPP'],
  ['D9XPF', 'XPF'],
  ['d9xpf', 'XPF'],
  ['VPP', 'VPP'],
  // No die code at the end — left for a person with the stick in hand.
  ['1', '1'],
  ['BHB', 'BHB'],
  ['DDR5', 'DDR5'],
  ['7TH7509VHP', '7TH7509VHP'],
  ['1HR75D8PJ', '1HR75D8PJ'],
  ['MICRON CHIP', 'MICRON CHIP'],
];

describe('chipMarkingCanon', () => {
  it.each(MICRON)('Micron %s → %s', (raw, want) => {
    expect(chipMarkingCanon(raw, 'Micron')).toBe(want);
  });

  it('is idempotent', () => {
    for (const [raw] of MICRON) {
      const once = chipMarkingCanon(raw, 'Micron');
      expect(chipMarkingCanon(once, 'Micron')).toBe(once);
    }
  });

  it('reads the brand case- and space-insensitively', () => {
    expect(chipMarkingCanon('8KE75 D9VPP', ' MICRON ')).toBe('VPP');
  });

  it('only upper-cases other brands, Micron-shaped or not', () => {
    expect(chipMarkingCanon(' d9vpp ', 'Kingston')).toBe('D9VPP');
    expect(chipMarkingCanon('k4a8g085wd', 'Samsung')).toBe('K4A8G085WD');
    expect(chipMarkingCanon('H5AN8G8NCJ', 'SK Hynix')).toBe('H5AN8G8NCJ');
    expect(chipMarkingCanon('8KE75D9VPP', null)).toBe('8KE75D9VPP');
  });
});

type Line = { id: string; chipNumber: string | null };
type Detail = { order: { lifecycle: string; lines: Line[] } };

const LINE = {
  category: 'RAM', brand: 'Micron', capacity: '8GB', type: 'Desktop', generation: 'DDR4',
  classification: 'UDIMM', rank: '1Rx8', speed: '2666', partNumber: 'MTA8ATF1G64AZ-2G6E1',
  condition: 'Pulled — Tested', qty: 6, unitCost: 9,
};

async function createPo(token: string, lines: Record<string, unknown>[]): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: { paypalTxnId: 'TESTPAYTXN0000001', category: 'RAM', warehouseId: 'WH-LA1', payment: 'company', lines },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

const get = async (id: string, token: string) =>
  (await api<Detail>('GET', `/api/orders/${id}`, { token })).body.order;

describe('Chip # writes', () => {
  beforeEach(async () => { await resetDb(); });

  it('stores the die code when a Micron line is created', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createPo(token, [
      { ...LINE, chipNumber: '8KE75 D9VPP' },
      { ...LINE, brand: 'Samsung', partNumber: 'M378A1K43CB2-CTD', chipNumber: 'k4a8g085wc-bctd' },
    ]);
    const chips = (await get(id, token)).lines.map(l => l.chipNumber).sort();
    expect(chips).toEqual(['K4A8G085WC-BCTD', 'VPP']);
  });

  it('a tab still holding the raw marking re-saves without sending the PO back to Draft', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createPo(token, [{ ...LINE, chipNumber: '8KE75 D9VPP' }]);
    expect((await api('POST', `/api/orders/${id}/advance`, { token })).status).toBe(200);
    const before = await get(id, token);
    expect(before.lifecycle).not.toBe('draft');

    const patched = await api('PATCH', `/api/orders/${id}`, {
      token, body: { lines: [{ id: before.lines[0].id, brand: 'Micron', chipNumber: '8KE75 D9VPP' }] },
    });
    expect(patched.status).toBe(200);
    const after = await get(id, token);
    expect(after.lifecycle).toBe(before.lifecycle);
    expect(after.lines[0].chipNumber).toBe('VPP');
  });

  it('judges a PATCH chip by the brand the line ends up with', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createPo(token, [{ ...LINE, brand: 'Other', chipNumber: '8KE75 D9VPP' }]);
    const lineId = (await get(id, token)).lines[0].id;
    expect((await get(id, token)).lines[0].chipNumber).toBe('8KE75 D9VPP');

    await api('PATCH', `/api/orders/${id}`, {
      token, body: { lines: [{ id: lineId, brand: 'Micron', chipNumber: '8KE75 D9VPP' }] },
    });
    expect((await get(id, token)).lines[0].chipNumber).toBe('VPP');

    // Brand absent from the patch: the stored brand decides.
    await api('PATCH', `/api/orders/${id}`, {
      token, body: { lines: [{ id: lineId, chipNumber: '2EF75 D8CJV' }] },
    });
    expect((await get(id, token)).lines[0].chipNumber).toBe('CJV');
  });
});

describe('0167: Micron Chip # backfill', () => {
  beforeEach(async () => { await resetDb(); });

  // Raw values set by SQL, behind the API's back, the way pre-0167 rows sit in
  // prod. Already trimmed and upper-cased (0096 did that), so the TS rule and
  // the migration see the same input.
  const ROWS: Array<[string, string]> = [
    ...MICRON.filter(([raw]) => raw === raw.trim().toUpperCase()).map(([raw]) => ['Micron', raw] as [string, string]),
    [' MICRON ', '2EF75 D8CJV'],
    ['micron', 'D9TBH'],
    ['Samsung', 'D9VPP'],
    ['Kingston', '2AB45D9XPF'],
    ['SK Hynix', 'H5AN8G8NCJ'],
  ];

  async function seedRaw(): Promise<string> {
    const { token } = await loginAs(MARCUS);
    const id = await createPo(token, ROWS.map((_, i) => ({ ...LINE, partNumber: `CHIP-PARITY-${i}` })));
    const sql = getTestDb();
    for (const [i, [brand, chip]] of ROWS.entries()) {
      await sql`UPDATE order_lines SET brand = ${brand}, chip_number = ${chip}
                WHERE order_id = ${id} AND part_number = ${`CHIP-PARITY-${i}`}`;
    }
    return id;
  }

  const stored = async (id: string) => (await getTestDb()<{ part_number: string; brand: string; chip_number: string }[]>`
    SELECT part_number, brand, chip_number FROM order_lines WHERE order_id = ${id} ORDER BY part_number
  `);

  it('lands on what chipMarkingCanon would store, row for row', async () => {
    const id = await seedRaw();
    await getTestDb().unsafe(migration);
    const rows = await stored(id);
    expect(rows).toHaveLength(ROWS.length);
    for (const r of rows) {
      const [brand, raw] = ROWS[Number(r.part_number.replace('CHIP-PARITY-', ''))];
      expect({ brand, raw, chip: r.chip_number }).toEqual({ brand, raw, chip: chipMarkingCanon(raw, brand) });
    }
  });

  it('is a no-op the second time', async () => {
    const id = await seedRaw();
    const sql = getTestDb();
    await sql.unsafe(migration);
    const once = await stored(id);
    await sql.unsafe(migration);
    expect(await stored(id)).toEqual(once);
  });
});
