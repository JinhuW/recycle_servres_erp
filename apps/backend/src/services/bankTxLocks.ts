import type { SqlLike } from '../db';

// Every write to a payment locks all of its legs first, and validates on what
// it locked. The Payments routes read a leg's group, judge it (not paired,
// not linked, not ignored…) and then write — and nothing between the read and
// the write stopped a rival from pairing, linking or ignoring the same leg in
// the meantime: two pairs of one Mercury leg both returned 200 and left a
// PayPal leg alone under a pair_id, and a link racing an ignore produced a
// payment that was both. The group is expanded from the pair as it stands;
// a leg paired by a rival between the expansion and the lock shows up as a
// member that was not locked, so the expansion runs again under the locks it
// holds until it is closed.
//
// FOR NO KEY UPDATE, in id order, one statement: the same shape as
// services/orderLocks.ts, so two writers naming the same legs cannot
// deadlock. Returns the locked ids.
export async function lockBankGroupTx(tx: SqlLike, ids: readonly string[]): Promise<string[]> {
  let want = [...new Set(ids)].sort();
  if (want.length === 0) return [];
  for (let round = 0; round < 4; round++) {
    const locked = await tx<{ id: string }[]>`
      SELECT id FROM bank_transactions
      WHERE id = ANY(${want}::uuid[])
         OR pair_id IN (SELECT pair_id FROM bank_transactions
                        WHERE id = ANY(${want}::uuid[]) AND pair_id IS NOT NULL)
      ORDER BY id
      FOR NO KEY UPDATE
    `;
    const have = new Set(locked.map((r) => r.id));
    const members = await tx<{ id: string }[]>`
      SELECT id FROM bank_transactions
      WHERE id = ANY(${[...have]}::uuid[])
         OR pair_id IN (SELECT pair_id FROM bank_transactions
                        WHERE id = ANY(${[...have]}::uuid[]) AND pair_id IS NOT NULL)
    `;
    if (members.every((m) => have.has(m.id))) return [...have].sort();
    want = [...new Set([...have, ...members.map((m) => m.id)])].sort();
  }
  throw new Error('bank transaction group kept changing while locking it');
}
