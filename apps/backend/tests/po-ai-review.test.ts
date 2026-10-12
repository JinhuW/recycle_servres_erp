// AI review of a PO: queued by the move into Reviewing (when switched on),
// run by the background loop, answered finding by finding in Review mode.
// The test env has no OPENROUTER_API_KEY, so the run is the deterministic
// part-number check alone — the model witnesses are skipped, not faked.

import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { Budget, drainPoAiReviews } from '../src/services/poAiReview';

// Decodes to Samsung 32GB DDR4 RDIMM Server 2Rx4 2400.
const PN = 'M393A4K40BB1-CRC0Q';

type Finding = {
  id: string; lineId: string | null; severity: string; code: string; field: string | null;
  currentValue: string | null; suggestedValue: string | null; resolution: string | null; stale: boolean;
};
type AiReview = {
  enabled: boolean;
  latest: { id: string; status: string; trigger: string } | null;
  shown: { id: string; status: string } | null;
  findings: Finding[];
};

async function enable(on = true) {
  await getTestDb()`
    UPDATE workspace_settings SET value = jsonb_set(value, '{enabled}', ${on ? 'true' : 'false'}::jsonb)
    WHERE key = 'po_ai_review'`;
}

async function createInTransit(pur: string): Promise<{ id: string; lineId: string }> {
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token: pur,
    body: {
      paypalTxnId: 'TESTPAYTXN0000001', category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
      lines: [
        // Capacity contradicts the part number; rank is blank for it to fill.
        { category: 'RAM', brand: 'Samsung', capacity: '16GB', generation: 'DDR4', type: 'Server',
          classification: 'RDIMM', speed: '2400', partNumber: PN, condition: 'Pulled — Tested', qty: 4, unitCost: 60 },
      ],
    },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await api('POST', `/api/orders/${id}/advance`, { token: pur })).status).toBe(200);
  const got = await api<{ order: { lines: { id: string }[] } }>('GET', `/api/orders/${id}`, { token: pur });
  return { id, lineId: got.body.order.lines[0]!.id };
}

const toReviewing = (id: string, mgr: string) =>
  api('POST', `/api/orders/${id}/advance`, { token: mgr, body: { toStage: 'reviewing' } });
const read = (id: string, mgr: string) => api<AiReview>('GET', `/api/orders/${id}/ai-review`, { token: mgr });
const drain = () => drainPoAiReviews(getTestDb(), testEnv);

describe('PO AI review', () => {
  let pur: string;
  let mgr: string;
  beforeEach(async () => {
    await resetDb();
    pur = (await loginAs(MARCUS)).token;
    mgr = (await loginAs(ALEX)).token;
  });

  it('queues nothing while switched off', async () => {
    const { id } = await createInTransit(pur);
    expect((await toReviewing(id, mgr)).status).toBe(200);
    const r = await read(id, mgr);
    expect(r.body).toMatchObject({ enabled: false, latest: null, findings: [] });
  });

  it('queues one review on the move, runs it, and tells the manager', async () => {
    await enable();
    const { id, lineId } = await createInTransit(pur);
    expect((await toReviewing(id, mgr)).status).toBe(200);
    expect((await read(id, mgr)).body.latest).toMatchObject({ status: 'queued', trigger: 'stage' });
    // A re-run asked for while one waits adds nothing.
    const again = await api<{ queued: boolean }>('POST', `/api/orders/${id}/ai-review/run`, { token: mgr });
    expect(again.body.queued).toBe(false);

    expect(await drain()).toBe(1);
    const r = (await read(id, mgr)).body;
    expect(r.latest).toMatchObject({ status: 'done' });
    expect(r.findings.find((f) => f.field === 'capacity')).toMatchObject({
      lineId, severity: 'warn', code: 'spec_mismatch', currentValue: '16GB', suggestedValue: '32GB', stale: false,
    });
    expect(r.findings.find((f) => f.field === 'rank')).toMatchObject({ code: 'spec_blank', suggestedValue: '2Rx4' });

    const sql = getTestDb();
    const ev = await sql`SELECT detail FROM order_events WHERE order_id = ${id} AND kind = 'ai_review_done'`;
    expect(ev).toHaveLength(1);
    expect(ev[0]!.detail).toMatchObject({ warnings: 1 });
    const n = await sql`
      SELECT n.title FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE u.email = ${ALEX} AND n.kind = 'ai_review'`;
    expect(n[0]!.title).toBe(`AI review: 1 issue on ${id}`);

    // The run is in the manager's history of the PO, not the purchaser's.
    type Evs = { events: { kind: string }[] };
    const kinds = async (token: string) =>
      (await api<Evs>('GET', `/api/orders/${id}/events`, { token })).body.events.map((e) => e.kind);
    expect(await kinds(mgr)).toContain('ai_review_done');
    expect(await kinds(pur)).not.toContain('ai_review_done');
  });

  it('records Apply only once the line holds the suggestion, and keeps a dismissal across re-runs', async () => {
    await enable();
    const { id, lineId } = await createInTransit(pur);
    await toReviewing(id, mgr);
    await drain();
    const findings = (await read(id, mgr)).body.findings;
    const cap = findings.find((f) => f.field === 'capacity')!;
    const rank = findings.find((f) => f.field === 'rank')!;
    const resolve = (fid: string, resolution: unknown) =>
      api<AiReview>('POST', `/api/orders/${id}/ai-review/findings/${fid}/resolve`, { token: mgr, body: { resolution } });

    expect((await resolve(cap.id, 'applied')).status).toBe(409);
    const patched = await api('PATCH', `/api/orders/${id}`, {
      token: mgr, body: { lines: [{ id: lineId, capacity: '32GB' }], expectStage: 'reviewing' },
    });
    expect(patched.status).toBe(200);
    const applied = await resolve(cap.id, 'applied');
    expect(applied.status).toBe(200);
    expect(applied.body.findings.find((f) => f.id === cap.id)).toMatchObject({ resolution: 'applied', stale: true });

    expect((await resolve(rank.id, 'dismissed')).body.findings.find((f) => f.id === rank.id)!.resolution).toBe('dismissed');
    const rerun = await api<{ queued: boolean }>('POST', `/api/orders/${id}/ai-review/run`, { token: mgr });
    expect(rerun.body.queued).toBe(true);
    await drain();
    const after = (await read(id, mgr)).body;
    expect(after.shown!.id).not.toBe(applied.body.shown!.id);
    expect(after.findings.find((f) => f.field === 'capacity')).toBeUndefined();
    expect(after.findings.find((f) => f.field === 'rank')!.resolution).toBe('dismissed');
  });

  it('reads a scan through the part-number correction the form applied, not the raw misread', async () => {
    await enable();
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: pur,
      body: {
        paypalTxnId: 'TESTPAYTXN0000002', category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
        lines: [
          // Saved from a scan whose model read had an O for the 0 in "40";
          // reconcileRamScan corrected it before the form saw it.
          { category: 'RAM', brand: 'Samsung', capacity: '16GB', generation: 'DDR4', type: 'Server',
            classification: 'RDIMM', rank: '1Rx4', speed: '2400', partNumber: 'M393A2K40BB1-CRC0Q',
            condition: 'Pulled — Tested', qty: 2, unitCost: 30 },
        ],
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const sql = getTestDb();
    const [owner] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${MARCUS}`;
    await sql`
      INSERT INTO label_scans (user_id, cf_image_id, delivery_url, category, extracted, confidence, provider)
      VALUES (${owner!.id}, 'label-scans/misread', NULL, 'RAM', ${sql.json({
        partNumber: 'M393A2K4OBB1-CRC0Q', brand: 'Samsung', capacity: '16GB', generation: 'DDR4',
        type: 'Server', classification: 'RDIMM', rank: '1Rx4', speed: '2400',
      })}, 0.9, 'openrouter')`;
    await sql`UPDATE order_lines SET scan_image_id = 'label-scans/misread' WHERE order_id = ${id}`;
    expect((await api('POST', `/api/orders/${id}/advance`, { token: pur })).status).toBe(200);
    expect((await toReviewing(id, mgr)).status).toBe(200);
    await drain();
    const r = (await read(id, mgr)).body;
    expect(r.latest).toMatchObject({ status: 'done' });
    expect(r.findings.filter((f) => f.field === 'partNumber')).toEqual([]);
  });

  it('supersedes a waiting review when the order is archived', async () => {
    await enable();
    const { id } = await createInTransit(pur);
    await toReviewing(id, mgr);
    expect((await api('POST', `/api/orders/${id}/archive`, { token: mgr, body: {} })).status).toBe(200);
    expect((await read(id, mgr)).body.latest!.status).toBe('superseded');
    expect(await drain()).toBe(0);
  });

  it('keeps showing the last finished review behind any number of failed runs', async () => {
    await enable();
    const { id } = await createInTransit(pur);
    await toReviewing(id, mgr);
    await drain();
    const done = (await read(id, mgr)).body;
    expect(done.findings.length).toBeGreaterThan(0);
    const sql = getTestDb();
    for (let i = 0; i < 6; i++) {
      await sql`INSERT INTO po_ai_reviews (order_id, trigger, status, error, created_at)
                VALUES (${id}, 'manual', 'failed', 'boom', NOW() + ${`${i + 1} seconds`}::interval)`;
    }
    const after = (await read(id, mgr)).body;
    expect(after.latest).toMatchObject({ status: 'failed' });
    expect(after.shown!.id).toBe(done.shown!.id);
    expect(after.findings).toHaveLength(done.findings.length);
  });

  it('supersedes a waiting review when the order goes back before Reviewing', async () => {
    await enable();
    const { id } = await createInTransit(pur);
    await toReviewing(id, mgr);
    expect((await api('POST', `/api/orders/${id}/advance`, { token: mgr, body: { toStage: 'in_transit' } })).status).toBe(200);
    expect((await read(id, mgr)).body.latest!.status).toBe('superseded');
    expect(await drain()).toBe(0);
  });

  it('validates the setting', async () => {
    const patch = (v: unknown) => api('PATCH', '/api/workspace', { token: mgr, body: { po_ai_review: v } });
    expect((await patch({ enabled: 'yes' })).status).toBe(400);
    expect((await patch({ enabled: true, maxCostPerPoUsd: 50 })).status).toBe(400);
    expect((await patch({ enabled: true, model: 'not a model' })).status).toBe(400);
    expect((await patch({ enabled: true, webLookup: false, maxCostPerPoUsd: 1, model: 'openai/gpt-6-luna' })).status).toBe(200);
  });

  it('is manager-only', async () => {
    const { id } = await createInTransit(pur);
    expect((await read(id, pur)).status).toBe(403);
    expect((await api('POST', `/api/orders/${id}/ai-review/run`, { token: pur })).status).toBe(403);
  });
});

describe('the per-PO cost cap', () => {
  it('holds when four lines reach for a model call at once', async () => {
    const budget = new Budget(0.1);
    const call = async () => {
      if (!(await budget.begin())) return;
      try {
        await new Promise((r) => setTimeout(r, 5));
        budget.add({ promptTokens: 1, completionTokens: 1, costUsd: 0.06 });
      } finally {
        budget.end();
      }
    };
    await Promise.all(Array.from({ length: 6 }, call));
    // One call over the cap at most, never a whole first wave.
    expect(budget.costUsd).toBeCloseTo(0.12);
    expect(budget.skipped).toBe(4);
  });
});
