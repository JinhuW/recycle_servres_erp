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
    // Test files run in PARALLEL, each fork against its own private database
    // (see global-setup.ts + db.ts → ensureWorkerDb). Cap the fork count so the
    // suite can't exhaust Postgres' connection limit — a handful of connections
    // per worker, 12 workers by default. Override with VITEST_MAX_FORKS.
    poolOptions: {
      forks: { maxForks: Number(process.env.VITEST_MAX_FORKS) || 8, minForks: 1 },
    },
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
