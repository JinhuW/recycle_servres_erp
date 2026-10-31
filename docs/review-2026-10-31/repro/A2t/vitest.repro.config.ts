// Runs only the A2t repro against the backend's own setup/globalSetup.
//   cd apps/backend && TEST_DATABASE_URL=postgres://postgres:review@127.0.0.1:55621/postgres \
//     npx vitest run --config ../../docs/review-2026-10-31/repro/A2t/vitest.repro.config.ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const backend = fileURLToPath(new URL('../../../../apps/backend/', import.meta.url));
export default defineConfig({
  root: backend,
  test: {
    include: [fileURLToPath(new URL('./*.repro.test.ts', import.meta.url))],
    setupFiles: ['tests/helpers/setup.ts'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
