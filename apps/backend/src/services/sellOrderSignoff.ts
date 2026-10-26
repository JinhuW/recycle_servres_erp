import type postgres from 'postgres';
import type { SqlLike } from '../db';

type SqlFragment = postgres.PendingQuery<postgres.Row[]>;

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
    SELECT ${fingerprintSql(tx, tx`so`)} AS fp
    FROM sell_orders so
    WHERE so.id = ${sellOrderId}
  `;
  return row?.fp ?? null;
}

/** orderFingerprint as an expression over a `sell_orders` alias, for a reader
 *  that asks "who still has to sign" of many orders in one query. */
export function fingerprintSql(sql: SqlLike, soAlias: SqlFragment): SqlFragment {
  return sql`md5(jsonb_build_array(
    ${soAlias}.customer_id, ${soAlias}.currency_code,
    COALESCE((
      SELECT jsonb_agg(l.x ORDER BY l.x::text)
      FROM (
        SELECT jsonb_build_array(
          sol.category, sol.label, sol.sub_label, sol.part_number, sol.condition, sol.qty,
          COALESCE(sol.source_unit_price, sol.unit_price),
          CASE WHEN sol.qty > 0 THEN sol.inventory_id END
        ) AS x
        FROM sell_order_lines sol
        WHERE sol.sell_order_id = ${soAlias}.id
      ) l
    ), '[]'::jsonb)
  )::text)`;
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

export type SignoffState = {
  managers: SignoffManager[];
  complete: boolean;
  // The order as it stands. Signing sends back the one the manager reviewed.
  fingerprint: string;
};

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
  return { managers, complete: missingSigners(managers).length === 0, fingerprint: fp ?? '' };
}

export function missingSigners(managers: readonly SignoffManager[]): SignoffManager[] {
  return managers.filter(m => m.required && (m.signedAt === null || m.stale));
}
