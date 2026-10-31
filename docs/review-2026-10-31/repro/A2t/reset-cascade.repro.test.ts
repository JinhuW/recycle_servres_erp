// A2t-01: a resetDb() that outlives its hook timeout keeps running, and the
// next test's resetDb() races it on DROP/CREATE DATABASE — so one slow reset
// fails the following, unrelated test with "database … already exists" /
// pg_database_datname_index instead of a timeout. Baseline 2026-10-31 shows
// exactly this in warehouses.test.ts and fleet-proxies.test.ts.
// Here the first hook's budget is made tiny instead of the machine slow.
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from '../../../../apps/backend/tests/helpers/db';

describe('resetDb after a timed-out reset', () => {
  let n = 0;
  beforeEach(async () => {
    n += 1;
    if (n === 1) {
      // First test: let the hook "time out" while the reset is still in flight.
      void resetDb().catch(() => {});
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('simulated hook timeout (reset still running)');
    }
    await resetDb();
  });

  it('first test (its hook timed out)', () => { expect(true).toBe(true); });

  it('second test only needs a clean DB', async () => {
    const r = await getTestDb()`SELECT count(*)::int AS n FROM users`;
    expect(r[0].n).toBeGreaterThan(0);
  });
});
