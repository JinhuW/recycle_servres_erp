import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { autoTrackParts } from '../src/lib/marketAutoTrack';

// autoTrackParts is called inside a caller's tx in production. Calling it with
// the plain pool here (autocommit per statement) is fine for asserting the row
// it writes.
describe('autoTrackParts — optional label/subLabel', () => {
  beforeEach(async () => { await resetDb(); });

  it('uses the supplied label and sub_label on the inserted row', async () => {
    const sql = getTestDb();
    const pn = 'LABELTEST-001';
    const out = await autoTrackParts(sql, [{
      category: 'RAM', partNumber: pn, label: 'Samsung 32GB DDR4', subLabel: 'RDIMM 3200',
    }]);
    expect(out.inserted).toBe(1);

    const row = (await sql<{ label: string; sub_label: string | null }[]>`
      SELECT label, sub_label FROM ref_prices WHERE part_number = ${pn} LIMIT 1
    `)[0];
    expect(row.label).toBe('Samsung 32GB DDR4');
    expect(row.sub_label).toBe('RDIMM 3200');
  });

  it('falls back to the part number when no label is given', async () => {
    const sql = getTestDb();
    const pn = 'LABELTEST-002';
    await autoTrackParts(sql, [{ category: 'RAM', partNumber: pn }]);
    const row = (await sql<{ label: string; sub_label: string | null }[]>`
      SELECT label, sub_label FROM ref_prices WHERE part_number = ${pn} LIMIT 1
    `)[0];
    expect(row.label).toBe(pn);
    expect(row.sub_label).toBeNull();
  });
});
