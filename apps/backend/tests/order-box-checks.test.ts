// Box check: a manager counting a PO against the box that arrived. Progress
// is stored per line; flags and extra items go to the purchaser as one
// notification plus an order event, and never move the stage.

import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

const PN = 'BOXCHECK-PN';

type Checks = {
  lines: {
    lineId: string; counted: number; flagReason: string | null; flagNote: string | null;
    checkedAt: string | null; flagSentAt: string | null;
  }[];
  extras: { id: string; partNumber: string; note: string | null; sentAt: string | null }[];
};

async function createReviewing(pur: string, mgr: string): Promise<{ id: string; lineIds: string[] }> {
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token: pur,
    body: {
      paypalTxnId: 'TESTPAYTXN0000001',
      category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
      lines: [
        { category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4', classification: 'RDIMM',
          speed: '3200', partNumber: PN, condition: 'Pulled — Tested', qty: 4, unitCost: 78.5 },
        { category: 'RAM', brand: 'Samsung', capacity: '16GB', type: 'DDR4', classification: 'RDIMM',
          speed: '3200', partNumber: PN + '-B', condition: 'Pulled — Tested', qty: 2, unitCost: 40 },
      ],
    },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await api('POST', `/api/orders/${id}/advance`, { token: pur })).status).toBe(200);
  expect((await api('POST', `/api/orders/${id}/advance`, { token: mgr, body: { toStage: 'reviewing' } })).status).toBe(200);
  const got = await api<{ order: { lines: { id: string }[] } }>('GET', `/api/orders/${id}`, { token: mgr });
  return { id, lineIds: got.body.order.lines.map(l => l.id) };
}

describe('box check', () => {
  let pur: string;
  let mgr: string;
  beforeEach(async () => {
    await resetDb();
    pur = (await loginAs(MARCUS)).token;
    mgr = (await loginAs(ALEX)).token;
  });

  it('saves counts per line and stamps checkedAt only at the full qty', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    const [a, b] = lineIds as [string, string];

    const empty = await api<Checks>('GET', `/api/orders/${id}/checks`, { token: mgr });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ lines: [], extras: [] });

    const part = await api<Checks>('PUT', `/api/orders/${id}/checks/${a}`, { token: mgr, body: { counted: 2 } });
    expect(part.status).toBe(200);
    expect(part.body.lines.find(l => l.lineId === a)).toMatchObject({ counted: 2, checkedAt: null });

    const full = await api<Checks>('PUT', `/api/orders/${id}/checks/${a}`, { token: mgr, body: { counted: 4 } });
    const stamped = full.body.lines.find(l => l.lineId === a)!.checkedAt;
    expect(stamped).not.toBeNull();

    // A recount that stays full keeps its place in the Checked group.
    const again = await api<Checks>('PUT', `/api/orders/${id}/checks/${a}`, { token: mgr, body: { counted: 4 } });
    expect(again.body.lines.find(l => l.lineId === a)!.checkedAt).toBe(stamped);

    const flagged = await api<Checks>('PUT', `/api/orders/${id}/checks/${b}`, {
      token: mgr, body: { counted: 1, flagReason: 'short', flagNote: '  one missing  ' },
    });
    expect(flagged.body.lines.find(l => l.lineId === b)).toMatchObject({ counted: 1, flagReason: 'short', flagNote: 'one missing' });

    // Reads never touch the PO's own qty or stage.
    const order = await api<{ order: { lifecycle: string; lines: { id: string; qty: number }[] } }>('GET', `/api/orders/${id}`, { token: mgr });
    expect(order.body.order.lifecycle).toBe('reviewing');
    expect(order.body.order.lines.find(l => l.id === b)!.qty).toBe(2);
  });

  it('takes checked as its own answer, apart from the count', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    const a = lineIds[0]!;
    const put = (body: unknown) => api<Checks>('PUT', `/api/orders/${id}/checks/${a}`, { token: mgr, body });
    const row = (r: { body: Checks }) => r.body.lines.find(l => l.lineId === a)!;

    // The count starts full; a full count left unticked is not checked.
    expect(row(await put({ counted: 4, checked: false })).checkedAt).toBeNull();
    const ticked = row(await put({ counted: 4, checked: true }));
    expect(ticked.checkedAt).not.toBeNull();
    // Re-sending the tick keeps its place in the Checked group.
    expect(row(await put({ counted: 4, checked: true })).checkedAt).toBe(ticked.checkedAt);
    // Unticking keeps the count.
    expect(row(await put({ counted: 4, checked: false }))).toMatchObject({ counted: 4, checkedAt: null });
    expect((await put({ counted: 4, checked: 'yes' })).status).toBe(400);
  });

  it('reads a body with no checked field the way the first bundle meant it', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    const a = lineIds[0]!;
    const r = await api<Checks>('PUT', `/api/orders/${id}/checks/${a}`, { token: mgr, body: { counted: 4 } });
    expect(r.body.lines.find(l => l.lineId === a)!.checkedAt).not.toBeNull();
  });

  it('keeps reads off the PO itself', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    const b = lineIds[1]!;
    await api('PUT', `/api/orders/${id}/checks/${b}`, { token: mgr, body: { counted: 1, checked: false, flagReason: 'short' } });
    const order = await api<{ order: { lifecycle: string; lines: { id: string; qty: number }[] } }>('GET', `/api/orders/${id}`, { token: mgr });
    expect(order.body.order.lifecycle).toBe('reviewing');
    expect(order.body.order.lines.find(l => l.id === b)!.qty).toBe(2);
  });

  it('refuses a purchaser, and lets a manager previewing as purchaser through (raw role)', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    expect((await api('GET', `/api/orders/${id}/checks`, { token: pur })).status).toBe(403);
    expect((await api('PUT', `/api/orders/${id}/checks/${lineIds[0]}`, { token: pur, body: { counted: 1 } })).status).toBe(403);
    expect((await api('POST', `/api/orders/${id}/checks/send`, { token: pur, body: {} })).status).toBe(403);

    expect((await api('PATCH', '/api/me/preferences', { token: mgr, body: { 'tweaks.rolePreview': 'as_purchaser' } })).status).toBe(200);
    expect((await api('GET', `/api/orders/${id}/checks`, { token: mgr })).status).toBe(200);
  });

  it('validates the line, the count and the reason', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    const other = await createReviewing(pur, mgr);
    const put = (lineId: string, body: unknown) => api('PUT', `/api/orders/${id}/checks/${lineId}`, { token: mgr, body });

    expect((await put(other.lineIds[0]!, { counted: 1 })).status).toBe(404);
    expect((await put('not-a-uuid', { counted: 1 })).status).toBe(404);
    expect((await put(lineIds[0]!, { counted: 5 })).status).toBe(400);
    expect((await put(lineIds[0]!, { counted: -1 })).status).toBe(400);
    expect((await put(lineIds[0]!, { counted: 1.5 })).status).toBe(400);
    expect((await put(lineIds[0]!, { counted: 1, flagReason: 'stolen' })).status).toBe(400);
    expect((await api('GET', '/api/orders/PO-NOPE/checks', { token: mgr })).status).toBe(404);
  });

  it('adds and removes extra items', async () => {
    const { id } = await createReviewing(pur, mgr);
    const added = await api<Checks>('POST', `/api/orders/${id}/checks/extras`, { token: mgr, body: { partNumber: ' X-99 ' } });
    expect(added.status).toBe(201);
    expect(added.body.extras).toMatchObject([{ partNumber: 'X-99', note: null }]);
    expect((await api('POST', `/api/orders/${id}/checks/extras`, { token: mgr, body: { partNumber: '  ' } })).status).toBe(400);

    const gone = await api<Checks>('DELETE', `/api/orders/${id}/checks/extras/${added.body.extras[0]!.id}`, { token: mgr });
    expect(gone.status).toBe(200);
    expect(gone.body.extras).toEqual([]);
  });

  it('refuses to send with nothing flagged, then notifies the owner and records the event', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    expect((await api('POST', `/api/orders/${id}/checks/send`, { token: mgr, body: {} })).status).toBe(409);

    await api('PUT', `/api/orders/${id}/checks/${lineIds[0]}`, { token: mgr, body: { counted: 4, flagReason: 'damaged', flagNote: 'bent pins' } });
    await api('POST', `/api/orders/${id}/checks/extras`, { token: mgr, body: { partNumber: 'X-99' } });
    const sent = await api<Checks & { ok: true; sentFlags: number; sentExtras: number; notified: boolean }>(
      'POST', `/api/orders/${id}/checks/send`, { token: mgr, body: {} });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ok: true, sentFlags: 1, sentExtras: 1, notified: true });
    // The response carries the stamped state, so the page shows what went out.
    expect(sent.body.lines.find(l => l.lineId === lineIds[0])?.flagSentAt).toBeTruthy();
    expect(sent.body.extras[0]?.sentAt).toBeTruthy();

    const events = await api<{ events: { kind: string; detail: { flags: unknown[]; extras: unknown[] } }[] }>(
      'GET', `/api/orders/${id}/events`, { token: pur });
    const ev = events.body.events.find(e => e.kind === 'box_check_flagged');
    expect(ev?.detail.flags).toMatchObject([{ partNumber: PN, reason: 'damaged', note: 'bent pins', counted: 4, qty: 4 }]);
    expect(ev?.detail.extras).toMatchObject([{ partNumber: 'X-99' }]);

    const sql = getTestDb();
    const notes = await sql<{ title: string; body: string }[]>`
      SELECT n.title, n.body FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE u.email = ${MARCUS} AND n.kind = 'box_check'`;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toContain(id);
    expect(notes[0]!.body).toContain('bent pins');

    const order = await api<{ order: { lifecycle: string } }>('GET', `/api/orders/${id}`, { token: mgr });
    expect(order.body.order.lifecycle).toBe('reviewing');
  });

  it('sends each flag once, and again only after it changes', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    const [a, b] = lineIds as [string, string];
    const send = () => api<{ sentFlags: number; sentExtras: number }>('POST', `/api/orders/${id}/checks/send`, { token: mgr, body: {} });
    const put = (lineId: string, body: unknown) => api('PUT', `/api/orders/${id}/checks/${lineId}`, { token: mgr, body });
    const sql = getTestDb();
    const noteCount = async () => (await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE u.email = ${MARCUS} AND n.kind = 'box_check'`)[0]!.n;

    await put(a, { counted: 4, flagReason: 'damaged', flagNote: 'bent pins' });
    expect((await send()).body).toMatchObject({ sentFlags: 1, sentExtras: 0 });
    expect((await send()).status).toBe(409);

    // A count-only write keeps the stamp; the flag itself is unchanged.
    await put(a, { counted: 3, flagReason: 'damaged', flagNote: 'bent pins' });
    expect((await send()).status).toBe(409);

    // A new flag on another line goes out alone; an edited flag goes again.
    await put(b, { counted: 1, flagReason: 'short' });
    expect((await send()).body).toMatchObject({ sentFlags: 1 });
    await put(a, { counted: 3, flagReason: 'damaged', flagNote: 'bent pins, cracked PCB' });
    expect((await send()).body).toMatchObject({ sentFlags: 1 });
    expect(await noteCount()).toBe(3);

    const events = await api<{ events: { kind: string; detail: { flags: { lineId: string }[] } }[] }>(
      'GET', `/api/orders/${id}/events`, { token: mgr });
    const sentLines = events.body.events.filter(e => e.kind === 'box_check_flagged').map(e => e.detail.flags.map(f => f.lineId));
    expect(sentLines.sort()).toEqual([[a], [a], [b]].sort());
  });

  it('says nobody was notified when the manager owns the PO', async () => {
    const { id, lineIds } = await createReviewing(mgr, mgr);
    await api('PUT', `/api/orders/${id}/checks/${lineIds[0]}`, { token: mgr, body: { counted: 4, flagReason: 'damaged' } });
    const sent = await api<{ notified: boolean }>('POST', `/api/orders/${id}/checks/send`, { token: mgr, body: {} });
    expect(sent.status).toBe(200);
    expect(sent.body.notified).toBe(false);
  });

  it('refuses writes on an archived PO but still reads', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    expect((await api('POST', `/api/orders/${id}/archive`, { token: mgr, body: {} })).status).toBe(200);
    expect((await api('GET', `/api/orders/${id}/checks`, { token: mgr })).status).toBe(200);
    expect((await api('PUT', `/api/orders/${id}/checks/${lineIds[0]}`, { token: mgr, body: { counted: 1 } })).status).toBe(409);
    expect((await api('POST', `/api/orders/${id}/checks/extras`, { token: mgr, body: { partNumber: 'X' } })).status).toBe(409);
  });

  it('drops a line\'s check with the line', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    await api('PUT', `/api/orders/${id}/checks/${lineIds[0]}`, { token: mgr, body: { counted: 2 } });
    const sql = getTestDb();
    await sql`DELETE FROM order_lines WHERE id = ${lineIds[0]!}`;
    const after = await api<Checks>('GET', `/api/orders/${id}/checks`, { token: mgr });
    expect(after.body.lines).toEqual([]);
  });
});
