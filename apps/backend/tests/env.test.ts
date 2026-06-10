import { describe, it, expect } from 'vitest';
import { buildEnv } from '../src/env';

describe('buildEnv', () => {
  it('maps process.env into the Env shape', () => {
    const env = buildEnv({
      DATABASE_URL: 'postgres://x',
      JWT_SECRET: 's',
      OPENROUTER_API_KEY: 'k',
      R2_BUCKET: 'b',
    } as NodeJS.ProcessEnv);
    expect(env.DATABASE_URL).toBe('postgres://x');
    expect(env.JWT_SECRET).toBe('s');
    expect(env.OPENROUTER_API_KEY).toBe('k');
    expect(env.R2_BUCKET).toBe('b');
    expect(env.JWT_ISSUER).toBe('recycle-erp');
  });

  it('throws when JWT_SECRET is missing', () => {
    expect(() => buildEnv({} as NodeJS.ProcessEnv)).toThrow(/JWT_SECRET/);
  });

  it('throws in production when OPENROUTER_API_KEY is missing', () => {
    expect(() => buildEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      JWT_SECRET: 's',
      CORS_ALLOWED_ORIGINS: 'https://app',
    } as NodeJS.ProcessEnv)).toThrow(/OPENROUTER_API_KEY/);
  });

  it('does not throw outside production when OPENROUTER_API_KEY is missing', () => {
    expect(() => buildEnv({
      DATABASE_URL: 'postgres://x',
      JWT_SECRET: 's',
    } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('rejects the published default JWT_SECRET in production', () => {
    expect(() => buildEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:realpw@db/erp',
      JWT_SECRET: 'dev-jwt-secret-change-me-in-prod',
      CORS_ALLOWED_ORIGINS: 'https://app',
      OPENROUTER_API_KEY: 'k',
      OAUTH_SIGNING_KEY_CURRENT: 'x',
    } as NodeJS.ProcessEnv)).toThrow(/published default/);
  });

  it('rejects the default dev DB password in production', () => {
    expect(() => buildEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://recycle:recycle@postgres:5432/recycle_erp',
      JWT_SECRET: 'a-real-secret', // test fixture — pragma: allowlist secret
      CORS_ALLOWED_ORIGINS: 'https://app',
      OPENROUTER_API_KEY: 'k',
      OAUTH_SIGNING_KEY_CURRENT: 'x',
    } as NodeJS.ProcessEnv)).toThrow(/default dev password/);
  });

  it('accepts the dev defaults outside production', () => {
    expect(() => buildEnv({
      DATABASE_URL: 'postgres://recycle:recycle@127.0.0.1:5432/recycle_erp',
      JWT_SECRET: 'dev-jwt-secret-change-me-in-prod',
    } as NodeJS.ProcessEnv)).not.toThrow();
  });
});
