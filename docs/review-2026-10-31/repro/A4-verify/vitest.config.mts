import { defineConfig } from '../../../../apps/backend/node_modules/vitest/dist/config.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const backend = join(here, '../../../../apps/backend');
export default defineConfig({
  root: backend,
  resolve: { alias: { vitest: join(backend, 'node_modules/vitest') } },
  test: {
    include: [join(here, '*.test.ts')],
    setupFiles: [join(backend, 'tests/helpers/setup.ts')],
    globalSetup: [join(backend, 'tests/helpers/global-setup.ts')],
    pool: 'forks', maxWorkers: 1, testTimeout: 30_000, hookTimeout: 60_000,
    server: { deps: { inline: [] } },
  },
});
