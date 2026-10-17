import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { poolKey, seal, sealOrNull, unseal, unsealOrEmpty } from '../src/lib/sealed';
import type { Env } from '../src/types';

const env = (over: Partial<Env>): Env =>
  ({ JWT_SECRET: 'test-secret-that-is-long-enough-for-hkdf', ...over }) as Env;

describe('sealed credentials', () => {
  const key = randomBytes(32);

  it('round-trips text and never repeats a ciphertext', () => {
    const a = seal('DemoOnly!1', key);
    const b = seal('DemoOnly!1', key);
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.')).toBe(true);
    expect(unseal(a, key)).toBe('DemoOnly!1');
    expect(unseal(b, key)).toBe('DemoOnly!1');
    expect(unseal(seal('', key), key)).toBe('');
    expect(unseal(seal('c_user=61556203481174; xs=ü∆', key), key)).toBe('c_user=61556203481174; xs=ü∆');
  });

  it('refuses a tampered blob, the wrong key and an unknown format', () => {
    const blob = seal('secret', key);
    const [v, iv, tag, body] = blob.split('.');
    const flipped = body[0] === 'A' ? 'B' : 'A';
    expect(() => unseal([v, iv, tag, flipped + body.slice(1)].join('.'), key)).toThrow();
    expect(() => unseal(blob, randomBytes(32))).toThrow();
    expect(() => unseal('v0.x.y.z', key)).toThrow(/Unrecognised/);
    expect(() => unseal('not a blob', key)).toThrow(/Unrecognised/);
  });

  it('maps blank secrets to NULL and back', () => {
    expect(sealOrNull('', key)).toBeNull();
    expect(unsealOrEmpty(null, key)).toBe('');
    expect(unsealOrEmpty(sealOrNull('x', key), key)).toBe('x');
  });

  it('uses FB_POOL_KEY when set, derives one outside production, and has none in production', () => {
    const hex = randomBytes(32).toString('hex');
    expect(poolKey(env({ FB_POOL_KEY: hex }))!.equals(Buffer.from(hex, 'hex'))).toBe(true);
    expect(poolKey(env({ FB_POOL_KEY: ` ${hex}\n`, NODE_ENV: 'production' }))!.equals(Buffer.from(hex, 'hex'))).toBe(true);
    const derived = poolKey(env({}));
    expect(derived).toHaveLength(32);
    expect(derived!.equals(poolKey(env({}))!)).toBe(true);
    expect(derived!.equals(poolKey(env({ JWT_SECRET: 'another-secret-of-sufficient-length' }))!)).toBe(false);
    expect(poolKey(env({ NODE_ENV: 'production' }))).toBeNull();
  });
});
