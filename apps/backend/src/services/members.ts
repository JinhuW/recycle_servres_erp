// Persistence + business logic for team members. No HTTP concerns here —
// callers pass in the `sql` client returned by `getDb(env)` so the same
// functions are usable from routes, scripts, or tests.

import type { Sql } from 'postgres';
import { hashPassword, generateTempPassword, revokeUserRefreshTokens } from '../auth';

export type MemberRole = 'manager' | 'purchaser';

export interface MemberSummary {
  id: string;
  email: string;
  name: string;
  initials: string;
  role: MemberRole;
  team: string | null;
  phone: string | null;
  title: string | null;
  active: boolean;
  created_at: Date;
  last_seen_at: Date | null;
  order_count: number;
  lifetime_profit: number;
}

export interface ListMembersOptions {
  includeInactive?: boolean;
}

export interface CreateMemberInput {
  email: string;
  name: string;
  role: MemberRole;
  team?: string;
  phone?: string;
  title?: string;
  password?: string;
}

export interface UpdateMemberInput {
  name?: string;
  team?: string;
  phone?: string;
  title?: string;
  role?: MemberRole;
  active?: boolean;
  password?: string;
}

function initialsFor(name: string): string {
  return (
    name
      .split(/\s+/)
      .map(s => s[0]?.toUpperCase() ?? '')
      .join('')
      .slice(0, 2) || 'NA'
  );
}

export async function listMembers(
  sql: Sql,
  opts: ListMembersOptions = {},
): Promise<MemberSummary[]> {
  const activeFilter = opts.includeInactive ? sql`TRUE` : sql`u.active = TRUE`;
  // lifetime_profit: realized revenue from sell_order_lines of Done sell orders,
  // attributed to the purchaser who created the source order (order_lines → orders).
  // Uses a scalar subquery to avoid inflating order_count via the sell-side joins.
  const rows = await sql`
    SELECT u.id, u.email, u.name, u.initials, u.role, u.team, u.phone, u.title,
           u.active, u.created_at,
           u.last_seen_at,
           COUNT(DISTINCT o.id)::int AS order_count,
           COALESCE((
             SELECT SUM((sol.unit_price - ol.unit_cost) * sol.qty)
             FROM orders po
             JOIN order_lines ol ON ol.order_id = po.id
             JOIN sell_order_lines sol ON sol.inventory_id = ol.id
             JOIN sell_orders so ON so.id = sol.sell_order_id AND so.status = 'Done'
             WHERE po.user_id = u.id
           ), 0)::float AS lifetime_profit
    FROM users u
    LEFT JOIN orders o ON o.user_id = u.id
    WHERE ${activeFilter}
    GROUP BY u.id
    ORDER BY u.role DESC, u.name
  `;
  return rows as unknown as MemberSummary[];
}

// Returns the plaintext password the caller can share with the new member.
// Equal to `input.password` when supplied, otherwise a freshly generated
// temporary password. The caller is expected to surface this to the inviting
// manager once — it is not retrievable after creation.
export async function createMember(
  sql: Sql,
  input: CreateMemberInput,
): Promise<{ id: string; password: string }> {
  const password = input.password || generateTempPassword();
  const hash = await hashPassword(password);
  const initials = initialsFor(input.name);
  const r = await sql`
    INSERT INTO users (email, name, initials, role, team, phone, title, password_hash)
    VALUES (
      ${input.email.toLowerCase()}, ${input.name}, ${initials}, ${input.role},
      ${input.team ?? null}, ${input.phone ?? null}, ${input.title ?? null}, ${hash}
    )
    RETURNING id
  `;
  return { id: (r[0] as { id: string }).id, password };
}

export async function updateMember(
  sql: Sql,
  id: string,
  input: UpdateMemberInput,
): Promise<void> {
  if (input.password) {
    // Password change + token revoke must be atomic: either both land or
    // neither does. A crash between the two would leave old (possibly stolen)
    // tokens live against the new password.
    const hash = await hashPassword(input.password);
    await sql.begin(async (tx) => {
      await tx`
        UPDATE users SET
          name            = COALESCE(${input.name ?? null},            name),
          team            = COALESCE(${input.team ?? null},            team),
          phone           = COALESCE(${input.phone ?? null},           phone),
          title           = COALESCE(${input.title ?? null},           title),
          role            = COALESCE(${input.role ?? null},            role),
          active          = COALESCE(${input.active ?? null},          active),
          password_hash   = ${hash}
        WHERE id = ${id}
      `;
      // A password reset must invalidate any existing (possibly stolen)
      // refresh tokens, mirroring deactivateMember's revoke.
      await revokeUserRefreshTokens(tx, id);
    });
  } else {
    await sql`
      UPDATE users SET
        name            = COALESCE(${input.name ?? null},            name),
        team            = COALESCE(${input.team ?? null},            team),
        phone           = COALESCE(${input.phone ?? null},           phone),
        title           = COALESCE(${input.title ?? null},           title),
        role            = COALESCE(${input.role ?? null},            role),
        active          = COALESCE(${input.active ?? null},          active)
      WHERE id = ${id}
    `;
  }
}

export async function getMemberStatus(
  sql: Sql,
  id: string,
): Promise<{ role: MemberRole; active: boolean } | null> {
  const r = await sql`SELECT role, active FROM users WHERE id = ${id}`;
  if (r.length === 0) return null;
  const row = r[0] as { role: MemberRole; active: boolean };
  return { role: row.role, active: row.active };
}

// Number of active managers other than the given id. Used by the soft-delete
// safeguard so we don't deactivate the last manager.
export async function countOtherActiveManagers(sql: Sql, exceptId: string): Promise<number> {
  const r = await sql`
    SELECT COUNT(*)::int AS n FROM users
    WHERE role = 'manager' AND active = TRUE AND id <> ${exceptId}
  `;
  return (r[0] as { n: number }).n;
}

// Soft-delete. Returns true if a row was updated, false if no such user.
export async function deactivateMember(sql: Sql, id: string): Promise<boolean> {
  let updated = false;
  // Wrap deactivation + token revoke in a single transaction so they are
  // always consistent: a crash between the two would leave a deactivated
  // user whose refresh tokens can still mint new access tokens.
  await sql.begin(async (tx) => {
    const r = await tx`UPDATE users SET active = FALSE WHERE id = ${id} RETURNING id`;
    if (r.length === 0) return; // no such user — nothing to revoke
    updated = true;
    // Close the refresh path immediately so they can't mint new access tokens.
    // (Their current short-lived access token still expires naturally <=15 min.)
    await revokeUserRefreshTokens(tx, id);
  });
  return updated;
}
