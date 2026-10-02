import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { DAY } from './helpers/bankProvider';
import { syncBankTransactions } from '../src/banktx/sync';
import type { BankFetch, BankProvider, BankSource } from '../src/banktx/types';

// A provider that records the window it was asked for and answers with one
// account and nothing else.
function recording(source: BankSource, extra: Partial<BankFetch> = {}, gate?: Promise<void>) {
  const asked: number[] = [];
  const provider: BankProvider = {
    source,
    async fetchSince(sinceIso) {
      asked.push(Date.parse(sinceIso));
      await gate;
      return { accounts: [{ externalId: `${source}-acct`, name: source }], txns: [], ...extra };
    },
  };
  return { provider, asked };
}

const daysAgo = (ms: number) => Math.round((Date.now() - ms) / DAY);

describe('bank sync window, health and single-flight', () => {
  beforeEach(async () => { await resetDb(); });

  it('reaches 60 days back once a week, otherwise only the cursor overlap', async () => {
    const sql = getTestDb();
    const first = recording('mercury');
    await syncBankTransactions(testEnv, [first.provider]);
    const [acct] = await sql<{ deep_synced_at: Date | null }[]>`
      SELECT deep_synced_at FROM bank_accounts WHERE external_id = 'mercury-acct'`;
    expect(acct.deep_synced_at).not.toBeNull(); // the 90-day backfill counts as deep

    const shallow = recording('mercury');
    await syncBankTransactions(testEnv, [shallow.provider]);
    expect(daysAgo(shallow.asked[0])).toBe(5);

    await sql`UPDATE bank_accounts SET deep_synced_at = NOW() - INTERVAL '8 days'
              WHERE external_id = 'mercury-acct'`;
    const deep = recording('mercury');
    await syncBankTransactions(testEnv, [deep.provider]);
    expect(daysAgo(deep.asked[0])).toBe(60);
  });

  it('stops a pending row older than 120 days from holding the window open', async () => {
    const sql = getTestDb();
    await syncBankTransactions(testEnv, [recording('mercury').provider]);
    const [acct] = await sql<{ id: string }[]>`SELECT id FROM bank_accounts WHERE external_id = 'mercury-acct'`;
    for (const [ext, days] of [['old-pending', 130], ['recent-pending', 20]] as const) {
      await sql`
        INSERT INTO bank_transactions (source, external_id, account_id, posted_at, amount, raw, settle_status)
        VALUES ('mercury', ${ext}, ${acct.id}, NOW() - make_interval(days => ${days}), -10, '{}'::jsonb, 'pending')`;
    }
    const run = recording('mercury');
    await syncBankTransactions(testEnv, [run.provider]);
    expect(daysAgo(run.asked[0])).toBe(20);
  });

  it('records a partial failure where /stats shows it, and clears it on a clean run', async () => {
    const { token } = await loginAs(ALEX);
    const failing = recording('mercury', { partialErrors: [{ account: null, message: 'credit list 403' }] });
    await syncBankTransactions(testEnv, [failing.provider]);
    type Stats = { sources: { source: string; syncError: string | null }[] };
    const bad = await api<Stats>('GET', '/api/bank-transactions/stats', { token });
    expect(bad.body.sources.find((s) => s.source === 'mercury')?.syncError).toBe('credit list 403');

    await syncBankTransactions(testEnv, [recording('mercury').provider]);
    const good = await api<Stats>('GET', '/api/bank-transactions/stats', { token });
    expect(good.body.sources.find((s) => s.source === 'mercury')?.syncError).toBeNull();
  });

  it('never lets a full sync settle for a PayPal-only run already in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const paypalOnly = recording('paypal', {}, gate);
    const full = { paypal: recording('paypal'), mercury: recording('mercury') };

    const partial = syncBankTransactions(testEnv, [paypalOnly.provider], { disputes: false });
    const whole = syncBankTransactions(testEnv, [full.paypal.provider, full.mercury.provider]);
    release();
    await Promise.all([partial, whole]);
    expect(full.mercury.asked).toHaveLength(1);
  });
});
