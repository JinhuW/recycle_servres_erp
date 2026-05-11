import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/helpers/setup.ts'],
    pool: 'forks',
    fileParallelism: false, // serialize — all tests share one Postgres database
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
