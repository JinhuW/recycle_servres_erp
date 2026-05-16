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
});
