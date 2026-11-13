import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  FB_CHAT_DEVICE_BEARER_PREFIX,
  type FbChatDeviceApproval,
  type FbChatDeviceRow,
  type FbChatDeviceStatus,
  type FbChatEnrollAnswer,
} from '@recycle-erp/shared';
import type postgres from 'postgres';
import type { SqlLike } from '../db';

// ─── Chat bridge devices ─────────────────────────────────────────────
// Each extension enrolls itself and waits for a manager's approval. The token
// is minted here and only its sha256 is kept, as with fleet host tokens. The
// enroll route is open to anyone, so it is bounded per address and overall,
// and a request nobody acts on is forgotten after a week.

/** Enrollments one address may make in an hour. */
export const ENROLL_PER_IP_HOUR = 5;
/** Waiting requests the list holds; past this the route answers 429. */
export const ENROLL_MAX_PENDING = 25;
/** A pending request not heard from in this long is deleted. */
export const PENDING_FORGET_DAYS = 7;

// No 0/O, 1/I/L: the code is read off one screen and compared with another.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

function pairingCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export type DeviceInfo = {
  label: string | null;
  extVersion: string | null;
  fbUid: string | null;
};

export type EnrollOrigin = { ip: string | null; ipKey: string; userAgent: string | null };

export type EnrollOutcome = FbChatEnrollAnswer | 'ip_limit' | 'pending_limit';

/** Records a pending device and hands back its one-time token. */
export async function enrollDevice(sql: SqlLike, info: DeviceInfo, origin: EnrollOrigin): Promise<EnrollOutcome> {
  await sql`
    DELETE FROM fb_chat_devices
     WHERE status = 'pending' AND last_seen_at < NOW() - make_interval(days => ${PENDING_FORGET_DAYS})`;
  const [counts] = await sql<{ from_ip: number; pending: number }[]>`
    SELECT (SELECT COUNT(*)::int FROM fb_chat_devices
             WHERE ip_key = ${origin.ipKey} AND created_at > NOW() - INTERVAL '1 hour') AS from_ip,
           (SELECT COUNT(*)::int FROM fb_chat_devices WHERE status = 'pending') AS pending`;
  if (counts!.from_ip >= ENROLL_PER_IP_HOUR) return 'ip_limit';
  if (counts!.pending >= ENROLL_MAX_PENDING) return 'pending_limit';

  const deviceId = randomBytes(9).toString('hex');
  const token = randomBytes(32).toString('base64url');
  const code = pairingCode();
  await sql`
    INSERT INTO fb_chat_devices
      (id, token_hash, code, label, fb_uid, ext_version, created_ip, ip_key, user_agent)
    VALUES
      (${deviceId}, ${sha256hex(token)}, ${code}, ${info.label ?? ''}, ${info.fbUid}, ${info.extVersion},
       ${origin.ip}, ${origin.ipKey}, ${origin.userAgent})`;
  return { deviceId, token, code, status: 'pending' };
}

/** True when the header's bearer is a device's rather than an OAuth token. */
export function isDeviceBearer(header: string | undefined): boolean {
  return /^bearer\s+/i.test(header ?? '') && header!.replace(/^bearer\s+/i, '').startsWith(FB_CHAT_DEVICE_BEARER_PREFIX);
}

export type DeviceRow = { id: string; code: string; status: FbChatDeviceStatus };

/** The device a `fbd_<id>_<token>` bearer names, or null when it names none. */
export async function deviceForBearer(sql: SqlLike, header: string): Promise<DeviceRow | null> {
  const bearer = header.replace(/^bearer\s+/i, '').trim();
  const m = /^fbd_([0-9a-f]{18})_([A-Za-z0-9_-]{43})$/.exec(bearer);
  if (!m) return null;
  const [row] = await sql<DeviceRow[]>`
    SELECT id, code, status FROM fb_chat_devices
     WHERE id = ${m[1]!} AND token_hash = ${sha256hex(m[2]!)}`;
  return row ?? null;
}

/** Notes the device was heard from, and what it now says about itself. */
export async function helloDevice(sql: SqlLike, id: string, info: DeviceInfo): Promise<void> {
  await sql`
    UPDATE fb_chat_devices SET
      last_seen_at = NOW(),
      label = COALESCE(${info.label}, label),
      fb_uid = COALESCE(${info.fbUid}, fb_uid),
      ext_version = COALESCE(${info.extVersion}, ext_version)
     WHERE id = ${id}`;
}

/** Marks an approved device seen, at most once a minute, from the push routes. */
export async function touchDevice(sql: SqlLike, id: string): Promise<void> {
  await sql`
    UPDATE fb_chat_devices SET last_seen_at = NOW()
     WHERE id = ${id} AND last_seen_at < NOW() - INTERVAL '1 minute'`;
}

export async function listDevices(sql: SqlLike): Promise<FbChatDeviceRow[]> {
  // matches_account: the Facebook user is an account the hub already has, so
  // approving this Chrome reconnects that account rather than adding one.
  return sql<FbChatDeviceRow[]>`
    SELECT d.id, d.code, d.status, d.label, d.fb_uid, d.ext_version, d.created_ip, d.user_agent,
           d.created_at, d.last_seen_at, u.name AS decided_by, d.decided_at,
           CASE WHEN a.id IS NULL THEN NULL
                ELSE jsonb_build_object('id', a.id::int, 'no', a.no, 'label', a.label) END AS matches_account
      FROM fb_chat_devices d LEFT JOIN users u ON u.id = d.decided_by
      LEFT JOIN fb_chat_accounts a ON a.fb_uid = d.fb_uid
     ORDER BY (d.status = 'pending') DESC, d.created_at DESC`;
}

export type DeviceDecision = 'approve' | 'reject' | 'revoke';

const DECISIONS: Record<DeviceDecision, { to: FbChatDeviceStatus; from: FbChatDeviceStatus[] }> = {
  approve: { to: 'approved', from: ['pending', 'rejected', 'revoked'] },
  reject: { to: 'rejected', from: ['pending'] },
  revoke: { to: 'revoked', from: ['approved'] },
};

/** Applies a manager's decision. False when the device is not in a state it applies to. */
export async function decideDevice(sql: SqlLike, id: string, decision: DeviceDecision, userId: string): Promise<boolean> {
  const { to, from } = DECISIONS[decision];
  const rows = await sql`
    UPDATE fb_chat_devices SET status = ${to}, decided_by = ${userId}, decided_at = NOW()
     WHERE id = ${id} AND status = ANY(${from})
     RETURNING id`;
  return rows.length > 0;
}

/**
 * Approves a device. When its Facebook user is an account the hub already
 * has, this Chrome takes that account over: the one relaying it until now is
 * revoked, and the name and pause asked for are dropped, since the account
 * keeps its own. Otherwise they wait on the device for the account's first
 * push (services/fbChat.ts → touchAccount). False when it cannot be approved.
 */
export async function approveDevice(
  tx: postgres.TransactionSql, id: string, approval: FbChatDeviceApproval, userId: string,
): Promise<boolean> {
  const [device] = await tx<{ fb_uid: string | null }[]>`
    SELECT fb_uid FROM fb_chat_devices
     WHERE id = ${id} AND status = ANY(${DECISIONS.approve.from}) FOR UPDATE`;
  if (!device) return false;
  const [account] = device.fb_uid === null ? [] : await tx<{ id: number; client_id: string | null }[]>`
    SELECT id::int AS id, client_id FROM fb_chat_accounts WHERE fb_uid = ${device.fb_uid} FOR UPDATE`;
  const clientId = `device:${id}`;
  if (account) {
    await tx`
      UPDATE fb_chat_devices SET status = 'revoked', decided_by = ${userId}, decided_at = NOW()
       WHERE 'device:' || id = ${account.client_id} AND id <> ${id} AND status = 'approved'`;
    await tx`UPDATE fb_chat_accounts SET client_id = ${clientId} WHERE id = ${account.id}`;
  }
  await tx`
    UPDATE fb_chat_devices SET
      status = 'approved', decided_by = ${userId}, decided_at = NOW(),
      account_label = ${account ? null : approval.label ?? null},
      start_paused = ${account ? false : approval.startPaused ?? false}
     WHERE id = ${id}`;
  return true;
}

/** Forgets a device. Its extension, if still running, enrolls again. */
export async function deleteDevice(sql: SqlLike, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM fb_chat_devices WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}
