import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';

// C1 regression: advancing a PO's lifecycle must write an inventory_events
// row of kind 'status' per line, recording the real from->to transition.
// The bug: the events INSERT ran a SELECT ... WHERE status IS DISTINCT FROM
// $new AFTER the UPDATE set every line to $new, so zero rows were ever
// inserted and the entire advance audit trail was silently empty.

describe('POST /api/orders/:id/advance — writes status audit events', () => {
  beforeEach(async () => { await resetDb(); });

  it('records a status event with the true from->to on advance', async () => {
    const { token } = await loginAs(MARCUS);

    const pn = 'ADV-AUDIT-1';
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM',
        lines: [{
          category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
          classification: 'RDIMM', speed: '3200',
          partNumber: pn, condition: 'Pulled — Tested', qty: 4, unitCost: 78.5,
        }],
      },
    });
    expect(created.status).toBe(201);

    const adv = await api('POST', `/api/orders/${created.body.id}/advance`, { token });
    expect(adv.status).toBe(200);

    const ev = await api<{ events: Array<{ kind: string; detail: { field?: string; from?: string; to?: string } }> }>(
      'GET', `/api/inventory/events/by-part?partNumber=${encodeURIComponent(pn)}`, { token });
    expect(ev.status).toBe(200);

    const statusEvents = ev.body.events.filter(e => e.kind === 'status');
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
    const e = statusEvents[0];
    expect(e.detail.field).toBe('status');
    expect(e.detail.from).toBe('Draft');
    expect(e.detail.to).toBe('In Transit');
  });
});
