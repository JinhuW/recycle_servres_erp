import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, getTestDb } from './helpers/db';

const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../migrations/0159_ssd_cap_2tb_ram_class_camm.sql'),
  'utf8',
);

// The seed rewrites catalog_options after migrating, so the template already
// holds 2TB and CAMM. Put the two groups back the way prod had them before 0159.
const PROD_SSD_CAP = [
  '120GB', '128GB', '240GB', '256GB', '400GB', '480GB', '512GB', '800GB', '960GB',
  '1000GB', '1TB', '1.6TB', '1.92TB', '3.2TB', '3.84TB', '6.4TB', '7.68TB', '8TB',
  '12.8TB', '15.36TB', '30.72TB',
];

async function shapeLikeProd() {
  const sql = getTestDb();
  await sql`DELETE FROM catalog_options WHERE ("group", value) IN (('SSD_CAP', '2TB'), ('RAM_CLASS', 'CAMM'))`;
  for (const [i, v] of PROD_SSD_CAP.entries()) {
    await sql`UPDATE catalog_options SET position = ${i} WHERE "group" = 'SSD_CAP' AND value = ${v}`;
  }
}

const groupOrder = async (group: string) =>
  (await getTestDb()<{ value: string }[]>`
    SELECT value FROM catalog_options
    WHERE "group" = ${group} AND active
    ORDER BY position, value
  `).map((r) => r.value);

describe('0159: SSD 2TB and RAM class CAMM', () => {
  beforeEach(async () => {
    await resetDb();
    await shapeLikeProd();
  });

  it('slots 2TB between 1.92TB and 3.2TB and appends CAMM', async () => {
    await getTestDb().unsafe(migration);
    const caps = await groupOrder('SSD_CAP');
    expect(caps).toEqual([...PROD_SSD_CAP.slice(0, 13), '2TB', ...PROD_SSD_CAP.slice(13)]);
    expect(await groupOrder('RAM_CLASS')).toEqual(['UDIMM', 'RDIMM', 'LRDIMM', 'SODIMM', 'CAMM']);
  });

  it('is a no-op the second time', async () => {
    const sql = getTestDb();
    await sql.unsafe(migration);
    const snapshot = await sql`SELECT "group", value, position, active FROM catalog_options ORDER BY "group", value`;
    await sql.unsafe(migration);
    expect(await sql`SELECT "group", value, position, active FROM catalog_options ORDER BY "group", value`)
      .toEqual(snapshot);
  });
});
