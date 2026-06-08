import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/helpers/setup.ts'],
    // Each `vitest run` provisions its own ephemeral database (dropped on
    // teardown), so concurrent runs (release gate + local run, CI + local)
    // can't clobber each other's schema mid-query. See global-setup.ts.
    globalSetup: ['tests/helpers/global-setup.ts'],
    pool: 'forks',
    fileParallelism: false, // serialize files within a run — they share the run's database
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
