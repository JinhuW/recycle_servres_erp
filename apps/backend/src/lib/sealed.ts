import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { Env } from '../types';

// Reversible encryption for third-party credentials the app has to hand back
// in clear (the Facebook pool's passwords, 2FA keys and cookies). Everything
// else the database holds is hashed; these can't be, so they get their own
// key, separate from JWT_SECRET, which rotates freely and must not take the
// stored logins with it.

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';

/**
 * The pool's key, or null when production has none: the routes then refuse
 * with 503 rather than the boot failing, because an unset key only disables
 * this one feature. Outside production the key is derived from JWT_SECRET so
 * dev, CI and the test suite need no extra variable.
 */
export function poolKey(env: Env): Buffer | null {
  const raw = env.FB_POOL_KEY?.trim();
  if (raw) return Buffer.from(raw, 'hex');
  if (env.NODE_ENV === 'production') return null;
  return Buffer.from(hkdfSync('sha256', env.JWT_SECRET, '', 'fb-pool', 32));
}

export function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), body]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

export function unseal(blob: string, key: Buffer): string {
  const parts = blob.split('.');
  // An empty secret seals to an empty body, so only the count is checked.
  if (parts.length !== 4 || parts[0] !== VERSION || !parts[1] || !parts[2]) {
    throw new Error('Unrecognised sealed value');
  }
  const [, iv, tag, body] = parts;
  const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}

/** Empty strings are stored as NULL, so a blank secret costs no ciphertext. */
export const sealOrNull = (plain: string, key: Buffer): string | null =>
  plain ? seal(plain, key) : null;

export const unsealOrEmpty = (blob: string | null, key: Buffer): string =>
  blob === null ? '' : unseal(blob, key);
