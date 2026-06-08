import { afterAll, beforeAll } from 'vitest';
import { closeTestDb, ensureWorkerDb } from './db';
import { closeSharedDb } from '../../src/db';

// Provision this worker's private database once, before any test in the file
// runs its resetDb (which assumes the DB exists).
beforeAll(async () => {
  await ensureWorkerDb();
});

afterAll(async () => {
  await closeTestDb();
  await closeSharedDb();
});
