import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/helpers/setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }, // serialize — shared DB
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
