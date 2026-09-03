import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb } from './helpers/db';
import { testEnv } from './helpers/app';
import { reportSyncResult, syncBankTransactions } from '../src/banktx/sync';
import type { BankProvider } from '../src/banktx/types';

// doSync deliberately swallows one provider's failure so the other still runs,
// which means the loop's own catch never fires for the failure that matters.
// Before this, the six-hourly pass was silent in both directions: nothing in
// production distinguished twenty-four clean runs from twenty-four broken ones,
// and the only way to find out was to open Payments and press Sync now.

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { out.push(line); });
  vi.spyOn(console, 'error').mockImplementation((line: string) => { err.push(line); });
});

afterEach(() => { vi.restoreAllMocks(); });

const lines = (raw: string[]) => raw.map((l) => JSON.parse(l));

describe('bank sync reporting', () => {
  it('warns per source when a provider fails, naming the source and the error', () => {
    reportSyncResult({
      perSource: {
        mercury: { inserted: 0, updated: 0, paired: 0, autoLinked: 0, error: 'HTTP 503' },
        paypal: { inserted: 3, updated: 1, paired: 1, autoLinked: 2 },
      },
      notConfigured: [],
    });

    const warned = lines(err);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({
      level: 'warn',
      module: 'banktx',
      message: 'sync failed for a source',
      source: 'mercury',
      error: 'HTTP 503',
    });

    // The healthy source still reports, so a pass is legible either way.
    const info = lines(out);
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({
      level: 'info', module: 'banktx', message: 'sync pass',
      source: 'paypal', inserted: 3, updated: 1, paired: 1, autoLinked: 2,
    });
  });

  it('reports a provider that threw, through the real sync path', async () => {
    await resetDb();
    const exploding: BankProvider = {
      source: 'mercury',
      async fetchSince() { throw new Error('mercury is down'); },
    };

    const result = await syncBankTransactions(testEnv, [exploding]);
    expect(result.perSource.mercury?.error).toContain('mercury is down');

    reportSyncResult(result);
    const warned = lines(err);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ level: 'warn', source: 'mercury' });
    expect(warned[0].error).toContain('mercury is down');
  });
});
