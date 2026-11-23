import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import { registerPackageTracking } from '../src/shipping/track';

// The add-time callers fire registration detached, so a database error inside
// it has to come back as `false`, never as a rejection: an unhandled one exits
// the process.

// A stand-in for the postgres.js tag: each awaited top-level query takes the
// next scripted outcome. Interpolated fragments (the claim's interval) are
// built but never awaited, so they consume nothing.
function scriptedSql(outcomes: Array<'ok' | 'claimed' | 'fail'>): Sql {
  const query = () => {
    let settled: Promise<unknown> | null = null;
    const run = () => {
      if (settled) return settled;
      const next = outcomes.shift();
      settled = next === 'fail'
        ? Promise.reject(new Error('connection terminated'))
        : Promise.resolve(next === 'claimed' ? [{ id: 'PKG-1' }] : []);
      return settled;
    };
    return {
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run().then(res, rej),
      catch: (rej: (e: unknown) => unknown) => run().catch(rej),
    };
  };
  return query as unknown as Sql;
}

const pkg = { id: 'PKG-1', tracking_number: '1Z999', carrier: 'ups' };
const ok = { registerTracking: async () => {} };
const refused = { registerTracking: async () => { throw new Error('shippo POST /tracks/ failed: HTTP 400'); } };

describe('registerPackageTracking never rejects', () => {
  it('returns false when the claim query fails', async () => {
    await expect(registerPackageTracking(scriptedSql(['fail']), ok, pkg)).resolves.toBe(false);
  });

  it('returns false when a refusal cannot free its claim', async () => {
    await expect(registerPackageTracking(scriptedSql(['claimed', 'fail']), refused, pkg)).resolves.toBe(false);
  });

  it('reports a registration whose stamp failed to save as subscribed', async () => {
    await expect(registerPackageTracking(scriptedSql(['claimed', 'fail']), ok, pkg)).resolves.toBe(true);
  });
});
