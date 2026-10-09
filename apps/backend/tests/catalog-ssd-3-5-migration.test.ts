import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, getTestDb } from './helpers/db';

const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../migrations/0171_ssd_form_3_5.sql'),
  'utf8',
);

// The seed rewrites catalog_options after migrating, so the template already
// holds 3.5". Put SSD_FORM back the way each database had it before 0171: prod
// with its hand-added M.2 2230, a fresh one without.
const PROD_SSD_FORM = ['2.5"', 'M.2 2230', 'M.2 2280', 'M.2 22110', 'U.2', 'AIC'];
const AFTER = ['2.5"', '3.5"', 'M.2 2230', 'M.2 2280', 'M.2 22110', 'U.2', 'AIC'];

async function shapeSsdForm(values: string[]) {
  const sql = getTestDb();
  await sql`DELETE FROM catalog_options WHERE "group" = 'SSD_FORM'`;
  for (const [i, v] of values.entries()) {
    await sql`INSERT INTO catalog_options ("group", value, position) VALUES ('SSD_FORM', ${v}, ${i})`;
  }
}

const ssdForms = async () =>
  (await getTestDb()<{ value: string }[]>`
    SELECT value FROM catalog_options
    WHERE "group" = 'SSD_FORM' AND active
    ORDER BY position, value
  `).map((r) => r.value);

describe('0171: SSD form 3.5"', () => {
  beforeEach(async () => { await resetDb(); });

  it('slots 3.5" after 2.5" on prod', async () => {
    await shapeSsdForm(PROD_SSD_FORM);
    await getTestDb().unsafe(migration);
    expect(await ssdForms()).toEqual(AFTER);
  });

  it('adds M.2 2230 where no migration ever did', async () => {
    await shapeSsdForm(PROD_SSD_FORM.filter((v) => v !== 'M.2 2230'));
    await getTestDb().unsafe(migration);
    expect(await ssdForms()).toEqual(AFTER);
  });

  it('is a no-op the second time', async () => {
    const sql = getTestDb();
    await shapeSsdForm(PROD_SSD_FORM);
    await sql.unsafe(migration);
    const snapshot = await sql`SELECT "group", value, position, active FROM catalog_options ORDER BY "group", value`;
    await sql.unsafe(migration);
    expect(await sql`SELECT "group", value, position, active FROM catalog_options ORDER BY "group", value`)
      .toEqual(snapshot);
  });
});
