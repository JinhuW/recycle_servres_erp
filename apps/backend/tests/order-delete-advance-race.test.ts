import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';

// M5a regression: DELETE /orders/:id read lifecycle + the sell-order guard
// OUTSIDE any transaction, and POST /:id/advance read lifecycle outside its
// tx too. Concurrently they could both act on a stale 'draft' read, deleting
// an order that was simultaneously advanced. Both now lock the orders row
// FOR UPDATE inside their tx, so exactly one wins and the invariant holds:
// an order is NEVER both successfully advanced AND deleted.

async function makeDraft(token: string): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      category: 'RAM',
      lines: [{ category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
        classification: 'RDIMM', speed: '3200', partNumber: 'RACE-1',
        condition: 'Pulled — Tested', qty: 1, unitCost: 50 }],
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

describe('DELETE vs advance race on a Draft order', () => {
  beforeEach(async () => { await resetDb(); });

  it('never leaves an order both advanced and deleted (and never 500s)', async () => {
    const { token } = await loginAs(MARCUS);

    for (let i = 0; i < 8; i++) {
      const id = await makeDraft(token);
      const [adv, del] = await Promise.all([
        api('POST', `/api/orders/${id}/advance`, { token }),
        api('DELETE', `/api/orders/${id}`, { token }),
      ]);

      // No request may blow up with an unhandled 500.
      expect(adv.status).not.toBe(500);
      expect(del.status).not.toBe(500);

      const get = await api(`GET`, `/api/orders/${id}`, { token });
      const gone = get.status === 404;

      // The core invariant: a successful advance must not coexist with the
      // order having been deleted.
      if (adv.status === 200) expect(gone).toBe(false);
      // And if it was deleted, the advance must not have reported success.
      if (gone) expect(adv.status).not.toBe(200);
    }
  });
});
