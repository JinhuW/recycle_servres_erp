import { describe, it, expect, afterAll } from 'vitest';
import postgres from 'postgres';
import { canonicalPartNumber } from '@recycle-erp/shared';
import { canonPartArg, canonPartNumberJs } from '../src/lib/part-number';
import { TEST_DATABASE_URL } from './helpers/db';

// Talks to this worker's database directly — it needs the SQL canon function,
// not the HTTP surface. Must be TEST_DATABASE_URL, not process.env.DATABASE_URL:
// the latter only happens to work when the repo-root .env points it at the test
// database, and is absent in CI (and may point at an unrelated project's
// database on a developer's machine).
const sql = postgres(TEST_DATABASE_URL, { prepare: false, max: 2 });

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
  'ABC_123', 'abc 123', 'ABC123',
];

describe('canonPartArg — canonical part-number parity', () => {
  it('collapses case / separators / P-N / S-N / PART prefixes to one key', async () => {
    const canons = await Promise.all(VARIANTS.map(canon));
    for (const c of canons) expect(c).toBe('ABC123');
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
  it('strips a P/N prefix, drops separators, upper-cases', () => {
    expect(canonPartNumberJs('P/N: hma 84gr7 afr4n-uh')).toBe('HMA84GR7AFR4NUH');
  });
  it('strips an S/N prefix', () => {
    expect(canonPartNumberJs('S/N abc-123')).toBe('ABC123');
  });

  // The reason the rule folds them: one part reaches us spelled three ways —
  // a vendor sheet writes i5-10500t, a scan writes i5 10500t, the synthesiser
  // writes MIXED_256GB_SATA. Each spelling used to open its own ref_prices row.
  it('folds hyphen / underscore / space into one key', () => {
    const keys = ['i5-10500t', 'i5 10500t', 'i5_10500t', 'I5 10500T'].map(canonPartNumberJs);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('I510500T');
    expect(canonPartNumberJs('Mixed 256gb sata')).toBe(canonPartNumberJs('MIXED_256GB_SATA'));
  });

  // A dot is not a separator: M.2, 2.5" and 1.92TB say something.
  it('keeps a dot', () => {
    expect(canonPartNumberJs('MIXED_512GB_SATA_M.2-2280')).toBe('MIXED512GBSATAM.22280');
  });
  it('treats spacing/case variants of the same PN as equal', () => {
    expect(canonPartNumberJs('  m393a2k43bb1-ctd ')).toBe(canonPartNumberJs('M393A2K43BB1-CTD'));
  });
  it('leaves a bare part number untouched except case and separators', () => {
    expect(canonPartNumberJs('720-ct')).toBe('720CT');
  });

  // The label needs its separator. Without one it also ate the opening letters
  // of part numbers that simply start that way — and this trade stocks them.
  it('keeps a part number that merely begins with a label', () => {
    expect(canonPartNumberJs('SNK-P0048AP4')).toBe('SNKP0048AP4');   // Supermicro heatsink
    expect(canonPartNumberJs('SNP112P/8G')).toBe('SNP112P/8G');       // Dell memory
    expect(canonPartNumberJs('PARTS-100')).toBe('PARTS100');
  });

  it('keeps two such part numbers apart', () => {
    expect(canonPartNumberJs('SNK-P0048AP4')).not.toBe(canonPartNumberJs('PNK-P0048AP4'));
    expect(canonPartNumberJs('PARTS-100')).not.toBe(canonPartNumberJs('S-100'));
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
