import {defineConfig} from '../../../../trackers/reddit/node_modules/vitest/dist/config.js';
export default defineConfig({test: {include: ['*.test.ts'], pool: 'forks', testTimeout: 20_000, hookTimeout: 60_000}});
