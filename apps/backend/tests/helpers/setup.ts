import { afterAll } from 'vitest';
import { closeTestDb } from './db';

afterAll(async () => { await closeTestDb(); });
