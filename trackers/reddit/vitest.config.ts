import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Claim tests need real Postgres semantics (FOR UPDATE SKIP LOCKED), so
    // each test file provisions its own ephemeral database — see
    // tests/helpers/db.ts. Forks keep those databases isolated per file.
    pool: 'forks',
    maxWorkers: Number(process.env.VITEST_MAX_FORKS) || 4,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
