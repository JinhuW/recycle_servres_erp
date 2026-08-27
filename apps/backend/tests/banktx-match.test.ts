import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';
import { syncBankTransactions } from '../src/banktx/sync';
import type { BankProvider, BankSource, NormalizedTxn } from '../src/banktx/types';
import { nearTolerance, rankCandidates, type CandidateRow, type MatchLeg } from '../src/banktx/match';

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
          postedAt: new Date(NOW),
          counterparty: null,
          description: null,
          paypalTxnId: null,
          category: 'external' as const,
          raw: { id: t.externalId },
          ...t,
        })),
      };
    },
  };
}

type Suggestion = {
  id: string;
  totalCost: number | null;
  reason: 'txn' | 'exact' | 'near' | 'search';
  dayGap: number | null;
  amountDiff: number | null;
  confidence: 'high' | 'medium' | 'low';
  linkedTotal: number;
  sellerName: string | null;
  affinity: boolean;
  covered: boolean;
};

type MatchSummary = {
  count: number;
  confidence: 'high' | 'medium' | 'low';
  best: { id: string; totalCost: number | null; dayGap: number | null };
};

// Orders are inserted directly: the suite needs exact control over
// total_cost and created_at, which the create-PO route derives from lines.
let seq = 0;
async function makePO(opts: {
  cost: number | null;
  daysFromNow: number;
  owner?: string;
  archived?: boolean;
}): Promise<string> {
  const sql = getTestDb();
  const id = `PO-9${String(++seq).padStart(3, '0')}`;
  const [user] = await sql`SELECT id FROM users WHERE email = ${opts.owner ?? MARCUS}`;
  await sql`
    INSERT INTO orders (id, user_id, category, total_cost, lifecycle, created_at, archived_at)
    VALUES (${id}, ${user.id}, 'RAM', ${opts.cost}, 'draft',
            ${new Date(NOW + opts.daysFromNow * DAY)},
            ${opts.archived ? new Date(NOW) : null})`;
  return id;
}

async function seedTxn(spec: TxnSpec): Promise<string> {
  await syncBankTransactions(testEnv, [fakeProvider('mercury', [spec])]);
  const rows = await getTestDb()`
    SELECT id FROM bank_transactions WHERE external_id = ${spec.externalId}`;
  return rows[0].id as string;
}

async function suggestionsFor(txnId: string, q?: string): Promise<Suggestion[]> {
  const { token } = await loginAs(ALEX);
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  const r = await api<{ suggestions: Suggestion[] }>(
    'GET', `/api/bank-transactions/${txnId}/suggestions${qs}`, { token });
  expect(r.status).toBe(200);
  return r.body.suggestions;
}

describe('bank transaction → PO matching', () => {
  beforeEach(async () => { await resetDb(); });

  describe('nearTolerance', () => {
    it('floors at $1 and caps at $20', () => {
      expect(nearTolerance(10)).toBe(1);       // 1% would be $0.10
      expect(nearTolerance(1000)).toBe(10);    // 1%
      expect(nearTolerance(40000)).toBe(20);   // capped
      expect(nearTolerance(-1000)).toBe(10);   // sign-blind
    });
  });

  describe('rankCandidates', () => {
    const leg: MatchLeg = {
      id: 'leg', amount: -1000, posted_at: new Date(NOW),
      counterparty: null, paypal_txn_id: null,
    };
    const row = (over: Partial<CandidateRow>): CandidateRow => ({
      id: 'PO-1', total_cost: 1000, created_at: new Date(NOW), lifecycle: 'draft',
      created_by_name: 'Marcus', linked_total: 0, seller_name: null,
      txn_hit: false, affinity: false, ...over,
    });

    it('a lone exact match inside the strong window is high confidence', () => {
      const [c] = rankCandidates(leg, [row({ created_at: new Date(NOW - 2 * DAY) })]);
      expect(c).toMatchObject({ reason: 'exact', dayGap: 2, confidence: 'high', amountDiff: 0 });
    });

    it('two exact matches inside the window are both medium, closest first', () => {
      const ranked = rankCandidates(leg, [
        row({ id: 'PO-far', created_at: new Date(NOW - 6 * DAY) }),
        row({ id: 'PO-near', created_at: new Date(NOW - 1 * DAY) }),
      ]);
      expect(ranked.map((c) => c.id)).toEqual(['PO-near', 'PO-far']);
      expect(ranked.every((c) => c.confidence === 'medium')).toBe(true);
    });

    it('an exact match outside the strong window never reaches high', () => {
      const [c] = rankCandidates(leg, [row({ created_at: new Date(NOW - 20 * DAY) })]);
      expect(c).toMatchObject({ dayGap: 20, confidence: 'medium' });
    });

    it('a near amount is reported as near and stays below high', () => {
      const [c] = rankCandidates(leg, [row({ total_cost: 1000.4 })]);
      expect(c).toMatchObject({ reason: 'near', confidence: 'low' });
      expect(c.amountDiff).toBeCloseTo(0.4, 2);
    });

    it('a txn-id hit outranks a closer exact match and is high', () => {
      const ranked = rankCandidates(leg, [
        row({ id: 'PO-close', created_at: new Date(NOW) }),
        row({ id: 'PO-txn', created_at: new Date(NOW - 25 * DAY), txn_hit: true }),
      ]);
      expect(ranked[0]).toMatchObject({ id: 'PO-txn', reason: 'txn', confidence: 'high' });
    });

    it('a PO whose payments already cover it ranks last and never wins on confidence', () => {
      const ranked = rankCandidates(leg, [
        row({ id: 'PO-paid', linked_total: 1000, created_at: new Date(NOW) }),
        row({ id: 'PO-open', created_at: new Date(NOW - 5 * DAY) }),
      ]);
      expect(ranked.map((c) => c.id)).toEqual(['PO-open', 'PO-paid']);
      expect(ranked[0].confidence).toBe('high');
      expect(ranked[1]).toMatchObject({ covered: true, confidence: 'low' });
    });

    it('a seller-name hit breaks a tie between equally close POs', () => {
      const ranked = rankCandidates(leg, [
        row({ id: 'PO-plain' }),
        row({ id: 'PO-seller', seller_name: "John's Servers" }),
      ]);
      expect(ranked[0].id).toBe('PO-seller');
    });

    it('purchaser affinity breaks a tie that day gap cannot', () => {
      const ranked = rankCandidates(leg, [
        row({ id: 'PO-cold' }),
        row({ id: 'PO-known', affinity: true }),
      ]);
      expect(ranked[0].id).toBe('PO-known');
    });
  });

  describe('GET /:id/suggestions', () => {
    it('offers the same-amount PO inside the window', async () => {
      const po = await makePO({ cost: 1240, daysFromNow: -3 });
      const txn = await seedTxn({ externalId: 'm-1', amount: -1240 });
      const s = await suggestionsFor(txn);
      expect(s.map((x) => x.id)).toEqual([po]);
      expect(s[0]).toMatchObject({ reason: 'exact', confidence: 'high', dayGap: 3 });
    });

    it('matches a refund by absolute amount', async () => {
      const po = await makePO({ cost: 500, daysFromNow: -2 });
      const txn = await seedTxn({ externalId: 'm-refund', amount: 500 });
      expect((await suggestionsFor(txn)).map((x) => x.id)).toEqual([po]);
    });

    it('accepts cents of drift as a near match', async () => {
      await makePO({ cost: 1240.4, daysFromNow: -1 });
      const s = await suggestionsFor(await seedTxn({ externalId: 'm-2', amount: -1240 }));
      expect(s).toHaveLength(1);
      expect(s[0].reason).toBe('near');
    });

    it('rejects an amount beyond the tolerance', async () => {
      await makePO({ cost: 1290, daysFromNow: -1 });
      expect(await suggestionsFor(await seedTxn({ externalId: 'm-3', amount: -1240 }))).toEqual([]);
    });

    it('rejects a PO outside the 30-day window', async () => {
      await makePO({ cost: 1240, daysFromNow: -45 });
      expect(await suggestionsFor(await seedTxn({ externalId: 'm-4', amount: -1240 }))).toEqual([]);
    });

    it('skips archived POs and POs with no goods total', async () => {
      await makePO({ cost: 1240, daysFromNow: -1, archived: true });
      await makePO({ cost: null, daysFromNow: -1 });
      expect(await suggestionsFor(await seedTxn({ externalId: 'm-5', amount: -1240 }))).toEqual([]);
    });

    it('ranks the ambiguous case by day gap and marks it medium', async () => {
      const far = await makePO({ cost: 3450, daysFromNow: -6 });
      const near = await makePO({ cost: 3450, daysFromNow: -2 });
      const s = await suggestionsFor(await seedTxn({ externalId: 'm-6', amount: -3450 }));
      expect(s.map((x) => x.id)).toEqual([near, far]);
      expect(s.every((x) => x.confidence === 'medium')).toBe(true);
    });

    it('a same-amount PO outside the strong window does not dilute the close one', async () => {
      const stale = await makePO({ cost: 3450, daysFromNow: -20 });
      const near = await makePO({ cost: 3450, daysFromNow: -2 });
      const s = await suggestionsFor(await seedTxn({ externalId: 'm-6b', amount: -3450 }));
      expect(s.map((x) => x.id)).toEqual([near, stale]);
      expect(s[0].confidence).toBe('high');
    });

    it('promotes the PO whose package seller matches the counterparty', async () => {
      const plain = await makePO({ cost: 3450, daysFromNow: -2 });
      const seller = await makePO({ cost: 3450, daysFromNow: -2 });
      await getTestDb()`
        INSERT INTO packages (tracking_number, carrier, seller_name, order_id)
        VALUES ('1Z999', 'UPS', ${"John's Servers"}, ${seller})`;
      const txn = await seedTxn({ externalId: 'm-7', amount: -3450, counterparty: "John's Servers" });
      const s = await suggestionsFor(txn);
      expect(s[0].id).toBe(seller);
      expect(s[0].sellerName).toBe("John's Servers");
      expect(s.map((x) => x.id)).toContain(plain);
    });

    it('treats a package paypal txn id as a txn-id hit', async () => {
      const po = await makePO({ cost: 3450, daysFromNow: -20 });
      await getTestDb()`
        INSERT INTO packages (tracking_number, carrier, paypal_txn_id, order_id)
        VALUES ('1Z888', 'UPS', '7AB12345CD678901E', ${po})`;
      const txn = await seedTxn({
        externalId: 'm-8', amount: -3450, paypalTxnId: '7AB12345CD678901E',
      });
      const s = await suggestionsFor(txn);
      expect(s[0]).toMatchObject({ id: po, reason: 'txn', confidence: 'high' });
    });

    it('free text searches id, purchaser and seller name', async () => {
      const po = await makePO({ cost: 77, daysFromNow: -200, owner: PRIYA });
      const txn = await seedTxn({ externalId: 'm-9', amount: -1240 });
      const s = await suggestionsFor(txn, po);
      expect(s.map((x) => x.id)).toContain(po);
      expect(s[0].reason).toBe('search');
    });
  });

  describe('list + stats', () => {
    it('attaches a match summary to open rows only', async () => {
      const po = await makePO({ cost: 1240, daysFromNow: -3 });
      await seedTxn({ externalId: 'm-open', amount: -1240 });
      const ignoredId = await seedTxn({ externalId: 'm-ignored', amount: -1240 });
      const { token } = await loginAs(ALEX);
      await api('POST', `/api/bank-transactions/${ignoredId}/ignore`, { token, body: {} });

      const r = await api<{ rows: { id: string; match: MatchSummary | null; ignored: boolean }[] }>(
        'GET', '/api/bank-transactions?status=all', { token });
      expect(r.status).toBe(200);
      const open = r.body.rows.find((x) => !x.ignored)!;
      const ignored = r.body.rows.find((x) => x.ignored)!;
      expect(open.match).toMatchObject({ count: 1, confidence: 'high' });
      expect(open.match!.best).toMatchObject({ id: po, dayGap: 3 });
      expect(ignored.match).toBeNull();
    });

    it('hasMatch=1 filters the queue and stats counts the same rows', async () => {
      await makePO({ cost: 1240, daysFromNow: -3 });
      await seedTxn({ externalId: 'm-has', amount: -1240 });
      await seedTxn({ externalId: 'm-none', amount: -99 });
      const { token } = await loginAs(ALEX);

      const all = await api<{ rows: { id: string }[] }>(
        'GET', '/api/bank-transactions?status=unlinked', { token });
      expect(all.body.rows).toHaveLength(2);

      const filtered = await api<{ rows: { match: MatchSummary | null }[] }>(
        'GET', '/api/bank-transactions?status=unlinked&hasMatch=1', { token });
      expect(filtered.body.rows).toHaveLength(1);
      expect(filtered.body.rows[0].match).not.toBeNull();

      const stats = await api<{ unlinked: { count: number }; suggested: { count: number } }>(
        'GET', '/api/bank-transactions/stats', { token });
      expect(stats.body.unlinked.count).toBe(2);
      expect(stats.body.suggested.count).toBe(1);
    });

    it('a linked row drops out of the suggested count', async () => {
      const po = await makePO({ cost: 1240, daysFromNow: -3 });
      const txn = await seedTxn({ externalId: 'm-link', amount: -1240 });
      const { token } = await loginAs(ALEX);
      const linked = await api('POST', `/api/bank-transactions/${txn}/link`, {
        token, body: { orderId: po },
      });
      expect(linked.status).toBe(200);
      const stats = await api<{ suggested: { count: number } }>(
        'GET', '/api/bank-transactions/stats', { token });
      expect(stats.body.suggested.count).toBe(0);
    });
  });
});
