import { afterEach, describe, it, expect, vi } from 'vitest';
import { paypalProvider } from '../src/banktx/paypal';
import type { Env } from '../src/types';

// Transaction Search defaults to balance-affecting records only, and a payment
// funded by eCheck affects nothing until it clears. Such a payment sat pending
// in PayPal for days while every sync reported nothing new, leaving the
// manager only its Mercury transfer leg, which cannot be linked. Asked for
// every record, PayPal answers with one per state a transaction went through,
// matched by when the record changed rather than when the transaction began.

const env = {
  PAYPAL_CLIENT_ID: 'id',
  PAYPAL_CLIENT_SECRET: 'secret',
  PAYPAL_ENV: 'sandbox',
} as unknown as Env;

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

const rec = (id: string, code: string, status: string, value: string, begun = ago(0.5), changed = begun) => ({
  transaction_info: {
    transaction_id: id,
    transaction_event_code: code,
    transaction_status: status,
    transaction_initiation_date: begun,
    transaction_updated_date: changed,
    transaction_amount: { currency_code: 'USD', value },
  },
});

type Mode = 'Y' | 'N';

/** Stubs the token mint plus Transaction Search; `page` answers per mode and window start. */
function stub(page: (mode: Mode, start: string) => unknown[]) {
  const modes: Mode[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/v1/oauth2/token')) return json({ access_token: 'tok', expires_in: 32400 });
    const q = new URL(url).searchParams;
    const mode = q.get('balance_affecting_records_only') as Mode;
    modes.push(mode);
    return json({ transaction_details: page(mode, q.get('start_date')!), total_pages: 1 });
  }));
  return modes;
}

afterEach(() => { vi.unstubAllGlobals(); });

async function fetchSince(since: string) {
  const { txns } = await paypalProvider(env).fetchSince(since);
  return { txns, by: new Map(txns.map((t) => [t.externalId, t])) };
}

describe('paypal transaction search', () => {
  it('adds pending money from outside the balance, and nothing settled', async () => {
    const card = rec('CARDPAY1', 'T1000', 'S', '-680.00');
    const modes = stub((mode) => mode === 'Y' ? [card] : [
      card,
      rec('ECHECKPAY1', 'T0011', 'P', '-11950.00'),
      rec('ECHECKFUND1', 'T0300', 'P', '11950.00'),
      rec('HOLDMEMO1', 'T9900', 'S', '-212.50'),
    ]);

    const { txns, by } = await fetchSince(ago(1));

    expect(new Set(modes)).toEqual(new Set(['Y', 'N']));
    expect(txns).toHaveLength(3);
    expect(by.get('CARDPAY1')?.settleStatus).toBe('settled');
    expect(by.get('ECHECKPAY1')).toMatchObject({ settleStatus: 'pending', category: 'external', amount: -11950 });
    expect(by.get('ECHECKFUND1')).toMatchObject({ settleStatus: 'pending', category: 'transfer' });
  });

  it('takes a transaction outside the balance at its latest record, whatever the order', async () => {
    stub((mode) => mode === 'Y' ? [] : [
      // A bounced eCheck: the denial is later, though PayPal listed it first.
      rec('BOUNCED1', 'T1000', 'D', '-500.00', ago(0.9), ago(0.1)),
      rec('BOUNCED1', 'T1000', 'P', '-500.00', ago(0.9), ago(0.9)),
      // An authorization held then voided, and a hold that ended settled.
      rec('AUTH1', 'T1300', 'P', '-212.50', ago(0.9), ago(0.9)),
      rec('AUTH1', 'T1302', 'V', '-212.50', ago(0.9), ago(0.2)),
      rec('HOLD2', 'T1501', 'P', '-27.16', ago(0.9), ago(0.9)),
      rec('HOLD2', 'T1501', 'S', '-27.16', ago(0.9), ago(0.2)),
    ]);

    const { txns, by } = await fetchSince(ago(1));

    expect(txns).toHaveLength(2);
    expect(by.get('BOUNCED1')?.settleStatus).toBe('failed');
    expect(by.get('AUTH1')?.settleStatus).toBe('reversed');
    expect(by.has('HOLD2')).toBe(false);
  });

  it('merges the records of one transaction across 31-day windows', async () => {
    const since = ago(40);
    stub((mode, start) => mode === 'Y' ? []
      : start === since ? [rec('ECHECK2', 'T0011', 'P', '-900.00', ago(35), ago(35))]
      : [rec('ECHECK2', 'T0011', 'D', '-900.00', ago(35), ago(2))]);

    const { txns } = await fetchSince(since);

    expect(txns).toHaveLength(1);
    expect(txns[0].settleStatus).toBe('failed');
  });

  it('ignores a late record of a transaction begun before the window', async () => {
    // A payment the balance pass returns only to a window reaching back to
    // when it began; a narrow one must not rewrite its status meanwhile.
    stub((mode) => mode === 'Y' ? [] : [
      rec('OLDPAY1', 'T0011', 'V', '-3100.00', ago(58), ago(0.5)),
    ]);

    const { txns } = await fetchSince(ago(5));

    expect(txns).toHaveLength(0);
  });

  it('returns a transaction both passes list once, as the balance pass had it', async () => {
    stub((mode) => mode === 'Y'
      ? [rec('PAID1', 'T0011', 'S', '-3485.00', ago(0.9), ago(0.2))]
      : [
        rec('PAID1', 'T0011', 'P', '-3485.00', ago(0.9), ago(0.9)),
        rec('PAID1', 'T0011', 'S', '-3485.00', ago(0.9), ago(0.2)),
      ]);

    const { txns } = await fetchSince(ago(1));

    expect(txns).toHaveLength(1);
    expect(txns[0].settleStatus).toBe('settled');
  });

  // The balance record of a bank-funded payment is stamped P when the money is
  // drawn; PayPal settles it in a record outside the balance.
  it('settles a pending balance record from its later history', async () => {
    const drawn = (id: string) => rec(id, 'T1000', 'P', '-500.00', ago(0.9), ago(0.6));
    stub((mode) => mode === 'Y'
      ? [drawn('CLEARED1'), drawn('REFUNDED1'), drawn('DENIED1'), drawn('INFLIGHT1')]
      : [
        rec('CLEARED1', 'T1000', 'P', '-500.00', ago(0.9), ago(0.9)),
        drawn('CLEARED1'),
        rec('CLEARED1', 'T1000', 'S', '-500.00', ago(0.9), ago(0.6)),
        // Refunded after settling: the money came back as a T1107 of its own.
        drawn('REFUNDED1'),
        rec('REFUNDED1', 'T1000', 'S', '-500.00', ago(0.9), ago(0.6)),
        rec('REFUNDED1', 'T1000', 'V', '-500.00', ago(0.9), ago(0.3)),
        drawn('DENIED1'),
        rec('DENIED1', 'T1000', 'D', '-500.00', ago(0.9), ago(0.3)),
        drawn('INFLIGHT1'),
      ]);

    const { by } = await fetchSince(ago(1));

    expect(by.get('CLEARED1')?.settleStatus).toBe('settled');
    expect(by.get('REFUNDED1')?.settleStatus).toBe('settled');
    expect(by.get('DENIED1')?.settleStatus).toBe('failed');
    expect(by.get('INFLIGHT1')?.settleStatus).toBe('pending');
    // The stored record stays the one PayPal returned.
    expect((by.get('CLEARED1')?.raw as { transaction_info: { transaction_status: string } })
      .transaction_info.transaction_status).toBe('P');
  });

  it('keeps a settled payment settled when its seller is later reversed', async () => {
    // A case against the seller: PayPal debits them and marks our payment V,
    // whether or not any money ever comes back to us.
    stub((mode) => mode === 'Y'
      ? [rec('DISPUTED1', 'T1000', 'S', '-580.00', ago(0.9), ago(0.9))]
      : [
        rec('DISPUTED1', 'T1000', 'S', '-580.00', ago(0.9), ago(0.9)),
        rec('DISPUTED1', 'T1000', 'V', '-580.00', ago(0.9), ago(0.2)),
      ]);

    const { txns } = await fetchSince(ago(1));

    expect(txns).toHaveLength(1);
    expect(txns[0].settleStatus).toBe('settled');
  });
});
