import { describe, it, expect, afterAll } from 'vitest';
import postgres from 'postgres';
import { canonicalPartNumber } from '@recycle-erp/shared';
import { canonPartArg, canonPartNumberJs } from '../src/lib/part-number';

// Uses the test Postgres directly (same DATABASE_URL the app uses in tests).
const sql = postgres(process.env.DATABASE_URL as string, { prepare: false, max: 2 });

async function canon(raw: string): Promise<string> {
  const rows = await sql<{ c: string }[]>`SELECT ${canonPartArg(sql, raw)} AS c`;
  return rows[0].c;
}

// Spelled as escapes: a literal non-breaking space in a source file is
// invisible, and the next editor to touch this would "clean" it into a plain
// one — which is exactly the case under test.
const NBSP = '\u00A0';
const EN_SPACE = '\u2002';

const VARIANTS = [
  'ABC-123', ' abc-123 ', 'PN: ABC-123', 'p/n abc-123', 'PART NO: ABC-123', 'S/N ABC-123',
];

describe('canonPartArg — canonical part-number parity', () => {
  it('collapses case / whitespace / P-N / S-N / PART prefixes to one key', async () => {
    const canons = await Promise.all(VARIANTS.map(canon));
    for (const c of canons) expect(c).toBe('ABC-123');
    expect(new Set(canons).size).toBe(1);
  });

  it('empty / whitespace-only canonicalises to empty string', async () => {
    expect(await canon('')).toBe('');
    expect(await canon('   ')).toBe('');
  });

  // The clients canonicalise with @recycle-erp/shared before they ask, and this
  // is what answers. Byte-for-byte or the lookup joins miss.
  it('agrees with the shared canonicaliser both apps ask with', async () => {
    for (const v of [...VARIANTS, 'PART NUMBER # hma 84gr7', '720-ct', '']) {
      expect(await canon(v), v).toBe(canonicalPartNumber(v));
    }
  });

  // The one that bit us: a part number pasted from a vendor PDF carries a
  // non-breaking space. POSIX [[:space:]] leaves it standing, so the shared
  // rule spells whitespace out as ASCII instead of using JS `\s`, which would
  // have dropped it and asked under a key this never produces.
  it('keeps a non-breaking space, and so does the shared rule', async () => {
    const raw = `p/n: abc${NBSP}123`;
    expect(await canon(raw)).toBe(`ABC${NBSP}123`);
    expect(canonicalPartNumber(raw)).toBe(await canon(raw));
  });

  afterAll(async () => { await sql.end({ timeout: 5 }); });
});

describe('canonPartNumberJs', () => {
  it('strips a P/N prefix, drops whitespace, upper-cases', () => {
    expect(canonPartNumberJs('P/N: hma 84gr7 afr4n-uh')).toBe('HMA84GR7AFR4N-UH');
  });
  it('strips an S/N prefix', () => {
    expect(canonPartNumberJs('S/N abc-123')).toBe('ABC-123');
  });
  it('treats spacing/case variants of the same PN as equal', () => {
    expect(canonPartNumberJs('  m393a2k43bb1-ctd ')).toBe(canonPartNumberJs('M393A2K43BB1-CTD'));
  });
  it('leaves a bare part number untouched except case', () => {
    expect(canonPartNumberJs('720-ct')).toBe('720-CT');
  });

  // Whether SQL agrees on these is not asserted: Postgres' [[:space:]] follows
  // the database's ctype, which counts the U+2000 block as space under a UTF-8
  // locale and not under C. What has to hold either way is that the key this
  // produces is the key the frontend asks under — one function, both apps.
  it('is the same rule the clients ask with, non-ASCII spaces included', () => {
    for (const raw of [`abc${NBSP}123`, `abc${EN_SPACE}123`, 'P/N: abc 123']) {
      expect(canonPartNumberJs(raw)).toBe(canonicalPartNumber(raw));
    }
    expect(canonPartNumberJs(`abc${EN_SPACE}123`)).toBe(`ABC${EN_SPACE}123`);
  });
});
