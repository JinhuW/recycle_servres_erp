import { describe, it, expect } from 'vitest';
import { resetDb } from '../../../../apps/backend/tests/helpers/db';

// A beforeEach that times out leaves its resetDb running; the next test's
// beforeEach then calls resetDb again while the first is mid DROP/CREATE.
// Two overlapping calls stand in for that overlap.
describe('resetDb serialisation', () => {
  it('two overlapping resets both succeed', async () => {
    await resetDb();
    const rs = await Promise.allSettled([resetDb(), resetDb(), resetDb()]);
    const errs = rs.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason));
    console.log('overlapping reset errors:', JSON.stringify(errs));
    expect(errs).toEqual([]);
  });
});
