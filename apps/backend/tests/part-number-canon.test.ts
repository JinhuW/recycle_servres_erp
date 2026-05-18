import { describe, it, expect, afterAll } from 'vitest';
import postgres from 'postgres';
import { canonPartArg } from '../src/lib/part-number';

// Uses the test Postgres directly (same DATABASE_URL the app uses in tests).
const sql = postgres(process.env.DATABASE_URL as string, { prepare: false, max: 2 });

async function canon(raw: string): Promise<string> {
  const rows = await sql<{ c: string }[]>`SELECT ${canonPartArg(sql, raw)} AS c`;
  return rows[0].c;
}

describe('canonPartArg — canonical part-number parity', () => {
  it('collapses case / whitespace / P-N / S-N / PART prefixes to one key', async () => {
    const variants = ['ABC-123', ' abc-123 ', 'PN: ABC-123', 'p/n abc-123', 'PART NO: ABC-123', 'S/N ABC-123'];
    const canons = await Promise.all(variants.map(canon));
    for (const c of canons) expect(c).toBe('ABC-123');
    expect(new Set(canons).size).toBe(1);
    expect(canons[0]).toBe('ABC-123');
  });

  it('empty / whitespace-only canonicalises to empty string', async () => {
    expect(await canon('')).toBe('');
    expect(await canon('   ')).toBe('');
  });

  afterAll(async () => { await sql.end({ timeout: 5 }); });
});
