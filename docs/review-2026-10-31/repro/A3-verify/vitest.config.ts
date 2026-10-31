import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Runs this folder's repro tests with apps/backend's harness (setup + global
// setup), without adding them to the backend suite's include list.
const backend = fileURLToPath(new URL('../../../../apps/backend/', import.meta.url));
const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: backend,
  test: {
    dir: here,
    include: [`${here}**/*.test.ts`],
    globals: true,
    setupFiles: [`${backend}tests/helpers/setup.ts`],
    globalSetup: [`${backend}tests/helpers/global-setup.ts`],
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
