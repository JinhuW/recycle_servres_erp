import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    root: '/Users/jinhu/orca/workspaces/recycle_servres_erp/brant/docs/review-2026-10-31/repro/A2t-verify',
    include: ['reset-race.test.ts'],
    setupFiles: ['/Users/jinhu/orca/workspaces/recycle_servres_erp/brant/apps/backend/tests/helpers/setup.ts'],
    globalSetup: ['/Users/jinhu/orca/workspaces/recycle_servres_erp/brant/apps/backend/tests/helpers/global-setup.ts'],
    pool: 'forks', maxWorkers: 1, testTimeout: 120000, hookTimeout: 120000,
  },
});
