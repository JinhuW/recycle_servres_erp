import type { SqlLike } from '../db';

// Done needs a sign-off from every active manager, on the order as it stands.

// What a sign-off approves: who the order sells to, in which currency, and
// what each line sells — the item, the qty, the native price and the lot it
// comes from. A row counts only while this still matches, so an edit voids
// earlier sign-offs without the writer knowing they exist.
//
// Lines are sorted by content, not position, so a save that resends the same
// lines keeps the hash, and priced natively, so a re-save at a new FX rate
// does too. A line held at 0 drops its lot: removing the PO line it names
// nulls it, and that sells nothing different. The warehouse is left out —
// a transfer moves where the goods ship from, not the deal.
export async function orderFingerprint(tx: SqlLike, sellOrderId: string): Promise<string | null> {
  const [row] = await tx<{ fp: string }[]>`
    SELECT md5(jsonb_build_array(
      so.customer_id, so.currency_code,
      COALESCE((
        SELECT jsonb_agg(l.x ORDER BY l.x::text)
        FROM (
          SELECT jsonb_build_array(
            sol.category, sol.label, sol.sub_label, sol.part_number, sol.condition, sol.qty,
            COALESCE(sol.source_unit_price, sol.unit_price),
            CASE WHEN sol.qty > 0 THEN sol.inventory_id END
          ) AS x
          FROM sell_order_lines sol
          WHERE sol.sell_order_id = so.id
        ) l
      ), '[]'::jsonb)
    )::text) AS fp
    FROM sell_orders so
    WHERE so.id = ${sellOrderId}
  `;
  return row?.fp ?? null;
}

export type SignoffManager = {
  id: string;
  name: string;
  // An active manager. Anyone else listed signed before they stopped being one,
  // which an order already Done keeps as its record.
  required: boolean;
  signedAt: string | null;
  // Signed, but the order has changed since.
  stale: boolean;
};

export type SignoffState = { managers: SignoffManager[]; complete: boolean };

export async function signoffState(tx: SqlLike, sellOrderId: string): Promise<SignoffState> {
  const fp = await orderFingerprint(tx, sellOrderId);
  const rows = await tx<{
    id: string; name: string; required: boolean; signed_at: string | null; fingerprint: string | null;
  }[]>`
    SELECT u.id, u.name, (u.role = 'manager' AND u.active = TRUE) AS required,
           s.signed_at, s.fingerprint
    FROM users u
    LEFT JOIN sell_order_signoffs s ON s.user_id = u.id AND s.sell_order_id = ${sellOrderId}
    WHERE (u.role = 'manager' AND u.active = TRUE) OR s.user_id IS NOT NULL
    ORDER BY u.name, u.id
  `;
  const managers = rows.map((r): SignoffManager => ({
    id: r.id,
    name: r.name,
    required: r.required,
    signedAt: r.signed_at,
    stale: r.fingerprint !== null && r.fingerprint !== fp,
  }));
  return { managers, complete: missingSigners(managers).length === 0 };
}

export function missingSigners(managers: readonly SignoffManager[]): SignoffManager[] {
  return managers.filter(m => m.required && (m.signedAt === null || m.stale));
}
