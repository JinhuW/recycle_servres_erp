// A durable budget for password guesses, shared by login and the signed-in
// password change. The attempt is reserved — a NULL-success row — BEFORE the
// count, so concurrent guesses count against one another; counting first let
// a whole burst pass before any was recorded. The reservation is settled once
// bcrypt answers, or deleted if the request is refused or fails first, so a
// refusal never lengthens the lockout.
//
// An email or address already locked is refused on a read alone, before any
// reservation: a flood against it would otherwise cost an insert, a count and
// a delete per request, for an answer that is already known.
import type { SqlLike } from '../db';
import type { ClientIp } from './clientIp';
import { log } from './log';

export const FAILED_LIMIT = 5;
export const IP_FAILED_LIMIT = 30;

export type AttemptReservation =
  | { locked: true }
  | { locked: false; settle: (success: boolean) => Promise<void>; release: () => Promise<void> };

export async function reserveAttempt(
  sql: SqlLike,
  who: { email: string; ip: ClientIp; ipKnown: boolean },
): Promise<AttemptReservation> {
  const { email, ip, ipKnown } = who;
  // Failures per email since its last success in the window, and per address
  // across any email. The address budget applies only when the Worker named
  // one caller (X-Client-IP); otherwise every request shares a Cloudflare
  // egress address and a per-address budget would lock everyone out together.
  const locked = async (excludeId: string | null): Promise<boolean> => {
    const [{ fails, ipFails }] = await sql<{ fails: number; ipFails: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM login_attempts
          WHERE email = ${email} AND success IS NOT TRUE
            AND (${excludeId}::bigint IS NULL OR id <> ${excludeId}::bigint)
            AND attempted_at > NOW() - INTERVAL '15 minutes'
            AND attempted_at > COALESCE(
              (SELECT MAX(attempted_at) FROM login_attempts
                WHERE email = ${email} AND success = TRUE),
              'epoch'::timestamptz)) AS fails,
        (SELECT COUNT(*)::int FROM login_attempts
          WHERE ${ipKnown} AND ip_key = ${ip.key} AND success IS NOT TRUE
            AND (${excludeId}::bigint IS NULL OR id <> ${excludeId}::bigint)
            AND attempted_at > NOW() - INTERVAL '15 minutes') AS "ipFails"
    `;
    return fails >= FAILED_LIMIT || ipFails >= IP_FAILED_LIMIT;
  };
  if (await locked(null)) return { locked: true };

  const [{ id: attemptId }] = await sql<{ id: string }[]>`
    INSERT INTO login_attempts (email, ip, ip_key, success)
    VALUES (${email}, ${ip.full}, ${ip.key}, NULL)
    RETURNING id
  `;
  let settled = false;
  const release = async () => {
    if (settled) return;
    settled = true;
    await sql`DELETE FROM login_attempts WHERE id = ${attemptId}`
      .catch((e) => log.error('login_attempts cleanup failed', e));
  };
  if (await locked(attemptId)) {
    await release();
    return { locked: true };
  }
  // A failed write leaves `settled` false, so release deletes the reservation
  // instead of leaving a NULL row that counts as a failure.
  const settle = async (success: boolean) => {
    if (settled) return;
    await sql`UPDATE login_attempts SET success = ${success} WHERE id = ${attemptId}`
      .then(() => { settled = true; })
      .catch((e) => log.error('login_attempts write failed', e));
  };
  return { locked: false, settle, release };
}
