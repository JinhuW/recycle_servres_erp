import { afterEach, describe, it, expect, vi } from 'vitest';
import { mercuryProvider } from '../src/banktx/mercury';
import type { Env } from '../src/types';

// The IO credit card is not in /accounts; /credit lists it, and until the
// sync asked there, no card charge — pending or posted — ever reached the
// Payments page. Its payoff from checking is then an internal move, or the
// same spend counts twice.

const env = { MERCURY_API_TOKEN: 'tok', MERCURY_API_URL: 'https://mercury.test' } as unknown as Env;

const CHECKING = 'acct-checking';
const CREDIT = 'acct-credit';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

function stub(opts: {
  credit?: () => Response;
  txns: Record<string, unknown[]>;
  fail?: Record<string, number>;
}) {
  const txnCalls: string[] = [];
  const starts: Record<string, string | null> = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = new URL(url);
    const path = u.pathname;
    if (path === '/api/v1/accounts') {
      return json({ accounts: [{ id: CHECKING, name: 'Mercury Checking ••7562' }] });
    }
    if (path === '/api/v1/credit') {
      return opts.credit ? opts.credit() : json({ accounts: [{ id: CREDIT, status: 'active' }] });
    }
    const m = path.match(/^\/api\/v1\/account\/([^/]+)\/transactions$/);
    if (m) {
      txnCalls.push(m[1]);
      starts[m[1]] = u.searchParams.get('start');
      const failWith = opts.fail?.[m[1]];
      if (failWith) return json({ error: 'nope' }, failWith);
      return json({ transactions: opts.txns[m[1]] ?? [] });
    }
    return json({ error: 'unexpected' }, 404);
  }));
  return { txnCalls, starts };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('mercury provider: credit accounts', () => {
  it('fetches card charges, pending ones dated by creation', async () => {
    stub({
      txns: {
        [CREDIT]: [
          {
            id: 'cc-pending', amount: -6814.57, kind: 'creditCardTransaction', status: 'pending',
            createdAt: '2026-09-24T18:10:51Z', postedAt: null,
            counterpartyId: 'merchant-1', counterpartyName: 'Data Destruction', bankDescription: 'DATA DESTRUCTION',
          },
          {
            id: 'cc-posted', amount: -70.83, kind: 'creditCardTransaction', status: 'sent',
            createdAt: '2026-09-19T22:18:21Z', postedAt: '2026-09-20T00:24:09Z',
            counterpartyId: 'merchant-2', counterpartyName: 'Costco',
          },
        ],
      },
    });

    const { accounts, txns } = await mercuryProvider(env).fetchSince('2026-09-01T00:00:00Z');

    expect(accounts).toContainEqual({ externalId: CREDIT, name: 'Mercury Credit' });
    const pending = txns.find((t) => t.externalId === 'cc-pending');
    expect(pending).toMatchObject({
      accountExternalId: CREDIT, amount: -6814.57, settleStatus: 'pending', category: 'external',
      counterparty: 'Data Destruction',
    });
    expect(pending?.postedAt.toISOString()).toBe('2026-09-24T18:10:51.000Z');
    expect(txns.find((t) => t.externalId === 'cc-posted')?.settleStatus).toBe('settled');
  });

  it('classifies the card payoff as a transfer on both sides', async () => {
    stub({
      txns: {
        [CHECKING]: [{
          id: 'payoff-out', amount: -1577.42, kind: 'other', status: 'sent',
          createdAt: '2026-09-20T00:21:02Z', postedAt: '2026-09-20T00:21:05Z',
          counterpartyId: CREDIT, counterpartyName: 'Mercury Credit', bankDescription: 'IO AUTOPAY',
        }],
        [CREDIT]: [{
          id: 'payoff-in', amount: 1577.42, kind: 'other', status: 'sent',
          createdAt: '2026-09-20T00:21:02Z', postedAt: '2026-09-20T00:21:05Z',
          counterpartyId: CHECKING, counterpartyName: 'Mercury Checking ••7562', bankDescription: 'IO AUTOPAY',
        }],
      },
    });

    const { txns } = await mercuryProvider(env).fetchSince('2026-09-01T00:00:00Z');

    expect(txns.find((t) => t.externalId === 'payoff-out')?.category).toBe('transfer');
    expect(txns.find((t) => t.externalId === 'payoff-in')?.category).toBe('transfer');
  });

  it('skips a card it has never seen that is not active', async () => {
    const { txnCalls } = stub({
      credit: () => json({ accounts: [{ id: CREDIT, status: 'archived' }] }),
      txns: {},
    });

    const { accounts } = await mercuryProvider(env).fetchSince('2026-09-01T00:00:00Z');

    expect(accounts.map((a) => a.externalId)).toEqual([CHECKING]);
    expect(txnCalls).toEqual([CHECKING]);
  });

  it('keeps fetching a known card after it stops being active', async () => {
    const { txnCalls } = stub({
      credit: () => json({ accounts: [{ id: CREDIT, status: 'frozen' }] }),
      txns: {},
    });

    const { accounts } = await mercuryProvider(env).fetchSince('2026-09-01T00:00:00Z', {
      since: new Map([[CHECKING, '2026-09-01T00:00:00Z'], [CREDIT, '2026-09-01T00:00:00Z']]),
      newSince: '2026-09-01T00:00:00Z',
    });

    expect(accounts.map((a) => a.externalId)).toEqual([CHECKING, CREDIT]);
    expect(txnCalls).toEqual([CHECKING, CREDIT]);
  });

  it('keeps a payoff a transfer when /credit fails, from the accounts already known', async () => {
    stub({
      credit: () => json({ error: 'unavailable' }, 503),
      txns: {
        [CHECKING]: [{
          id: 'payoff-out', amount: -1577.42, kind: 'other', status: 'sent',
          createdAt: '2026-09-20T00:21:02Z', postedAt: '2026-09-20T00:21:05Z',
          counterpartyId: CREDIT, counterpartyName: 'Mercury Credit', bankDescription: 'IO AUTOPAY',
        }],
      },
    });

    const { accounts, txns } = await mercuryProvider(env).fetchSince('2026-09-01T00:00:00Z', {
      since: new Map([[CHECKING, '2026-09-15T00:00:00Z'], [CREDIT, '2026-09-15T00:00:00Z']]),
      newSince: '2026-01-01T00:00:00Z',
    });

    expect(accounts.map((a) => a.externalId)).toEqual([CHECKING]);
    expect(txns.find((t) => t.externalId === 'payoff-out')?.category).toBe('transfer');
  });

  it('fetches each account from its own start, a new one from newSince', async () => {
    const { starts } = stub({ txns: {} });

    await mercuryProvider(env).fetchSince('2026-09-01T00:00:00Z', {
      since: new Map([[CHECKING, '2026-09-19T06:00:00Z']]),
      newSince: '2025-12-27T00:00:00Z',
    });

    expect(starts).toEqual({ [CHECKING]: '2026-09-19', [CREDIT]: '2025-12-27' });
  });

  it('drops a card whose transactions fail, keeping the bank feed', async () => {
    stub({
      fail: { [CREDIT]: 500 },
      txns: {
        [CHECKING]: [{
          id: 'wire-1', amount: -560, kind: 'outgoingPayment', status: 'sent',
          createdAt: '2026-09-18T13:02:24Z', postedAt: '2026-09-18T13:02:25Z', counterpartyName: 'Seller LLC',
        }],
      },
    });

    const { accounts, txns } = await mercuryProvider(env).fetchSince('2026-09-01T00:00:00Z');

    expect(accounts.map((a) => a.externalId)).toEqual([CHECKING]);
    expect(txns.map((t) => t.externalId)).toEqual(['wire-1']);
  });

  it('still fails the sync when a bank account fetch fails', async () => {
    stub({ fail: { [CHECKING]: 500 }, txns: {} });

    await expect(mercuryProvider(env).fetchSince('2026-09-01T00:00:00Z')).rejects.toThrow(/HTTP 500/);
  });

  it('keeps the bank feed when /credit fails', async () => {
    stub({
      credit: () => json({ errors: { errorCode: 'forbidden' } }, 403),
      txns: {
        [CHECKING]: [{
          id: 'wire-1', amount: -560, kind: 'outgoingPayment', status: 'sent',
          createdAt: '2026-09-18T13:02:24Z', postedAt: '2026-09-18T13:02:25Z', counterpartyName: 'Seller LLC',
        }],
      },
    });

    const { accounts, txns } = await mercuryProvider(env).fetchSince('2026-09-01T00:00:00Z');

    expect(accounts.map((a) => a.externalId)).toEqual([CHECKING]);
    expect(txns.map((t) => t.externalId)).toEqual(['wire-1']);
  });
});
