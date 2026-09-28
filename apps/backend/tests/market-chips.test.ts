import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

// The part number → chip # map is learnt from past PO lines: the capture
// screens ask it for a part # and fill a blank chip # with the answer, so a
// chip marking is typed once per part number instead of once per line.

type ChipsBody = { items: Record<string, string> };

// Part numbers the seed never uses, so its lines can't vote.
const PN = 'ZZTEST-CHIPMAP-01';

async function createPo(token: string, lines: Array<{ partNumber: string; chipNumber?: string }>): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      category: 'RAM',
      lines: lines.map(l => ({
        category: 'RAM', brand: 'Micron', capacity: '32GB', type: 'DDR4',
        classification: 'RDIMM', speed: '3200', condition: 'Pulled — Tested',
        qty: 1, unitCost: 50, ...l,
      })),
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

function chips(token: string, partNumbers: unknown) {
  return api<ChipsBody>('POST', '/api/market/chips', { token, body: { partNumbers } });
}

describe('POST /api/market/chips', () => {
  beforeEach(async () => { await resetDb(); });

  it('answers the chip recorded on the most POs, keyed by the asked spelling', async () => {
    const { token } = await loginAs(ALEX);
    await createPo(token, [{ partNumber: PN, chipNumber: 'D9XPF' }]);
    await createPo(token, [{ partNumber: 'zztest chipmap 01', chipNumber: 'D9XPF' }]);
    await createPo(token, [{ partNumber: PN, chipNumber: 'D9ZZZ' }]);

    const r = await chips(token, ['zztest_chipmap-01', 'ZZTEST-UNKNOWN-99']);
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual({ 'zztest_chipmap-01': 'D9XPF' });
  });

  it('counts a PO once however many rows carry the part', async () => {
    const { token } = await loginAs(ALEX);
    await createPo(token, [
      { partNumber: PN, chipNumber: 'SPLIT' },
      { partNumber: PN, chipNumber: 'SPLIT' },
      { partNumber: PN, chipNumber: 'SPLIT' },
    ]);
    await createPo(token, [{ partNumber: PN, chipNumber: 'MAJOR' }]);
    await createPo(token, [{ partNumber: PN, chipNumber: 'MAJOR' }]);

    const r = await chips(token, [PN]);
    expect(r.body.items[PN]).toBe('MAJOR');
  });

  it('breaks a tie with the most recent line', async () => {
    const { token } = await loginAs(ALEX);
    await createPo(token, [{ partNumber: PN, chipNumber: 'OLDER' }]);
    await createPo(token, [{ partNumber: PN, chipNumber: 'NEWER' }]);
    await getTestDb()`
      UPDATE order_lines SET created_at = NOW() - INTERVAL '1 day'
       WHERE part_number = ${PN} AND chip_number = 'OLDER'
    `;

    const r = await chips(token, [PN]);
    expect(r.body.items[PN]).toBe('NEWER');
  });

  it('ignores blank chips and archived POs', async () => {
    const { token } = await loginAs(ALEX);
    await createPo(token, [{ partNumber: PN }]);
    const archived = await createPo(token, [{ partNumber: PN, chipNumber: 'GONE' }]);
    await getTestDb()`UPDATE orders SET archived_at = NOW() WHERE id = ${archived}`;

    const r = await chips(token, [PN]);
    expect(r.body.items).toEqual({});
  });

  it('is workspace-wide: a purchaser learns from another user\'s PO', async () => {
    const alex = await loginAs(ALEX);
    await createPo(alex.token, [{ partNumber: PN, chipNumber: 'D9XPF' }]);

    const marcus = await loginAs(MARCUS);
    const r = await chips(marcus.token, [PN]);
    expect(r.status).toBe(200);
    expect(r.body.items[PN]).toBe('D9XPF');
  });

  it('rejects a malformed body and an oversized batch', async () => {
    const { token } = await loginAs(ALEX);
    expect((await chips(token, 'nope')).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `ZZ-${i}`);
    expect((await chips(token, many)).status).toBe(413);
  });
});
