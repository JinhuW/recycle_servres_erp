import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { syncBankTransactions } from '../src/banktx/sync';
import type { BankProvider, BankSource, NormalizedTxn } from '../src/banktx/types';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

type TxnSpec = Partial<NormalizedTxn> & { externalId: string; amount: number };

function fakeProvider(source: BankSource, txns: TxnSpec[]): BankProvider {
  return {
    source,
    async fetchSince() {
      return {
        accounts: [{ externalId: `${source}-acct`, name: `${source} acct` }],
        txns: txns.map((t) => ({
          source,
          accountExternalId: `${source}-acct`,
          postedAt: new Date(NOW - DAY),
          counterparty: null,
          description: null,
          paypalTxnId: source === 'paypal' ? t.externalId : null,
          category: 'external' as const,
          settleStatus: 'settled' as const,
          raw: { id: t.externalId },
          ...t,
        })),
      };
    },
  };
}

type Row = {
  external_id: string;
  ignored: boolean;
  ignore_rule_id: string | null;
  no_auto_ignore: boolean;
  pair_id: string | null;
  order_id: string | null;
};

async function rows(): Promise<Map<string, Row>> {
  const r = await getTestDb()<Row[]>`
    SELECT external_id, ignored, ignore_rule_id, no_auto_ignore, pair_id, order_id
    FROM bank_transactions`;
  return new Map(r.map((x) => [x.external_id, x]));
}

async function idOf(externalId: string): Promise<string> {
  const r = await getTestDb()`SELECT id FROM bank_transactions WHERE external_id = ${externalId}`;
  expect(r).toHaveLength(1);
  return r[0].id as string;
}

async function createPO(token: string): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: { category: 'RAM', lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

type Rule = { id: string; source: string | null; pattern: string; label: string; matched: number };

async function addRule(token: string, body: { pattern: string; label?: string; source?: string | null }) {
  const r = await api<{ rule: Rule; ignored: number }>('POST', '/api/bank-transactions/ignore-rules', { token, body });
  expect(r.status).toBe(201);
  return r.body;
}

// The card-spend shape the rules exist for: single Mercury legs, plus the
// things a rule must leave alone — a linked row, a transfer, the other source.
async function seedCardSpend(): Promise<void> {
  await syncBankTransactions(testEnv, [
    fakeProvider('mercury', [
      { externalId: 'm-shell', amount: -62.7, counterparty: 'Shell', description: 'SHELL 57544282502' },
      { externalId: 'm-gas', amount: -100, counterparty: 'Costco', description: 'COSTCO GAS #0629' },
      { externalId: 'm-seller', amount: -560, counterparty: 'Reddit Seller' },
      { externalId: 'm-linked', amount: -80, counterparty: 'Shell', description: 'SHELL 57544280506' },
      { externalId: 'm-transfer', amount: -500, counterparty: 'Shell', category: 'transfer' },
    ]),
    fakeProvider('paypal', [
      { externalId: 'p-shell', amount: -40, counterparty: 'Shell Station' },
    ]),
  ]);
}

describe('bank ignore rules', () => {
  beforeEach(async () => { await resetDb(); });

  it('is manager-only', async () => {
    const { token } = await loginAs(MARCUS);
    for (const [method, path] of [
      ['GET', '/api/bank-transactions/ignore-rules'],
      ['GET', '/api/bank-transactions/ignore-rules/preview?pattern=x'],
      ['POST', '/api/bank-transactions/ignore-rules'],
      ['PATCH', '/api/bank-transactions/ignore-rules/00000000-0000-0000-0000-000000000000'],
      ['DELETE', '/api/bank-transactions/ignore-rules/00000000-0000-0000-0000-000000000000'],
    ] as const) {
      const r = await api(method, path, { token, ...(method === 'GET' ? {} : { body: { pattern: 'x' } }) });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
  });

  it('a rule ignores matching open rows now — case-insensitive, on counterparty or description, per source', async () => {
    await seedCardSpend();
    const { token } = await loginAs(ALEX);
    const poId = await createPO(token);
    await api('POST', `/api/bank-transactions/${await idOf('m-linked')}/link`, { token, body: { orderId: poId } });

    const gas = await addRule(token, { pattern: 'gas', label: 'Gas' });
    expect(gas.ignored).toBe(1);
    const shell = await addRule(token, { pattern: 'SHELL', source: 'mercury' });
    expect(shell.ignored).toBe(1);

    const r = await rows();
    expect(r.get('m-gas')).toMatchObject({ ignored: true, ignore_rule_id: gas.rule.id });
    expect(r.get('m-shell')).toMatchObject({ ignored: true, ignore_rule_id: shell.rule.id });
    // Linked, transfer, the other source and the non-match all stay put.
    for (const k of ['m-linked', 'm-transfer', 'p-shell', 'm-seller']) {
      expect(r.get(k), k).toMatchObject({ ignored: false, ignore_rule_id: null });
    }

    const list = await api<{ rules: Rule[] }>('GET', '/api/bank-transactions/ignore-rules', { token });
    expect(list.body.rules.map((x) => [x.pattern, x.source, x.label, x.matched])).toEqual([
      ['SHELL', 'mercury', '', 1],
      ['gas', null, 'Gas', 1],
    ]);

    // The Ignored list names the rule: its label, or its pattern when unlabelled.
    const feed = await api<{ rows: { counterparty: string; ignoreRuleLabel: string | null }[] }>(
      'GET', '/api/bank-transactions?status=ignored', { token });
    expect(feed.body.rows.map((x) => [x.counterparty, x.ignoreRuleLabel]).sort()).toEqual([
      ['Costco', 'Gas'],
      ['Shell', 'SHELL'],
    ]);
  });

  it('validates the body', async () => {
    const { token } = await loginAs(ALEX);
    expect((await api('POST', '/api/bank-transactions/ignore-rules', { token, body: { pattern: '   ' } })).status).toBe(400);
    expect((await api('POST', '/api/bank-transactions/ignore-rules', { token, body: { pattern: 'x', source: 'venmo' } })).status).toBe(400);
    expect((await api('POST', '/api/bank-transactions/ignore-rules', { token, body: { pattern: 'x'.repeat(121) } })).status).toBe(400);
    expect((await api('PATCH', '/api/bank-transactions/ignore-rules/not-a-uuid', { token, body: { pattern: 'x' } })).status).toBe(404);
    expect((await api('DELETE', '/api/bank-transactions/ignore-rules/00000000-0000-0000-0000-000000000000', { token })).status).toBe(404);
  });

  it('takes a pair whole, and leaves a pair with a linked leg alone', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [
        { externalId: 'P-A', amount: -300, counterparty: 'Shell Station' },
        { externalId: 'P-B', amount: -700, counterparty: 'Shell Station' },
      ]),
      fakeProvider('mercury', [
        { externalId: 'm-A', amount: -300, paypalTxnId: 'P-A', counterparty: 'PayPal', description: 'PAYPAL *NONAME' },
        { externalId: 'm-B', amount: -700, paypalTxnId: 'P-B', counterparty: 'PayPal', description: 'PAYPAL *NONAME' },
      ]),
    ]);
    const { token } = await loginAs(ALEX);
    const poId = await createPO(token);
    await api('POST', `/api/bank-transactions/${await idOf('P-B')}/link`, { token, body: { orderId: poId } });

    const rule = await addRule(token, { pattern: 'shell station' });
    // One logical payment, two legs.
    expect(rule.ignored).toBe(2);
    const r = await rows();
    expect(r.get('P-A')?.pair_id).toBe(r.get('m-A')?.pair_id);
    expect(r.get('P-A')).toMatchObject({ ignored: true, ignore_rule_id: rule.rule.id });
    expect(r.get('m-A')).toMatchObject({ ignored: true, ignore_rule_id: rule.rule.id });
    expect(r.get('P-B')).toMatchObject({ ignored: false, order_id: poId });
    expect(r.get('m-B')).toMatchObject({ ignored: false, order_id: poId });
  });

  it('every sync re-applies the rules, after pairing', async () => {
    const { token } = await loginAs(ALEX);
    const rule = await addRule(token, { pattern: 'shell' });
    expect(rule.ignored).toBe(0);

    // Charge and settlement in one sync: they pair, and both go.
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [{ externalId: 'P-1', amount: -300, counterparty: 'Shell Station' }]),
      fakeProvider('mercury', [
        { externalId: 'm-1', amount: -300, paypalTxnId: 'P-1', counterparty: 'PayPal', description: 'PAYPAL *NONAME' },
        { externalId: 'm-card', amount: -55, counterparty: 'Shell', description: 'SHELL 57544280506' },
      ]),
    ]);
    let r = await rows();
    expect(r.get('P-1')?.pair_id).not.toBeNull();
    expect(r.get('P-1')?.pair_id).toBe(r.get('m-1')?.pair_id);
    for (const k of ['P-1', 'm-1', 'm-card']) {
      expect(r.get(k), k).toMatchObject({ ignored: true, ignore_rule_id: rule.rule.id });
    }

    // The settlement of an already-ignored charge arrives syncs later: the
    // rule-ignored charge still pairs, and the new leg is taken with it.
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [{ externalId: 'P-2', amount: -420, counterparty: 'Shell Station' }]),
    ]);
    r = await rows();
    expect(r.get('P-2')).toMatchObject({ ignored: true, pair_id: null });
    await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [
        { externalId: 'm-2', amount: -420, paypalTxnId: 'P-2', counterparty: 'PayPal', description: 'PAYPAL *NONAME' },
      ]),
    ]);
    r = await rows();
    expect(r.get('m-2')?.pair_id).not.toBeNull();
    expect(r.get('m-2')?.pair_id).toBe(r.get('P-2')?.pair_id);
    expect(r.get('m-2')).toMatchObject({ ignored: true, ignore_rule_id: rule.rule.id });
  });

  it('a human Unignore on a rule-ignored row sticks; on a human-ignored row it leaves no tombstone', async () => {
    await seedCardSpend();
    const { token } = await loginAs(ALEX);
    await addRule(token, { pattern: 'shell', source: 'mercury' });
    await api('POST', `/api/bank-transactions/${await idOf('m-seller')}/ignore`, { token });

    expect((await api('POST', `/api/bank-transactions/${await idOf('m-shell')}/unignore`, { token })).status).toBe(200);
    expect((await api('POST', `/api/bank-transactions/${await idOf('m-seller')}/unignore`, { token })).status).toBe(200);
    let r = await rows();
    expect(r.get('m-shell')).toMatchObject({ ignored: false, ignore_rule_id: null, no_auto_ignore: true });
    expect(r.get('m-seller')).toMatchObject({ ignored: false, ignore_rule_id: null, no_auto_ignore: false });

    await seedCardSpend();
    r = await rows();
    expect(r.get('m-shell')).toMatchObject({ ignored: false });
    // A tombstoned row is not even offered by the preview.
    const p = await api<{ count: number }>('GET', '/api/bank-transactions/ignore-rules/preview?pattern=shell&source=mercury', { token });
    expect(p.body.count).toBe(0);
  });

  it('delete gives the rows back unless another rule claims them; a human ignore is untouched', async () => {
    await seedCardSpend();
    const { token } = await loginAs(ALEX);
    await api('POST', `/api/bank-transactions/${await idOf('m-seller')}/ignore`, { token });
    const shell = await addRule(token, { pattern: 'shell' });
    expect(shell.ignored).toBe(3); // m-shell, m-linked (not linked here), p-shell
    const station = await addRule(token, { pattern: 'station' });
    expect(station.ignored).toBe(0); // p-shell is already shell's

    const del = await api<{ ok: boolean; restored: number }>(
      'DELETE', `/api/bank-transactions/ignore-rules/${shell.rule.id}`, { token });
    expect(del.status).toBe(200);
    expect(del.body.restored).toBe(2);
    const r = await rows();
    expect(r.get('m-shell')).toMatchObject({ ignored: false, ignore_rule_id: null });
    expect(r.get('m-linked')).toMatchObject({ ignored: false, ignore_rule_id: null });
    expect(r.get('p-shell')).toMatchObject({ ignored: true, ignore_rule_id: station.rule.id });
    expect(r.get('m-seller')).toMatchObject({ ignored: true, ignore_rule_id: null });
  });

  it('edit reverts the old match and applies the new one', async () => {
    await seedCardSpend();
    const { token } = await loginAs(ALEX);
    const rule = await addRule(token, { pattern: 'gas', label: 'Gas' });
    const upd = await api<{ rule: Rule; ignored: number }>(
      'PATCH', `/api/bank-transactions/ignore-rules/${rule.rule.id}`,
      { token, body: { pattern: 'reddit', label: 'Sellers', source: null } });
    expect(upd.status).toBe(200);
    expect(upd.body.ignored).toBe(1);
    expect(upd.body.rule).toMatchObject({ pattern: 'reddit', label: 'Sellers', source: null, matched: 1 });
    const r = await rows();
    expect(r.get('m-gas')).toMatchObject({ ignored: false, ignore_rule_id: null });
    expect(r.get('m-seller')).toMatchObject({ ignored: true, ignore_rule_id: rule.rule.id });
  });

  it('preview counts open matches without writing', async () => {
    await seedCardSpend();
    const { token } = await loginAs(ALEX);
    const poId = await createPO(token);
    await api('POST', `/api/bank-transactions/${await idOf('m-linked')}/link`, { token, body: { orderId: poId } });
    const p = await api<{ count: number; sample: { counterparty: string }[] }>(
      'GET', '/api/bank-transactions/ignore-rules/preview?pattern=SHELL', { token });
    expect(p.status).toBe(200);
    // m-shell and p-shell; not the linked row, not the transfer.
    expect(p.body.count).toBe(2);
    expect(p.body.sample.map((s) => s.counterparty).sort()).toEqual(['Shell', 'Shell Station']);
    expect([...(await rows()).values()].every((x) => !x.ignored)).toBe(true);
    expect((await api('GET', '/api/bank-transactions/ignore-rules/preview', { token })).status).toBe(400);
  });

  it('0136 ignores what was unlinked before Aug 2026, pairs whole', async () => {
    const jul = new Date('2026-07-15T12:00:00-06:00');
    const jul31 = new Date('2026-07-31T20:00:00-06:00');
    const aug1 = new Date('2026-08-01T09:00:00-06:00');
    const aug = new Date('2026-08-15T12:00:00-06:00');
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [
        { externalId: 'P-old', amount: -300, counterparty: 'Old Seller', postedAt: jul31 },
      ]),
      fakeProvider('mercury', [
        { externalId: 'm-old', amount: -120, counterparty: 'Old Seller', postedAt: jul },
        { externalId: 'm-new', amount: -130, counterparty: 'New Seller', postedAt: aug },
        { externalId: 'm-settle', amount: -300, paypalTxnId: 'P-old', postedAt: aug1 },
        { externalId: 'm-failed', amount: -90, counterparty: 'Old Seller', postedAt: jul, settleStatus: 'failed' },
        { externalId: 'm-transfer', amount: -90, counterparty: 'Old Seller', postedAt: jul, category: 'transfer' },
      ]),
    ]);
    const sqlText = readFileSync(
      fileURLToPath(new URL('../migrations/0136_ignore_unlinked_before_aug_2026.sql', import.meta.url)), 'utf8');
    await getTestDb().unsafe(sqlText);

    const r = await rows();
    expect(r.get('P-old')?.pair_id).toBe(r.get('m-settle')?.pair_id);
    expect(r.get('m-old')?.ignored).toBe(true);
    expect(r.get('P-old')?.ignored).toBe(true);
    expect(r.get('m-settle')?.ignored).toBe(true);
    expect(r.get('m-new')?.ignored).toBe(false);
    expect(r.get('m-failed')?.ignored).toBe(false);
    expect(r.get('m-transfer')?.ignored).toBe(false);
  });
});
