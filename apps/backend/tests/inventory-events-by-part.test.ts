import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

// Bug: the Inventory product view treated two POs carrying the SAME item as two
// different products because part numbers were compared with exact equality —
// "ABC-123", " abc-123 " and "PN: ABC-123" looked distinct. The product change
// log must therefore be the UNION of every peer line's inventory_events,
// matched on a canonical part number.

type Line = { id: string; part_number: string | null; qty: number };

async function createPoLine(token: string, partNumber: string): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      category: 'RAM',
      lines: [{
        category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
        classification: 'RDIMM', speed: '3200',
        partNumber, condition: 'Pulled — Tested', qty: 4, unitCost: 78.5,
      }],
    },
  });
  expect(r.status).toBe(201);
  const list = await api<{ items: Line[] }>('GET', '/api/inventory', { token });
  // The line just created is the newest (list is ORDER BY created_at DESC).
  return list.body.items[0].id;
}

async function eventsByPart(token: string, pn: string) {
  return api<{ events: Array<{ id: string; line_id: string; kind: string }> }>(
    'GET', `/api/inventory/events/by-part?partNumber=${encodeURIComponent(pn)}`,
    { token },
  );
}

describe('GET /api/inventory/events/by-part — union across same-part-number peers', () => {
  beforeEach(async () => { await resetDb(); });

  it('unions inventory_events from peer lines that differ only by case/space/prefix', async () => {
    const { token } = await loginAs(ALEX);

    // Two separate POs, same physical item, sloppy part-number entry.
    const lineA = await createPoLine(token, 'ABC-123');
    const lineB = await createPoLine(token, ' abc-123 ');
    const lineC = await createPoLine(token, 'PN: ABC-123');
    expect(new Set([lineA, lineB, lineC]).size).toBe(3);

    // Generate one audit event on each line (condition edit -> 'edited').
    for (const id of [lineA, lineB, lineC]) {
      const p = await api('PATCH', `/api/inventory/${id}`, {
        token, body: { condition: 'Pulled — Untested' },
      });
      expect(p.status).toBe(200);
    }

    const r = await eventsByPart(token, 'ABC-123');
    expect(r.status).toBe(200);

    const lineIds = new Set(r.body.events.map(e => e.line_id));
    // The union must span ALL three peers despite case/space/prefix variance.
    expect(lineIds.has(lineA)).toBe(true);
    expect(lineIds.has(lineB)).toBe(true);
    expect(lineIds.has(lineC)).toBe(true);
    expect(r.body.events.length).toBeGreaterThanOrEqual(3);
  });

  it('requires a partNumber query param', async () => {
    const { token } = await loginAs(ALEX);
    const r = await eventsByPart(token, '');
    expect(r.status).toBe(400);
  });

  it('scopes purchasers to their own lines (no cross-purchaser leak)', async () => {
    const mgr = await loginAs(ALEX);
    const lineA = await createPoLine(mgr.token, 'XYZ-9');
    await api('PATCH', `/api/inventory/${lineA}`, {
      token: mgr.token, body: { condition: 'Pulled — Untested' },
    });

    // A purchaser who owns no line with this part number sees an empty log.
    const buyer = await loginAs(MARCUS);
    const r = await eventsByPart(buyer.token, 'XYZ-9');
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBe(0);
  });
});
