import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';
import { syncBankTransactions } from '../src/banktx/sync';
import type { BankProvider, BankSource, NormalizedTxn } from '../src/banktx/types';
import { nearTolerance, rankCandidates, tolFrag, type CandidateRow, type MatchLeg } from '../src/banktx/match';

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
  shown: number;
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
  otherFees?: number;
  paypalTxnId?: string;
}): Promise<string> {
  const sql = getTestDb();
  const id = `PO-9${String(++seq).padStart(3, '0')}`;
  const [user] = await sql`SELECT id FROM users WHERE email = ${opts.owner ?? MARCUS}`;
  await sql`
    INSERT INTO orders (id, user_id, category, total_cost, other_fees, paypal_txn_id,
                        lifecycle, created_at, archived_at)
    VALUES (${id}, ${user.id}, 'RAM', ${opts.cost}, ${opts.otherFees ?? 0},
            ${opts.paypalTxnId ?? null}, 'draft',
            ${new Date(NOW + opts.daysFromNow * DAY)},
            ${opts.archived ? new Date(NOW) : null})`;
  return id;
}

async function seedTxn(spec: TxnSpec, source: BankSource = 'mercury'): Promise<string> {
  await syncBankTransactions(testEnv, [fakeProvider(source, [spec])]);
  const rows = await getTestDb()`
    SELECT id FROM bank_transactions
    WHERE external_id = ${spec.externalId} AND source = ${source}`;
  return rows[0].id as string;
}

// Two legs of one logical payment. Written directly rather than through the
// pairing endpoint so the test controls which leg carries what.
async function pairLegs(a: string, b: string): Promise<void> {
  const sql = getTestDb();
  const [{ pid }] = await sql<{ pid: string }[]>`SELECT gen_random_uuid() AS pid`;
  await sql`UPDATE bank_transactions SET pair_id = ${pid} WHERE id IN (${a}, ${b})`;
}

async function linkTo(txnId: string, orderId: string): Promise<void> {
  const { token } = await loginAs(ALEX);
  const r = await api('POST', `/api/bank-transactions/${txnId}/link`, { token, body: { orderId } });
  expect(r.status).toBe(200);
}

async function suggestionBody(
  txnId: string, q?: string,
): Promise<{ suggestions: Suggestion[]; total: number }> {
  const { token } = await loginAs(ALEX);
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  const r = await api<{ suggestions: Suggestion[]; total: number }>(
    'GET', `/api/bank-transactions/${txnId}/suggestions${qs}`, { token });
  expect(r.status).toBe(200);
  return r.body;
}

async function suggestionsFor(txnId: string, q?: string): Promise<Suggestion[]> {
  return (await suggestionBody(txnId, q)).suggestions;
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

    // The feed's filter has no TypeScript leg to compute against, so the rule
    // exists twice. This is what stops one of them being changed alone —
    // without it the unit tests above assert a formula no request runs.
    it('agrees with the SQL the queries actually use', async () => {
      const sql = getTestDb();
      const amounts = [-10, -99.5, -1000, -2500.25, -40000, 5, 1999.99];
      const rows = await sql<{ amount: number; tol: number }[]>`
        SELECT l.amount::float AS amount, ${tolFrag(sql as never, 'l')}::float AS tol
        FROM unnest(${amounts}::numeric[]) AS l(amount)`;
      expect(rows).toHaveLength(amounts.length);
      for (const r of rows) expect(r.tol).toBeCloseTo(nearTolerance(r.amount), 6);
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
      txn_hit: false, affinity: false, pool_total: 1, ...over,
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

    it('rejects a PO outside the match window', async () => {
      await makePO({ cost: 1240, daysFromNow: -120 });
      expect(await suggestionsFor(await seedTxn({ externalId: 'm-4', amount: -1240 }))).toEqual([]);
    });

    // routes/packages.ts mints a draft PO when a box is delivered, so for those
    // the distance from the payment is the shipment's transit time.
    it('still offers a PO two months after the payment posted', async () => {
      const po = await makePO({ cost: 1240, daysFromNow: -60 });
      const s = await suggestionsFor(await seedTxn({ externalId: 'm-4b', amount: -1240 }));
      expect(s.map((x) => x.id)).toEqual([po]);
      expect(s[0].dayGap).toBe(60);
      // Far outside the strong window, so it is offered but not asserted.
      expect(s[0].confidence).not.toBe('high');
    });

    // total_cost is the goods total; other_fees is the rest of what the bank
    // was actually asked for, and it is routinely larger than the tolerance.
    it('matches the charge that includes the PO other fees', async () => {
      const po = await makePO({ cost: 3450, otherFees: 105, daysFromNow: -2 });
      const s = await suggestionsFor(await seedTxn({ externalId: 'm-fees', amount: -3555 }));
      expect(s.map((x) => x.id)).toEqual([po]);
      expect(s[0].amountDiff).toBe(-105);
    });

    // Both legs of a pair carry order_id, so summing every linked row read a
    // $1,200 payment as $2,400 and called a half-paid PO settled.
    it('counts a paired payment once', async () => {
      const po = await makePO({ cost: 2400, daysFromNow: -6 });
      const m = await seedTxn({ externalId: 'pair-m', amount: -1200 }, 'mercury');
      const pp = await seedTxn({ externalId: 'pair-p', amount: -1200 }, 'paypal');
      await pairLegs(m, pp);
      await linkTo(pp, po);

      const s = await suggestionsFor(await seedTxn({ externalId: 'm-bal', amount: -2400 }));
      expect(s.map((x) => x.id)).toEqual([po]);
      expect(s[0].linkedTotal).toBe(1200);
      expect(s[0].covered).toBe(false);
      expect(s[0].confidence).toBe('high');
    });

    it('lets a refund cancel out the payment it reversed', async () => {
      const po = await makePO({ cost: 1000, daysFromNow: -6 });
      await linkTo(await seedTxn({ externalId: 'r-pay', amount: -1000 }), po);
      await linkTo(await seedTxn({ externalId: 'r-back', amount: 1000 }), po);

      const s = await suggestionsFor(await seedTxn({ externalId: 'r-again', amount: -1000 }));
      expect(s.map((x) => x.id)).toEqual([po]);
      expect(s[0].linkedTotal).toBe(0);
      expect(s[0].covered).toBe(false);
    });

    // The txn-id branch is amount- and date-unbounded on purpose, so an
    // unpaired settlement leg finds the PO it already paid. count === 1 plus
    // 'high' is exactly what arms the one-click Link.
    it('never calls an already-paid PO a high-confidence match, even by txn id', async () => {
      const po = await makePO({
        cost: 3450, daysFromNow: -4, paypalTxnId: '7AB12345CD678901E',
      });
      await linkTo(await seedTxn({ externalId: 'cov-pay', amount: -3450 }), po);

      const s = await suggestionsFor(await seedTxn({
        externalId: 'cov-again', amount: -3450, paypalTxnId: '7AB12345CD678901E',
      }));
      expect(s[0]).toMatchObject({ id: po, reason: 'txn', covered: true, confidence: 'low' });
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

    // Bank descriptors are not seller names. The old rule was a bare ILIKE
    // with no wildcards, so it only ever fired on byte-identical strings.
    it('matches a seller name the bank wrote differently', async () => {
      const plain = await makePO({ cost: 3450, daysFromNow: -2 });
      const seller = await makePO({ cost: 3450, daysFromNow: -2 });
      await getTestDb()`
        INSERT INTO packages (tracking_number, carrier, seller_name, order_id)
        VALUES ('1Z777', 'UPS', ${"John's Servers"}, ${seller})`;
      const s = await suggestionsFor(await seedTxn({
        externalId: 'm-seller-fuzzy', amount: -3450, counterparty: 'JOHNS SERVERS LLC',
      }));
      expect(s[0].id).toBe(seller);
      expect(s[0].sellerName).toBe("John's Servers");
      expect(s.find((x) => x.id === plain)!.sellerName).toBeNull();
    });

    // '_' and '%' are ordinary characters in an ACH descriptor. Fed to ILIKE
    // they are wildcards, and the seller chip then asserts evidence that does
    // not exist.
    it('does not let LIKE metacharacters in a descriptor invent a seller hit', async () => {
      const po = await makePO({ cost: 3450, daysFromNow: -2 });
      await getTestDb()`
        INSERT INTO packages (tracking_number, carrier, seller_name, order_id)
        VALUES ('1Z776', 'UPS', 'ACMEXPARTS', ${po})`;
      const s = await suggestionsFor(await seedTxn({
        externalId: 'm-seller-wild', amount: -3450, counterparty: 'ACME_PARTS',
      }));
      expect(s.map((x) => x.id)).toEqual([po]);
      expect(s[0].sellerName).toBeNull();
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

    // Ordering the pool by created_at before ranking evicted exactly the case
    // the unbounded txn-id branch exists for.
    it('keeps a txn-id hit that the candidate cap would have dropped', async () => {
      // The id lives on the package, not the order: sync's autoLink claims a
      // transaction whose id is on the PO itself, and a linked PO is a
      // different test.
      const old = await makePO({ cost: 999, daysFromNow: -80 });
      await getTestDb()`
        INSERT INTO packages (tracking_number, carrier, paypal_txn_id, order_id)
        VALUES ('1Z555', 'UPS', '7AB12345CD678901E', ${old})`;
      for (let i = 0; i < 30; i++) await makePO({ cost: 3450, daysFromNow: -1 });
      const body = await suggestionBody(await seedTxn({
        externalId: 'm-cap', amount: -3450, paypalTxnId: '7AB12345CD678901E',
      }));
      expect(body.suggestions).toHaveLength(25);
      // The count the badge shows is the whole pool, not the truncated list.
      expect(body.total).toBe(31);
      expect(body.suggestions[0]).toMatchObject({ id: old, reason: 'txn' });
    });

    it('free text searches id, purchaser and seller name', async () => {
      const po = await makePO({ cost: 77, daysFromNow: -200, owner: PRIYA });
      const txn = await seedTxn({ externalId: 'm-9', amount: -1240 });
      const s = await suggestionsFor(txn, po);
      expect(s.map((x) => x.id)).toContain(po);
      expect(s[0].reason).toBe('search');
    });

    // The identifier is the strongest signal there is, and pasting it into the
    // box is the one thing a manager does when the ranking already failed.
    it('free text finds the PO carrying the pasted paypal txn id', async () => {
      const po = await makePO({
        cost: 77, daysFromNow: -200, paypalTxnId: '7AB12345CD678901E',
      });
      const txn = await seedTxn({ externalId: 'm-q-txn', amount: -1240 });
      const s = await suggestionsFor(txn, '7ab12345cd678901e');
      expect(s[0]).toMatchObject({ id: po, reason: 'txn' });
    });

    it('free text skips archived POs, like the ranked path does', async () => {
      const po = await makePO({ cost: 77, daysFromNow: -2, archived: true });
      const txn = await seedTxn({ externalId: 'm-q-arch', amount: -1240 });
      expect(await suggestionsFor(txn, po)).toEqual([]);
    });

    it('free text treats a wildcard as the character it is', async () => {
      await makePO({ cost: 77, daysFromNow: -2 });
      const txn = await seedTxn({ externalId: 'm-q-wild', amount: -1240 });
      expect(await suggestionsFor(txn, 'PO-9%')).toEqual([]);
    });

    // The feed's display row is always the PayPal leg, so the endpoint has to
    // score the same one — a Mercury leg carries no txn id, a processor as its
    // counterparty, and a settlement date days later.
    it('scores a paired row from the same leg the feed badged', async () => {
      const po = await makePO({
        cost: 5000, daysFromNow: -70, paypalTxnId: '7AB12345CD678901E',
      });
      const m = await seedTxn({ externalId: 'pair-m2', amount: -1200 }, 'mercury');
      const pp = await seedTxn({
        externalId: 'pair-p2', amount: -1200, paypalTxnId: '7AB12345CD678901E',
      }, 'paypal');
      await pairLegs(m, pp);
      expect((await suggestionsFor(m))[0]).toMatchObject({ id: po, reason: 'txn' });
      expect((await suggestionsFor(pp))[0]).toMatchObject({ id: po, reason: 'txn' });
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

    // hasMatch is a toolbar toggle, persisted, and independent of the tabs —
    // so it has to carry the same open-row predicate `match` is computed under
    // or it returns rows whose payload is null.
    it('hasMatch never returns rows that carry no match payload', async () => {
      const po = await makePO({ cost: 1240, daysFromNow: -3 });
      const txn = await seedTxn({ externalId: 'm-hm-linked', amount: -1240 });
      await linkTo(txn, po);
      const { token } = await loginAs(ALEX);

      const linked = await api<{ rows: { match: MatchSummary | null }[] }>(
        'GET', '/api/bank-transactions?status=linked', { token });
      expect(linked.body.rows).toHaveLength(1);

      const filtered = await api<{ rows: { match: MatchSummary | null }[] }>(
        'GET', '/api/bank-transactions?status=linked&hasMatch=1', { token });
      expect(filtered.body.rows).toEqual([]);
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
