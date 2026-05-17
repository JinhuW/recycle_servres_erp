import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';

// Regression for the seed/schema drift introduced by migration 0027: the old
// RAM `type` column (DDR generation) was renamed to `generation` and `type`
// repurposed as the device class. seed.mjs must populate the new layout.
describe('seeded RAM rows match the 0027 schema', () => {
  beforeEach(async () => { await resetDb(); });

  it('puts the DDR generation in `generation` and a device class in `type`', async () => {
    const db = getTestDb();
    const rows = await db<{ generation: string | null; type: string | null }[]>`
      SELECT generation, type FROM order_lines WHERE category = 'RAM' LIMIT 100
    `;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.generation).toMatch(/^DDR[345]$/);
      expect(['Desktop', 'Server', 'Laptop']).toContain(r.type);
    }
  });
});
