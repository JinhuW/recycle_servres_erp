// Tests for atomicity and realized-profit basis in members service.

import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { issueRefresh, rotateRefresh } from '../src/auth';
import { deactivateMember, updateMember } from '../src/services/members';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

// ── Fix 4a: deactivateMember atomicity ──────────────────────────────────────

describe('deactivateMember — atomic deactivation + token revoke', () => {
  beforeAll(async () => { await resetDb(); });

  it('revokes refresh tokens in the same operation as deactivation', async () => {
    const db = getTestDb();
    const uid = (await db<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;

    const { raw } = await issueRefresh(db, uid);
    // Sanity: token rotates before deactivation.
    expect((await rotateRefresh(db, raw)).ok).toBe(true);

    // Issue a fresh token, then deactivate.
    const { raw: raw2 } = await issueRefresh(db, uid);
    const result = await deactivateMember(db, uid);
    expect(result).toBe(true);

    // The refresh token issued before deactivation must now be revoked.
    expect((await rotateRefresh(db, raw2)).ok).toBe(false);
  });

  it('returns false for an unknown user id and revokes nothing', async () => {
    const db = getTestDb();
    const result = await deactivateMember(db, '00000000-0000-0000-0000-000000000000');
    expect(result).toBe(false);
  });
});

// ── Fix 4b: updateMember password change atomicity ───────────────────────────

describe('updateMember password change — atomic update + token revoke', () => {
  beforeAll(async () => { await resetDb(); });

  it('invalidates existing refresh tokens when the password is changed', async () => {
    const db = getTestDb();
    const uid = (await db<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;

    const { raw } = await issueRefresh(db, uid);
    await updateMember(db, uid, { password: 'a-new-password-123' });

    // Token issued before the password change must now be revoked.
    expect((await rotateRefresh(db, raw)).ok).toBe(false);
  });

  it('does not revoke tokens for a metadata-only update', async () => {
    const db = getTestDb();
    const uid = (await db<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;

    const { raw } = await issueRefresh(db, uid);
    await updateMember(db, uid, { title: 'Senior Buyer' });

    expect((await rotateRefresh(db, raw)).ok).toBe(true);
  });
});

// ── Fix 5: lifetime_profit uses realized sell revenue ───────────────────────

describe('GET /api/members — lifetime_profit is realized (not projected)', () => {
  beforeAll(async () => { await resetDb(); });

  it('is 0 for a purchaser with no Done sell orders, even if PO lines have sell_price', async () => {
    const db = getTestDb();
    // Wipe any seeded sell orders to make this deterministic.
    await db`DELETE FROM sell_order_lines`;
    await db`DELETE FROM sell_orders`;

    const { token } = await loginAs(ALEX);
    const r = await api<{ items: { email: string; lifetime_profit: number }[] }>(
      'GET', '/api/members', { token },
    );
    expect(r.status).toBe(200);
    const marcus = r.body.items.find(m => m.email === MARCUS)!;
    expect(marcus).toBeDefined();
    // PO lines with sell_price still exist, but realized profit must be 0.
    expect(marcus.lifetime_profit).toBe(0);
  });

  it('reflects only Done sell-order revenue, not PO-side sell_price projection', async () => {
    const db = getTestDb();
    await db`DELETE FROM sell_order_lines`;
    await db`DELETE FROM sell_orders`;

    // Pick one of MARCUS's sellable PO lines.
    const line = (await db<{ id: string; unit_cost: string }[]>`
      SELECT ol.id, ol.unit_cost
      FROM order_lines ol
      JOIN orders po ON po.id = ol.order_id
      JOIN users u   ON u.id  = po.user_id
      WHERE u.email = ${MARCUS}
        AND ol.status IN ('Reviewing','Done') AND ol.qty > 0 AND ol.sell_price IS NOT NULL
      LIMIT 1
    `)[0];
    expect(line, 'expected at least one sellable Marcus line in seed').toBeTruthy();

    const UNIT_PRICE = 1234.00;
    const customerId = (await db<{ id: string }[]>`SELECT id FROM customers LIMIT 1`)[0].id;
    const soId = 'SL-MEMBERS-PROFIT-1';
    await db`
      INSERT INTO sell_orders (id, customer_id, status, created_by, created_at, updated_at)
      VALUES (${soId}, ${customerId}, 'Done',
              (SELECT id FROM users WHERE email = ${MARCUS}), NOW(), NOW())
    `;
    await db`
      INSERT INTO sell_order_lines (sell_order_id, inventory_id, category, label, qty, unit_price, position)
      VALUES (${soId}, ${line.id}, 'RAM', 'x', 1, ${UNIT_PRICE}, 0)
    `;

    const { token } = await loginAs(ALEX);
    const r = await api<{ items: { email: string; lifetime_profit: number }[] }>(
      'GET', '/api/members', { token },
    );
    expect(r.status).toBe(200);
    const marcus = r.body.items.find(m => m.email === MARCUS)!;
    const expectedProfit = UNIT_PRICE - Number(line.unit_cost);
    expect(marcus.lifetime_profit).toBeCloseTo(expectedProfit, 2);
  });
});
