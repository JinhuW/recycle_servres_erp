import { afterAll } from 'vitest';
import { closeTestDb } from './db';
import { closeSharedDb } from '../../src/db';

afterAll(async () => {
  await closeTestDb();
  await closeSharedDb();
});
